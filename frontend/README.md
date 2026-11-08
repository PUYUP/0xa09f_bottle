# a09f frontend

React + Vite + Tailwind CSS client for the anonymous E2EE bottle network.
All cryptography runs in the browser (WebCrypto); the backend is a blind relay.

## Develop

```sh
npm install
npm run dev        # http://localhost:5173, /api proxied to localhost:8080
```

Point the proxy elsewhere with `VITE_API_PROXY=http://host:port npm run dev`.

## Build

```sh
npm run build      # outputs dist/
npm run preview    # serve dist locally
```

## Separate deploy (FE and BE on different servers)

The API base URL is baked at build time:

```sh
# .env.local or build arg
VITE_API_URL=https://api.example.com npm run build
```

or with Docker:

```sh
docker build --build-arg VITE_API_URL=https://api.example.com -t a09f-web .
docker run -p 80:80 a09f-web
```

The backend must allow the frontend origin via CORS (already `*` by default;
see `backend/internal/api/server.go`).

## Structure

- `src/lib/idb.ts` — IndexedDB key/meta storage
- `src/lib/crypto.ts` — ECDH P-256 wrap, AES-256-GCM, pickup proofs
- `src/lib/identity.ts` — identity key, user id, nonce proof-of-possession
- `src/lib/api.ts` — API client with auth headers
- `src/lib/store.ts` — app state + actions (deposit, drop, reply, check, vault)
- `src/components/` — thread view, pool/my-keys/account panels
