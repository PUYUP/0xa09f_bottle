# saltleak (0xa09f/bottle)

Anonymous, asynchronous, end-to-end encrypted "message in a sea" network for software engineers. The server is a blind relay: it never sees plaintext or private keys.

## Repository layout

```
backend/    Go + Fiber API, Redis pool, optional Postgres archive — fully self-contained
            (own Dockerfile, docker-compose, README, .env). See backend/README.md.
frontend/   React + Vite + Tailwind web client — fully self-contained
            (own Dockerfile/nginx, .env.example, README). See frontend/README.md.
backend/web/  Legacy vanilla-JS client, embedded into the Go binary and served at /
            (kept for backwards compatibility; new work goes in frontend/).
```

Frontend and backend are **100% independent**: the React app talks to the API
over HTTP(S) only, with `VITE_API_URL` deciding where. They can be deployed to
separate servers, or run together locally.

## Quick start (local, both)

```sh
# terminal 1 — backend (needs redis; postgres optional)
cd backend
cp .env.example .env
go run ./cmd/server          # or: docker compose up -d --build

# terminal 2 — frontend
cd frontend
npm install
npm run dev                  # http://localhost:5173, /api proxied to :8080
```

Or serve the legacy embedded client directly from the backend at `http://localhost:8080`.

## Deploy separately

- **Backend**: `cd backend && docker compose up -d --build` (or `docker build -t bottle-api .`).
- **Frontend**: `cd frontend && docker build --build-arg VITE_API_URL=https://<api-host> -t saltleak-web .` then run the nginx image, or any static host.
