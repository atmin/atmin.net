package main

import (
	"log"
	"os"
	"strconv"
)

type Config struct {
	ListenAddr       string
	ServerSecret     []byte
	S3Endpoint       string
	S3PublicEndpoint string
	S3Bucket         string
	S3Region         string
	S3AccessKey      string
	S3SecretKey      string

	// Data-retention cleanup (ADR-0006), used by the `cleanup` subcommand.
	CleanupInactiveDays int
	CleanupBatchSize    int
}

func loadConfig() Config {
	endpoint := envRequired("S3_ENDPOINT")
	cfg := Config{
		ListenAddr:       envOr("LISTEN_ADDR", ":8080"),
		ServerSecret:     []byte(envRequired("SERVER_SECRET")),
		S3Endpoint:       endpoint,
		S3PublicEndpoint: envOr("S3_PUBLIC_ENDPOINT", endpoint),
		S3Bucket:         envRequired("S3_BUCKET"),
		S3Region:         envOr("S3_REGION", "auto"),
		S3AccessKey:      envRequired("S3_ACCESS_KEY"),
		S3SecretKey:      envRequired("S3_SECRET_KEY"),

		CleanupInactiveDays: envIntOr("CLEANUP_INACTIVE_DAYS", 180),
		CleanupBatchSize:    envIntOr("CLEANUP_BATCH_SIZE", 100),
	}
	return cfg
}

func envRequired(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("required environment variable %s is not set", key)
	}
	return v
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envIntOr(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		log.Fatalf("invalid integer for %s: %q", key, v)
	}
	return n
}
