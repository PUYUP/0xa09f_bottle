package api

import (
	"errors"
	"regexp"
	"strings"
	"time"

	"a09f/bottle/internal/keyauth"
	"a09f/bottle/internal/pgstore"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgconn"
)

var usernameRe = regexp.MustCompile(`^[a-zA-Z0-9_.-]{3,32}$`)

type registerRequest struct {
	Username  string `json:"username"`
	PublicKey string `json:"publicKey"`
	UserID    string `json:"userId"`
	Ts        int64  `json:"ts"`
	Nonce     string `json:"nonce"`
	Proof     string `json:"proof"`
}

type nonceRequest struct {
	UserID string `json:"userId"`
}

var userIDRe = regexp.MustCompile(`^u_[0-9a-f]{32}$`)

// issueNonce hands out a single-use nonce bound to a user id. Issuance is
// unauthenticated on purpose: a nonce alone is useless without the
// proof-of-possession that binds it.
func (s *Server) issueNonce(c fiber.Ctx) error {
	var req nonceRequest
	if err := bindJSON(c, &req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	if !userIDRe.MatchString(req.UserID) {
		return fiber.NewError(fiber.StatusBadRequest, "invalid userId")
	}
	nonce, err := s.store.IssueNonce(c.Context(), req.UserID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "nonce failed")
	}
	return c.JSON(fiber.Map{"nonce": nonce, "expiresIn": 600})
}

// registerUser claims a username for an ECDH identity key. The request must
// carry a proof-of-possession so nobody can register a key they do not own.
// Re-registering an existing user id is idempotent and returns the user.
func (s *Server) registerUser(c fiber.Ctx) error {
	if s.pg == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "auth unavailable")
	}
	var req registerRequest
	if err := bindJSON(c, &req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	req.Username = strings.TrimSpace(req.Username)
	if !usernameRe.MatchString(req.Username) {
		return fiber.NewError(fiber.StatusBadRequest, "username must be 3-32 chars of [a-zA-Z0-9_.-]")
	}
	if len(req.PublicKey) == 0 || len(req.PublicKey) > 8192 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid publicKey")
	}
	userID, err := keyauth.UserID(req.PublicKey)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid publicKey")
	}
	if req.UserID != "" && req.UserID != userID {
		return fiber.NewError(fiber.StatusBadRequest, "userId does not match publicKey")
	}
	priv, err := s.authKey()
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "auth key unavailable")
	}
	ok, err := s.store.ConsumeNonce(c.Context(), req.Nonce, userID)
	if err != nil || !ok {
		return fiber.NewError(fiber.StatusUnauthorized, "invalid or used nonce")
	}
	if !keyauth.VerifyProof(priv, req.PublicKey, userID, req.Ts, req.Nonce, req.Proof, time.Now().Unix()) {
		return fiber.NewError(fiber.StatusUnauthorized, "invalid proof")
	}

	if existing, err := s.pg.GetUserByID(c.Context(), userID); err == nil {
		return c.JSON(fiber.Map{"user": publicUser(existing)})
	}
	if _, err := s.pg.GetUserByUsername(c.Context(), req.Username); err == nil {
		return fiber.NewError(fiber.StatusConflict, "username taken")
	} else if !errors.Is(err, pgstore.ErrNotFound) {
		return fiber.NewError(fiber.StatusInternalServerError, "lookup failed")
	}
	if err := s.pg.CreateUser(c.Context(), userID, req.Username); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return fiber.NewError(fiber.StatusConflict, "username taken")
		}
		return fiber.NewError(fiber.StatusInternalServerError, "create failed")
	}
	if err := s.pg.UpsertUserIdentity(c.Context(), userID, req.PublicKey); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "create failed")
	}
	user, err := s.pg.GetUserByID(c.Context(), userID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "create failed")
	}
	s.metrics.inc("user_registrations")
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"user": publicUser(user)})
}

// serverKey exposes the server's static ECDH public key so clients can
// compute proof-of-possession values. It is public by design.
func (s *Server) serverKey(c fiber.Ctx) error {
	if s.pg == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "auth unavailable")
	}
	id, err := s.store.AuthIdentity(c.Context())
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "auth key unavailable")
	}
	return c.JSON(fiber.Map{"publicKey": id.PublicJWK})
}

