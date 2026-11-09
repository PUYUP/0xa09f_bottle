package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"a09f/bottle/internal/pgstore"

	"github.com/gofiber/fiber/v3"
)

// Billing is Polar.sh-based: checkout links are created server-side, and
// subscription state arrives via signed webhooks. The only identifier we
// store is the anonymous userId (identity public key) — PII stays with
// Polar as merchant of record.

// entitlement returns the user's access state, lazily starting the trial
// for identities that predate billing.
func (s *Server) entitlement(ctx context.Context, userID string) (*pgstore.Entitlement, error) {
	return s.pg.Entitlement(ctx, userID, s.cfg.TrialDays, s.cfg.TrialExtensions)
}

// billingEntitled caches entitlement lookups for 60s — subscription state
// changes rarely and this sits on the hot auth path.
func (s *Server) billingEntitled(ctx context.Context, userID string) (bool, error) {
	s.entMu.Lock()
	if e, ok := s.entCache[userID]; ok && time.Now().Unix() < e.until {
		s.entMu.Unlock()
		return e.ok, nil
	}
	s.entMu.Unlock()

	ent, err := s.entitlement(ctx, userID)
	if err != nil {
		return false, err
	}
	s.entMu.Lock()
	if len(s.entCache) > 10000 {
		s.entCache = map[string]entCacheEntry{}
	}
	s.entCache[userID] = entCacheEntry{ok: ent.Entitled, until: time.Now().Unix() + 60}
	s.entMu.Unlock()
	return ent.Entitled, nil
}

// billingExempt paths stay reachable regardless of entitlement — otherwise
// an expired user could never pay or check status.
func billingExempt(path string) bool {
	return strings.HasPrefix(path, "/api/billing/")
}

// billingStatus reports the caller's entitlement for the paywall UI.
func (s *Server) billingStatus(c fiber.Ctx) error {
	user, err := s.requireAuth(c)
	if err != nil {
		return err
	}
	ent, err := s.entitlement(c.Context(), user.ID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "billing lookup failed")
	}
	return c.JSON(fiber.Map{"entitlement": ent})
}

// billingCheckout creates a Polar checkout session and returns its URL.
// plan: "monthly" | "yearly".
func (s *Server) billingCheckout(c fiber.Ctx) error {
	user, err := s.requireAuth(c)
	if err != nil {
		return err
	}
	var req struct {
		Plan string `json:"plan"`
	}
	if err := bindJSON(c, &req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	productID := ""
	switch req.Plan {
	case "monthly":
		productID = s.cfg.PolarProductMonthly
	case "yearly":
		productID = s.cfg.PolarProductYearly
	default:
		return fiber.NewError(fiber.StatusBadRequest, "plan must be monthly or yearly")
	}
	if s.cfg.PolarAccessToken == "" || productID == "" {
		return fiber.NewError(fiber.StatusServiceUnavailable, "billing not configured")
	}

	body, _ := json.Marshal(map[string]any{
		"products":    []string{productID},
		"success_url": s.cfg.WebURL + "/?checkout=success",
		"return_url":  s.cfg.WebURL + "/",
		"metadata":    map[string]string{"user_id": user.ID},
	})
	httpReq, err := http.NewRequestWithContext(c.Context(), http.MethodPost,
		strings.TrimRight(s.cfg.PolarAPIBase, "/")+"/v1/checkouts/",
		bytes.NewReader(body))
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "checkout failed")
	}
	httpReq.Header.Set("Authorization", "Bearer "+s.cfg.PolarAccessToken)
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return fiber.NewError(fiber.StatusBadGateway, "polar unreachable")
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		log.Printf("polar checkout %d: %s", resp.StatusCode, string(respBody))
		return fiber.NewError(fiber.StatusBadGateway, "polar checkout failed")
	}
	var checkout struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(respBody, &checkout); err != nil || checkout.URL == "" {
		return fiber.NewError(fiber.StatusBadGateway, "polar checkout failed")
	}
	s.metrics.inc("billing_checkouts")
	return c.JSON(fiber.Map{"url": checkout.URL})
}

// billingExtendTrial grants one additional trial period.
func (s *Server) billingExtendTrial(c fiber.Ctx) error {
	user, err := s.requireAuth(c)
	if err != nil {
		return err
	}
	ent, err := s.pg.ExtendTrial(c.Context(), user.ID, s.cfg.TrialExtensionDays, s.cfg.TrialExtensions)
	if err != nil {
		if errors.Is(err, pgstore.ErrNotFound) {
			return fiber.NewError(fiber.StatusConflict, "trial cannot be extended")
		}
		return fiber.NewError(fiber.StatusInternalServerError, "extend failed")
	}
	s.entMu.Lock()
	delete(s.entCache, user.ID)
	s.entMu.Unlock()
	s.metrics.inc("trial_extensions")
	return c.JSON(fiber.Map{"entitlement": ent})
}

