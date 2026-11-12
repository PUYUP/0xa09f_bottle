import { API_BASE } from "./api";
import { idbGet, idbPut, KV_STORE, META_STORE } from "./idb";
import type { IdentityRecord, JWK } from "./types";
import { b64urlToBytes, bytesToB64 } from "./util";

const IDENTITY_META_ID = "identity";

let identityRecord: IdentityRecord | null = null;
let serverPubKey: CryptoKey | null = null;
let serverPubPromise: Promise<CryptoKey> | null = null;

export function getIdentityRecord(): IdentityRecord | null {
  return identityRecord;
}

export async function getIdentity(): Promise<IdentityRecord> {
  if (identityRecord) return identityRecord;
  identityRecord = ((await idbGet<IdentityRecord>(META_STORE, IDENTITY_META_ID).catch(() => null)) || null) as IdentityRecord | null;
  if (!identityRecord?.privateJwk) {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JWK;
    const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JWK;
    identityRecord = { id: IDENTITY_META_ID, privateJwk, publicJwk };
    await idbPut(META_STORE, identityRecord).catch(() => {});
  }
  return identityRecord;
}

export function resetIdentityCache(): void {
  identityRecord = null;
}

export async function deriveUserId(publicJwk: JWK): Promise<string> {
  const x = b64urlToBytes(publicJwk.x);
  const y = b64urlToBytes(publicJwk.y);
  const cat = new Uint8Array(x.length + y.length);
  cat.set(x);
  cat.set(y, x.length);
  const digest = await crypto.subtle.digest("SHA-256", cat);
  return (
    "u_" +
    [...new Uint8Array(digest).slice(0, 16)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

export async function getServerPub(): Promise<CryptoKey> {
  if (serverPubKey) return serverPubKey;
  serverPubPromise ??= (async () => {
    // raw fetch: api() itself needs authHeaders -> getServerPub
    const res = await fetch(`${API_BASE}/api/auth/server-key`);
    const { publicKey } = (await res.json()) as { publicKey: string };
    serverPubKey = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(publicKey),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );
    return serverPubKey;
  })();
  return serverPubPromise;
}

export async function fetchNonce(userId: string): Promise<string> {
  // raw fetch: api() itself needs authHeaders -> fetchNonce
  const res = await fetch(`${API_BASE}/api/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  const data = (await res.json()) as { nonce?: string; error?: string };
  if (!res.ok) throw new Error(data?.error || `http ${res.status}`);
  return data.nonce as string;
}

export async function computeProof(
  privateJwk: JWK,
  serverPub: CryptoKey,
  userId: string,
  nonce: string
): Promise<{ ts: number; nonce: string; proof: string }> {
  const priv = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: serverPub }, priv, 256);
  const ts = Math.floor(Date.now() / 1000);
  const uid = new TextEncoder().encode(userId);
  const tsBytes = new TextEncoder().encode(String(ts));
  const nonceBytes = new TextEncoder().encode(nonce);
  const shared = new Uint8Array(bits);
  const buf = new Uint8Array(shared.length + uid.length + tsBytes.length + nonceBytes.length);
  buf.set(shared);
  buf.set(uid, shared.length);
  buf.set(tsBytes, shared.length + uid.length);
  buf.set(nonceBytes, shared.length + uid.length + tsBytes.length);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return { ts, nonce, proof: bytesToB64(new Uint8Array(digest)) };
}

// kidProofDigest hashes a precomputed ECDH shared secret into the PoP proof
// payload. The shared secret is time-invariant per (kid, server) pair, so
// callers may cache it and only recompute this cheap hash per request.
export async function kidProofDigest(
  shared: ArrayBuffer,
  kid: string,
  ts: number
): Promise<string> {
  const kidBytes = new TextEncoder().encode(kid);
  const tagBytes = new TextEncoder().encode("a09f-pop-v1");
  const tsBytes = new TextEncoder().encode(String(ts));
  const sharedBytes = new Uint8Array(shared);
  const buf = new Uint8Array(sharedBytes.length + tagBytes.length + kidBytes.length + tsBytes.length);
  buf.set(sharedBytes, 0);
  buf.set(tagBytes, sharedBytes.length);
  buf.set(kidBytes, sharedBytes.length + tagBytes.length);
  buf.set(tsBytes, sharedBytes.length + tagBytes.length + kidBytes.length);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return bytesToB64(new Uint8Array(digest));
}

// computeKidProof produces the proof-of-possession digest for an envelope
// kid: {ts, base64(SHA-256(ecdhShared || "a09f-pop-v1" || kid || ts))} where
// ecdhShared = ECDH(kidPrivateKey, serverPub). Must match keyauth.PoPHash.
export async function computeKidProof(
  privateJwk: JWK,
  serverPub: CryptoKey,
  kid: string
): Promise<{ ts: number; proof: string }> {
  const priv = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: serverPub }, priv, 256);
  const ts = Math.floor(Date.now() / 1000);
  return { ts, proof: await kidProofDigest(bits, kid, ts) };
}

let deviceIdCache: string | null = null;

// getDeviceId returns a stable per-install identifier sent as X-Device-Id
// on authenticated requests. The server uses it for the device list and
// session revocation; it is not a secret and reveals nothing beyond "this
// install".
export async function getDeviceId(): Promise<string> {
  if (deviceIdCache) return deviceIdCache;
  const rec = await idbGet<{ v?: string }>(KV_STORE, "device:id").catch(() => null);
  if (rec?.v) {
    deviceIdCache = rec.v;
    return rec.v;
  }
  const id = crypto.randomUUID();
  await idbPut(KV_STORE, { id: "device:id", v: id }).catch(() => {});
  deviceIdCache = id;
  return id;
}

export async function authHeaders(): Promise<Record<string, string> | null> {
  const id = await getIdentity();
  if (!id.username || !id.userId) return null;
  const [serverPub, nonce, deviceId] = await Promise.all([getServerPub(), fetchNonce(id.userId), getDeviceId()]);
  const { ts, proof } = await computeProof(id.privateJwk, serverPub, id.userId, nonce);
  return {
    "X-User-Id": id.userId,
    "X-Auth-Ts": String(ts),
    "X-Auth-Nonce": nonce,
    "X-Auth-Proof": proof,
    "X-Device-Id": deviceId,
  };
}

export async function claimUsername(username: string): Promise<void> {
  // dynamic import to avoid module cycle at load time
  const { api } = await import("./api");
  const id = await getIdentity();
  const userId = await deriveUserId(id.publicJwk);
  const [serverPub, nonce] = await Promise.all([getServerPub(), fetchNonce(userId)]);
  const { ts, proof } = await computeProof(id.privateJwk, serverPub, userId, nonce);
  const res = await api<{ user?: { username?: string } }>("/api/users", {
    method: "POST",
    body: JSON.stringify({
      username,
      publicKey: JSON.stringify(id.publicJwk),
      userId,
      ts,
      nonce,
      proof,
    }),
  });
  // The server is authoritative: re-claiming an existing identity returns
  // the stored profile and ignores the requested username, so take the
  // canonical name from the response (or /api/me as fallback).
  let canonical = res?.user?.username || username;
  try {
    const { user } = await api<{ user?: { username?: string } }>("/api/me");
    if (user?.username) canonical = user.username;
  } catch {
    // keep response value
  }
  id.username = canonical;
  id.userId = userId;
  await idbPut(META_STORE, id).catch(() => {});
  identityRecord = id;
}

const RANDOM_NAME_A = ["drifter","nomad","cipher","static","deep","paper","salt","ember","foghorn","meridian","packet","quiet","rust","tide","brine"];
const RANDOM_NAME_B = ["fox","whale","monk","engine","letter","sparrow","vault","signal","anchor","drift","field","harbor","lantern","current","moth"];

export function randomUsername(): string {
  const a = RANDOM_NAME_A[Math.floor(Math.random() * RANDOM_NAME_A.length)];
  const b = RANDOM_NAME_B[Math.floor(Math.random() * RANDOM_NAME_B.length)];
  const n = Math.floor(Math.random() * 900 + 100);
  return `${a}_${b}${n}`;
}
