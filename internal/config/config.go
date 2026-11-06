package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	Addr        string
	RedisURL    string
	DatabaseURL string
	PoolTTL     time.Duration
	BottleTTL   time.Duration
	MaxPool     int
	MaxBottles  int
}

func FromEnv() Config {
	return Config{
		Addr:        env("ADDR", ":8080"),
		RedisURL:    env("REDIS_URL", "redis://localhost:6379/0"),
		DatabaseURL: env("DATABASE_URL", ""),
		PoolTTL:     durationHours("POOL_TTL_HOURS", 24),
		BottleTTL:   durationHours("BOTTLE_TTL_HOURS", 24*7),
		MaxPool:     intEnv("MAX_POOL_KEYS", 10000),
		MaxBottles:  intEnv("MAX_ACTIVE_BOTTLES", 500),
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func intEnv(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func durationHours(key string, fallbackHours int) time.Duration {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Hour
		}
	}
	return time.Duration(fallbackHours) * time.Hour
}
