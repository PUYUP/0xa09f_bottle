package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"a09f/bottle/internal/keyauth"

	"github.com/redis/go-redis/v9"
)

const (
	poolKey         = "a09f:blind_pool"
	kidsKey         = "a09f:blind_pool:kids"
	activeKey       = "a09f:bottles:active"
	authIdentityKey = "a09f:auth:identity"
)

var (
	ErrBottleExists    = errors.New("bottle already exists")
	ErrBottleNotActive = errors.New("bottle not active")
	ErrEnvelopeLimit   = errors.New("envelope limit reached")
	ErrBottleNotFound  = errors.New("bottle not found")
)

type PoolKey struct {
	KID        string `json:"kid"`
	PublicKey  string `json:"publicKey"`
	TTLSeconds int    `json:"ttlSeconds,omitempty"`
	ExpiresAt  int64  `json:"expiresAt"`
	DepositedN int    `json:"-"`
}

type Envelope struct {
	KID             string `json:"kid"`
	AuthorPublicKey string `json:"authorPublicKey"`
	WrapIV          string `json:"wrapIv"`
	WrappedKey      string `json:"wrappedKey"`
	PickupHash      string `json:"pickupHash,omitempty"`
}

type Bottle struct {
	ID            string     `json:"id"`
	CreatedAt     int64      `json:"createdAt"`
	MaxDeliveries int        `json:"maxDeliveries"`
	Depth         int        `json:"depth,omitempty"`
	ParentID      string     `json:"parentId,omitempty"`
	Deliveries    int        `json:"deliveries"`
	Status        string     `json:"status"`
	PayloadIV     string     `json:"payloadIv"`
	Ciphertext    string     `json:"ciphertext"`
	Envelopes     []Envelope `json:"envelopes"`
	DeliveredKids []string   `json:"deliveredKids,omitempty"`
}

type PickupResult struct {
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
	Status     string `json:"status,omitempty"`
	Deliveries int    `json:"deliveries"`
}

type Store struct {
	rdb        *redis.Client
	poolTTL    time.Duration
	bottleTTL  time.Duration
	maxPool    int64
	maxBottles int64
}

func New(redisURL string, poolTTL, bottleTTL time.Duration, maxPool, maxBottles int) (*Store, error) {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}
	rdb := redis.NewClient(opt)
	return &Store{
		rdb:        rdb,
		poolTTL:    poolTTL,
		bottleTTL:  bottleTTL,
		maxPool:    int64(maxPool),
		maxBottles: int64(maxBottles),
	}, nil
}

func (s *Store) Ping(ctx context.Context) error {
	return s.rdb.Ping(ctx).Err()
}

func (s *Store) Close() error {
	return s.rdb.Close()
}

func bottleRedisKey(id string) string {
	return "a09f:bottle:" + id
}

// poolMember is the compact on-Redis representation of a PoolKey.
// "p" holds the JWK x/y coordinates as "x.y" (base64url), avoiding
// storing the verbose JWK JSON envelope inside every member.
type poolMember struct {
	KID string `json:"k"`
	PK  string `json:"p"`
	Exp int64  `json:"e"`
}

