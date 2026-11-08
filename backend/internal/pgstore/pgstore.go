package pgstore

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"a09f/bottle/internal/store"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const schema = `
CREATE TABLE IF NOT EXISTS bottles (
  id              TEXT PRIMARY KEY,
  created_at      BIGINT NOT NULL,
  depth           INT NOT NULL DEFAULT 1,
  parent_id       TEXT NOT NULL DEFAULT '',
  max_deliveries  INT NOT NULL,
  deliveries      INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  payload_iv      TEXT NOT NULL,
  ciphertext      TEXT NOT NULL,
  envelopes       JSONB NOT NULL,
  delivered_kids  JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS bottles_created_at_idx ON bottles (created_at DESC);
CREATE INDEX IF NOT EXISTS bottles_parent_id_idx ON bottles (parent_id) WHERE parent_id <> '';

-- One row per envelope kid: the index behind "bottles involving me"
-- queries (recipient pool kids, self:<userId> sender marker, reply:<id>).
CREATE TABLE IF NOT EXISTS bottle_kids (
  bottle_id  TEXT NOT NULL REFERENCES bottles(id) ON DELETE CASCADE,
  kid        TEXT NOT NULL,
  pubkey     TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (bottle_id, kid)
);
CREATE INDEX IF NOT EXISTS bottle_kids_kid_idx ON bottle_kids (kid);
ALTER TABLE bottle_kids ADD COLUMN IF NOT EXISTS pubkey TEXT NOT NULL DEFAULT '';

-- key_registry binds kid -> recipient pubkey from deposit time onward, so
-- proof-of-possession can be verified before any bottle references the kid.
-- expires_at/consumed_at/tz_offset mirror the Redis pool member so the
-- active pool can be rebuilt from Postgres after a Redis loss.
CREATE TABLE IF NOT EXISTS key_registry (
  kid         TEXT PRIMARY KEY,
  public_key  TEXT NOT NULL,
  owner       TEXT NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL DEFAULT 0,
  consumed_at BIGINT NOT NULL DEFAULT 0,
  tz_offset   INT
);
CREATE INDEX IF NOT EXISTS key_registry_owner_idx ON key_registry (owner);
ALTER TABLE key_registry ADD COLUMN IF NOT EXISTS expires_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE key_registry ADD COLUMN IF NOT EXISTS consumed_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE key_registry ADD COLUMN IF NOT EXISTS tz_offset INT;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username));

-- users may own many public keys (pool kids live in user_keys); the single
-- identity key used for proof-of-possession auth lives here.
ALTER TABLE users DROP COLUMN IF EXISTS public_key;
CREATE TABLE IF NOT EXISTS user_identities (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key  TEXT NOT NULL,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_keys (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kid         TEXT NOT NULL,
  public_key  TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (user_id, kid)
);
CREATE INDEX IF NOT EXISTS user_keys_kid_idx ON user_keys (kid);

CREATE TABLE IF NOT EXISTS blocked_users (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason           TEXT NOT NULL DEFAULT '',
  created_at       BIGINT NOT NULL,
  PRIMARY KEY (user_id, blocked_user_id),
  CHECK (user_id <> blocked_user_id)
);
CREATE INDEX IF NOT EXISTS blocked_users_blocked_idx ON blocked_users (blocked_user_id);

CREATE TABLE IF NOT EXISTS reported_users (
  reported_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason              TEXT NOT NULL DEFAULT '',
  created_at          BIGINT NOT NULL,
  PRIMARY KEY (reported_by_user_id, reported_user_id),
  CHECK (reported_by_user_id <> reported_user_id)
);
CREATE INDEX IF NOT EXISTS reported_users_reported_idx ON reported_users (reported_user_id);

CREATE TABLE IF NOT EXISTS reported_bottles (
  bottle_id         TEXT NOT NULL,
  reporter_user_id  TEXT NOT NULL DEFAULT '',
  reason            TEXT NOT NULL DEFAULT '',
  created_at        BIGINT NOT NULL,
  PRIMARY KEY (bottle_id, reporter_user_id)
);
CREATE INDEX IF NOT EXISTS reported_bottles_created_idx ON reported_bottles (created_at DESC);
`

type PGStore struct {
	pool *pgxpool.Pool
}

