import { API_BASE } from "./api";
import { idbGet, idbPut, META_STORE } from "./idb";
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

export async function authHeaders(): Promise<Record<string, string> | null> {
  const id = await getIdentity();
  if (!id.username || !id.userId) return null;
  const [serverPub, nonce] = await Promise.all([getServerPub(), fetchNonce(id.userId)]);
  const { ts, proof } = await computeProof(id.privateJwk, serverPub, id.userId, nonce);
  return {
    "X-User-Id": id.userId,
    "X-Auth-Ts": String(ts),
    "X-Auth-Nonce": nonce,
    "X-Auth-Proof": proof,
  };
}

export async function claimUsername(username: string): Promise<void> {
  // dynamic import to avoid module cycle at load time
  const { api } = await import("./api");
  const id = await getIdentity();
  const userId = await deriveUserId(id.publicJwk);
  const [serverPub, nonce] = await Promise.all([getServerPub(), fetchNonce(userId)]);
  const { ts, proof } = await computeProof(id.privateJwk, serverPub, userId, nonce);
  await api("/api/users", {
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
  id.username = username;
  id.userId = userId;
  await idbPut(META_STORE, id).catch(() => {});
  identityRecord = id;
}

const RANDOM_NAME_A = ["drifter","nomad","cipher","static","void","paper","salt","ember","foghorn","meridian","packet","quiet","rust","tide","umbra"];
const RANDOM_NAME_B = ["fox","whale","monk","engine","letter","sparrow","vault","signal","anchor","drift","field","harbor","lantern","current","moth"];

export function randomUsername(): string {
  const a = RANDOM_NAME_A[Math.floor(Math.random() * RANDOM_NAME_A.length)];
  const b = RANDOM_NAME_B[Math.floor(Math.random() * RANDOM_NAME_B.length)];
  const n = Math.floor(Math.random() * 900 + 100);
  return `${a}_${b}${n}`;
}