func encodePoolMember(k PoolKey, expiresAt int64) (string, error) {
	var jwk struct {
		X string `json:"x"`
		Y string `json:"y"`
	}
	if err := json.Unmarshal([]byte(k.PublicKey), &jwk); err != nil {
		return "", err
	}
	if jwk.X == "" || jwk.Y == "" {
		return "", errors.New("publicKey missing x/y coordinates")
	}
	raw, err := json.Marshal(poolMember{KID: k.KID, PK: jwk.X + "." + jwk.Y, Exp: expiresAt})
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func decodePoolMember(raw string) (PoolKey, bool) {
	var m poolMember
	if err := json.Unmarshal([]byte(raw), &m); err != nil || m.KID == "" || m.PK == "" {
		return PoolKey{}, false
	}
	parts := strings.SplitN(m.PK, ".", 2)
	if len(parts) != 2 {
		return PoolKey{}, false
	}
	pub := fmt.Sprintf(`{"kty":"EC","crv":"P-256","x":%q,"y":%q}`, parts[0], parts[1])
	return PoolKey{KID: m.KID, PublicKey: pub, ExpiresAt: m.Exp}, true
}

func poolKeyFromMember(raw string) (PoolKey, bool) {
	if key, ok := decodePoolMember(raw); ok {
		return key, true
	}
	// legacy format: full PoolKey JSON
	var key PoolKey
	if err := json.Unmarshal([]byte(raw), &key); err != nil || key.KID == "" {
		return PoolKey{}, false
	}
	return key, true
}

type depositItem struct {
	Member string `json:"m"`
	Score  int64  `json:"s"`
	KID    string `json:"k"`
}

var depositKeysScript = redis.NewScript(`
local items = cjson.decode(ARGV[1])
local now = tonumber(ARGV[2])
local maxPool = tonumber(ARGV[3])
-- Purge expired entries first so a re-deposited kid whose old entry expired
-- is not mistaken for an active duplicate (and cannot leave a stale member).
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local added = 0
for i, it in ipairs(items) do
  if redis.call('ZSCORE', KEYS[2], it.k) == false then
    redis.call('ZADD', KEYS[1], it.s, it.m)
    redis.call('ZADD', KEYS[2], it.s, it.k)
    added = added + 1
  end
end
if maxPool > 0 then
  local card = redis.call('ZCARD', KEYS[1])
  if card > maxPool then
    local excess = card - maxPool
    local victims = redis.call('ZRANGE', KEYS[1], 0, excess - 1)
    for _, m in ipairs(victims) do
      local ok, obj = pcall(cjson.decode, m)
      if ok then
        local kid = obj.k or obj.kid
        if kid then redis.call('ZREM', KEYS[2], kid) end
      end
    end
    redis.call('ZREMRANGEBYRANK', KEYS[1], 0, excess - 1)
  end
end
return added
`)

func (s *Store) DepositKeys(ctx context.Context, keys []PoolKey) error {
	if len(keys) == 0 {
		return nil
	}
	now := time.Now()
	items := make([]depositItem, 0, len(keys))
	for i := range keys {
		ttl := s.poolTTL
		if keys[i].TTLSeconds > 0 {
			ttl = time.Duration(keys[i].TTLSeconds) * time.Second
		}
		expiresAt := now.Add(ttl).Unix()
		keys[i].ExpiresAt = expiresAt
		member, err := encodePoolMember(keys[i], expiresAt)
		if err != nil {
			return err
		}
		items = append(items, depositItem{Member: member, Score: expiresAt, KID: keys[i].KID})
	}
	raw, err := json.Marshal(items)
	if err != nil {
		return err
	}
	_, err = depositKeysScript.Run(ctx, s.rdb, []string{poolKey, kidsKey}, string(raw), time.Now().Unix(), s.maxPool).Result()
	return err
}

var fetchKeysScript = redis.NewScript(`
local now = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
local exclude = {}
if ARGV[3] and ARGV[3] ~= '' then
  local ok, arr = pcall(cjson.decode, ARGV[3])
  if ok and type(arr) == 'table' then
    for _, k in ipairs(arr) do exclude[tostring(k)] = true end
  end
end
local function kidOf(m)
  local ok, obj = pcall(cjson.decode, m)
  if ok then return obj.k or obj.kid end
  return nil
end
local function excluded(m)
  local kid = kidOf(m)
  return kid ~= nil and exclude[kid] == true
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local card = redis.call('ZCARD', KEYS[1])
if card == 0 then return {} end
if count > card then count = card end
local members = {}
if count >= card then
  local all = redis.call('ZRANGE', KEYS[1], 0, -1)
  for _, m in ipairs(all) do
    if not excluded(m) then members[#members + 1] = m end
  end
else
  local used = {}
  local guard = 0
  local maxGuard = count * 50 + 200
  while #members < count and guard < maxGuard do
    guard = guard + 1
    local rank = math.random(0, card - 1)
    if not used[rank] then
      used[rank] = true
      local m = redis.call('ZRANGE', KEYS[1], rank, rank)[1]
      if m and not excluded(m) then members[#members + 1] = m end
    end
  end
end
if #members > 0 then
  redis.call('ZREM', KEYS[1], unpack(members))
  for _, m in ipairs(members) do
    local kid = kidOf(m)
    if kid then redis.call('ZREM', KEYS[2], kid) end
  end
end
return members
`)

// FetchKeys atomically removes and returns up to count random pool keys.
// exclude lists kid values that must not be handed out (e.g. keys owned by
// users blocked by the requester); excluded members stay in the pool.
func (s *Store) FetchKeys(ctx context.Context, count int, exclude []string) ([]PoolKey, error) {
	if count <= 0 {
		return nil, nil
	}
	var excludeJSON string
	if len(exclude) > 0 {
		raw, err := json.Marshal(exclude)
		if err != nil {
			return nil, err
		}
		excludeJSON = string(raw)
	}
	raw, err := fetchKeysScript.Run(ctx, s.rdb, []string{poolKey, kidsKey}, time.Now().Unix(), count, excludeJSON).StringSlice()
	if err != nil {
		return nil, err
	}
	keys := make([]PoolKey, 0, len(raw))
	for _, item := range raw {
		if key, ok := poolKeyFromMember(item); ok {
			keys = append(keys, key)
		}
	}
	return keys, nil
}

func (s *Store) PoolSize(ctx context.Context) (int64, error) {
	return s.rdb.ZCard(ctx, poolKey).Result()
}

// Nonce issuance/consumption for single-use auth proofs.
const noncePrefix = "a09f:auth:nonce:"

const nonceTTL = 10 * time.Minute

// IssueNonce stores a single-use nonce bound to userID for nonceTTL.
func (s *Store) IssueNonce(ctx context.Context, userID string) (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	nonce := hex.EncodeToString(buf)
	if err := s.rdb.Set(ctx, noncePrefix+nonce, userID, nonceTTL).Err(); err != nil {
		return "", err
	}
	return nonce, nil
}

// ConsumeNonce atomically deletes the nonce and reports whether it existed
// and was bound to userID. GETDEL guarantees single use even under
// concurrent requests.
func (s *Store) ConsumeNonce(ctx context.Context, nonce, userID string) (bool, error) {
	if nonce == "" || len(nonce) > 128 {
		return false, nil
	}
	val, err := s.rdb.GetDel(ctx, noncePrefix+nonce).Result()
	if err == redis.Nil {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return val == userID, nil
}

// AuthIdentity is the server's static ECDH keypair used to verify
// proof-of-possession auth proofs. It is generated once and persisted in
// Redis so proofs survive restarts.
type AuthIdentity struct {
	PrivateJWK string `json:"privateJwk"`
	PublicJWK  string `json:"publicJwk"`
}

func (s *Store) AuthIdentity(ctx context.Context) (AuthIdentity, error) {
	raw, err := s.rdb.Get(ctx, authIdentityKey).Result()
	if err == nil && raw != "" {
		var id AuthIdentity
		if json.Unmarshal([]byte(raw), &id) == nil && id.PrivateJWK != "" {
			return id, nil
		}
	}
	priv, pub, err := keyauth.GenerateIdentity()
	if err != nil {
		return AuthIdentity{}, err
	}
	payload, err := json.Marshal(AuthIdentity{PrivateJWK: priv, PublicJWK: pub})
	if err != nil {
		return AuthIdentity{}, err
	}
	ok, err := s.rdb.SetNX(ctx, authIdentityKey, payload, 0).Result()
	if err != nil {
		return AuthIdentity{}, err
	}
	if !ok {
		// Another replica won the race; read its identity.
		raw, err = s.rdb.Get(ctx, authIdentityKey).Result()
		if err != nil {
			return AuthIdentity{}, err
		}
		var id AuthIdentity
		if err := json.Unmarshal([]byte(raw), &id); err != nil {
			return AuthIdentity{}, err
		}
		return id, nil
	}
	return AuthIdentity{PrivateJWK: priv, PublicJWK: pub}, nil
}

func (s *Store) StartPoolSweeper(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Minute
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				// Distributed lock: only one replica sweeps the pool per interval
				lockTTL := interval - 5*time.Second
				if lockTTL < time.Second {
					lockTTL = time.Minute
				}
				acquired, err := s.rdb.SetNX(ctx, "a09f:lock:sweeper", "1", lockTTL).Result()
				if err == nil && acquired {
					s.sweepPool(ctx)
				}
			}
		}
	}()
}