func New(ctx context.Context, databaseURL string, maxConns, minConns int) (*PGStore, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("pgx config: %w", err)
	}
	if maxConns > 0 {
		cfg.MaxConns = int32(maxConns)
	}
	if minConns > 0 {
		cfg.MinConns = int32(minConns)
	}
	// Avoid prepared-statement cache races (SQLSTATE 42P05) when multiple
	// pooled connections prepare the same statement concurrently.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("pgx pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pg ping: %w", err)
	}
	if _, err := pool.Exec(ctx, schema); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pg migrate: %w", err)
	}
	pg := &PGStore{pool: pool}
	pg.backfillBottleKids(ctx)
	return pg, nil
}

// backfillBottleKids populates bottle_kids from existing envelopes JSONB.
// Runs once when the table is empty; afterwards SaveBottle keeps it in sync.
func (p *PGStore) backfillBottleKids(ctx context.Context) {
	var n int
	if err := p.pool.QueryRow(ctx, `SELECT count(*) FROM bottle_kids`).Scan(&n); err != nil || n > 0 {
		return
	}
	if _, err := p.pool.Exec(ctx, `
INSERT INTO bottle_kids (bottle_id, kid, pubkey, created_at)
SELECT b.id, e->>'kid', COALESCE(e->>'recipientPublicKey', ''), b.created_at
FROM bottles b, LATERAL jsonb_array_elements(b.envelopes) e
WHERE e->>'kid' IS NOT NULL AND e->>'kid' <> ''
ON CONFLICT DO NOTHING`); err != nil {
		// Non-fatal: new bottles still populate the table going forward.
		fmt.Printf("pg backfill bottle_kids: %v\n", err)
	}
	// Fill pubkey for rows created before envelopes carried recipientPublicKey.
	if _, err := p.pool.Exec(ctx, `
UPDATE bottle_kids k
SET pubkey = e->>'recipientPublicKey'
FROM bottles b, LATERAL jsonb_array_elements(b.envelopes) e
WHERE k.bottle_id = b.id AND e->>'kid' = k.kid
  AND k.pubkey = '' AND e->>'recipientPublicKey' IS NOT NULL`); err != nil {
		fmt.Printf("pg backfill bottle_kids pubkey: %v\n", err)
	}
}

func (p *PGStore) Ping(ctx context.Context) error {
	return p.pool.Ping(ctx)
}

func (p *PGStore) TryAdvisoryLock(ctx context.Context, lockID int64) (bool, error) {
	var acquired bool
	err := p.pool.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", lockID).Scan(&acquired)
	return acquired, err
}

func (p *PGStore) AdvisoryUnlock(ctx context.Context, lockID int64) error {
	var unlocked bool
	return p.pool.QueryRow(ctx, "SELECT pg_advisory_unlock($1)", lockID).Scan(&unlocked)
}

func (p *PGStore) Close() {
	p.pool.Close()
}

