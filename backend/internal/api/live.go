package api

import (
	"context"
	"time"

	"a09f/bottle/internal/store"
)

// LiveStore is the storage contract the API needs for hot/live state.
// *store.Store (Redis) and *pgstore.LiveStore (Postgres, PG_ONLY mode)
// both satisfy it; handlers are backend-agnostic.
type LiveStore interface {
	DepositKeys(ctx context.Context, keys []store.PoolKey) error
	RestorePoolKeys(ctx context.Context, keys []store.PoolKey) (int, error)
	FetchKeys(ctx context.Context, count int, exclude []string, tzOffset *int) ([]store.PoolKey, error)
	PoolSize(ctx context.Context) (int64, error)
	PoolKidsExist(ctx context.Context, kids []string) (map[string]bool, error)
	ListPoolKids(ctx context.Context, limit int) ([]string, int64, error)
	ListPoolKeys(ctx context.Context, limit, offset int) ([]store.PoolKey, int64, error)
	StartPoolSweeper(ctx context.Context, interval time.Duration)

	IssueNonce(ctx context.Context, userID string) (string, error)
	ConsumeNonce(ctx context.Context, nonce, userID string) (bool, error)
	AuthIdentity(ctx context.Context) (store.AuthIdentity, error)

	CreateBottle(ctx context.Context, bottle store.Bottle) error
	GetBottle(ctx context.Context, id string) (store.Bottle, error)
	ListBottles(ctx context.Context, limit, offset int) ([]store.Bottle, error)
	ListBottlesCursor(ctx context.Context, limit int, beforeCreatedAt int64, beforeID string) ([]store.Bottle, error)
	ListChildren(ctx context.Context, parentID string, limit int) ([]store.Bottle, error)
	DeleteBottle(ctx context.Context, id string) error
	Pickup(ctx context.Context, id, kid, tokenHash string) (store.PickupResult, error)

	IssuePopToken(ctx context.Context, kids []string) (string, error)
	PopTokenKids(ctx context.Context, token string) ([]string, bool)
	PopSetGet(ctx context.Context, userID string) ([]string, error)
	PopSetPut(ctx context.Context, userID string, kids []string) error
	PopSetDelete(ctx context.Context, userID string) error

	PubkeysForKids(ctx context.Context, kids []string) (map[string][]string, error)

	PGOutboxPush(ctx context.Context, raw string) error
	PGOutboxPop(ctx context.Context, timeout time.Duration) (string, error)
	PGOutboxLen(ctx context.Context) (int64, error)

	Ping(ctx context.Context) error
	Close() error
}
