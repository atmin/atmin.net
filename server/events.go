package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// EventHub manages Server-Sent Events connections for real-time notifications.
// Multiple clients (devices) for the same user can connect simultaneously.
type EventHub struct {
	clients map[string][]chan string
	mu      sync.RWMutex
}

func NewEventHub() *EventHub {
	return &EventHub{
		clients: make(map[string][]chan string),
	}
}

// Register adds a new SSE client channel for the given user.
func (h *EventHub) Register(userID string, ch chan string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[userID] = append(h.clients[userID], ch)
}

// Unregister removes and closes a client channel.
func (h *EventHub) Unregister(userID string, ch chan string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	clients := h.clients[userID]
	for i, c := range clients {
		if c == ch {
			h.clients[userID] = append(clients[:i], clients[i+1:]...)
			close(ch)
			break
		}
	}
	if len(h.clients[userID]) == 0 {
		delete(h.clients, userID)
	}
}

// Notify sends an event to all connected clients for the given user.
// Non-blocking: slow clients are skipped.
func (h *EventHub) Notify(userID string, event string) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, ch := range h.clients[userID] {
		select {
		case ch <- event:
		default:
			// Don't block if client buffer is full
		}
	}
}

// GET /v1/events - Server-Sent Events stream for real-time notifications
func handleEvents(store Store, hub *EventHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := userIDFrom(r.Context())

		// Set SSE headers
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no") // Disable nginx buffering

		// Create channel for this client (buffered to avoid blocking)
		messages := make(chan string, 10)
		hub.Register(userID, messages)
		defer hub.Unregister(userID, messages)

		// Update last_active in a background goroutine (detached context)
		go updateLastActive(store, userID)

		// Send initial connection event
		fmt.Fprintf(w, "event: connected\ndata: {}\n\n")
		w.(http.Flusher).Flush()

		// Send keepalive comments every 30s to prevent timeout
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-r.Context().Done():
				// Client disconnected
				return
			case <-ticker.C:
				// Send keepalive comment (lines starting with : are ignored by EventSource)
				fmt.Fprintf(w, ":\n\n")
				w.(http.Flusher).Flush()
			case event := <-messages:
				// Send actual event
				fmt.Fprintf(w, "event: %s\ndata: {}\n\n", event)
				w.(http.Flusher).Flush()
			}
		}
	}
}

// updateLastActive sets last_active on the user's profile, skipping if
// the existing value is less than 1 hour old.
func updateLastActive(store Store, userID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	key := "users/" + userID + "/profile.json"
	data, err := store.GetObject(ctx, key)
	if err != nil {
		return
	}

	var profile map[string]string
	if err := json.Unmarshal(data, &profile); err != nil {
		return
	}

	// Skip if last_active is less than 1 hour old
	if la, ok := profile["last_active"]; ok {
		if t, err := time.Parse(time.RFC3339, la); err == nil {
			if time.Since(t) < time.Hour {
				return
			}
		}
	}

	profile["last_active"] = time.Now().UTC().Format(time.RFC3339)
	updated, _ := json.Marshal(profile)
	store.PutObject(ctx, key, updated, "application/json")
}