func publicUser(u pgstore.User) fiber.Map {
	return fiber.Map{"id": u.ID, "username": u.Username, "createdAt": u.CreatedAt}
}

type changeUsernameRequest struct {
	Username string `json:"username"`
}

// changeUsername renames the authenticated user. PoP headers required;
// server enforces a cooldown between changes.
func (s *Server) changeUsername(c fiber.Ctx) error {
	user, err := s.requireAuth(c)
	if err != nil {
		return err
	}
	var req changeUsernameRequest
	if err := bindJSON(c, &req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	req.Username = strings.TrimSpace(req.Username)
	if !usernameRe.MatchString(req.Username) {
		return fiber.NewError(fiber.StatusBadRequest, "username must be 3-32 chars of [a-zA-Z0-9_.-]")
	}
	if strings.EqualFold(req.Username, user.Username) {
		return c.JSON(fiber.Map{"user": publicUser(user)})
	}
	if err := s.pg.ChangeUsername(c.Context(), user.ID, req.Username); err != nil {
		switch {
		case errors.Is(err, pgstore.ErrTaken):
			return fiber.NewError(fiber.StatusConflict, "username taken")
		case errors.Is(err, pgstore.ErrCooldown):
			return fiber.NewError(fiber.StatusTooManyRequests, "username can be changed once every 7 days")
		case errors.Is(err, pgstore.ErrNotFound):
			return fiber.NewError(fiber.StatusNotFound, "user not found")
		default:
			return fiber.NewError(fiber.StatusInternalServerError, "update failed")
		}
	}
	updated, err := s.pg.GetUserByID(c.Context(), user.ID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "lookup failed")
	}
	return c.JSON(fiber.Map{"user": publicUser(updated)})
}

// listDevices returns the caller's registered client devices. The current
// device is flagged via the X-Device-Id header when present.
func (s *Server) listDevices(c fiber.Ctx) error {
	user, err := s.requireAuth(c)
	if err != nil {
		return err
	}
	devices, err := s.pg.ListDevices(c.Context(), user.ID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "lookup failed")
	}
	current := c.Get("X-Device-Id")
	out := make([]pgstore.Device, 0, len(devices))
	for _, d := range devices {
		d.Current = d.DeviceID == current
		out = append(out, d)
	}
	return c.JSON(fiber.Map{"devices": out})
}

// revokeDevice marks a device as revoked; its next authenticated request
// fails proof-of-possession.
func (s *Server) revokeDevice(c fiber.Ctx) error {
	user, err := s.requireAuth(c)
	if err != nil {
		return err
	}
	deviceID := c.Params("deviceId")
	if len(deviceID) == 0 || len(deviceID) > 128 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid device id")
	}
	if deviceID == c.Get("X-Device-Id") {
		return fiber.NewError(fiber.StatusBadRequest, "cannot revoke the current device")
	}
	if err := s.pg.RevokeDevice(c.Context(), user.ID, deviceID); err != nil {
		if errors.Is(err, pgstore.ErrNotFound) {
			return fiber.NewError(fiber.StatusNotFound, "device not found")
		}
		return fiber.NewError(fiber.StatusInternalServerError, "revoke failed")
	}
	return c.JSON(fiber.Map{"ok": true})
}

// deleteMe permanently removes the authenticated user's account: identity,
// username, key ownership, blocks, reports they filed, and encrypted sync
// records. Encrypted bottles are untouched — the server cannot read them
// anyway, and recipients keep their legitimate copies. Store policy
// (Apple/Google) requires this endpoint for UGC apps.
func (s *Server) deleteMe(c fiber.Ctx) error {
	user, err := s.requireAuth(c)
	if err != nil {
		return err
	}
	if err := s.pg.DeleteUser(c.Context(), user.ID); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "delete failed")
	}
	_ = s.store.PopSetDelete(c.Context(), user.ID)
	s.metrics.inc("account_deletes")
	return c.JSON(fiber.Map{"ok": true})
}

// me returns the authenticated user. Auth = proof-of-possession headers.
func (s *Server) me(c fiber.Ctx) error {
	user, err := s.requireAuth(c)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"user": publicUser(user)})
}

