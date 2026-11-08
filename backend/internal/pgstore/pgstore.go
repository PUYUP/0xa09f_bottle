package pgstore

import (
	"context"
	"encoding/json"
	"fmt"

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
	return &PGStore{pool: pool}, nil
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
	_, err = p.pool.Exec(ctx, `
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
	return err
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
