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
	DBMaxConns  int
	DBMinConns  int
	// BottleRetentionDays controls PG archive retention; 0 keeps bottles
	// forever (default — user messages are never auto-deleted).
	BottleRetentionDays int
	// MetricsToken protects GET /api/metrics when set; empty leaves the
	// endpoint open (fine for local dev, set it in production).
	MetricsToken string
	// SentryDSN enables error reporting when set; empty disables it.
	SentryDSN string
}

func FromEnv() Config {
	return Config{
		Addr:                env("ADDR", ":8080"),
		RedisURL:            env("REDIS_URL", "redis://localhost:6379/0"),
		DatabaseURL:         env("DATABASE_URL", ""),
		PoolTTL:             durationHours("POOL_TTL_HOURS", 24),
		BottleTTL:           durationHours("BOTTLE_TTL_HOURS", 24*7),
		MaxPool:             intEnv("MAX_POOL_KEYS", 10000),
		MaxBottles:          intEnv("MAX_ACTIVE_BOTTLES", 500),
		DBMaxConns:          intEnv("DB_MAX_CONNS", 25),
		DBMinConns:          intEnv("DB_MIN_CONNS", 5),
		BottleRetentionDays: intEnv("BOTTLE_RETENTION_DAYS", 0),
		MetricsToken:        os.Getenv("METRICS_TOKEN"),
		SentryDSN:           os.Getenv("SENTRY_DSN"),
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