func (p *PGStore) SaveBottle(ctx context.Context, b store.Bottle) error {
	envelopes, err := json.Marshal(b.Envelopes)
	if err != nil {
		return err
	}
	kidsJSON := []byte("[]")
	if len(b.DeliveredKids) > 0 {
		kidsJSON, err = json.Marshal(b.DeliveredKids)
		if err != nil {
			return err
		}
	}
	// Bottle row and its bottle_kids index rows commit atomically: a bottle
	// must never exist without its kid index, or kid-filtered listings
	// would silently miss it until the reconciler heals the gap.
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `
INSERT INTO bottles (id, created_at, depth, parent_id, max_deliveries, deliveries, status, payload_iv, ciphertext, envelopes, delivered_kids)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
ON CONFLICT (id) DO UPDATE SET
  deliveries = GREATEST(bottles.deliveries, EXCLUDED.deliveries),
  status = CASE WHEN bottles.status = 'EXHAUSTED' OR EXCLUDED.status = 'EXHAUSTED' THEN 'EXHAUSTED' ELSE EXCLUDED.status END,
  delivered_kids = CASE
    WHEN jsonb_typeof(EXCLUDED.delivered_kids) = 'array'
     AND (jsonb_typeof(bottles.delivered_kids) <> 'array'
          OR jsonb_array_length(EXCLUDED.delivered_kids) > jsonb_array_length(bottles.delivered_kids))
    THEN EXCLUDED.delivered_kids
    ELSE bottles.delivered_kids
  END`,
		b.ID, b.CreatedAt, b.Depth, b.ParentID, b.MaxDeliveries, b.Deliveries, b.Status,
		b.PayloadIV, b.Ciphertext, string(envelopes), string(kidsJSON))
	if err != nil {
		return err
	}
	if err := syncBottleKidsTx(ctx, tx, b); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func syncBottleKidsTx(ctx context.Context, tx pgx.Tx, b store.Bottle) error {
	kids := make([]string, 0, len(b.Envelopes))
	pubs := make([]string, 0, len(b.Envelopes))
	for _, env := range b.Envelopes {
		if env.KID != "" {
			kids = append(kids, env.KID)
			pubs = append(pubs, env.RecipientPublicKey)
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM bottle_kids WHERE bottle_id = $1`, b.ID); err != nil {
		return err
	}
	if len(kids) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `
INSERT INTO bottle_kids (bottle_id, kid, pubkey, created_at)
SELECT $1, k.kid, k.pub, $4
FROM unnest($2::text[], $3::text[]) AS k(kid, pub)
ON CONFLICT (bottle_id, kid) DO NOTHING`, b.ID, kids, pubs, b.CreatedAt)
	return err
}

// RegisterPoolKeys upserts kid -> pubkey bindings collected at deposit time.
// Best-effort: failures are logged by the caller, never block deposits.
// Re-depositing a kid refreshes expires_at/tz_offset/owner and clears
// consumed_at — the key is alive in the pool again.
func (p *PGStore) RegisterPoolKeys(ctx context.Context, keys []store.PoolKey) error {
	if len(keys) == 0 {
		return nil
	}
	kids := make([]string, 0, len(keys))
	pubs := make([]string, 0, len(keys))
	owners := make([]string, 0, len(keys))
	exps := make([]int64, 0, len(keys))
	tzs := make([]string, 0, len(keys))
	now := time.Now().Unix()
	for _, k := range keys {
		kids = append(kids, k.KID)
		pubs = append(pubs, k.PublicKey)
		owners = append(owners, k.Owner)
		exps = append(exps, k.ExpiresAt)
		tz := ""
		if k.TZOffset != nil {
			tz = fmt.Sprintf("%d", *k.TZOffset)
		}
		tzs = append(tzs, tz)
	}
	_, err := p.pool.Exec(ctx, `
INSERT INTO key_registry (kid, public_key, owner, created_at, expires_at, tz_offset)
SELECT k.kid, k.pub, k.owner, $5, k.exp, NULLIF(k.tz, '')::int
FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $6::text[]) AS k(kid, pub, owner, exp, tz)
ON CONFLICT (kid) DO UPDATE SET
  expires_at = EXCLUDED.expires_at,
  tz_offset = EXCLUDED.tz_offset,
  owner = EXCLUDED.owner,
  consumed_at = 0`, kids, pubs, owners, exps, now, tzs)
	return err
}

// MarkPoolKeysConsumed records that pool keys were handed out by a fetch.
// Best-effort bookkeeping for pool rebuilds; fetch itself never depends on it.
func (p *PGStore) MarkPoolKeysConsumed(ctx context.Context, kids []string) error {
	if len(kids) == 0 {
		return nil
	}
	_, err := p.pool.Exec(ctx, `
UPDATE key_registry SET consumed_at = $2
WHERE kid = ANY($1::text[]) AND consumed_at = 0`, kids, time.Now().Unix())
	return err
}

// PoolKeyState is the registry-side view of one pool kid used by the
// pool-status endpoint: expiry plus whether the key was ever consumed
// (explicit consumed_at, or implied by appearing in bottle_kids for
// consumption that predates the column).
type PoolKeyState struct {
	ExpiresAt int64
	Consumed  bool
	Found     bool
}

// PoolKeyStates returns registry state for a set of kids. Kids absent from
// the registry report Found=false.
func (p *PGStore) PoolKeyStates(ctx context.Context, kids []string) (map[string]PoolKeyState, error) {
	out := make(map[string]PoolKeyState, len(kids))
	if len(kids) == 0 {
		return out, nil
	}
	rows, err := p.pool.Query(ctx, `
SELECT kid, expires_at, consumed_at,
       EXISTS(SELECT 1 FROM bottle_kids bk WHERE bk.kid = key_registry.kid) AS in_bottles
FROM key_registry
WHERE kid = ANY($1::text[])`, kids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var kid string
		var st PoolKeyState
		var consumedAt int64
		var inBottles bool
		if err := rows.Scan(&kid, &st.ExpiresAt, &consumedAt, &inBottles); err != nil {
			return nil, err
		}
		st.Found = true
		st.Consumed = consumedAt > 0 || inBottles
		out[kid] = st
	}
	return out, rows.Err()
}

// LivePoolKeys returns registry entries that should be in the active pool:
// not consumed, not expired, and never wrapped into a bottle. The bottle_kids
// exclusion covers consumption that happened before consumed_at existed.
func (p *PGStore) LivePoolKeys(ctx context.Context, now int64) ([]store.PoolKey, error) {
	rows, err := p.pool.Query(ctx, `
SELECT kid, public_key, owner, expires_at, tz_offset
FROM key_registry kr
WHERE kr.consumed_at = 0
  AND kr.expires_at > $1
  AND NOT EXISTS (SELECT 1 FROM bottle_kids bk WHERE bk.kid = kr.kid)
ORDER BY kr.created_at ASC`, now)
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

// PubkeysForKid returns every pubkey ever bound to a kid: deposit-time
// registry entries plus recipientPublicKey values embedded in envelopes.
func (p *PGStore) PubkeysForKid(ctx context.Context, kid string) ([]string, error) {
	rows, err := p.pool.Query(ctx, `
SELECT pubkey FROM (
  SELECT public_key AS pubkey FROM key_registry WHERE kid = $1
  UNION
  SELECT pubkey FROM bottle_kids WHERE kid = $1 AND pubkey <> ''
) t WHERE pubkey <> ''`, kid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var pubs []string
	for rows.Next() {
		var pub string
		if err := rows.Scan(&pub); err != nil {
			return nil, err
		}
		pubs = append(pubs, pub)
	}
	return pubs, rows.Err()
}

func (p *PGStore) UpdateDelivery(ctx context.Context, id string, deliveries int, status string, deliveredKids []string) error {
	kidsJSON := []byte("[]")
	var err error
	if len(deliveredKids) > 0 {
		kidsJSON, err = json.Marshal(deliveredKids)
		if err != nil {
			return err
		}
	}
	_, err = p.pool.Exec(ctx,
		`UPDATE bottles SET deliveries = $2, status = $3, delivered_kids = $4 WHERE id = $1`,
		id, deliveries, status, string(kidsJSON))
	return err
}

func (p *PGStore) ListBottles(ctx context.Context, limit, offset int) ([]store.Bottle, error) {
	if limit <= 0 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	rows, err := p.pool.Query(ctx, `
SELECT id, created_at, depth, parent_id, max_deliveries, deliveries, status, payload_iv, ciphertext, envelopes, delivered_kids
FROM bottles
ORDER BY created_at DESC, id COLLATE "C" DESC
LIMIT $1 OFFSET $2`, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	bottles := make([]store.Bottle, 0, limit)
	for rows.Next() {
		var b store.Bottle
		var envelopes, kids []byte
		if err := rows.Scan(&b.ID, &b.CreatedAt, &b.Depth, &b.ParentID, &b.MaxDeliveries,
			&b.Deliveries, &b.Status, &b.PayloadIV, &b.Ciphertext, &envelopes, &kids); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(envelopes, &b.Envelopes); err != nil {
			continue
		}
		_ = json.Unmarshal(kids, &b.DeliveredKids)
		bottles = append(bottles, b)
	}
	return bottles, rows.Err()
}

// ListChildren returns archive bottles whose parent_id matches, oldest first
// so clients can rebuild a thread in chronological order.
func (p *PGStore) ListChildren(ctx context.Context, parentID string, limit int) ([]store.Bottle, error) {
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	rows, err := p.pool.Query(ctx, `
SELECT id, created_at, depth, parent_id, max_deliveries, deliveries, status, payload_iv, ciphertext, envelopes, delivered_kids
FROM bottles
WHERE parent_id = $1
ORDER BY created_at ASC, id COLLATE "C" ASC
LIMIT $2`, parentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	bottles := make([]store.Bottle, 0, limit)
	for rows.Next() {
		var b store.Bottle
		var envelopes, kids []byte
		if err := rows.Scan(&b.ID, &b.CreatedAt, &b.Depth, &b.ParentID, &b.MaxDeliveries,
			&b.Deliveries, &b.Status, &b.PayloadIV, &b.Ciphertext, &envelopes, &kids); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(envelopes, &b.Envelopes); err != nil {
			continue
		}
		_ = json.Unmarshal(kids, &b.DeliveredKids)
		bottles = append(bottles, b)
	}
	return bottles, rows.Err()
}

// ListBottlesByKids returns bottles carrying at least one of the given
// envelope kids, newest-first with the same composite cursor semantics as
// ListBottlesCursor. Served by the bottle_kids index, so it stays fast and
// exhaustive regardless of corpus size.
func (p *PGStore) ListBottlesByKids(ctx context.Context, kids []string, limit int, beforeCreatedAt int64, beforeID string) ([]store.Bottle, error) {
	if limit <= 0 {
		limit = 50
	}
	if len(kids) == 0 {
		return []store.Bottle{}, nil
	}
	rows, err := p.pool.Query(ctx, `
SELECT DISTINCT b.id, b.created_at, b.depth, b.parent_id, b.max_deliveries, b.deliveries, b.status, b.payload_iv, b.ciphertext, b.envelopes, b.delivered_kids
FROM bottles b
JOIN bottle_kids k ON k.bottle_id = b.id
WHERE k.kid = ANY($1::text[])
  AND ($2 = 0 OR b.created_at < $2 OR (b.created_at = $2 AND b.id COLLATE "C" < $3))
ORDER BY b.created_at DESC, b.id COLLATE "C" DESC
LIMIT $4`, kids, beforeCreatedAt, beforeID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	bottles := make([]store.Bottle, 0, limit)
	for rows.Next() {
		var b store.Bottle
		var envelopes, delivered []byte
		if err := rows.Scan(&b.ID, &b.CreatedAt, &b.Depth, &b.ParentID, &b.MaxDeliveries,
			&b.Deliveries, &b.Status, &b.PayloadIV, &b.Ciphertext, &envelopes, &delivered); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(envelopes, &b.Envelopes); err != nil {
			continue
		}
		_ = json.Unmarshal(delivered, &b.DeliveredKids)
		bottles = append(bottles, b)
	}
	return bottles, rows.Err()
}

// ChildStats returns per-parent reply aggregates for a set of bottle ids:
// direct-child count and the newest child's created_at. Used by the
// kids-filtered listing so clients can badge threads with unseen replies
// without fetching every thread's children.
func (p *PGStore) ChildStats(ctx context.Context, ids []string) (map[string][2]int64, error) {
	out := make(map[string][2]int64, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := p.pool.Query(ctx, `
SELECT parent_id, COUNT(*)::bigint, COALESCE(MAX(created_at), 0)
FROM bottles
WHERE parent_id = ANY($1::text[])
GROUP BY parent_id`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var parent string
		var count, last int64
		if err := rows.Scan(&parent, &count, &last); err != nil {
			return nil, err
		}
		out[parent] = [2]int64{count, last}
	}
	return out, rows.Err()
}

func (p *PGStore) ListBottlesCursor(ctx context.Context, limit int, beforeCreatedAt int64, beforeID string) ([]store.Bottle, error) {
	if limit <= 0 {
		limit = 50
	}
	query := `
SELECT id, created_at, depth, parent_id, max_deliveries, deliveries, status, payload_iv, ciphertext, envelopes, delivered_kids
FROM bottles
WHERE ($1 = 0 OR created_at < $1 OR (created_at = $1 AND id COLLATE "C" < $2))
ORDER BY created_at DESC, id COLLATE "C" DESC
LIMIT $3`
	rows, err := p.pool.Query(ctx, query, beforeCreatedAt, beforeID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	bottles := make([]store.Bottle, 0, limit)
	for rows.Next() {
		var b store.Bottle
		var envelopes, kids []byte
		if err := rows.Scan(&b.ID, &b.CreatedAt, &b.Depth, &b.ParentID, &b.MaxDeliveries,
			&b.Deliveries, &b.Status, &b.PayloadIV, &b.Ciphertext, &envelopes, &kids); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(envelopes, &b.Envelopes); err != nil {
			continue
		}
		_ = json.Unmarshal(kids, &b.DeliveredKids)
		bottles = append(bottles, b)
	}
	return bottles, rows.Err()
}
