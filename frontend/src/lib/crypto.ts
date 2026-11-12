import { p256 } from "@noble/curves/nist.js";
import { idbPut, META_STORE } from "./idb";
import type { JWK, KeyRecord, Plain } from "./types";
import { b64ToBytes, b64urlToBytes, bytesToB64, randBytes, textBytes } from "./util";

export const WRAP_INFO = "a09f-wrap-v1";
export const REPLY_PREFIX = "reply:";
export const BAIT_PREFIX = "bait:";
export const SELF_PREFIX = "self:";
export const MAX_THREAD_DEPTH = 20;
export const BOTTLE_QUOTA = 5;
export const MAX_LOCAL_KEYS = 5;

export async function makeKeyRecord(): Promise<KeyRecord> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JWK;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JWK;
  return {
    kid: crypto.randomUUID(),
    privateJwk,
    publicJwk,
    createdAt: Date.now(),
    depositedAt: null,
  };
}

export async function storeReplyKey(bottleId: string, pair: KeyRecord): Promise<void> {
  await idbPut(META_STORE, {
    id: `${REPLY_PREFIX}${bottleId}`,
    privateJwk: pair.privateJwk,
    publicJwk: pair.publicJwk,
    createdAt: Date.now(),
  });
}

const REPLY_INFO = "a09f-reply-v1";
const BAIT_INFO = "a09f-bait-v1";

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// deriveScalarKeyPair deterministically derives a P-256 keypair from the
// identity private key: HKDF-SHA256(d || salt, info:counter) -> scalar
// (rejection-sampled). Shared by reply and bait keys — neither needs
// per-message key storage; the private half is recomputed on demand.
async function deriveScalarKeyPair(
  identityPrivateJwk: JWK,
  salt: string,
  infoPrefix: string
): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const dBytes = b64urlToBytes(identityPrivateJwk.d || "");
  const hkdf = await crypto.subtle.importKey("raw", dBytes, "HKDF", false, ["deriveBits"]);
  const saltBytes = textBytes(salt);
  let counter = 0;
  let priv: Uint8Array<ArrayBuffer>;
  for (;;) {
    const info = textBytes(`${infoPrefix}:${counter}`);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: saltBytes, info },
      hkdf,
      256
    );
    priv = new Uint8Array(bits);
    if (p256.utils.isValidSecretKey(priv)) break;
    counter++;
  }
  const pub = p256.getPublicKey(priv, false); // 0x04 || x(32) || y(32)
  const publicJwk: JWK = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
  };
  const privateJwk: JWK = { ...publicJwk, d: b64urlEncode(priv) };
  return { privateJwk, publicJwk };
}

// deriveReplyKeyPair derives the reply keypair for a bottle from the
// identity private key: HKDF-SHA256(d || bottleId, "a09f-reply-v1").
export async function deriveReplyKeyPair(
  identityPrivateJwk: JWK,
  bottleId: string
): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  return deriveScalarKeyPair(identityPrivateJwk, bottleId, REPLY_INFO);
}

// deriveBaitKeyPair derives the bait keypair for a pool slot from the
// identity private key: HKDF-SHA256(d || "a09f-bait", "a09f-bait-v1:<seq>").
// Bait pubkeys are therefore re-derivable from the identity alone — the
// vault only needs to carry {kid, seq} metadata, never the private half.
export async function deriveBaitKeyPair(
  identityPrivateJwk: JWK,
  seq: number
): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  return deriveScalarKeyPair(identityPrivateJwk, "a09f-bait", `${BAIT_INFO}:${seq}`);
}

export async function deriveWrapKey(
  bottleId: string,
  sharedBits: ArrayBuffer,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  const hkdf = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: textBytes(bottleId),
      info: textBytes(WRAP_INFO),
    },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

export function importECDHPublic(jwk: JWK): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
}

export function importECDHPrivate(jwk: JWK): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
}

// derivePickupProof binds the pickup proof to (sessionKey, bottleId, kid).
// kid may be omitted to reproduce the legacy v1 proof for bottles created
// before kid-binding existed.
export async function derivePickupProof(
  rawSessionKey: ArrayBuffer,
  bottleId: string,
  kid = ""
): Promise<{ token: string; hash: string }> {
  const keyBytes = new Uint8Array(rawSessionKey);
  const bottleBytes = textBytes(bottleId);
  const kidBytes = textBytes(kid);
  const tagBytes = textBytes(kid ? "a09f-pickup-v2" : "a09f-pickup-v1");
  const combined = new Uint8Array(
    keyBytes.length + bottleBytes.length + kidBytes.length + tagBytes.length
  );
  combined.set(keyBytes, 0);
  combined.set(bottleBytes, keyBytes.length);
  combined.set(kidBytes, keyBytes.length + bottleBytes.length);
  combined.set(tagBytes, keyBytes.length + bottleBytes.length + kidBytes.length);
  const tokenBuf = await crypto.subtle.digest("SHA-256", combined);
  const token = bytesToB64(new Uint8Array(tokenBuf));
  const hashBuf = await crypto.subtle.digest("SHA-256", textBytes(token));
  const hash = bytesToB64(new Uint8Array(hashBuf));
  return { token, hash };
}

