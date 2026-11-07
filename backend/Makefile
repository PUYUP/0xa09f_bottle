.PHONY: dev build test run redis

dev:
	go run ./cmd/server

build:
	go build -o bin/server ./cmd/server

test:
	go test ./...

run: build
	./bin/server

redis:
	redis-server
