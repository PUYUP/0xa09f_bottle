# 0xa09f

Anonymous, asynchronous, end-to-end encrypted "message in a sea" network for software engineers.

The server is a blind relay: it stores opaque ciphertext, blind public keys, delivery counters, and TTLs. It never receives plaintext messages or private keys.

## Stack

- Go + Fiber v3 API
- Redis for the blind key pool and active bottle queue
- Optional PostgreSQL/Supabase archive for bottles (`DATABASE_URL`) — Redis stays the fast path; Postgres keeps every bottle (including `EXHAUSTED`/expired ones) so `GET /api/bottles` can list history beyond the Redis TTL
- Vanilla JS + Web Crypto on the client
- ECDH P-256 ephemeral key wrap + AES-256-GCM payload encryption
- Portable identity vault export/import encrypted with PBKDF2 + AES-GCM

## Run locally

```sh
redis-server
# or: docker compose up -d redis

cp .env.example .env
go run ./cmd/server
```

Open `http://localhost:8080`.

## Client flow

1. `generate + deposit keys` creates local ECDH P-256 keypairs in IndexedDB and deposits only public JWKs into the server's blind pool.
2. `drop bottle` fetches 2 blind public keys, generates an AES-256-GCM session key, encrypts the message locally, wraps the session key once per recipient, and posts ciphertext envelopes.
3. `check bottles` scans active ciphertexts, tries local private keys against envelope key ids, unwraps the session key, decrypts the payload, then posts a pickup claim.
4. A bottle becomes `EXHAUSTED` after `maxDeliveries` distinct key claims and leaves the public list.

## API

- `GET /api/health`
- `POST /api/pool/deposit` — `{ "keys": [{ "kid": "...", "publicKey": "<jwk json>", "ttlSeconds": 86400 }] }` (`ttlSeconds` optional; `0`/omitted uses `POOL_TTL_HOURS`, allowed range `60..2592000`)
- `POST /api/pool/fetch` — `{ "count": 2 }`
- `GET /api/pool/keys?limit=200` — list blind pool keys without consuming them
- `POST /api/bottles` — opaque bottle payload/envelopes
- `GET /api/bottles?limit=50`
- `POST /api/bottles/:id/pickup` — `{ "kid": "..." }`

## Env

See `.env.example`.

- `ADDR` default `:8080`
- `REDIS_URL` default `redis://localhost:6379/0`
- `DATABASE_URL` optional — any Postgres connection string, including Supabase (`postgres://postgres:<password>@db.<ref>.supabase.co:5432/postgres`). When set, bottles are dual-written to a `bottles` table (auto-migrated on boot) and pickup claims sync deliveries/status back.
- `POOL_TTL_HOURS` default `24`
- `BOTTLE_TTL_HOURS` default `168`
- `MAX_POOL_KEYS`, `MAX_ACTIVE_BOTTLES`

## Notes

- Redis is the primary datastore for this MVP. PostgreSQL can be added later for long-term audit/delivery metadata.
- The pickup endpoint trusts that a client successfully decrypted before claiming; this is inherent to a blind E2EE relay without a server-visible proof of plaintext.