export async function wrapSessionKey(
  bottleId: string,
  recipientPublicKeyJwk: JWK,
  rawSessionKey: ArrayBuffer,
  kid: string
) {
  const authorPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const recipientPub = await importECDHPublic(recipientPublicKeyJwk);
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: recipientPub },
    authorPair.privateKey,
    256
  );
  const wrapKey = await deriveWrapKey(bottleId, bits, ["encrypt"]);
  const iv = randBytes(12);
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, rawSessionKey);
  const authorPublicJwk = (await crypto.subtle.exportKey("jwk", authorPair.publicKey)) as JWK;
  const { hash: pickupHash } = await derivePickupProof(rawSessionKey, bottleId, kid);
  return {
    kid: null as string | null,
    authorPublicKey: JSON.stringify(authorPublicJwk),
    recipientPublicKey: JSON.stringify(recipientPublicKeyJwk),
    wrapIv: bytesToB64(iv),
    wrappedKey: bytesToB64(new Uint8Array(wrapped)),
    pickupHash,
  };
}

export function encodePlaintext(text: string, replyJwk: JWK | null): string {
  return JSON.stringify({ v: 1, text, reply: replyJwk || null });
}

export function decodePlaintext(raw: string): Plain {
  try {
    const obj = JSON.parse(raw) as Plain;
    if (obj && obj.v === 1 && typeof obj.text === "string") return obj;
  } catch {
    // legacy plaintext
  }
  return { v: 0, text: raw, reply: null };
}

export async function unwrapSessionKey(
  bottleId: string,
  envelope: { authorPublicKey: string; wrapIv: string; wrappedKey: string },
  privateJwk: JWK
): Promise<ArrayBuffer> {
  const privateKey = await importECDHPrivate(privateJwk);
  const authorPublicJwk = JSON.parse(envelope.authorPublicKey) as JWK;
  const authorPublic = await importECDHPublic(authorPublicJwk);
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: authorPublic },
    privateKey,
    256
  );
  const wrapKey = await deriveWrapKey(bottleId, bits, ["decrypt"]);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(envelope.wrapIv) },
    wrapKey,
    b64ToBytes(envelope.wrappedKey)
  );
}

// ---------- encrypted sync state ----------
// readAt/dismissedAt sync across devices as per-record AES-GCM blobs keyed
// by the identity private key. The server stores ciphertext it cannot read;
// record keys are salted hashes so it cannot tell which fields exist either.

const SYNC_INFO = "a09f-sync-v1";

async function deriveSyncKey(identityPrivateJwk: JWK): Promise<CryptoKey> {
  const dBytes = b64urlToBytes(identityPrivateJwk.d || "");
  const hkdf = await crypto.subtle.importKey("raw", dBytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: textBytes("a09f"), info: textBytes(SYNC_INFO) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function packSyncBlob(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = randBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textBytes(plaintext));
  const raw = new Uint8Array(iv.length + ct.byteLength);
  raw.set(iv, 0);
  raw.set(new Uint8Array(ct), iv.length);
  return bytesToB64(raw);
}

async function unpackSyncBlob(key: CryptoKey, blob: string): Promise<string | null> {
  try {
    const raw = b64ToBytes(blob);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.slice(0, 12) },
      key,
      raw.slice(12)
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export interface SyncRecordPlain {
  k: string; // field key: "<metaRecordId>" for reads, "bait:<kid>" for dismissals
  t: number; // unix ms
}

// syncRecordKey hashes (userId, fieldKey) into the opaque storage key —
// deterministic so the server can upsert/dedupe without learning the field.
export async function syncRecordKey(userId: string, fieldKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textBytes(`a09f-syncrec-v1:${userId}:${fieldKey}`)
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function encryptSyncRecord(
  identityPrivateJwk: JWK,
  fieldKey: string,
  ts: number
): Promise<string> {
  const key = await deriveSyncKey(identityPrivateJwk);
  return packSyncBlob(key, JSON.stringify({ v: 1, k: fieldKey, t: ts }));
}

export async function decryptSyncRecord(
  identityPrivateJwk: JWK,
  blob: string
): Promise<SyncRecordPlain | null> {
  const key = await deriveSyncKey(identityPrivateJwk);
  const pt = await unpackSyncBlob(key, blob);
  if (!pt) return null;
  try {
    const obj = JSON.parse(pt) as SyncRecordPlain & { v?: number };
    if (obj?.v !== 1 || typeof obj.k !== "string" || typeof obj.t !== "number") return null;
    return { k: obj.k, t: obj.t };
  } catch {
    return null;
  }
}

export async function decryptPayload(
  bottle: { id: string; payloadIv?: string; ciphertext?: string },
  rawSessionKey: ArrayBuffer
): Promise<string> {
  const sessionKey = await crypto.subtle.importKey(
    "raw",
    rawSessionKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(bottle.payloadIv!) },
    sessionKey,
    b64ToBytes(bottle.ciphertext!)
  );
  return new TextDecoder().decode(plain);
}
