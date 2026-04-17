package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// lokiSender batches log entries and POSTs them to a Loki push endpoint.
type lokiSender struct {
	endpoint string
	token    string
	labels   map[string]string
	ch       chan lokiEntry
	stop     chan struct{}
	done     chan struct{}
	client   *http.Client
}

type lokiEntry struct {
	ts   int64  // Unix nanoseconds
	line string // JSON-encoded log line
}

func newLokiSender(endpoint, token string, labels map[string]string) *lokiSender {
	s := &lokiSender{
		endpoint: endpoint,
		token:    token,
		labels:   labels,
		ch:       make(chan lokiEntry, 512),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
		client:   &http.Client{Timeout: 10 * time.Second},
	}
	go s.run()
	return s
}

func (s *lokiSender) send(ts time.Time, line string) {
	select {
	case s.ch <- lokiEntry{ts.UnixNano(), line}:
	default: // buffer full — drop rather than block the request path
	}
}

func (s *lokiSender) run() {
	ticker := time.NewTicker(5 * time.Second)
	defer func() {
		ticker.Stop()
		close(s.done)
	}()
	var buf []lokiEntry
	for {
		select {
		case e := <-s.ch:
			buf = append(buf, e)
			if len(buf) >= 100 {
				s.flush(buf)
				buf = buf[:0]
			}
		case <-ticker.C:
			if len(buf) > 0 {
				s.flush(buf)
				buf = buf[:0]
			}
		case <-s.stop:
			// drain remaining entries before exit
			for {
				select {
				case e := <-s.ch:
					buf = append(buf, e)
				default:
					if len(buf) > 0 {
						s.flush(buf)
					}
					return
				}
			}
		}
	}
}

type lokiPushPayload struct {
	Streams []lokiStream `json:"streams"`
}

type lokiStream struct {
	Stream map[string]string `json:"stream"`
	Values [][2]string       `json:"values"`
}

func (s *lokiSender) flush(entries []lokiEntry) {
	values := make([][2]string, len(entries))
	for i, e := range entries {
		values[i] = [2]string{strconv.FormatInt(e.ts, 10), e.line}
	}
	payload := lokiPushPayload{
		Streams: []lokiStream{{
			Stream: s.labels,
			Values: values,
		}},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, s.endpoint, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.token)
	resp, err := s.client.Do(req)
	if err != nil {
		slog.Warn("loki flush failed", "err", err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		slog.Warn("loki flush error", "status", resp.StatusCode)
	}
}

func (s *lokiSender) shutdown(ctx context.Context) {
	close(s.stop)
	select {
	case <-s.done:
	case <-ctx.Done():
	}
}

// lokiHandler is a slog.Handler that forwards records to Loki
// while also delegating to a stderr handler.
type lokiHandler struct {
	sender   *lokiSender
	stderr   slog.Handler
	preAttrs []slog.Attr
}

func newLokiHandler(sender *lokiSender, stderr slog.Handler) *lokiHandler {
	return &lokiHandler{sender: sender, stderr: stderr}
}

func (h *lokiHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.stderr.Enabled(ctx, level)
}

func (h *lokiHandler) Handle(ctx context.Context, r slog.Record) error {
	// Clone the record, merge pre-stored attrs, format as JSON for Loki.
	clone := r.Clone()
	if len(h.preAttrs) > 0 {
		clone.AddAttrs(h.preAttrs...)
	}
	var buf bytes.Buffer
	jh := slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})
	if err := jh.Handle(ctx, clone); err == nil {
		h.sender.send(r.Time, strings.TrimRight(buf.String(), "\n"))
	}
	return h.stderr.Handle(ctx, r)
}

func (h *lokiHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &lokiHandler{
		sender:   h.sender,
		stderr:   h.stderr.WithAttrs(attrs),
		preAttrs: append(slices.Clone(h.preAttrs), attrs...),
	}
}

func (h *lokiHandler) WithGroup(name string) slog.Handler {
	// Group nesting is not forwarded to Loki — attrs remain flat.
	return &lokiHandler{
		sender:   h.sender,
		stderr:   h.stderr.WithGroup(name),
		preAttrs: h.preAttrs,
	}
}
