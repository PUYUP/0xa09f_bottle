package pgstore

import (
	"context"
	"encoding/json"
	"fmt"

	"a09f/bottle/internal/store"

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
`

type PGStore struct {
	pool *pgxpool.Pool
}

func New(ctx context.Context, databaseURL string) (*PGStore, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
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

func (p *PGStore) Close() {
	p.pool.Close()
}

func (p *PGStore) SaveBottle(ctx context.Context, b store.Bottle) error {
	envelopes, err := json.Marshal(b.Envelopes)
	if err != nil {
		return err
	}
	kids, err := json.Marshal(b.DeliveredKids)
	if err != nil {
		return err
	}
	_, err = p.pool.Exec(ctx, `
INSERT INTO bottles (id, created_at, depth, parent_id, max_deliveries, deliveries, status, payload_iv, ciphertext, envelopes, delivered_kids)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
ON CONFLICT (id) DO UPDATE SET
  deliveries = EXCLUDED.deliveries,
  status = EXCLUDED.status,
  delivered_kids = EXCLUDED.delivered_kids`,
		b.ID, b.CreatedAt, b.Depth, b.ParentID, b.MaxDeliveries, b.Deliveries, b.Status,
		b.PayloadIV, b.Ciphertext, envelopes, kids)
	return err
}

func (p *PGStore) UpdateDelivery(ctx context.Context, id string, deliveries int, status string, deliveredKids []string) error {
	kids, err := json.Marshal(deliveredKids)
	if err != nil {
		return err
	}
	_, err = p.pool.Exec(ctx,
		`UPDATE bottles SET deliveries = $2, status = $3, delivered_kids = $4 WHERE id = $1`,
		id, deliveries, status, kids)
	return err
}

func (p *PGStore) ListBottles(ctx context.Context, limit int) ([]store.Bottle, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := p.pool.Query(ctx, `
SELECT id, created_at, depth, parent_id, max_deliveries, deliveries, status, payload_iv, ciphertext, envelopes, delivered_kids
FROM bottles
ORDER BY created_at DESC
LIMIT $1`, limit)
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
