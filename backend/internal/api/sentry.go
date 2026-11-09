package api

import (
	"errors"
	"fmt"
	"runtime/debug"

	"github.com/getsentry/sentry-go"
	"github.com/gofiber/fiber/v3"
)

// sentryRecovery captures panics per request and reports them to Sentry.
// No-op when SENTRY_DSN is unset (sentry-go stays uninitialized).
func sentryRecovery() fiber.Handler {
	return func(c fiber.Ctx) error {
		defer func() {
			if r := recover(); r != nil {
				var err error
				if e, ok := r.(error); ok {
					err = e
				} else {
					err = errors.New(fmt.Sprint(r))
				}
				hub := sentry.CurrentHub().Clone()
				hub.WithScope(func(scope *sentry.Scope) {
					scope.SetTag("panic", "true")
					scope.SetTag("path", c.Path())
					scope.SetContext("stack", map[string]any{"trace": string(debug.Stack())})
					hub.CaptureException(err)
				})
				_ = c.Status(fiber.StatusInternalServerError).SendString("internal error")
			}
		}()
		return c.Next()
	}
}
