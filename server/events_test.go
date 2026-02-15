package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestEventHubRegisterAndNotify(t *testing.T) {
	hub := NewEventHub()
	ch := make(chan string, 10)
	hub.Register("alice", ch)

	hub.Notify("alice", "new_message")

	select {
	case event := <-ch:
		if event != "new_message" {
			t.Fatalf("event = %q, want %q", event, "new_message")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for event")
	}
}

func TestEventHubNotifyNoClients(t *testing.T) {
	hub := NewEventHub()
	// Should not panic
	hub.Notify("nobody", "new_message")
}

func TestEventHubMultipleClients(t *testing.T) {
	hub := NewEventHub()
	ch1 := make(chan string, 10)
	ch2 := make(chan string, 10)
	hub.Register("alice", ch1)
	hub.Register("alice", ch2)

	hub.Notify("alice", "new_message")

	for i, ch := range []chan string{ch1, ch2} {
		select {
		case event := <-ch:
			if event != "new_message" {
				t.Fatalf("ch%d: event = %q, want %q", i+1, event, "new_message")
			}
		case <-time.After(time.Second):
			t.Fatalf("ch%d: timed out", i+1)
		}
	}
}

func TestEventHubUnregister(t *testing.T) {
	hub := NewEventHub()
	ch := make(chan string, 10)
	hub.Register("alice", ch)
	hub.Unregister("alice", ch)

	// Channel should be closed
	_, ok := <-ch
	if ok {
		t.Fatal("channel should be closed after unregister")
	}

	// User should be removed from clients map
	hub.mu.RLock()
	_, exists := hub.clients["alice"]
	hub.mu.RUnlock()
	if exists {
		t.Fatal("user should be removed from clients map when last client unregisters")
	}
}

func TestEventHubUnregisterOneOfMany(t *testing.T) {
	hub := NewEventHub()
	ch1 := make(chan string, 10)
	ch2 := make(chan string, 10)
	hub.Register("alice", ch1)
	hub.Register("alice", ch2)

	hub.Unregister("alice", ch1)

	// ch2 should still receive events
	hub.Notify("alice", "new_message")
	select {
	case event := <-ch2:
		if event != "new_message" {
			t.Fatalf("event = %q, want %q", event, "new_message")
		}
	case <-time.After(time.Second):
		t.Fatal("remaining client should still receive events")
	}
}

func TestEventHubSlowClientSkipped(t *testing.T) {
	hub := NewEventHub()
	// Buffer size 1 — will be full after first notify
	slow := make(chan string, 1)
	fast := make(chan string, 10)
	hub.Register("alice", slow)
	hub.Register("alice", fast)

	// Fill slow client's buffer
	hub.Notify("alice", "msg1")
	// This should skip the slow client without blocking
	hub.Notify("alice", "msg2")

	// Fast client got both
	if e := <-fast; e != "msg1" {
		t.Fatalf("fast got %q, want msg1", e)
	}
	if e := <-fast; e != "msg2" {
		t.Fatalf("fast got %q, want msg2", e)
	}

	// Slow client got only the first
	if e := <-slow; e != "msg1" {
		t.Fatalf("slow got %q, want msg1", e)
	}
	select {
	case e := <-slow:
		t.Fatalf("slow should have no more events, got %q", e)
	default:
		// expected
	}
}

// TestHandleEventsSSE tests the full SSE endpoint via HTTP.
func TestHandleEventsSSE(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	// Use a cancellable context so we can stop the SSE stream
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	req := httptest.NewRequest("GET", "/v1/events?token="+alice.Token, nil)
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()

	// Run handler in a goroutine since it blocks until context is cancelled
	done := make(chan struct{})
	go func() {
		mux.ServeHTTP(w, req)
		close(done)
	}()

	// Wait for the response to start streaming
	time.Sleep(50 * time.Millisecond)

	// Cancel context to disconnect
	cancel()
	<-done

	// Verify SSE headers
	if ct := w.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", ct)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("Cache-Control = %q, want no-cache", cc)
	}

	// Verify initial connected event was sent
	body := w.Body.String()
	if !strings.Contains(body, "event: connected") {
		t.Fatalf("body missing 'event: connected'; got: %s", body)
	}
}

// TestHandleEventsReceivesNotification tests that SSE clients receive
// new_message events when messages are sent to them.
func TestHandleEventsReceivesNotification(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	bob := registerTestUser(t, mux, "Bob")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Bob connects to SSE
	req := httptest.NewRequest("GET", "/v1/events?token="+bob.Token, nil)
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		mux.ServeHTTP(w, req)
		close(done)
	}()

	// Wait for SSE connection to establish
	time.Sleep(50 * time.Millisecond)

	// Alice sends a message to Bob
	envelope := map[string]any{
		"v": 1, "to_user": bob.UserID,
		"from_user": alice.UserID, "from_device": alice.DeviceID,
		"msg_id": "msg001", "content_type": "megolm.message",
		"payload": map[string]string{"session_id": "S1", "ciphertext": "dGVzdA"},
	}
	body, _ := json.Marshal(map[string]any{"envelopes": []any{envelope}})
	sendW := httptest.NewRecorder()
	mux.ServeHTTP(sendW, authedRequest(t, "POST", "/v1/send", alice.Token, string(body)))
	if sendW.Code != http.StatusOK {
		t.Fatalf("send status = %d", sendW.Code)
	}

	// Give the SSE handler time to write the event
	time.Sleep(50 * time.Millisecond)
	cancel()
	<-done

	// Parse SSE events from response body
	scanner := bufio.NewScanner(strings.NewReader(w.Body.String()))
	var events []string
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event: ") {
			events = append(events, strings.TrimPrefix(line, "event: "))
		}
	}

	// Should have "connected" and "new_message"
	if len(events) < 2 {
		t.Fatalf("expected at least 2 events, got %d: %v\nbody: %s", len(events), events, w.Body.String())
	}
	if events[0] != "connected" {
		t.Fatalf("first event = %q, want connected", events[0])
	}
	if events[1] != "new_message" {
		t.Fatalf("second event = %q, want new_message", events[1])
	}
}

// TestHandleEventsRequiresAuth tests that the SSE endpoint requires authentication.
func TestHandleEventsRequiresAuth(t *testing.T) {
	_, mux, _ := testServer(t)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/v1/events", nil))

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

// TestHandleEventsTokenInQuery tests that auth works via query parameter.
func TestHandleEventsTokenInQuery(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Auth via query param (no Authorization header)
	req := httptest.NewRequest("GET", "/v1/events?token="+alice.Token, nil)
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		mux.ServeHTTP(w, req)
		close(done)
	}()

	time.Sleep(50 * time.Millisecond)
	cancel()
	<-done

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if !strings.Contains(w.Body.String(), "event: connected") {
		t.Fatalf("missing connected event; body: %s", w.Body.String())
	}
}
