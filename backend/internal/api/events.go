package api

import (
	"bufio"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"a09f/bottle/internal/store"

	"github.com/gofiber/fiber/v3"
)

// eventSub is one SSE client subscribed to bottle events for a set of
// envelope kids. Kids are public pool identifiers — matching is blind.
type eventSub struct {
	ch   chan string
	kids map[string]struct{}
}

type eventHub struct {
	mu   sync.Mutex
	subs map[*eventSub]struct{}
}

func newEventHub() *eventHub {
	return &eventHub{subs: make(map[*eventSub]struct{})}
}

func (h *eventHub) subscribe(kids map[string]struct{}) *eventSub {
	sub := &eventSub{ch: make(chan string, 16), kids: kids}
	h.mu.Lock()
	h.subs[sub] = struct{}{}
	h.mu.Unlock()
	return sub
}

func (h *eventHub) unsubscribe(sub *eventSub) {
	h.mu.Lock()
	delete(h.subs, sub)
	h.mu.Unlock()
}

// publish notifies subscribers whose kid set intersects the bottle's
// envelope kids. Delivery is best-effort: a slow client simply misses
// events and catches up on the next manual/periodic scan.
func (h *eventHub) publish(bottle store.Bottle) {
	h.publishFlagged(bottle, false)
}

// publishDeleted notifies the same kid-matched subscribers that a bottle
// was tombstoned, so clients can drop their local copy immediately.
func (h *eventHub) publishDeleted(bottle store.Bottle) {
	h.publishFlagged(bottle, true)
}

func (h *eventHub) publishFlagged(bottle store.Bottle, deleted bool) {
	bottleKids := make(map[string]struct{}, len(bottle.Envelopes))
	for _, env := range bottle.Envelopes {
		bottleKids[env.KID] = struct{}{}
	}
	payload, _ := json.Marshal(map[string]any{"id": bottle.ID, "deleted": deleted})
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.subs {
		for kid := range sub.kids {
			if _, ok := bottleKids[kid]; ok {
				select {
				case sub.ch <- string(payload):
				default:
				}
				break
			}
		}
	}
}

// streamEvents serves GET /api/events?token=... as an SSE stream. The pop
// token carries the kid set the client proved possession of; each matching
// new bottle produces `event: bottle` with {"id": ...}.
func (s *Server) streamEvents(c fiber.Ctx) error {
	tokenKids, ok := s.store.PopTokenKids(c.Context(), c.Query("token"))
	if !ok {
		return fiber.NewError(fiber.StatusUnauthorized, "valid pop token required")
	}
	kids := make(map[string]struct{}, len(tokenKids))
	for _, k := range tokenKids {
		kids[k] = struct{}{}
	}
	sub := s.events.subscribe(kids)
	defer s.events.unsubscribe(sub)

	c.Set("Content-Type", "text/event-stream")
	c.Set("Cache-Control", "no-cache")
	c.Set("Connection", "keep-alive")
	c.Set("X-Accel-Buffering", "no")

	return c.SendStreamWriter(func(w *bufio.Writer) {
		fmt.Fprint(w, "retry: 3000\n\n")
		w.Flush()
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-c.Context().Done():
				return
			case data := <-sub.ch:
				fmt.Fprintf(w, "event: bottle\ndata: %s\n\n", data)
				w.Flush()
			case <-ticker.C:
				fmt.Fprint(w, ": ping\n\n")
				w.Flush()
			}
		}
	})
}
