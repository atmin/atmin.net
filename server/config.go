package main

import (
	"log"
	"os"
)

type Config struct {
	ListenAddr   string
	ServerSecret []byte
	S3Endpoint   string
	S3Bucket     string
	S3Region     string
	S3AccessKey  string
	S3SecretKey  string
}

func loadConfig() Config {
	cfg := Config{
		ListenAddr:   envOr("LISTEN_ADDR", ":8080"),
		ServerSecret: []byte(envRequired("SERVER_SECRET")),
		S3Endpoint:   envRequired("S3_ENDPOINT"),
		S3Bucket:     envRequired("S3_BUCKET"),
		S3Region:     envOr("S3_REGION", "auto"),
		S3AccessKey:  envRequired("S3_ACCESS_KEY"),
		S3SecretKey:  envRequired("S3_SECRET_KEY"),
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
