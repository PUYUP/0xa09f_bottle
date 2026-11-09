package pgstore

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"a09f/bottle/internal/keyauth"
	"a09f/bottle/internal/store"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// LiveStore is the Postgres-backed implementation of the live-state role
// Redis normally plays: pool keys, bottles, pickup claims, auth nonces,
// pop tokens, verified-kid sets, and the server identity. It is selected
// when PG_ONLY is set (or REDIS_URL is empty); every method mirrors the
// semantics of the Redis store so handlers don't care which backend is
// active.
type LiveStore struct {
	pg      *PGStore
	poolTTL time.Duration
	maxPool int
}

func NewLiveStore(pg *PGStore, poolTTL time.Duration, maxPool int) *LiveStore {
	if poolTTL <= 0 {
		poolTTL = 24 * time.Hour
	}
	return &LiveStore{pg: pg, poolTTL: poolTTL, maxPool: maxPool}
}

// ---------- pool keys ----------
// Pool membership in PG mode is derived, not stored: a key is "in the
// pool" while key_registry has consumed_at = 0 AND expires_at > now AND
// no bottle_kids row references it (belt-and-braces for legacy consumes).
// Fetch atomically flips consumed_at so concurrent casts can't double-
// hand the same bait.

func (l *LiveStore) DepositKeys(ctx context.Context, keys []store.PoolKey) error {
	if len(keys) == 0 {
		return nil
	}
	now := time.Now()
	alive := make([]store.PoolKey, 0, len(keys))
	for i := range keys {
		ttl := l.poolTTL
		if keys[i].TTLSeconds > 0 {
			ttl = time.Duration(keys[i].TTLSeconds) * time.Second
		}
		keys[i].ExpiresAt = now.Add(ttl).Unix()
		alive = append(alive, keys[i])
	}
	if err := l.pg.RegisterPoolKeys(ctx, alive); err != nil {
		return err
	}
	// Enforce the pool cap the same way the Redis sorted set does: drop
	// the oldest live keys beyond maxPool.
	if l.maxPool > 0 {
		_, _ = l.pg.pool.Exec(ctx, `
DELETE FROM key_registry WHERE kid IN (
  SELECT kid FROM key_registry kr
  WHERE kr.consumed_at = 0 AND kr.expires_at > $1
    AND NOT EXISTS (SELECT 1 FROM bottle_kids bk WHERE bk.kid = kr.kid)
  ORDER BY kr.created_at ASC
  OFFSET $2)`, now.Unix(), l.maxPool)
	}
	return nil
}

func (l *LiveStore) RestorePoolKeys(ctx context.Context, keys []store.PoolKey) (int, error) {
	now := time.Now().Unix()
	live := make([]store.PoolKey, 0, len(keys))
	for _, k := range keys {
		if k.ExpiresAt > now {
			live = append(live, k)
		}
	}
	if err := l.pg.RegisterPoolKeys(ctx, live); err != nil {
		return 0, err
	}
	return len(live), nil
}

