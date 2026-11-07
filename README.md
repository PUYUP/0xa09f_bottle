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
- `GET /api/bottles?limit=50&offset=0` — paginated bottle list (Redis active + Postgres archive merged)
- `POST /api/bottles/:id/pickup` — `{ "kid": "...", "pickupToken": "..." }`
- `GET /api/bottles?limit=50&cursor=<createdAt>_<id>` — cursor-paginated bottle list (Redis active + Postgres archive merged, ordered `createdAt DESC, id DESC`); `offset` still works for backward compatibility. Response includes `nextCursor`.
- `GET /api/pool/kids?limit=20000` — lightweight list of pool key ids + pool size

## Users, block & report (passwordless)

There are **no passwords, logins, or sessions**. A user is an ECDH P-256
identity key; `user.id` is derived deterministically from the public key
(`u_` + first 16 bytes of `SHA-256(x || y)`, hex), so the same key always maps
to the same user.

**Proof-of-possession with one-time nonce** — every authenticated request
carries headers:

```
X-User-Id:    <user id>
X-Auth-Ts:    <unix seconds>
X-Auth-Nonce: <nonce>
X-Auth-Proof: base64( SHA-256( ecdhShared || utf8(userId) || utf8(str(ts)) || utf8(nonce) ) )
```

`ecdhShared` = `ECDH(userPrivateKey, serverPublicKey)` (32 bytes). The server
recomputes `ECDH(serverPrivateKey, userPublicKey)` and compares hashes in
constant time; timestamps older/newer than ±300s are rejected.

Before each authenticated request the client must obtain a nonce:

- `POST /api/auth/nonce` — `{ "userId" }` → `{ "nonce", "expiresIn": 600 }`.
  Unauthenticated by design (a nonce alone proves nothing). The nonce is
  stored in Redis with a 10-minute TTL.
- The server atomically consumes it (`GETDEL`) when verifying the request —
  **each nonce works exactly once**, so a captured proof tuple can never be
  replayed. Register (`POST /api/users`) consumes its nonce the same way via
  a `nonce` field in the JSON body.

The server's static public key is public: `GET /api/auth/server-key`.

Endpoints:

- `POST /api/users` — `{ "username", "publicKey", "userId", "ts", "nonce", "proof" }` → registers/claims a username for an identity key (proof + nonce verified against the submitted key; re-registering the same key is idempotent)
- `GET /api/me` — auth headers → own profile
- `GET /api/users/:id` — public profile `{id, username}`
- `POST /api/users/:id/block` `{ "reason"? }` — auth headers; blocked users' pool keys are **excluded from your `/api/pool/fetch` results** so their keys never receive your bottles
- `DELETE /api/users/:id/block` — remove a block
- `GET /api/me/blocks` — list blocked users
- `POST /api/users/:id/report` `{ "reason" }` — file a report for moderation
- `POST /api/bottles/:id/report` `{ "reason"? }` — report a bottle/message for moderation (UGC compliance); auth optional, anonymous reports stored with empty reporter id. Rate-limited, bottle must exist.
- `GET /api/users/by-username/:username` — resolve username → `{id, username}` for block/report targeting
- `POST /api/pool/deposit` — send the same auth headers to attribute deposited kids to your account (`user_keys` table); anonymous deposits still work
- `POST /api/pool/fetch` — auth headers enable block enforcement; anonymous fetch works but ignores blocks

Postgres tables (auto-migrated): `users` (id + username only — a user may own
many keys), `user_identities` (the single proof-of-possession key per user),
`user_keys` (every pool kid attributed to a user), `blocked_users`,
`reported_users`. Block/report require `DATABASE_URL`; without it those
endpoints return 503 and fetch/deposit simply skip attribution.

## Env

See `.env.example`.

- `ADDR` default `:8080`
- `REDIS_URL` default `redis://localhost:6379/0`
- `DATABASE_URL` optional — any Postgres connection string, including Supabase (`postgres://postgres:<password>@db.<ref>.supabase.co:5432/postgres`). When set, bottles are dual-written to a `bottles` table (auto-migrated on boot) and pickup claims sync deliveries/status back.
- `POOL_TTL_HOURS` default `24`
- `BOTTLE_TTL_HOURS` default `168`
- `MAX_POOL_KEYS`, `MAX_ACTIVE_BOTTLES`

## Notes

- Redis is authoritative for the ephemeral blind pool and active bottles; PostgreSQL archives bottles and stores users/block/report data. Pool keys themselves are never persisted to Postgres.
- The pickup endpoint trusts that a client successfully decrypted before claiming; this is inherent to a blind E2EE relay without a server-visible proof of plaintext.
