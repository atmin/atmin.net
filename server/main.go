package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	stderr := slog.NewTextHandler(os.Stderr, nil)
	slog.SetDefault(slog.New(stderr))

	cfg := loadConfig()

	var loki *lokiSender
	if cfg.CockpitLokiURL != "" && cfg.CockpitToken != "" {
		if cfg.AppEnv == "" {
			slog.Error("APP_ENV must be set when Loki is configured")
			os.Exit(1)
		}
		loki = newLokiSender(cfg.CockpitLokiURL, cfg.CockpitToken, map[string]string{
			"app": "atmin",
			"env": cfg.AppEnv,
		})
		slog.SetDefault(slog.New(newLokiHandler(loki, stderr)))
	}

	s3c, err := NewS3Client(context.Background(), cfg)
	if err != nil {
		slog.Error("failed to create S3 client", "err", err)
		os.Exit(1)
	}

	hub := NewEventHub()
	mux := newMux(s3c, cfg, hub)

	srv := &http.Server{Addr: cfg.ListenAddr, Handler: mux}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	}()

	slog.Info("starting server", "addr", cfg.ListenAddr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server failed", "err", err)
		os.Exit(1)
	}

	if loki != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		loki.shutdown(ctx)
	}
}
