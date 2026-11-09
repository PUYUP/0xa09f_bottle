package pgstore

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Subscription is the paywall entitlement row for one identity. Status
// values: trialing | active | past_due | canceled.
type Subscription struct {
	UserID              string `json:"-"`
	PolarSubscriptionID string `json:"-"`
	PolarCustomerID     string `json:"-"`
	Status              string `json:"status"`
	TrialEndsAt         int64  `json:"trialEndsAt"`
	TrialExtensions     int    `json:"trialExtensions"`
	CurrentPeriodEnd    int64  `json:"currentPeriodEnd"`
	CreatedAt           int64  `json:"-"`
	UpdatedAt           int64  `json:"-"`
}

// Entitlement is the computed access state shown to clients.
type Entitlement struct {
	Entitled       bool   `json:"entitled"`
	CanExtend      bool   `json:"canExtend"`
	Status         string `json:"status"`
	TrialEndsAt    int64  `json:"trialEndsAt"`
	PeriodEnd      int64  `json:"periodEnd"`
	ExtensionsLeft int    `json:"extensionsLeft"`
	DaysLeft       int64  `json:"daysLeft"`
}

// EnsureTrial creates the subscription row on first sight of an identity.
// The trial clock starts here — at registration or first gated request.
func (p *PGStore) EnsureTrial(ctx context.Context, userID string, trialDays int) error {
	now := time.Now().Unix()
	_, err := p.pool.Exec(ctx, `
INSERT INTO subscriptions (user_id, status, trial_ends_at, created_at, updated_at)
VALUES ($1, 'trialing', $2, $3, $3)
ON CONFLICT (user_id) DO NOTHING`,
		userID, now+int64(trialDays)*86400, now)
	return err
}

func (p *PGStore) getSubscription(ctx context.Context, userID string) (*Subscription, error) {
	var s Subscription
	err := p.pool.QueryRow(ctx, `
SELECT user_id, COALESCE(polar_subscription_id,''), COALESCE(polar_customer_id,''), status,
       trial_ends_at, trial_extensions, current_period_end, created_at, updated_at
FROM subscriptions WHERE user_id = $1`, userID).Scan(
		&s.UserID, &s.PolarSubscriptionID, &s.PolarCustomerID, &s.Status,
		&s.TrialEndsAt, &s.TrialExtensions, &s.CurrentPeriodEnd, &s.CreatedAt, &s.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// Entitlement evaluates access for a user. A paid period (active,
// past_due, or canceled-but-not-yet-ended) wins over the trial clock.
// A lapsed trial can be extended once while extensions remain.
func (p *PGStore) Entitlement(ctx context.Context, userID string, trialDays, maxExtensions int) (*Entitlement, error) {
	sub, err := p.getSubscription(ctx, userID)
	if err != nil {
		return nil, err
	}
	if sub == nil {
		// No row yet (legacy user pre-billing) — grant a fresh trial.
		if err := p.EnsureTrial(ctx, userID, trialDays); err != nil {
			return nil, err
		}
		sub, err = p.getSubscription(ctx, userID)
		if err != nil {
			return nil, err
		}
	}
	now := time.Now().Unix()
	e := &Entitlement{
		Status:         sub.Status,
		TrialEndsAt:    sub.TrialEndsAt,
		PeriodEnd:      sub.CurrentPeriodEnd,
		ExtensionsLeft: maxExtensions - sub.TrialExtensions,
	}
	if e.ExtensionsLeft < 0 {
		e.ExtensionsLeft = 0
	}

	paid := (sub.Status == "active" || sub.Status == "past_due" || sub.Status == "canceled") &&
		sub.CurrentPeriodEnd > now
	if paid {
		e.Entitled = true
		e.DaysLeft = (sub.CurrentPeriodEnd - now + 86399) / 86400
		return e, nil
	}
	if sub.TrialEndsAt > now {
		e.Entitled = true
		e.DaysLeft = (sub.TrialEndsAt - now + 86399) / 86400
		return e, nil
	}
	e.CanExtend = e.ExtensionsLeft > 0
	return e, nil
}

// ExtendTrial grants one more trial period. Only valid while the trial is
// lapsed and extensions remain; optimistic concurrency on the extension
// count keeps concurrent calls from double-extending.
func (p *PGStore) ExtendTrial(ctx context.Context, userID string, extensionDays, maxExtensions int) (*Entitlement, error) {
	now := time.Now().Unix()
	ct, err := p.pool.Exec(ctx, `
UPDATE subscriptions
SET trial_ends_at = GREATEST(trial_ends_at, $2) + $3,
    trial_extensions = trial_extensions + 1,
    updated_at = $2
WHERE user_id = $1
  AND trial_extensions < $4
  AND NOT (
    status IN ('active','past_due','canceled') AND current_period_end > $2
  )
  AND trial_ends_at <= $2`,
		userID, now, int64(extensionDays)*86400, maxExtensions)
	if err != nil {
		return nil, err
	}
	if ct.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	return p.Entitlement(ctx, userID, 0, maxExtensions)
}

// UserIDForPolarSub recovers the bound userId when a webhook payload lacks
// metadata (e.g. subscription.updated for a sub we already recorded).
func (p *PGStore) UserIDForPolarSub(ctx context.Context, subID string) (string, error) {
	var uid string
	err := p.pool.QueryRow(ctx,
		`SELECT user_id FROM subscriptions WHERE polar_subscription_id = $1`, subID).Scan(&uid)
	if err == pgx.ErrNoRows {
		return "", ErrNotFound
	}
	return uid, err
}

// UpsertPolarSubscription records payment state from a Polar webhook.
// periodEnd is unix seconds (0 = unknown).
func (p *PGStore) UpsertPolarSubscription(ctx context.Context, userID, subID, customerID, status string, periodEnd int64) error {
	now := time.Now().Unix()
	_, err := p.pool.Exec(ctx, `
INSERT INTO subscriptions (user_id, polar_subscription_id, polar_customer_id, status, current_period_end, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $6)
ON CONFLICT (user_id) DO UPDATE SET
  polar_subscription_id = EXCLUDED.polar_subscription_id,
  polar_customer_id     = EXCLUDED.polar_customer_id,
  status                = EXCLUDED.status,
  current_period_end    = EXCLUDED.current_period_end,
  updated_at            = EXCLUDED.updated_at`,
		userID, subID, customerID, status, periodEnd, now)
	return err
}
