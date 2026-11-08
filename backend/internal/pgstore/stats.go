package pgstore

import "context"

// UserStats aggregates everything the server can honestly compute about a
// user from stored metadata. No plaintext is involved: casts/replies are
// counted via the self:<userId> envelope marker, receives via delivered_kids
// intersected with the user's deposited pool kids.
type UserStats struct {
	MemberSince    int64 `json:"memberSince"`
	Casts          int64 `json:"casts"`
	Replies        int64 `json:"replies"`
	CastsDelivered int64 `json:"castsDelivered"`
	CastsExhausted int64 `json:"castsExhausted"`
	Received       int64 `json:"received"`
	Claims         int64 `json:"claims"`
	KeysDeposited  int64 `json:"keysDeposited"`
	FirstActivity  int64 `json:"firstActivity"`
	LastActivity   int64 `json:"lastActivity"`
	ReportsFiled   int64 `json:"reportsFiled"`
	TimesReported  int64 `json:"timesReported"`
	UsersBlocked   int64 `json:"usersBlocked"`
}

func (p *PGStore) UserStats(ctx context.Context, userID string) (UserStats, error) {
	var st UserStats
	selfKid := "self:" + userID

	// Authored bottles: any bottle carrying our self archive envelope.
	// depth=1 → root cast, depth>1 → thread reply.
	err := p.pool.QueryRow(ctx, `
		SELECT
		  count(*) FILTER (WHERE depth = 1),
		  count(*) FILTER (WHERE depth > 1),
		  count(*) FILTER (WHERE deliveries > 0),
		  count(*) FILTER (WHERE status = 'EXHAUSTED'),
		  COALESCE(min(created_at), 0),
		  COALESCE(max(created_at), 0)
		FROM bottles
		WHERE EXISTS (
		  SELECT 1 FROM jsonb_array_elements(envelopes) e
		  WHERE e->>'kid' = $1
		)`, selfKid).Scan(&st.Casts, &st.Replies, &st.CastsDelivered, &st.CastsExhausted, &st.FirstActivity, &st.LastActivity)
	if err != nil {
		return st, err
	}

	// Received: bottles where at least one of our pool kids was delivered.
	// Claims: total delivery events attributed to our kids.
	// received_kids guard: legacy rows may hold jsonb 'null' instead of '[]'.
	err = p.pool.QueryRow(ctx, `
		SELECT
		  count(DISTINCT b.id),
		  (SELECT count(*) FROM bottles b2
		   WHERE jsonb_typeof(b2.delivered_kids) = 'array'
		     AND EXISTS (
		       SELECT 1 FROM jsonb_array_elements_text(b2.delivered_kids) d
		       JOIN user_keys k ON k.user_id = $1 AND k.kid = d))
		FROM bottles b
		WHERE jsonb_typeof(b.delivered_kids) = 'array'
		  AND EXISTS (
		    SELECT 1 FROM user_keys k
		    WHERE k.user_id = $1 AND b.delivered_kids ? k.kid
		  )`, userID).Scan(&st.Received, &st.Claims)
	if err != nil {
		return st, err
	}

	err = p.pool.QueryRow(ctx, `
		SELECT
		  (SELECT count(*) FROM user_keys WHERE user_id = $1),
		  (SELECT count(*) FROM reported_users WHERE reported_by_user_id = $1),
		  (SELECT count(*) FROM reported_users WHERE reported_user_id = $1),
		  (SELECT count(*) FROM blocked_users WHERE user_id = $1),
		  (SELECT created_at FROM users WHERE id = $1)`,
		userID).Scan(&st.KeysDeposited, &st.ReportsFiled, &st.TimesReported, &st.UsersBlocked, &st.MemberSince)
	if err != nil {
		return st, err
	}
	return st, nil
}
