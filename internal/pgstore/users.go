package pgstore

import (
	"context"
	"errors"
	"time"

	"a09f/bottle/internal/store"

	"github.com/jackc/pgx/v5"
)

var ErrNotFound = errors.New("not found")

// User is an account identified solely by an ECDH P-256 identity key.
// PublicKey is the identity key joined from user_identities — a user may own
// additional public keys, which live in user_keys.
type User struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	PublicKey string `json:"publicKey"`
	CreatedAt int64  `json:"createdAt"`
}

type Block struct {
	UserID        string `json:"userId"`
	BlockedUserID string `json:"blockedUserId"`
	Username      string `json:"username"`
	Reason        string `json:"reason"`
	CreatedAt     int64  `json:"createdAt"`
}

const userSelect = `
SELECT u.id, u.username, COALESCE(i.public_key, ''), u.created_at
FROM users u LEFT JOIN user_identities i ON i.user_id = u.id`

func (p *PGStore) CreateUser(ctx context.Context, id, username string) error {
	_, err := p.pool.Exec(ctx,
		`INSERT INTO users (id, username, created_at) VALUES ($1,$2,$3)`,
		id, username, time.Now().Unix())
	return err
}

// UpsertUserIdentity stores the user's proof-of-possession identity key.
func (p *PGStore) UpsertUserIdentity(ctx context.Context, userID, publicKey string) error {
	_, err := p.pool.Exec(ctx, `INSERT INTO user_identities (user_id, public_key, created_at)
		VALUES ($1,$2,$3)
		ON CONFLICT (user_id) DO UPDATE SET public_key = EXCLUDED.public_key`,
		userID, publicKey, time.Now().Unix())
	return err
}

func (p *PGStore) GetUserByUsername(ctx context.Context, username string) (User, error) {
	var u User
	err := p.pool.QueryRow(ctx, userSelect+` WHERE LOWER(u.username) = LOWER($1)`, username).
		Scan(&u.ID, &u.Username, &u.PublicKey, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

func (p *PGStore) GetUserByID(ctx context.Context, id string) (User, error) {
	var u User
	err := p.pool.QueryRow(ctx, userSelect+` WHERE u.id = $1`, id).
		Scan(&u.ID, &u.Username, &u.PublicKey, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

// UpsertUserKeys records which pool kids belong to a user. Re-depositing a
// kid re-assigns ownership, which is correct because kids are random UUIDs.
func (p *PGStore) UpsertUserKeys(ctx context.Context, userID string, keys []store.PoolKey) error {
	if len(keys) == 0 {
		return nil
	}
	now := time.Now().Unix()
	batch := &pgx.Batch{}
	for _, k := range keys {
		batch.Queue(`INSERT INTO user_keys (user_id, kid, public_key, created_at)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (user_id, kid) DO UPDATE SET public_key = EXCLUDED.public_key`,
			userID, k.KID, k.PublicKey, now)
	}
	return p.pool.SendBatch(ctx, batch).Close()
}

func (p *PGStore) BlockUser(ctx context.Context, userID, blockedUserID, reason string) error {
	_, err := p.pool.Exec(ctx, `INSERT INTO blocked_users (user_id, blocked_user_id, reason, created_at)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (user_id, blocked_user_id) DO UPDATE SET reason = EXCLUDED.reason`,
		userID, blockedUserID, reason, time.Now().Unix())
	return err
}

func (p *PGStore) UnblockUser(ctx context.Context, userID, blockedUserID string) error {
	ct, err := p.pool.Exec(ctx,
		`DELETE FROM blocked_users WHERE user_id = $1 AND blocked_user_id = $2`,
		userID, blockedUserID)
	if err == nil && ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

func (p *PGStore) ListBlocks(ctx context.Context, userID string) ([]Block, error) {
	rows, err := p.pool.Query(ctx, `
SELECT b.blocked_user_id, u.username, b.reason, b.created_at
FROM blocked_users b JOIN users u ON u.id = b.blocked_user_id
WHERE b.user_id = $1 ORDER BY b.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Block
	for rows.Next() {
		var b Block
		if err := rows.Scan(&b.BlockedUserID, &b.Username, &b.Reason, &b.CreatedAt); err != nil {
			return nil, err
		}
		b.UserID = userID
		out = append(out, b)
	}
	return out, rows.Err()
}

// ListBlockedKids returns pool kids owned by users blocked by userID.
// These are excluded from random key fetch so blocked users never receive
// the requester's bottles.
func (p *PGStore) ListBlockedKids(ctx context.Context, userID string, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 10000
	}
	rows, err := p.pool.Query(ctx, `
SELECT DISTINCT uk.kid
FROM user_keys uk
JOIN blocked_users b ON b.blocked_user_id = uk.user_id
WHERE b.user_id = $1
LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	kids := make([]string, 0, 64)
	for rows.Next() {
		var kid string
		if err := rows.Scan(&kid); err != nil {
			return nil, err
		}
		kids = append(kids, kid)
	}
	return kids, rows.Err()
}

func (p *PGStore) ReportUser(ctx context.Context, reporterID, reportedID, reason string) error {
	_, err := p.pool.Exec(ctx, `INSERT INTO reported_users (reported_by_user_id, reported_user_id, reason, created_at)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (reported_by_user_id, reported_user_id)
		DO UPDATE SET reason = EXCLUDED.reason, created_at = EXCLUDED.created_at`,
		reporterID, reportedID, reason, time.Now().Unix())
	return err
}

// ReportBottle files a UGC report against a bottle. reporterID may be ""
// for anonymous reports; one report per (bottle, reporter) pair.
func (p *PGStore) ReportBottle(ctx context.Context, bottleID, reporterID, reason string) error {
	_, err := p.pool.Exec(ctx, `INSERT INTO reported_bottles (bottle_id, reporter_user_id, reason, created_at)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (bottle_id, reporter_user_id)
		DO UPDATE SET reason = EXCLUDED.reason, created_at = EXCLUDED.created_at`,
		bottleID, reporterID, reason, time.Now().Unix())
	return err
}

// BottleExists reports whether a bottle id is present in the archive.
func (p *PGStore) BottleExists(ctx context.Context, id string) (bool, error) {
	var exists bool
	err := p.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bottles WHERE id = $1)`, id).Scan(&exists)
	return exists, err
}
