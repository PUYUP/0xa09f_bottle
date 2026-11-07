# Build stage
FROM golang:1.27-alpine AS builder
ENV GOTOOLCHAIN=auto

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-s -w" \
    -trimpath \
    -o /bin/server \
    ./cmd/server

# Final production stage
FROM alpine:3.20

RUN addgroup -S app && adduser -S app -G app

USER app
WORKDIR /app

COPY --from=builder /bin/server /app/server

EXPOSE 8080

ENTRYPOINT ["/app/server"]