// poolCandidates returns unconsumed, unexpired registry rows not yet
// wrapped into a bottle, excluding the given kids. Bounded by maxRows —
// the pool is capped at MAX_POOL_KEYS so this stays small.
func (l *LiveStore) poolCandidates(ctx context.Context, exclude []string, maxRows int) ([]store.PoolKey, error) {
	rows, err := l.pg.pool.Query(ctx, `
SELECT kid, public_key, owner, expires_at, tz_offset
FROM key_registry kr
WHERE kr.consumed_at = 0
  AND kr.expires_at > $1
  AND NOT EXISTS (SELECT 1 FROM bottle_kids bk WHERE bk.kid = kr.kid)
  AND ($2::text[] IS NULL OR kr.kid <> ALL($2::text[]))
ORDER BY random()
LIMIT $3`, time.Now().Unix(), exclude, maxRows)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var keys []store.PoolKey
	for rows.Next() {
		var k store.PoolKey
		var tz *int32
		if err := rows.Scan(&k.KID, &k.PublicKey, &k.Owner, &k.ExpiresAt, &tz); err != nil {
			return nil, err
		}
		if tz != nil {
			v := int(*tz)
			k.TZOffset = &v
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}

// FetchKeys mirrors the Redis Lua pick: ~60% of slots prefer keys in the
// requester's ±2h timezone zone, one key per owner tag, then the rest are
// global-random. Consumption is committed atomically — only kids the
// UPDATE actually flipped are returned.
func (l *LiveStore) FetchKeys(ctx context.Context, count int, exclude []string, tzOffset *int) ([]store.PoolKey, error) {
	if count <= 0 {
		return nil, nil
	}
	candidates, err := l.poolCandidates(ctx, exclude, 5000)
	if err != nil || len(candidates) == 0 {
		return nil, err
	}
	zoneWant := 0
	if tzOffset != nil {
		zoneWant = int(float64(count)*0.6 + 0.5)
	}
	inZone := func(k store.PoolKey) bool {
		if tzOffset == nil || k.TZOffset == nil {
			return false
		}
		d := abs(*k.TZOffset-*tzOffset) % 1440
		if d > 720 {
			d = 1440 - d
		}
		return d <= 120
	}
	usedOwner := map[string]bool{}
	pickedKids := map[string]bool{}
	picked := make([]store.PoolKey, 0, count)
	pick := func(wantZone bool) bool {
		var fallback *store.PoolKey
		for i := range candidates {
			k := candidates[i]
			if pickedKids[k.KID] || (k.Owner != "" && usedOwner[k.Owner]) {
				continue
			}
			if wantZone && !inZone(k) {
				if fallback == nil {
					fb := k
					fallback = &fb
				}
				continue
			}
			picked = append(picked, k)
			pickedKids[k.KID] = true
			if k.Owner != "" {
				usedOwner[k.Owner] = true
			}
			return true
		}
		if fallback != nil {
			picked = append(picked, *fallback)
			pickedKids[fallback.KID] = true
			if fallback.Owner != "" {
				usedOwner[fallback.Owner] = true
			}
			return true
		}
		return false
	}
	for i := 0; i < zoneWant; i++ {
		pick(true)
	}
	for len(picked) < count && pick(false) {
	}
	if len(picked) == 0 {
		return []store.PoolKey{}, nil
	}
	kids := make([]string, len(picked))
	for i, k := range picked {
		kids[i] = k.KID
	}
	// Atomic consume: only rows still unconsumed flip — concurrent fetches
	// can't hand out the same bait twice.
	rows, err := l.pg.pool.Query(ctx, `
UPDATE key_registry SET consumed_at = $2
WHERE kid = ANY($1::text[]) AND consumed_at = 0
RETURNING kid`, kids, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	consumed := map[string]bool{}
	for rows.Next() {
		var kid string
		if err := rows.Scan(&kid); err != nil {
			return nil, err
		}
		consumed[kid] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]store.PoolKey, 0, len(picked))
	for _, k := range picked {
		if consumed[k.KID] {
			out = append(out, k)
		}
	}
	return out, nil
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func (l *LiveStore) PoolSize(ctx context.Context) (int64, error) {
	var n int64
	err := l.pg.pool.QueryRow(ctx, `
SELECT count(*) FROM key_registry kr
WHERE kr.consumed_at = 0 AND kr.expires_at > $1
  AND NOT EXISTS (SELECT 1 FROM bottle_kids bk WHERE bk.kid = kr.kid)`,
		time.Now().Unix()).Scan(&n)
	return n, err
}

func (l *LiveStore) PoolKidsExist(ctx context.Context, kids []string) (map[string]bool, error) {
	out := make(map[string]bool, len(kids))
	if len(kids) == 0 {
		return out, nil
	}
	rows, err := l.pg.pool.Query(ctx, `
SELECT kid FROM key_registry kr
WHERE kr.kid = ANY($1::text[]) AND kr.consumed_at = 0 AND kr.expires_at > $2
  AND NOT EXISTS (SELECT 1 FROM bottle_kids bk WHERE bk.kid = kr.kid)`, kids, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var kid string
		if err := rows.Scan(&kid); err != nil {
			return nil, err
		}
		out[kid] = true
	}
	return out, rows.Err()
}

func (l *LiveStore) ListPoolKids(ctx context.Context, limit int) ([]string, int64, error) {
	if limit <= 0 {
		limit = 200
	}
	if limit > 20000 {
		limit = 20000
	}
	var size int64
	if err := l.pg.pool.QueryRow(ctx, `
SELECT count(*) FROM key_registry kr
WHERE kr.consumed_at = 0 AND kr.expires_at > $1
  AND NOT EXISTS (SELECT 1 FROM bottle_kids bk WHERE bk.kid = kr.kid)`,
		time.Now().Unix()).Scan(&size); err != nil {
		return nil, 0, err
	}
	rows, err := l.pg.pool.Query(ctx, `
SELECT kid FROM key_registry kr
WHERE kr.consumed_at = 0 AND kr.expires_at > $1
  AND NOT EXISTS (SELECT 1 FROM bottle_kids bk WHERE bk.kid = kr.kid)
ORDER BY kr.created_at ASC LIMIT $2`, time.Now().Unix(), limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	kids := []string{}
	for rows.Next() {
		var kid string
		if err := rows.Scan(&kid); err != nil {
			return nil, 0, err
		}
		kids = append(kids, kid)
	}
	return kids, size, rows.Err()
}

func (l *LiveStore) ListPoolKeys(ctx context.Context, limit, offset int) ([]store.PoolKey, int64, error) {
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	if offset < 0 {
		offset = 0
	}
	size, err := l.PoolSize(ctx)
	if err != nil {
		return nil, 0, err
	}
	rows, err := l.pg.pool.Query(ctx, `
SELECT kid, public_key, owner, expires_at, tz_offset
FROM key_registry kr
WHERE kr.consumed_at = 0 AND kr.expires_at > $1
  AND NOT EXISTS (SELECT 1 FROM bottle_kids bk WHERE bk.kid = kr.kid)
ORDER BY kr.created_at ASC LIMIT $2 OFFSET $3`, time.Now().Unix(), limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	keys := []store.PoolKey{}
	for rows.Next() {
		var k store.PoolKey
		var tz *int32
		if err := rows.Scan(&k.KID, &k.PublicKey, &k.Owner, &k.ExpiresAt, &tz); err != nil {
			return nil, 0, err
		}
		if tz != nil {
			v := int(*tz)
			k.TZOffset = &v
		}
		keys = append(keys, k)
	}
	return keys, size, rows.Err()
}

// StartPoolSweeper is a no-op in PG mode: pool membership is computed from
// expires_at/consumed_at at query time, and RunRetention prunes dead rows.
func (l *LiveStore) StartPoolSweeper(ctx context.Context, interval time.Duration) {}

// ---------- server_kv helpers ----------

func (l *LiveStore) kvGet(ctx context.Context, key string) (string, bool, error) {
	var out string
	err := l.pg.pool.QueryRow(ctx,
		`SELECT value FROM server_kv WHERE key = $1 AND (expires_at = 0 OR expires_at > $2)`,
		key, time.Now().Unix()).Scan(&out)
	if err == pgx.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return out, true, nil
}

func (l *LiveStore) kvPut(ctx context.Context, key, value string, ttl time.Duration) error {
	exp := int64(0)
	if ttl > 0 {
		exp = time.Now().Add(ttl).Unix()
	}
	_, err := l.pg.pool.Exec(ctx,
		`INSERT INTO server_kv (key, value, expires_at) VALUES ($1, $2, $3)
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
		key, value, exp)
	return err
}

func (l *LiveStore) kvDelete(ctx context.Context, key string) error {
	_, err := l.pg.pool.Exec(ctx, `DELETE FROM server_kv WHERE key = $1`, key)
	return err
}

// ---------- auth nonces ----------

func (l *LiveStore) IssueNonce(ctx context.Context, userID string) (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	nonce := hex.EncodeToString(buf)
	if err := l.kvPut(ctx, "nonce:"+nonce, userID, 10*time.Minute); err != nil {
		return "", err
	}
	return nonce, nil
}

// ConsumeNonce deletes the nonce row and reports whether it existed and
// was bound to userID — DELETE ... RETURNING is atomic, so of two
// concurrent requests carrying the same nonce exactly one proceeds.
func (l *LiveStore) ConsumeNonce(ctx context.Context, nonce, userID string) (bool, error) {
	if nonce == "" || len(nonce) > 128 {
		return false, nil
	}
	var val string
	err := l.pg.pool.QueryRow(ctx,
		`DELETE FROM server_kv WHERE key = $1 AND (expires_at = 0 OR expires_at > $2) RETURNING value`,
		"nonce:"+nonce, time.Now().Unix()).Scan(&val)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return val == userID, nil
}

// ---------- server identity ----------

func (l *LiveStore) AuthIdentity(ctx context.Context) (store.AuthIdentity, error) {
	if raw, ok, err := l.kvGet(ctx, "auth:identity"); err == nil && ok {
		var id store.AuthIdentity
		if json.Unmarshal([]byte(raw), &id) == nil && id.PrivateJWK != "" {
			return id, nil
		}
	}
	priv, pub, err := keyauth.GenerateIdentity()
	if err != nil {
		return store.AuthIdentity{}, err
	}
	payload, err := json.Marshal(store.AuthIdentity{PrivateJWK: priv, PublicJWK: pub})
	if err != nil {
		return store.AuthIdentity{}, err
	}
	// INSERT ... ON CONFLICT DO NOTHING makes the first writer win; a
	// concurrent replica then reads the winner's row.
	if _, err := l.pg.pool.Exec(ctx,
		`INSERT INTO server_kv (key, value, expires_at) VALUES ('auth:identity', $1, 0)
		 ON CONFLICT (key) DO NOTHING`, string(payload)); err != nil {
		return store.AuthIdentity{}, err
	}
	raw, ok, err := l.kvGet(ctx, "auth:identity")
	if err != nil || !ok {
		return store.AuthIdentity{}, fmt.Errorf("auth identity readback failed")
	}
	var id store.AuthIdentity
	if err := json.Unmarshal([]byte(raw), &id); err != nil {
		return store.AuthIdentity{}, err
	}
	return id, nil
}

// ---------- pop tokens ----------

func (l *LiveStore) IssuePopToken(ctx context.Context, kids []string) (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)
	raw, err := json.Marshal(kids)
	if err != nil {
		return "", err
	}
	if err := l.kvPut(ctx, "poptoken:"+token, string(raw), 10*time.Minute); err != nil {
		return "", err
	}
	return token, nil
}

func (l *LiveStore) PopTokenKids(ctx context.Context, token string) ([]string, bool) {
	if token == "" || len(token) > 128 {
		return nil, false
	}
	raw, ok, err := l.kvGet(ctx, "poptoken:"+token)
	if err != nil || !ok {
		return nil, false
	}
	var kids []string
	if err := json.Unmarshal([]byte(raw), &kids); err != nil {
		return nil, false
	}
	return kids, true
}

// ---------- verified kid sets ----------

func (l *LiveStore) PopSetGet(ctx context.Context, userID string) ([]string, error) {
	raw, ok, err := l.kvGet(ctx, "popset:"+userID)
	if err != nil || !ok {
		return nil, err
	}
	var kids []string
	if err := json.Unmarshal([]byte(raw), &kids); err != nil {
		return nil, nil
	}
	return kids, nil
}

func (l *LiveStore) PopSetPut(ctx context.Context, userID string, kids []string) error {
	if len(kids) > 5000 {
		kids = kids[:5000]
	}
	raw, err := json.Marshal(kids)
	if err != nil {
		return err
	}
	return l.kvPut(ctx, "popset:"+userID, string(raw), 7*24*time.Hour)
}

func (l *LiveStore) PopSetDelete(ctx context.Context, userID string) error {
	return l.kvDelete(ctx, "popset:"+userID)
}

// ---------- bottles ----------

func (l *LiveStore) CreateBottle(ctx context.Context, bottle store.Bottle) error {
	if bottle.CreatedAt == 0 {
		bottle.CreatedAt = time.Now().Unix()
	}
	exists, err := l.pg.BottleExists(ctx, bottle.ID)
	if err != nil {
		return err
	}
	if exists {
		return store.ErrBottleExists
	}
	if err := l.pg.SaveBottle(ctx, bottle); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return store.ErrBottleExists
		}
		return err
	}
	return nil
}

func (l *LiveStore) GetBottle(ctx context.Context, id string) (store.Bottle, error) {
	return l.pg.GetBottle(ctx, id)
}

func (l *LiveStore) ListBottles(ctx context.Context, limit, offset int) ([]store.Bottle, error) {
	return l.pg.ListBottles(ctx, limit, offset)
}

func (l *LiveStore) ListBottlesCursor(ctx context.Context, limit int, beforeCreatedAt int64, beforeID string) ([]store.Bottle, error) {
	return l.pg.ListBottlesCursor(ctx, limit, beforeCreatedAt, beforeID)
}

func (l *LiveStore) ListChildren(ctx context.Context, parentID string, limit int) ([]store.Bottle, error) {
	return l.pg.ListChildren(ctx, parentID, limit)
}

func (l *LiveStore) ListThread(ctx context.Context, rootID string, limit int) ([]store.Bottle, error) {
	return l.pg.ListThread(ctx, rootID, limit)
}

func (l *LiveStore) DeleteBottle(ctx context.Context, id string) error {
	// The handler already tombstones via pg.TombstoneBottle; this is the
	// store-side equivalent so the interface stays uniform. Idempotent.
	_, err := l.pg.TombstoneBottle(ctx, id)
	return err
}

// Pickup mirrors the Redis Lua claim: bottle must be ACTIVE, kid must own
// an envelope (pickupHash must match when set), deliveries increment, and
// the bottle flips to EXHAUSTED at maxDeliveries. All inside one tx with
// SELECT ... FOR UPDATE so concurrent pickups can't double-claim.
func (l *LiveStore) Pickup(ctx context.Context, id, kid, tokenHash string) (store.PickupResult, error) {
	tx, err := l.pg.pool.Begin(ctx)
	if err != nil {
		return store.PickupResult{}, err
	}
	defer tx.Rollback(ctx)

	var status string
	var maxDel, deliveries int
	var envelopesJSON, deliveredJSON []byte
	err = tx.QueryRow(ctx, `
SELECT status, max_deliveries, deliveries, envelopes, delivered_kids
FROM bottles WHERE id = $1 FOR UPDATE`, id).
		Scan(&status, &maxDel, &deliveries, &envelopesJSON, &deliveredJSON)
	if err == pgx.ErrNoRows {
		return store.PickupResult{OK: false, Error: "not_found"}, nil
	}
	if err != nil {
		return store.PickupResult{}, err
	}
	if status != "ACTIVE" {
		return store.PickupResult{OK: false, Error: "not_active", Status: status, Deliveries: deliveries}, nil
	}
	if deliveries >= maxDel {
		_, _ = tx.Exec(ctx, `UPDATE bottles SET status = 'EXHAUSTED' WHERE id = $1`, id)
		_ = tx.Commit(ctx)
		return store.PickupResult{OK: false, Error: "exhausted", Status: "EXHAUSTED", Deliveries: deliveries}, nil
	}
	var delivered []string
	_ = json.Unmarshal(deliveredJSON, &delivered)
	for _, k := range delivered {
		if k == kid {
			return store.PickupResult{OK: false, Error: "already_delivered", Status: status, Deliveries: deliveries}, nil
		}
	}
	var envelopes []store.Envelope
	if err := json.Unmarshal(envelopesJSON, &envelopes); err != nil {
		return store.PickupResult{}, err
	}
	envelopeFound := false
	for _, env := range envelopes {
		if env.KID != kid {
			continue
		}
		if env.PickupHash != "" && (tokenHash == "" || env.PickupHash != tokenHash) {
			return store.PickupResult{OK: false, Error: "invalid_token", Status: status, Deliveries: deliveries}, nil
		}
		envelopeFound = true
	}
	if !envelopeFound {
		return store.PickupResult{OK: false, Error: "unknown_key", Status: status, Deliveries: deliveries}, nil
	}
	delivered = append(delivered, kid)
	kidsJSON, err := json.Marshal(delivered)
	if err != nil {
		return store.PickupResult{}, err
	}
	newDeliveries := deliveries + 1
	newStatus := status
	if newDeliveries >= maxDel {
		newStatus = "EXHAUSTED"
	}
	if _, err := tx.Exec(ctx, `
UPDATE bottles SET deliveries = $2, status = $3, delivered_kids = $4 WHERE id = $1`,
		id, newDeliveries, newStatus, string(kidsJSON)); err != nil {
		return store.PickupResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return store.PickupResult{}, err
	}
	return store.PickupResult{OK: true, Status: newStatus, Deliveries: newDeliveries}, nil
}

// ---------- misc ----------

// PubkeysForKids has no Redis equivalent in PG mode — PG registries
// (key_registry, bottle_kids, user_identities) are the only source, which
// is what pg.PubkeysForKids already covers.
func (l *LiveStore) PubkeysForKids(ctx context.Context, kids []string) (map[string][]string, error) {
	return map[string][]string{}, nil
}

func (l *LiveStore) PGOutboxPush(ctx context.Context, raw string) error { return nil }
func (l *LiveStore) PGOutboxLen(ctx context.Context) (int64, error)     { return 0, nil }
func (l *LiveStore) PGOutboxPop(ctx context.Context, timeout time.Duration) (string, error) {
	return "", errors.New("no outbox in pg mode")
}

func (l *LiveStore) Ping(ctx context.Context) error { return l.pg.Ping(ctx) }
func (l *LiveStore) Close() error                   { return nil }
