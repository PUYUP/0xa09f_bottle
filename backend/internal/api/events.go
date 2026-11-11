package api

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
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

func (h *eventHub) subCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
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
	kidList := make([]string, 0, len(bottle.Envelopes))
	for _, env := range bottle.Envelopes {
		bottleKids[env.KID] = struct{}{}
		kidList = append(kidList, env.KID)
	}
	payload, _ := json.Marshal(map[string]any{
		"id":       bottle.ID,
		"deleted":  deleted,
		"parentId": bottle.ParentID,
		"rootId":   bottle.RootID,
	})
	h.mu.Lock()
	defer h.mu.Unlock()
	delivered := 0
	for sub := range h.subs {
		for kid := range sub.kids {
			if _, ok := bottleKids[kid]; ok {
				select {
				case sub.ch <- string(payload):
					delivered++
				default:
				}
				break
			}
		}
	}
	log.Printf("sse publish %s deleted=%v subs=%d delivered=%d kids=%v", bottle.ID, deleted, len(h.subs), delivered, kidList)
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
	log.Printf("sse subscribe kids=%d totalSubs=%d", len(kids), s.events.subCount())

	c.Set("Content-Type", "text/event-stream")
	c.Set("Cache-Control", "no-cache")
	c.Set("Connection", "keep-alive")
	c.Set("X-Accel-Buffering", "no")

	// SendStreamWriter does NOT block: the handler returns as soon as the
	// writer is registered, so an unsubscribe deferred here would drop the
	// subscriber milliseconds after subscribing (the stream itself keeps
	// running inside fasthttp). Unsubscribe inside the writer instead —
	// it runs when the stream actually ends.
	return c.SendStreamWriter(func(w *bufio.Writer) {
		defer s.events.unsubscribe(sub)
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