func (s *Store) sweepPool(ctx context.Context) {
	now := time.Now().Unix()
	max := fmt.Sprint(now)
	for {
		members, err := s.rdb.ZRangeByScore(ctx, poolKey, &redis.ZRangeBy{
			Min: "-inf", Max: max, Offset: 0, Count: 1000,
		}).Result()
		if err != nil || len(members) == 0 {
			break
		}
		kids := make([]string, 0, len(members))
		for _, m := range members {
			if key, ok := poolKeyFromMember(m); ok {
				kids = append(kids, key.KID)
			}
		}
		if len(kids) > 0 {
			args := make([]interface{}, len(kids))
			for i, k := range kids {
				args[i] = k
			}
			_ = s.rdb.ZRem(ctx, kidsKey, args...).Err()
		}
		args := make([]interface{}, len(members))
		for i, m := range members {
			args[i] = m
		}
		_ = s.rdb.ZRem(ctx, poolKey, args...).Err()
	}
	_ = s.rdb.ZRemRangeByScore(ctx, kidsKey, "-inf", max).Err()
}

func (s *Store) ListPoolKids(ctx context.Context, limit int) ([]string, int64, error) {
	if limit <= 0 {
		limit = 200
	}
	if limit > 20000 {
		limit = 20000
	}
	now := time.Now().Unix()
	_ = s.rdb.ZRemRangeByScore(ctx, poolKey, "-inf", fmt.Sprint(now)).Err()
	size, err := s.rdb.ZCard(ctx, poolKey).Result()
	if err != nil {
		return nil, 0, err
	}
	members, err := s.rdb.ZRange(ctx, poolKey, 0, int64(limit-1)).Result()
	if err != nil {
		return nil, 0, err
	}
	kids := make([]string, 0, len(members))
	for _, item := range members {
		key, ok := poolKeyFromMember(item)
		if !ok {
			continue
		}
		if key.ExpiresAt > 0 && key.ExpiresAt <= now {
			continue
		}
		kids = append(kids, key.KID)
	}
	return kids, size, nil
}

