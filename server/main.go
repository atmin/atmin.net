package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	cfg := loadConfig()

	s3c, err := NewS3Client(context.Background(), cfg)
	if err != nil {
		slog.Error("failed to create S3 client", "err", err)
		os.Exit(1)
	}

	hub := NewEventHub()

	mux := newMux(s3c, cfg, hub)

	slog.Info("starting server", "addr", cfg.ListenAddr)
	if err := http.ListenAndServe(cfg.ListenAddr, mux); err != nil {
		slog.Error("server failed", "err", err)
		os.Exit(1)
	}
}