// getUser returns the public profile of any user (id + username only).
func (s *Server) getUser(c fiber.Ctx) error {
	if s.pg == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "auth unavailable")
	}
	id := c.Params("id")
	if len(id) > 64 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid user id")
	}
	user, err := s.pg.GetUserByID(c.Context(), id)
	if errors.Is(err, pgstore.ErrNotFound) {
		return fiber.NewError(fiber.StatusNotFound, "user not found")
	}
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "lookup failed")
	}
	return c.JSON(fiber.Map{"user": publicUser(user)})
}

// getUserByUsername resolves a username to a public profile so clients can
// target block/report actions without knowing the user id.
func (s *Server) getUserByUsername(c fiber.Ctx) error {
	if s.pg == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "auth unavailable")
	}
	name := c.Params("username")
	if len(name) > 64 {
		return fiber.NewError(fiber.StatusBadRequest, "invalid username")
	}
	user, err := s.pg.GetUserByUsername(c.Context(), name)
	if errors.Is(err, pgstore.ErrNotFound) {
		return fiber.NewError(fiber.StatusNotFound, "user not found")
	}
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "lookup failed")
	}
	return c.JSON(fiber.Map{"user": publicUser(user)})
}

type blockRequest struct {
	Reason string `json:"reason"`
}

func (s *Server) blockUser(c fiber.Ctx) error {
	user, err := s.requireAuth(c)
	if err != nil {
		return err
	}
	target := c.Params("id")
	if target == user.ID {
		return fiber.NewError(fiber.StatusBadRequest, "cannot block yourself")
	}
	if _, err := s.pg.GetUserByID(c.Context(), target); errors.Is(err, pgstore.ErrNotFound) {
		return fiber.NewError(fiber.StatusNotFound, "user not found")
	} else if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "lookup failed")
	}
	var req blockRequest
	if len(c.Body()) > 0 {
		if err := bindJSON(c, &req); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "invalid json")
		}
	}
	req.Reason = strings.TrimSpace(req.Reason)
	if len(req.Reason) > 500 {
		return fiber.NewError(fiber.StatusBadRequest, "reason too long")
	}
	if err := s.pg.BlockUser(c.Context(), user.ID, target, req.Reason); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "block failed")
	}
	return c.JSON(fiber.Map{"ok": true})
}

func (s *Server) unblockUser(c fiber.Ctx) error {
	user, err := s.requireAuth(c)
	if err != nil {
		return err
	}
	target := c.Params("id")
	if err := s.pg.UnblockUser(c.Context(), user.ID, target); errors.Is(err, pgstore.ErrNotFound) {
		return fiber.NewError(fiber.StatusNotFound, "not blocked")
	} else if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "unblock failed")
	}
	return c.JSON(fiber.Map{"ok": true})
}

func (s *Server) listBlocks(c fiber.Ctx) error {
	user, err := s.requireAuth(c)
	if err != nil {
		return err
	}
	blocks, err := s.pg.ListBlocks(c.Context(), user.ID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "list failed")
	}
	if blocks == nil {
		blocks = []pgstore.Block{}
	}
	return c.JSON(fiber.Map{"blocks": blocks})
}

type reportRequest struct {
	Reason string `json:"reason"`
}

func (s *Server) reportUser(c fiber.Ctx) error {
	user, err := s.requireAuth(c)
	if err != nil {
		return err
	}
	target := c.Params("id")
	if target == user.ID {
		return fiber.NewError(fiber.StatusBadRequest, "cannot report yourself")
	}
	if _, err := s.pg.GetUserByID(c.Context(), target); errors.Is(err, pgstore.ErrNotFound) {
		return fiber.NewError(fiber.StatusNotFound, "user not found")
	} else if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "lookup failed")
	}
	var req reportRequest
	if err := bindJSON(c, &req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid json")
	}
	req.Reason = strings.TrimSpace(req.Reason)
	if len(req.Reason) > 280 {
		return fiber.NewError(fiber.StatusBadRequest, "reason too long")
	}
	if err := s.pg.ReportUser(c.Context(), user.ID, target, req.Reason); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "report failed")
	}
	s.metrics.inc("user_reports")
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"ok": true})
}