func (s *Store) ListPoolKeys(ctx context.Context, limit, offset int) ([]PoolKey, int64, error) {
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	if offset < 0 {
		offset = 0
	}
	now := time.Now().Unix()
	_ = s.rdb.ZRemRangeByScore(ctx, poolKey, "-inf", fmt.Sprint(now)).Err()
	_ = s.rdb.ZRemRangeByScore(ctx, kidsKey, "-inf", fmt.Sprint(now)).Err()
	size, err := s.rdb.ZCard(ctx, poolKey).Result()
	if err != nil {
		return nil, 0, err
	}
	start := int64(offset)
	members, err := s.rdb.ZRange(ctx, poolKey, start, start+int64(limit)-1).Result()
	if err != nil {
		return nil, 0, err
	}
	keys := make([]PoolKey, 0, len(members))
	for _, item := range members {
		key, ok := poolKeyFromMember(item)
		if !ok {
			continue
		}
		if key.ExpiresAt > 0 && key.ExpiresAt <= now {
			continue
		}
		keys = append(keys, key)
	}
	return keys, size, nil
}

var createBottleScript = redis.NewScript(`
local bottleKey = KEYS[1]
local activeKey = KEYS[2]
local bottleId = ARGV[1]
local raw = ARGV[2]
local ttlSeconds = tonumber(ARGV[3])
local createdAt = tonumber(ARGV[4])
local maxBottles = tonumber(ARGV[5])

local setRes = redis.call('SET', bottleKey, raw, 'NX', 'EX', ttlSeconds)
if not setRes then
  return 'EXISTS'
end
redis.call('ZADD', activeKey, createdAt, bottleId)
if maxBottles > 0 then
  local card = redis.call('ZCARD', activeKey)
  if card > maxBottles then
    local excess = card - maxBottles
    local victims = redis.call('ZRANGE', activeKey, 0, excess - 1)
    for _, id in ipairs(victims) do
      redis.call('DEL', 'a09f:bottle:' .. id)
    end
    redis.call('ZREMRANGEBYRANK', activeKey, 0, excess - 1)
  end
end
return 'OK'
`)

func (s *Store) CreateBottle(ctx context.Context, bottle Bottle) error {
	if bottle.CreatedAt == 0 {
		bottle.CreatedAt = time.Now().Unix()
	}
	raw, err := json.Marshal(bottle)
	if err != nil {
		return err
	}
	ttlSec := int(s.bottleTTL.Seconds())
	if ttlSec <= 0 {
		ttlSec = 7 * 24 * 3600
	}
	res, err := createBottleScript.Run(ctx, s.rdb, []string{bottleRedisKey(bottle.ID), activeKey},
		bottle.ID, string(raw), ttlSec, bottle.CreatedAt, s.maxBottles).Text()
	if err != nil {
		return err
	}
	if res == "EXISTS" {
		return ErrBottleExists
	}
	return nil
}