// billingWebhook receives Polar subscription events. Signature-verified
// via the Standard Webhooks scheme (HMAC-SHA256 over id.timestamp.body).
func (s *Server) billingWebhook(c fiber.Ctx) error {
	if s.cfg.PolarWebhookSecret == "" {
		return fiber.NewError(fiber.StatusServiceUnavailable, "webhook not configured")
	}
	body := c.Body()
	if !verifyWebhookSignature(s.cfg.PolarWebhookSecret,
		c.Get("webhook-id"), c.Get("webhook-timestamp"), c.Get("webhook-signature"), body) {
		return fiber.NewError(fiber.StatusUnauthorized, "bad signature")
	}
	var event struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &event); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid payload")
	}
	if !strings.HasPrefix(event.Type, "subscription.") {
		return c.JSON(fiber.Map{"ok": true, "ignored": event.Type})
	}
	// Decode defensively: current_period_end arrives as an ISO string on
	// current API versions but has been a unix number historically.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(event.Data, &raw); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid subscription")
	}
	getStr := func(k string) string {
		var v string
		_ = json.Unmarshal(raw[k], &v)
		return v
	}
	subID := getStr("id")
	customerID := getStr("customer_id")
	polarStatus := getStr("status")
	var metadata map[string]string
	_ = json.Unmarshal(raw["metadata"], &metadata)
	periodEnd := parsePeriodEnd(raw["current_period_end"])

	userID := metadata["user_id"]
	if userID == "" {
		// Metadata missing — try to recover via an existing row.
		if s.pg != nil {
			uid, err := s.pg.UserIDForPolarSub(c.Context(), subID)
			if err == nil {
				userID = uid
			}
		}
	}
	if userID == "" {
		log.Printf("polar webhook %s: no user_id for sub %s", event.Type, subID)
		return c.JSON(fiber.Map{"ok": true, "unmatched": true})
	}
	status := normalizePolarStatus(event.Type, polarStatus)
	if err := s.pg.UpsertPolarSubscription(c.Context(), userID, subID, customerID, status, periodEnd); err != nil {
		log.Printf("polar upsert %s: %v", userID, err)
		return fiber.NewError(fiber.StatusInternalServerError, "upsert failed")
	}
	s.entMu.Lock()
	delete(s.entCache, userID)
	s.entMu.Unlock()
	s.metrics.inc("billing_webhooks")
	return c.JSON(fiber.Map{"ok": true})
}

func normalizePolarStatus(eventType, polarStatus string) string {
	switch eventType {
	case "subscription.revoked":
		return "canceled"
	case "subscription.canceled":
		return "canceled"
	case "subscription.past_due":
		return "past_due"
	}
	switch polarStatus {
	case "active", "trialing", "past_due", "canceled":
		return polarStatus
	default:
		return "canceled"
	}
}

func parsePeriodEnd(raw json.RawMessage) int64 {
	if len(raw) == 0 {
		return 0
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil && s != "" {
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			return t.Unix()
		}
		return 0
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err == nil {
		// seconds or milliseconds
		if f > 1e12 {
			return int64(f / 1000)
		}
		return int64(f)
	}
	return 0
}

// verifyWebhookSignature implements the Standard Webhooks scheme used by
// Polar: HMAC-SHA256 over "{id}.{timestamp}.{body}" keyed by the base64
// secret after the whsec_ prefix; header carries space-separated v1 sigs.
func verifyWebhookSignature(secret, id, ts, sigHeader string, body []byte) bool {
	if id == "" || ts == "" || sigHeader == "" || secret == "" {
		return false
	}
	tsInt, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || time.Since(time.Unix(tsInt, 0)) > 5*time.Minute ||
		time.Until(time.Unix(tsInt, 0)) > time.Minute {
		return false
	}
	keyB64 := strings.TrimPrefix(secret, "whsec_")
	key, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		// Some providers hand the raw secret without base64 — try raw bytes.
		key = []byte(keyB64)
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(id + "." + ts + "."))
	mac.Write(body)
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	for _, part := range strings.Fields(sigHeader) {
		kv := strings.SplitN(part, ",", 2)
		if len(kv) == 2 && kv[0] == "v1" &&
			subtle.ConstantTimeCompare([]byte(kv[1]), []byte(expected)) == 1 {
			return true
		}
	}
	return false
}
