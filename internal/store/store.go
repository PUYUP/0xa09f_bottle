package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	poolKey   = "a09f:blind_pool"
	activeKey = "a09f:bottles:active"
)

var ErrBottleExists = errors.New("bottle already exists")

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

func (s *Store) DepositKeys(ctx context.Context, keys []PoolKey) error {
	if len(keys) == 0 {
		return nil
	}
	now := time.Now()
	pipe := s.rdb.Pipeline()
	for i := range keys {
		ttl := s.poolTTL
		if keys[i].TTLSeconds > 0 {
			ttl = time.Duration(keys[i].TTLSeconds) * time.Second
		}
		expiresAt := now.Add(ttl).Unix()
		keys[i].ExpiresAt = expiresAt
		raw, err := json.Marshal(keys[i])
		if err != nil {
			return err
		}
		pipe.ZAdd(ctx, poolKey, redis.Z{Score: float64(expiresAt), Member: string(raw)})
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return err
	}
	if s.maxPool > 0 {
		card, err := s.rdb.ZCard(ctx, poolKey).Result()
		if err == nil && card > s.maxPool {
			_ = s.rdb.ZRemRangeByRank(ctx, poolKey, 0, card-s.maxPool-1).Err()
		}
	}
	return nil
}

var fetchKeysScript = redis.NewScript(`
local now = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local members = redis.call('ZRANGE', KEYS[1], 0, count - 1)
if #members > 0 then
  redis.call('ZREM', KEYS[1], unpack(members))
end
return members
`)

func (s *Store) FetchKeys(ctx context.Context, count int) ([]PoolKey, error) {
	if count <= 0 {
		return nil, nil
	}
	raw, err := fetchKeysScript.Run(ctx, s.rdb, []string{poolKey}, time.Now().Unix(), count).StringSlice()
	if err != nil {
		return nil, err
	}
	keys := make([]PoolKey, 0, len(raw))
	for _, item := range raw {
		var key PoolKey
		if err := json.Unmarshal([]byte(item), &key); err != nil {
			continue
		}
		keys = append(keys, key)
	}
	return keys, nil
}

func (s *Store) PoolSize(ctx context.Context) (int64, error) {
	return s.rdb.ZCard(ctx, poolKey).Result()
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
		var key PoolKey
		if err := json.Unmarshal([]byte(item), &key); err != nil {
			continue
		}
		if key.ExpiresAt > 0 && key.ExpiresAt <= now {
			continue
		}
		kids = append(kids, key.KID)
	}
	return kids, size, nil
}

func (s *Store) ListPoolKeys(ctx context.Context, limit int) ([]PoolKey, int64, error) {
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	size, err := s.rdb.ZCard(ctx, poolKey).Result()
	if err != nil {
		return nil, 0, err
	}
	members, err := s.rdb.ZRange(ctx, poolKey, 0, int64(limit-1)).Result()
	if err != nil {
		return nil, 0, err
	}
	now := time.Now().Unix()
	keys := make([]PoolKey, 0, len(members))
	for _, item := range members {
		var key PoolKey
		if err := json.Unmarshal([]byte(item), &key); err != nil {
			continue
		}
		if key.ExpiresAt > 0 && key.ExpiresAt <= now {
			continue
		}
		keys = append(keys, key)
	}
	return keys, size, nil
}

func (s *Store) CreateBottle(ctx context.Context, bottle Bottle) error {
	if bottle.CreatedAt == 0 {
		bottle.CreatedAt = time.Now().Unix()
	}
	raw, err := json.Marshal(bottle)
	if err != nil {
		return err
	}
	ok, err := s.rdb.SetNX(ctx, bottleRedisKey(bottle.ID), raw, s.bottleTTL).Result()
	if err != nil {
		return err
	}
	if !ok {
		return ErrBottleExists
	}
	if err := s.rdb.ZAdd(ctx, activeKey, redis.Z{Score: float64(bottle.CreatedAt), Member: bottle.ID}).Err(); err != nil {
		return err
	}
	if s.maxBottles > 0 {
		card, err := s.rdb.ZCard(ctx, activeKey).Result()
		if err == nil && card > s.maxBottles {
			_ = s.rdb.ZRemRangeByRank(ctx, activeKey, 0, card-s.maxBottles-1).Err()
		}
	}
	return nil
}

func (s *Store) ListBottles(ctx context.Context, limit int) ([]Bottle, error) {
	if limit <= 0 {
		limit = 50
	}
	cutoff := time.Now().Add(-s.bottleTTL).Unix()
	_ = s.rdb.ZRemRangeByScore(ctx, activeKey, "-inf", fmt.Sprint(cutoff)).Err()

	ids, err := s.rdb.ZRange(ctx, activeKey, 0, int64(limit-1)).Result()
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
  if env.kid == ARGV[1] then envelopeFound = true end
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
		return Bottle{}, err
	}
	var bottle Bottle
	if err := json.Unmarshal([]byte(raw), &bottle); err != nil {
		return Bottle{}, err
	}
	return bottle, nil
}

func (s *Store) Pickup(ctx context.Context, id, kid string) (PickupResult, error) {
	out, err := pickupScript.Run(ctx, s.rdb, []string{bottleRedisKey(id), activeKey}, kid, id).Text()
	if err != nil {
		return PickupResult{}, err
	}
	var result PickupResult
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		return PickupResult{}, err
	}
	return result, nil
}