func (s *Store) ListBottles(ctx context.Context, limit, offset int) ([]Bottle, error) {
	if limit <= 0 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	cutoff := time.Now().Add(-s.bottleTTL).Unix()
	_ = s.rdb.ZRemRangeByScore(ctx, activeKey, "-inf", fmt.Sprint(cutoff)).Err()

	ids, err := s.rdb.ZRevRange(ctx, activeKey, int64(offset), int64(offset+limit-1)).Result()
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return []Bottle{}, nil
	}
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = bottleRedisKey(id)
	}
	vals, err := s.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	bottles := make([]Bottle, 0, len(vals))
	missing := make([]string, 0)
	for i, val := range vals {
		if val == nil {
			missing = append(missing, ids[i])
			continue
		}
		raw, ok := val.(string)
		if !ok {
			missing = append(missing, ids[i])
			continue
		}
		var bottle Bottle
		if err := json.Unmarshal([]byte(raw), &bottle); err != nil {
			missing = append(missing, ids[i])
			continue
		}
		if bottle.Status != "ACTIVE" {
			missing = append(missing, ids[i])
			continue
		}
		bottles = append(bottles, bottle)
	}
	if len(missing) > 0 {
		_ = s.rdb.ZRem(ctx, activeKey, missing).Err()
	}
	return bottles, nil
}

// ListBottlesCursor returns up to limit ACTIVE bottles ordered by
// (createdAt DESC, id DESC), strictly older than the (beforeCreatedAt,
// beforeID) boundary. A composite cursor is required for correctness when
// multiple bottles share the same second-resolution createdAt; an empty
// beforeID keeps legacy timestamp-only semantics.
func (s *Store) ListBottlesCursor(ctx context.Context, limit int, beforeCreatedAt int64, beforeID string) ([]Bottle, error) {
	if limit <= 0 {
		limit = 50
	}
	cutoff := time.Now().Add(-s.bottleTTL).Unix()
	_ = s.rdb.ZRemRangeByScore(ctx, activeKey, "-inf", fmt.Sprint(cutoff)).Err()

	var ids []string
	if beforeCreatedAt > 0 {
		if beforeID != "" {
			// Same-score band: members sort lexicographically (DESC under
			// ZREVRANGEBYSCORE), so the continuation is the suffix with
			// member < beforeID.
			band, err := s.rdb.ZRevRangeByScore(ctx, activeKey, &redis.ZRangeBy{
				Min: fmt.Sprint(beforeCreatedAt),
				Max: fmt.Sprint(beforeCreatedAt),
			}).Result()
			if err != nil {
				return nil, err
			}
			for _, id := range band {
				if id < beforeID {
					ids = append(ids, id)
				}
				if len(ids) >= limit {
					break
				}
			}
		}
		if len(ids) < limit {
			rest, err := s.rdb.ZRevRangeByScore(ctx, activeKey, &redis.ZRangeBy{
				Max:   fmt.Sprintf("(%d", beforeCreatedAt),
				Min:   "-inf",
				Count: int64(limit - len(ids)),
			}).Result()
			if err != nil {
				return nil, err
			}
			ids = append(ids, rest...)
		}
	} else {
		var err error
		ids, err = s.rdb.ZRevRangeByScore(ctx, activeKey, &redis.ZRangeBy{
			Max:   "+inf",
			Min:   "-inf",
			Count: int64(limit),
		}).Result()
		if err != nil {
			return nil, err
		}
	}
	if len(ids) == 0 {
		return []Bottle{}, nil
	}
	if len(ids) == 0 {
		return []Bottle{}, nil
	}
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = bottleRedisKey(id)
	}
	vals, err := s.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	bottles := make([]Bottle, 0, len(vals))
	missing := make([]string, 0)
	for i, val := range vals {
		if val == nil {
			missing = append(missing, ids[i])
			continue
		}
		raw, ok := val.(string)
		if !ok {
			missing = append(missing, ids[i])
			continue
		}
		var bottle Bottle
		if err := json.Unmarshal([]byte(raw), &bottle); err != nil {
			missing = append(missing, ids[i])
			continue
		}
		if bottle.Status != "ACTIVE" {
			missing = append(missing, ids[i])
			continue
		}
		bottles = append(bottles, bottle)
	}
	if len(missing) > 0 {
		_ = s.rdb.ZRem(ctx, activeKey, missing).Err()
	}
	return bottles, nil
}

