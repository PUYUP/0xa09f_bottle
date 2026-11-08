import { p256 } from "@noble/curves/nist.js";
import { idbPut, META_STORE } from "./idb";
import type { JWK, KeyRecord, Plain } from "./types";
import { b64ToBytes, b64urlToBytes, bytesToB64, randBytes, textBytes } from "./util";

export const WRAP_INFO = "a09f-wrap-v1";
export const REPLY_PREFIX = "reply:";
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

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// deriveReplyKeyPair deterministically derives the reply keypair for a bottle
// from the identity private key: HKDF-SHA256(d || bottleId, "a09f-reply-v1")
// -> P-256 scalar (rejection-sampled). No per-message key storage needed —
// the private key is recomputed on demand from the master identity key.
export async function deriveReplyKeyPair(
  identityPrivateJwk: JWK,
  bottleId: string
): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const dBytes = b64urlToBytes(identityPrivateJwk.d || "");
  const hkdf = await crypto.subtle.importKey("raw", dBytes, "HKDF", false, ["deriveBits"]);
  const salt = textBytes(bottleId);
  let counter = 0;
  let priv: Uint8Array<ArrayBuffer>;
  for (;;) {
    const info = textBytes(`${REPLY_INFO}:${counter}`);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
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
// readAt/dismissedAt sync across devices as an opaque AES-GCM blob keyed by
// the identity private key. The server stores ciphertext it cannot read.

const SYNC_INFO = "a09f-sync-v1";

export interface SyncPayload {
  v: number;
  readAt: Record<string, number>; // meta record id -> unix ms
  dismissed: Record<string, number>; // bait kid -> unix ms
}

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

export async function encryptSyncState(payload: SyncPayload, identityPrivateJwk: JWK): Promise<string> {
  const key = await deriveSyncKey(identityPrivateJwk);
  const iv = randBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textBytes(JSON.stringify(payload))
  );
  const raw = new Uint8Array(iv.length + ct.byteLength);
  raw.set(iv, 0);
  raw.set(new Uint8Array(ct), iv.length);
  return bytesToB64(raw);
}

export async function decryptSyncState(blob: string, identityPrivateJwk: JWK): Promise<SyncPayload | null> {
  try {
    const key = await deriveSyncKey(identityPrivateJwk);
    const raw = b64ToBytes(blob);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.slice(0, 12) },
      key,
      raw.slice(12)
    );
    const obj = JSON.parse(new TextDecoder().decode(pt)) as SyncPayload;
    if (obj?.v !== 1) return null;
    return obj;
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
