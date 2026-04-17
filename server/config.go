package main

import (
	"log"
	"os"
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
	CockpitLokiURL   string // optional; e.g. https://logs.cockpit.fr-par.scw.cloud/loki/api/v1/push
	CockpitToken     string // optional; Scaleway Cockpit token
	AppEnv           string // "prod" or "staging", used as Loki label
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
		CockpitLokiURL:   os.Getenv("COCKPIT_LOKI_URL"),
		CockpitToken:     os.Getenv("COCKPIT_TOKEN"),
		AppEnv:           os.Getenv("APP_ENV"),
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