var pickupScript = redis.NewScript(`
local raw = redis.call('GET', KEYS[1])
if not raw then
  return cjson.encode({ok=false, error='not_found'})
end
local obj = cjson.decode(raw)
if obj.status ~= 'ACTIVE' then
  return cjson.encode({ok=false, error='not_active', status=obj.status, deliveries=obj.deliveries or 0})
end
local maxDeliveries = tonumber(obj.maxDeliveries)
local deliveries = tonumber(obj.deliveries or 0)
if deliveries >= maxDeliveries then
  obj.status = 'EXHAUSTED'
  redis.call('ZREM', KEYS[2], ARGV[2])
  redis.call('SET', KEYS[1], cjson.encode(obj), 'KEEPTTL')
  return cjson.encode({ok=false, error='exhausted', status='EXHAUSTED', deliveries=deliveries})
end
local already = false
for i, kid in ipairs(obj.deliveredKids or {}) do
  if kid == ARGV[1] then already = true end
end
if already then
  return cjson.encode({ok=false, error='already_delivered', status=obj.status, deliveries=deliveries})
end
local envelopeFound = false
for i, env in ipairs(obj.envelopes) do
  if env.kid == ARGV[1] then
    if env.pickupHash and env.pickupHash ~= '' then
      if not ARGV[3] or ARGV[3] == '' or env.pickupHash ~= ARGV[3] then
        return cjson.encode({ok=false, error='invalid_token', status=obj.status, deliveries=deliveries})
      end
    end
    envelopeFound = true
  end
end
if not envelopeFound then
  return cjson.encode({ok=false, error='unknown_key', status=obj.status, deliveries=deliveries})
end
obj.deliveries = deliveries + 1
obj.deliveredKids = obj.deliveredKids or {}
table.insert(obj.deliveredKids, ARGV[1])
if obj.deliveries >= maxDeliveries then
  obj.status = 'EXHAUSTED'
  redis.call('ZREM', KEYS[2], ARGV[2])
end
redis.call('SET', KEYS[1], cjson.encode(obj), 'KEEPTTL')
return cjson.encode({ok=true, status=obj.status, deliveries=obj.deliveries})
`)

func (s *Store) GetBottle(ctx context.Context, id string) (Bottle, error) {
	raw, err := s.rdb.Get(ctx, bottleRedisKey(id)).Result()
	if err != nil {
		if err == redis.Nil {
			return Bottle{}, ErrBottleNotFound
		}
		return Bottle{}, err
	}
	var bottle Bottle
	if err := json.Unmarshal([]byte(raw), &bottle); err != nil {
		return Bottle{}, err
	}
	return bottle, nil
}

// AppendEnvelopes adds recipient envelopes to an ACTIVE bottle in place,
// preserving its TTL. Duplicate kids are skipped. Total envelopes may not
// exceed MaxDeliveries+1 (the +1 slot is the sender's self archive envelope).
// Only the session-key holder can produce envelopes that actually decrypt;
// foreign appends are inert garbage.
func (s *Store) AppendEnvelopes(ctx context.Context, id string, envs []Envelope) (Bottle, error) {
	bottle, err := s.GetBottle(ctx, id)
	if err != nil {
		return Bottle{}, err
	}
	if bottle.Status != "ACTIVE" {
		return Bottle{}, ErrBottleNotActive
	}
	seen := make(map[string]bool, len(bottle.Envelopes)+len(envs))
	for _, e := range bottle.Envelopes {
		seen[e.KID] = true
	}
	added := 0
	for _, e := range envs {
		if seen[e.KID] {
			continue
		}
		if len(bottle.Envelopes)+added+1 > bottle.MaxDeliveries+1 {
			return Bottle{}, ErrEnvelopeLimit
		}
		bottle.Envelopes = append(bottle.Envelopes, e)
		seen[e.KID] = true
		added++
	}
	if added == 0 {
		return bottle, nil
	}
	raw, err := json.Marshal(bottle)
	if err != nil {
		return Bottle{}, err
	}
	if err := s.rdb.SetArgs(ctx, bottleRedisKey(id), raw, redis.SetArgs{KeepTTL: true}).Err(); err != nil {
		return Bottle{}, err
	}
	return bottle, nil
}

func (s *Store) Pickup(ctx context.Context, id, kid, tokenHash string) (PickupResult, error) {
	out, err := pickupScript.Run(ctx, s.rdb, []string{bottleRedisKey(id), activeKey}, kid, id, tokenHash).Text()
	if err != nil {
		return PickupResult{}, err
	}
	var result PickupResult
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		return PickupResult{}, err
	}
	return result, nil
}
