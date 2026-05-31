package main

import (
	"context"
	"flag"
	"log/slog"
	"net/http"
	"os"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	cfg := loadConfig()

	// Subcommand dispatch. The same image runs either the HTTP server (default)
	// or a one-shot maintenance task. `cleanup` is invoked by a scheduled
	// Scaleway Serverless Job (ADR-0006, docs/ops.md), not in-process.
	if len(os.Args) > 1 && os.Args[1] == "cleanup" {
		runCleanupCmd(cfg, os.Args[2:])
		return
	}

	runServer(cfg)
}

func runServer(cfg Config) {
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

func runCleanupCmd(cfg Config, args []string) {
	fs := flag.NewFlagSet("cleanup", flag.ExitOnError)
	apply := fs.Bool("apply", false, "actually delete (default: dry-run)")
	_ = fs.Parse(args)

	s3c, err := NewS3Client(context.Background(), cfg)
	if err != nil {
		slog.Error("failed to create S3 client", "err", err)
		os.Exit(1)
	}

	res, err := runCleanup(context.Background(), s3c, CleanupOpts{
		InactiveDays: cfg.CleanupInactiveDays,
		BatchSize:    cfg.CleanupBatchSize,
		DryRun:       !*apply,
	})
	if err != nil {
		slog.Error("cleanup failed", "err", err)
		os.Exit(1)
	}
	slog.Info("cleanup done",
		"scanned", res.HandlesScanned, "abandoned", res.Abandoned,
		"inactive", res.Inactive, "tombstones", res.Tombstones,
		"deleted", res.Deleted, "errors", res.Errors, "dry_run", !*apply)
}
