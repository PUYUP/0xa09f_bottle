const DB_NAME = "a09f";
const DB_VERSION = 1;
const KEY_STORE = "keys";
const META_STORE = "meta";
const WRAP_INFO = "a09f-wrap-v1";
const enc = new TextEncoder();
const dec = new TextDecoder();

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const inboxEl = $("inbox");
const statusEl = $("status");
const messageEl = $("message");
const ttlInputEl = $("key-ttl");
const ttlDescEl = $("key-ttl-desc");

let db;
let keyRecords = [];
let keyByKid = new Map();
let activePoolKeys = null;
let ownPoolKids = new Set();
const BOTTLE_QUOTA = 5;
const MAX_LOCAL_KEYS = 5;
const caughtThisSession = new Set();

function log(msg, cls = "") {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

async function api(path, options = {}) {
  const auth = options.auth === false ? null : await authHeaders().catch(() => null);
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(auth || {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!res.ok) {
    const err = new Error(data?.error || data?.raw || `http ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(KEY_STORE)) d.createObjectStore(KEY_STORE, { keyPath: "kid" });
      if (!d.objectStoreNames.contains(META_STORE)) d.createObjectStore(META_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => {
        d.close();
        if (db === d) db = null;
      };
      d.onclose = () => {
        if (db === d) db = null;
      };
      resolve(d);
    };
    req.onerror = () => reject(req.error);
  });
}

async function ensureDB() {
  if (!db) db = await openDB();
  return db;
}

async function idbGetAll(storeName) {
  const d = await ensureDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, "readonly");
    const req = t.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(storeName, key) {
  const d = await ensureDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, "readonly");
    const req = t.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(storeName, key) {
  const d = await ensureDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, "readwrite");
    const req = t.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    t.onabort = () => reject(t.error);
  });
}

async function idbPut(storeName, value, key) {
  const d = await ensureDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, "readwrite");
    const s = t.objectStore(storeName);
    let result;
    const req = key === undefined ? s.put(value) : s.put(value, key);
    req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function bytesToB64(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return b64ToBytes(s);
}

// ---- passwordless identity & proof-of-possession auth ----
// A user is an ECDH P-256 identity key stored in IndexedDB meta. Requests
// carry X-User-Id / X-Auth-Ts / X-Auth-Proof headers; the proof is
// SHA-256( ECDH(identityPriv, serverPub) || userId || ts ).

const IDENTITY_META_ID = "identity";
let identityRecord = null;
let serverPubKey = null;
let serverPubPromise = null;

async function getIdentity() {
  if (identityRecord) return identityRecord;
  identityRecord = (await idbGet(META_STORE, IDENTITY_META_ID).catch(() => null)) || null;
  if (!identityRecord?.privateJwk) {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    identityRecord = { id: IDENTITY_META_ID, privateJwk, publicJwk };
    await idbPut(META_STORE, identityRecord).catch(() => {});
  }
  return identityRecord;
}

async function deriveUserId(publicJwk) {
  const x = b64urlToBytes(publicJwk.x);
  const y = b64urlToBytes(publicJwk.y);
  const cat = new Uint8Array(x.length + y.length);
  cat.set(x);
  cat.set(y, x.length);
  const digest = await crypto.subtle.digest("SHA-256", cat);
  return "u_" + [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getServerPub() {
  if (serverPubKey) return serverPubKey;
  serverPubPromise ??= (async () => {
    // raw fetch: api() itself needs authHeaders -> getServerPub
    const res = await fetch("/api/auth/server-key");
    const { publicKey } = await res.json();
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

async function fetchNonce(userId) {
  // raw fetch: api() itself needs authHeaders -> fetchNonce
  const res = await fetch("/api/auth/nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `http ${res.status}`);
  return data.nonce;
}

async function computeProof(privateJwk, serverPub, userId, nonce) {
  const priv = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: serverPub }, priv, 256);
  const ts = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const uid = enc.encode(userId);
  const tsBytes = enc.encode(String(ts));
  const nonceBytes = enc.encode(nonce);
  const shared = new Uint8Array(bits);
  const buf = new Uint8Array(shared.length + uid.length + tsBytes.length + nonceBytes.length);
  buf.set(shared);
  buf.set(uid, shared.length);
  buf.set(tsBytes, shared.length + uid.length);
  buf.set(nonceBytes, shared.length + uid.length + tsBytes.length);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return { ts, nonce, proof: bytesToB64(new Uint8Array(digest)) };
}

async function authHeaders() {
  const id = await getIdentity();
  if (!id.username || !id.userId) return null;
  const [serverPub, nonce] = await Promise.all([
    getServerPub(),
    fetchNonce(id.userId),
  ]);
  const { ts, proof } = await computeProof(id.privateJwk, serverPub, id.userId, nonce);
  return {
    "X-User-Id": id.userId,
    "X-Auth-Ts": String(ts),
    "X-Auth-Nonce": nonce,
    "X-Auth-Proof": proof,
  };
}

async function claimUsername(username) {
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

function randBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function makeKeyRecord() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid: crypto.randomUUID(),
    privateJwk,
    publicJwk,
    createdAt: Date.now(),
    depositedAt: null,
  };
}

async function loadKeys() {
  keyRecords = await idbGetAll(KEY_STORE);
  keyRecords.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  keyByKid = new Map(keyRecords.map((k) => [k.kid, k]));
  renderStatus();
  await refreshActivePoolKeys();
}

async function refreshActivePoolKeys() {
  activePoolKeys = await ownKeysInPool();
  const el = $("dep-count");
  if (el) el.textContent = `in pool ${activePoolKeys}`;
}

function renderStatus() {
  const total = keyRecords.length;
  const capLabel = Number.isFinite(MAX_LOCAL_KEYS) ? String(MAX_LOCAL_KEYS) : "∞";
  statusEl.innerHTML = "";
  statusEl.append(
    document.createTextNode(`keys ${total} · `),
    (() => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.id = "dep-count";
      btn.className = "linklike";
      btn.textContent = `in pool ${activePoolKeys ?? "…"}`;
      btn.title = "click to view your keys";
      return btn;
    })(),
    document.createTextNode(
      ` · pool cap ${capLabel} · quota ${BOTTLE_QUOTA} · e2ee · ${
        identityRecord?.username ? `@${identityRecord.username}` : "anon"
      }`
    )
  );
}

async function saveKeyRecord(record) {
  await idbPut(KEY_STORE, record);
  await loadKeys();
}

function formatTTL(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "expires in —";
  const s = Math.round(seconds);
  const fmt = (n) => String(Math.round(n * 100) / 100);
  const unit = (value, singular, plural) => `${fmt(value)} ${value === 1 ? singular : plural}`;
  if (s >= 86400) return `expires in ${unit(s / 86400, "day", "days")}`;
  if (s >= 3600) return `expires in ${unit(s / 3600, "hour", "hours")}`;
  if (s >= 60) return `expires in ${unit(s / 60, "minute", "minutes")}`;
  return `expires in ${s} second${s === 1 ? "" : "s"}`;
}

function readTTLSeconds() {
  const raw = Number.parseInt(ttlInputEl.value, 10);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.min(2592000, Math.max(60, raw));
}

function depositTTLSeconds() {
  return readTTLSeconds() ?? 86400;
}

function updateTTLDesc() {
  const seconds = readTTLSeconds();
  ttlDescEl.textContent = seconds ? formatTTL(seconds) : "expires in —";
}

async function depositUndeposited() {
  const now = Date.now();
  const pending = keyRecords.filter(
    (k) => !k.depositedAt || (k.expiresAt && k.expiresAt <= now)
  );
  if (!pending.length) return 0;
  await api("/api/pool/deposit", {
    method: "POST",
    body: JSON.stringify({
      keys: pending.map((k) => ({
        kid: k.kid,
        publicKey: JSON.stringify(k.publicJwk),
        ttlSeconds: depositTTLSeconds(),
      })),
    }),
  });
  const expiresAt = now + depositTTLSeconds() * 1000;
  for (const k of pending) {
    k.depositedAt = now;
    k.expiresAt = expiresAt;
    await idbPut(KEY_STORE, k);
  }
  await loadKeys();
  return pending.length;
}

async function ownKeysInPool() {
  try {
    const { kids = [] } = await api("/api/pool/kids?limit=20000", { auth: false });
    const pool = new Set(kids);
    ownPoolKids = new Set(keyRecords.filter((k) => pool.has(k.kid)).map((k) => k.kid));
    return ownPoolKids.size;
  } catch {
    ownPoolKids = new Set();
    return keyRecords.filter((k) => k.depositedAt).length;
  }
}

async function generateAndDeposit() {
  const inPool = await ownKeysInPool();
  if (inPool >= MAX_LOCAL_KEYS) {
    log(`pool key limit reached (${MAX_LOCAL_KEYS}); consumed keys free up slots`, "warn");
    return;
  }
  const rec = await makeKeyRecord();
  await idbPut(KEY_STORE, rec);
  await loadKeys();
  const n = await depositUndeposited();
  const capLabel = Number.isFinite(MAX_LOCAL_KEYS) ? `/${MAX_LOCAL_KEYS}` : "";
  log(`generated key material; deposited ${n} blind public key(s) (${inPool + n}${capLabel} in pool)`);
}

async function deriveWrapKey(bottleId, sharedBits, usages) {
  const hkdf = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode(bottleId),
      info: enc.encode(WRAP_INFO),
    },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

async function importECDHPublic(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
}

async function importECDHPrivate(jwk) {
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
async function derivePickupProof(rawSessionKey, bottleId, kid = "") {
  const keyBytes = new Uint8Array(rawSessionKey);
  const bottleBytes = enc.encode(bottleId);
  const kidBytes = enc.encode(kid);
  const tagBytes = enc.encode(kid ? "a09f-pickup-v2" : "a09f-pickup-v1");
  const combined = new Uint8Array(
    keyBytes.length + bottleBytes.length + kidBytes.length + tagBytes.length
  );
  combined.set(keyBytes, 0);
  combined.set(bottleBytes, keyBytes.length);
  combined.set(kidBytes, keyBytes.length + bottleBytes.length);
  combined.set(tagBytes, keyBytes.length + bottleBytes.length + kidBytes.length);
  const tokenBuf = await crypto.subtle.digest("SHA-256", combined);
  const token = bytesToB64(new Uint8Array(tokenBuf));
  const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(token));
  const hash = bytesToB64(new Uint8Array(hashBuf));
  return { token, hash };
}

async function wrapSessionKey(bottleId, recipientPublicKeyJwk, rawSessionKey, kid) {
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
  const authorPublicJwk = await crypto.subtle.exportKey("jwk", authorPair.publicKey);
  const { hash: pickupHash } = await derivePickupProof(rawSessionKey, bottleId, kid);
  return {
    kid: null,
    authorPublicKey: JSON.stringify(authorPublicJwk),
    wrapIv: bytesToB64(iv),
    wrappedKey: bytesToB64(new Uint8Array(wrapped)),
    pickupHash,
  };
}

const MAX_THREAD_DEPTH = 20;
const REPLY_PREFIX = "reply:";

function encodePlaintext(text, replyJwk) {
  return JSON.stringify({ v: 1, text, reply: replyJwk || null });
}

function decodePlaintext(raw) {
  try {
    const obj = JSON.parse(raw);
    if (obj && obj.v === 1 && typeof obj.text === "string") return obj;
  } catch {
    // legacy plaintext
  }
  return { v: 0, text: raw, reply: null };
}

async function storeReplyKey(bottleId, pair) {
  await idbPut(META_STORE, {
    id: `${REPLY_PREFIX}${bottleId}`,
    privateJwk: pair.privateJwk,
    publicJwk: pair.publicJwk,
    createdAt: Date.now(),
  });
}

async function dropBottle(retried = false) {
  const text = messageEl.value.trim();
  if (!text) {
    log("message is empty", "warn");
    return;
  }
  const { size = 0 } = await api("/api/pool/kids?limit=1", { auth: false }).catch(() => ({ size: 0 }));
  if (size < 1) {
    log("bait pool is empty; throw bait first", "err");
    return;
  }
  const fetched = await api("/api/pool/fetch", {
    method: "POST",
    body: JSON.stringify({
      count: BOTTLE_QUOTA,
      // keep our own keys in the pool instead of burning them on our own bottle
      exclude: keyRecords.map((k) => k.kid),
    }),
  });
  const allPoolKeys = fetched.keys || [];
  const poolKeys = allPoolKeys.filter((pk) => !keyByKid.has(pk.kid));
  if (poolKeys.length < 1) {
    if (allPoolKeys.length > 0) {
      log("all fetched keys belong to this device; generate keys on another device", "warn");
    } else {
      log("bait pool returned no keys; throw more bait and retry", "err");
    }
    return;
  }

  const bottleId = crypto.randomUUID();
  const replyPair = await makeKeyRecord();
  await storeReplyKey(bottleId, replyPair);
  const sessionKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"]
  );
  const payloadIV = randBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: payloadIV },
    sessionKey,
    enc.encode(encodePlaintext(text, replyPair.publicJwk))
  );
  const rawSessionKey = await crypto.subtle.exportKey("raw", sessionKey);

  const envelopes = [];
  for (const pk of poolKeys) {
    const recipientJwk = JSON.parse(pk.publicKey);
    const env = await wrapSessionKey(bottleId, recipientJwk, rawSessionKey, pk.kid);
    env.kid = pk.kid;
    envelopes.push(env);
  }
  const recipientCount = envelopes.length;
  const id = await getIdentity();
  const selfKid = `self:${await deriveUserId(id.publicJwk)}`;
  const selfEnv = await wrapSessionKey(bottleId, id.publicJwk, rawSessionKey, selfKid);
  selfEnv.kid = selfKid;
  envelopes.push(selfEnv);

  try {
    await api("/api/bottles", {
      method: "POST",
      body: JSON.stringify({
        id: bottleId,
        createdAt: Date.now(),
        depth: 1,
        maxDeliveries: recipientCount,
        payloadIv: bytesToB64(payloadIV),
        ciphertext: bytesToB64(new Uint8Array(ciphertext)),
        envelopes,
      }),
    });
  } catch (e) {
    if (e.data?.error === "blocked_key_conflict" && !retried) {
      log("some recipients are blocked; refetching bait pool", "warn");
      return dropBottle(true);
    }
    throw e;
  }

  await storeSentRecord(bottleId, {
    id: bottleId,
    createdAt: Date.now(),
    depth: 1,
    maxDeliveries: envelopes.length,
    status: "ACTIVE",
  }, { v: 1, text, reply: replyPair.publicJwk }, "");
  await renderInbox();
  messageEl.value = "";
  log(`dropped bottle ${bottleId} to ${envelopes.length} blind recipients`);
}

async function replyBottle(parent, parentPlain, text) {
  const depth = (parent.depth || 1) + 1;
  if (depth > MAX_THREAD_DEPTH) {
    log(`thread depth limit reached (${MAX_THREAD_DEPTH})`, "err");
    return;
  }
  if (!parentPlain?.reply) {
    log("parent bottle has no reply address", "err");
    return;
  }
  const bottleId = crypto.randomUUID();
  let replyJwk = null;
  if (depth < MAX_THREAD_DEPTH) {
    const replyPair = await makeKeyRecord();
    await storeReplyKey(bottleId, replyPair);
    replyJwk = replyPair.publicJwk;
  }
  const sessionKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"]
  );
  const payloadIV = randBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: payloadIV },
    sessionKey,
    enc.encode(encodePlaintext(text, replyJwk))
  );
  const rawSessionKey = await crypto.subtle.exportKey("raw", sessionKey);
  const replyKid = `${REPLY_PREFIX}${parent.id}`;
  const env = await wrapSessionKey(bottleId, parentPlain.reply, rawSessionKey, replyKid);
  env.kid = replyKid;
  const id = await getIdentity();
  const selfKid = `self:${await deriveUserId(id.publicJwk)}`;
  const selfEnv = await wrapSessionKey(bottleId, id.publicJwk, rawSessionKey, selfKid);
  selfEnv.kid = selfKid;
  await api("/api/bottles", {
    method: "POST",
    body: JSON.stringify({
      id: bottleId,
      createdAt: Date.now(),
      depth,
      parentId: parent.id,
      maxDeliveries: 1,
      payloadIv: bytesToB64(payloadIV),
      ciphertext: bytesToB64(new Uint8Array(ciphertext)),
      envelopes: [env, selfEnv],
    }),
  });
  await storeSentRecord(bottleId, {
    id: bottleId,
    createdAt: Date.now(),
    depth,
    parentId: parent.id,
    maxDeliveries: 1,
    status: "ACTIVE",
  }, { v: 1, text, reply: replyJwk }, env.kid);
  await renderInbox();
  log(`replied to ${parent.id.slice(0, 8)} (depth ${depth}/${MAX_THREAD_DEPTH})`);
}

async function unwrapSessionKey(bottle, envelope, record) {
  const privateKey = await importECDHPrivate(record.privateJwk);
  const authorPublicJwk = JSON.parse(envelope.authorPublicKey);
  const authorPublic = await importECDHPublic(authorPublicJwk);
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: authorPublic },
    privateKey,
    256
  );
  const wrapKey = await deriveWrapKey(bottle.id, bits, ["decrypt"]);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(envelope.wrapIv) },
    wrapKey,
    b64ToBytes(envelope.wrappedKey)
  );
}

async function decryptPayload(bottle, rawSessionKey) {
  const sessionKey = await crypto.subtle.importKey(
    "raw",
    rawSessionKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(bottle.payloadIv) },
    sessionKey,
    b64ToBytes(bottle.ciphertext)
  );
  return dec.decode(plain);
}

async function claimBottle(bottleId, kid, pickupToken) {
  return api(`/api/bottles/${encodeURIComponent(bottleId)}/pickup`, {
    method: "POST",
    body: JSON.stringify({ kid, pickupToken }),
  });
}

function createMessageNode(rec, orphan = false, sentIds = null) {
  const { bottle, plain, kid, claim } = rec;
  const node = document.createElement("div");
  node.className = bottle.parentId ? "msg reply" : "msg";

  const head = document.createElement("div");
  head.className = "bottle-head";
  const id = document.createElement("span");
  id.textContent = orphan && bottle.parentId ? `↳ reply to ${bottle.parentId.slice(0, 8)}` : bottle.id.slice(0, 8);
  const meta = document.createElement("span");
  meta.textContent = `${claim?.status || "CLAIMED"} · ${claim?.deliveries ?? "?"}/${bottle.maxDeliveries} · depth ${(bottle.depth || 1)}/${MAX_THREAD_DEPTH} · key ${(kid || "").slice(0, 8)}`;
  head.append(id, meta);

  const body = document.createElement("p");
  body.className = "bottle-text";
  body.textContent = plain.text;

  node.append(head, body);
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  if (claim?.status !== "SENT") {
    const reportBtn = document.createElement("button");
    reportBtn.className = "btn small";
    reportBtn.textContent = "[ report ]";
    reportBtn.addEventListener("click", () => {
      const reason = prompt("report reason (optional)") || "";
      api(`/api/bottles/${encodeURIComponent(bottle.id)}/report`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      })
        .then(() => log(`reported bottle ${bottle.id.slice(0, 8)}`))
        .catch((e) => log(`report: ${e.message}`, "err"));
    });
    actions.appendChild(reportBtn);
  }
  const depth = bottle.depth || 1;
  if (plain.reply && depth < MAX_THREAD_DEPTH && claim?.status !== "SENT" && !sentIds?.has(bottle.id)) {
    const btn = document.createElement("button");
    btn.className = "btn small";
    btn.textContent = "[ reply ]";
    btn.addEventListener("click", () => {
      const text = prompt("reply message");
      if (!text?.trim()) return;
      replyBottle(bottle, plain, text.trim()).catch((e) => log(`reply: ${e.message}`, "err"));
    });
    actions.appendChild(btn);
  }
  if (actions.children.length) node.appendChild(actions);
  return node;
}

function buildThreadEl(rec, childrenOf, orphan = false, sentIds = null) {
  const card = document.createElement("article");
  card.className = orphan && rec.bottle.parentId ? "thread bottle orphan" : "thread bottle";
  card.appendChild(createMessageNode(rec, orphan, sentIds));
  const kids = childrenOf.get(rec.bottle.id) || [];
  if (kids.length) {
    const replies = document.createElement("div");
    replies.className = "replies";
    for (const child of kids) replies.appendChild(buildThreadEl(child, childrenOf, false, sentIds));
    card.appendChild(replies);
  }
  return card;
}

function isSentRecord(r) {
  return typeof r.id === "string" && r.id.startsWith("sent:");
}

async function storeSentRecord(bottleId, bottle, plain, kid) {
  await idbPut(META_STORE, {
    id: `sent:${bottleId}`,
    bottle,
    plain,
    kid: kid || "",
    claim: { status: "SENT" },
    caughtAt: Date.now(),
  }).catch(() => {});
}

async function renderInbox() {
  const all = await idbGetAll(META_STORE).catch(() => []);
  const recs = all
    .filter((r) => typeof r.id === "string" && (r.id.startsWith("caught:") || r.id.startsWith("sent:")) && r.bottle && r.plain)
    .sort((a, b) => (a.caughtAt || 0) - (b.caughtAt || 0));
  const byBottle = new Map();
  for (const r of recs) {
    const prev = byBottle.get(r.bottle.id);
    if (!prev || (isSentRecord(prev) && !isSentRecord(r))) byBottle.set(r.bottle.id, r);
  }
  const unique = [...byBottle.values()].sort((a, b) => (a.caughtAt || 0) - (b.caughtAt || 0));
  const byId = new Map(unique.map((r) => [r.bottle.id, r]));
  const childrenOf = new Map();
  const roots = [];
  for (const r of unique) {
    const pid = r.bottle.parentId;
    if (pid && byId.has(pid)) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid).push(r);
    } else {
      roots.push(r);
    }
  }
  for (const r of unique) caughtThisSession.add(r.bottle.id);
  const sentIds = new Set(recs.filter(isSentRecord).map((r) => r.bottle.id));
  inboxEl.innerHTML = "";
  if (!roots.length) {
    if (!keyRecords.length && !identityRecord?.username) {
      const welcome = document.createElement("div");
      welcome.className = "panel";
      welcome.innerHTML = `
        <div class="welcome-title">welcome drifter!</div>
        <p class="hint">Messages here are sealed with E2EE — only the sender and the intended recipient can ever read them. To start receiving, throw some bait: deposit your public keys into the bait pool.</p>
        <ol class="welcome-steps">
          <li><b>[ throw bait ]</b> — publish a keypair to the pool (max ${MAX_LOCAL_KEYS})</li>
          <li><b>[ account ]</b> — claim a username to enable blocking &amp; reporting</li>
          <li><b>[ cast message ]</b> a message, or wait for the current sea to wash one your way — then <b>[ check catch ]</b></li>
        </ol>
        <div class="welcome-actions">
          <button class="btn primary" data-welcome="keys">[ throw bait ]</button>
          <button class="btn" data-welcome="account">[ claim username ]</button>
          <button class="btn" data-welcome="check">[ check catch ]</button>
        </div>`;
      welcome.querySelectorAll("[data-welcome]").forEach((b) =>
        b.addEventListener("click", () => {
          const id = { keys: "btn-keys", account: "btn-account", check: "btn-check" }[b.dataset.welcome];
          $(id)?.click();
        })
      );
      inboxEl.appendChild(welcome);
    } else {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "the water is calm — nothing on the line yet";
      inboxEl.appendChild(empty);
    }
    return;
  }
  for (const r of roots) inboxEl.appendChild(buildThreadEl(r, childrenOf, !!r.bottle.parentId, sentIds));
}

async function checkBottles() {
  let caught = 0;
  let scanned = 0;
  let cursor = 0;
  // recipient filter: pool kids + self:<userId> + reply:<known bottle ids>.
  // no known thread records -> unfiltered bootstrap scan.
  const metas = await idbGetAll(META_STORE).catch(() => []);
  const knownIds = new Set();
  for (const r of metas) {
    if ((typeof r.id === "string" && (r.id.startsWith("caught:") || r.id.startsWith("sent:"))) && r.bottle?.id) {
      knownIds.add(r.bottle.id);
    }
  }
  let kidsQuery = "";
  if (knownIds.size > 0) {
    // only kids still able to receive new bottles (in-pool); consumed/expired
    // kids can never be targeted again
    const now = Date.now();
    const liveKids = ownPoolKids.size > 0
      ? [...ownPoolKids]
      : keyRecords.filter((k) => k.depositedAt && (!k.expiresAt || k.expiresAt > now)).map((k) => k.kid);
    const parts = liveKids;
    const idt = await getIdentity().catch(() => null);
    if (idt?.publicJwk) {
      const uid = await deriveUserId(idt.publicJwk);
      parts.push(`self:${uid}`);
      for (const bid of [...knownIds].slice(0, 120)) parts.push(`reply:${bid}`);
      kidsQuery = `&kids=${encodeURIComponent(parts.join(","))}`;
    }
  }
  for (let page = 0; page < 100; page++) {
    const { bottles = [], nextCursor = 0 } = await api(
      `/api/bottles?limit=100${cursor ? `&cursor=${cursor}` : ""}${kidsQuery}`,
      { auth: false }
    );
    if (!bottles.length) break;
    scanned += bottles.length;
    for (const bottle of bottles) {
    if (caughtThisSession.has(bottle.id)) continue;
    let claimed = false;
    for (const envelope of bottle.envelopes || []) {
      const isSelf = typeof envelope.kid === "string" && envelope.kid.startsWith("self:");
      let record = isSelf ? null : keyByKid.get(envelope.kid);
      if (!record && !isSelf && typeof envelope.kid === "string" && envelope.kid.startsWith(REPLY_PREFIX)) {
        const replyRec = await idbGet(META_STORE, envelope.kid).catch(() => null);
        if (replyRec?.privateJwk) record = { privateJwk: replyRec.privateJwk };
      }
      if (isSelf) {
        const idt = await getIdentity().catch(() => null);
        if (idt?.privateJwk) record = { privateJwk: idt.privateJwk };
      }
      if (!record) continue;
      try {
        const rawSession = await unwrapSessionKey(bottle, envelope, record);
        const plain = decodePlaintext(await decryptPayload(bottle, rawSession));
        if (isSelf) {
          // own sent bottle: recover plaintext locally, no pickup claim
          await idbPut(META_STORE, {
            id: `sent:${bottle.id}`,
            bottle,
            plain,
            kid: envelope.kid,
            claim: { status: "SENT" },
            caughtAt: Date.now(),
          }).catch(() => {});
          caughtThisSession.add(bottle.id);
          caught += 1;
          claimed = true;
          log(`recovered sent bottle ${bottle.id.slice(0, 8)}`);
          break;
        }
        const { token: pickupToken } = await derivePickupProof(rawSession, bottle.id, envelope.kid);
        let claim = null;
        try {
          claim = await claimBottle(bottle.id, envelope.kid, pickupToken);
        } catch (e) {
          claim = { ok: false, error: e.message };
        }
        await idbPut(META_STORE, {
          id: `caught:${bottle.id}`,
          bottle,
          plain,
          kid: envelope.kid,
          claim,
          caughtAt: Date.now(),
        }).catch(() => {});
        // note: reply keys are NOT burned at max depth — reply:<parentId>
        // decrypts every reply addressed to that parent (all same depth),
        // so sibling replies may still need it. Depth-20 bottles carry no
        // reply address of their own, so threads cannot grow past the cap.
        if (claim?.ok !== false) {
          caughtThisSession.add(bottle.id);
        }
        caught += 1;
        claimed = true;
        log(`caught bottle ${bottle.id.slice(0, 8)} (${claim?.status || claim?.error || "claimed"})`, claim?.ok === false ? "warn" : "");
        break;
      } catch {
        // not ours or corrupted envelope; keep scanning
      }
    }
    if (!claimed) {
      // no local key matched; ignore
    }
    }
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  await renderInbox();
  await refreshActivePoolKeys();
  log(`checked ${scanned} bottle(s); caught ${caught}`);
}

async function vaultKeysPayload() {
  const keys = await idbGetAll(KEY_STORE);
  const meta = await idbGetAll(META_STORE).catch(() => []);
  // slim vault: private key material only (bait pool + identity + reply keys).
  // bottle plaintext/thread records are rebuilt from server ciphertext.
  const keyMeta = meta.filter(
    (m) => m?.id === "identity" || (typeof m?.id === "string" && m.id.startsWith(REPLY_PREFIX))
  );
  return {
    version: 3,
    exportedAt: new Date().toISOString(),
    keys: keys.map((k) => ({
      kid: k.kid,
      privateJwk: k.privateJwk,
      publicJwk: k.publicJwk,
      createdAt: k.createdAt,
      depositedAt: k.depositedAt,
      expiresAt: k.expiresAt,
    })),
    meta: keyMeta,
  };
}

async function encryptVault(plaintext, passphrase) {
  const salt = randBytes(16);
  const iv = randBytes(12);
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const wrapKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, enc.encode(plaintext));
  return {
    v: 1,
    kdf: { name: "PBKDF2", iterations: 200000, hash: "SHA-256", salt: bytesToB64(salt) },
    cipher: "AES-GCM-256",
    iv: bytesToB64(iv),
    ciphertext: bytesToB64(new Uint8Array(ciphertext)),
  };
}

async function decryptVault(blob, passphrase) {
  const salt = b64ToBytes(blob.kdf.salt);
  const iv = b64ToBytes(blob.iv);
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const wrapKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: blob.kdf.iterations || 200000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    wrapKey,
    b64ToBytes(blob.ciphertext)
  );
  return JSON.parse(dec.decode(plain));
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportVault() {
  const payload = await vaultKeysPayload();
  const hasIdentity = payload.meta.some((m) => m?.id === "identity");
  if (!payload.keys.length && !hasIdentity) {
    log("no bait yet to export", "warn");
    return;
  }
  const passphrase = prompt("vault passphrase");
  if (!passphrase) return;
  const encrypted = await encryptVault(JSON.stringify(payload), passphrase);
  downloadJson("saltleak-identity.json", encrypted);
  log(`exported encrypted vault with ${payload.keys.length} pool key(s)`);
}

async function importVaultFile(file) {
  const passphrase = prompt("vault passphrase");
  if (!passphrase) return;
  const text = await file.text();
  const blob = JSON.parse(text);
  const payload = await decryptVault(blob, passphrase);
  if (!Array.isArray(payload.keys)) throw new Error("invalid vault payload");
  for (const k of payload.keys) {
    if (!k.kid || !k.privateJwk || !k.publicJwk) continue;
    await idbPut(KEY_STORE, {
      kid: k.kid,
      privateJwk: k.privateJwk,
      publicJwk: k.publicJwk,
      createdAt: k.createdAt || Date.now(),
      depositedAt: k.depositedAt || null,
      expiresAt: k.expiresAt || null,
    });
  }
  let metaCount = 0;
  for (const m of payload.meta || []) {
    if (!m?.id) continue;
    await idbPut(META_STORE, m);
    metaCount += 1;
  }
  identityRecord = null;
  identityRecord = await getIdentity().catch(() => null);
  await loadKeys();
  await renderInbox();
  renderStatus();
  log(`imported vault with ${payload.keys.length} key(s), ${metaCount} thread record(s)`);
}

function formatExpiry(expiresAt) {
  if (!expiresAt) return "no expiry";
  const ms = expiresAt * 1000 - Date.now();
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  if (s >= 86400) return `expires in ${Math.floor(s / 86400)}d`;
  if (s >= 3600) return `expires in ${Math.floor(s / 3600)}h`;
  if (s >= 60) return `expires in ${Math.floor(s / 60)}m`;
  return `expires in ${s}s`;
}

async function toggleMyKeysPanel() {
  const panel = $("my-keys-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    await refreshActivePoolKeys();
    renderMyKeys();
  }
}

function renderMyKeys() {
  $("my-keys-count").textContent = `(${keyRecords.length})`;
  const list = $("my-keys");
  list.innerHTML = "";
  if (!keyRecords.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "no bait yet";
    list.appendChild(empty);
    return;
  }
  for (const k of keyRecords) {
    const row = document.createElement("div");
    row.className = "pool-key";
    const kid = document.createElement("span");
    kid.className = "kid";
    kid.textContent = k.kid;
    kid.title = k.kid;
    const meta = document.createElement("span");
    meta.className = "exp";
    const created = k.createdAt ? new Date(k.createdAt).toLocaleString() : "—";
    if (!k.depositedAt) {
      meta.className = "st-pending";
      meta.textContent = `pending · created ${created}`;
    } else if (ownPoolKids.has(k.kid)) {
      meta.className = "st-inpool";
      const parts = ["in pool"];
      if (k.expiresAt) {
        const remaining = (k.expiresAt - Date.now()) / 1000;
        parts.push(remaining > 0 ? formatTTL(remaining) : "expired");
      }
      meta.textContent = parts.join(" · ");
    } else if (k.expiresAt && k.expiresAt <= Date.now()) {
      meta.className = "st-expired";
      meta.textContent = `expired ${new Date(k.expiresAt).toLocaleString()}`;
    } else {
      meta.className = "st-used";
      meta.textContent = `used · deposited ${k.depositedAt ? new Date(k.depositedAt).toLocaleString() : "—"}`;
    }
    row.append(kid, meta);
    list.appendChild(row);
  }
}

async function togglePoolPanel() {
  const panel = $("pool-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) await refreshPoolKeys();
}

async function refreshPoolKeys() {
  const { keys = [], size = 0 } = await api("/api/pool/keys?limit=200", { auth: false });
  $("pool-count").textContent = `(${size} in pool)`;
  const list = $("pool-keys");
  list.innerHTML = "";
  if (!keys.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "the water is empty — no bait in the pool";
    list.appendChild(empty);
    return;
  }
  for (const k of keys) {
    const row = document.createElement("div");
    row.className = "pool-key";
    const kid = document.createElement("span");
    kid.className = "kid";
    kid.textContent = k.kid;
    kid.title = k.kid;
    const exp = document.createElement("span");
    exp.className = "exp";
    exp.textContent = formatExpiry(k.expiresAt);
    row.append(kid, exp);
    list.appendChild(row);
  }
}

// ---- account panel: identity, block, report ----

const accountPanelEl = () => $("account-panel");

async function toggleAccountPanel() {
  const panel = accountPanelEl();
  panel.hidden = !panel.hidden;
  if (!panel.hidden) await renderAccount();
}

async function resolveUserTarget(input) {
  const v = input.trim();
  if (!v) return null;
  if (v.startsWith("u_")) return v;
  const { user } = await api(`/api/users/by-username/${encodeURIComponent(v)}`);
  return user?.id || null;
}

async function renderAccount() {
  const info = $("account-info");
  const blocksEl = $("blocks-list");
  const id = await getIdentity();
  if (id.username) {
    info.textContent = `@${id.username} · ${id.userId}`;
    info.title = id.userId;
  } else {
    info.textContent = "anonymous — claim a username to enable block/report";
  }
  blocksEl.innerHTML = "";
  if (!id.username) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "no account";
    blocksEl.appendChild(empty);
    return;
  }
  try {
    const { blocks = [] } = await api("/api/me/blocks");
    if (!blocks.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "not blocking anyone";
      blocksEl.appendChild(empty);
      return;
    }
    for (const b of blocks) {
      const row = document.createElement("div");
      row.className = "pool-key";
      const name = document.createElement("span");
      name.className = "kid";
      name.textContent = `@${b.username}`;
      name.title = `${b.blockedUserId}${b.reason ? ` · ${b.reason}` : ""}`;
      const btn = document.createElement("button");
      btn.className = "btn small";
      btn.textContent = "[ unblock ]";
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/users/${encodeURIComponent(b.blockedUserId)}/block`, { method: "DELETE" });
          log(`unblocked @${b.username}`);
          await renderAccount();
        } catch (e) {
          log(`unblock: ${e.message}`, "err");
        }
      });
      row.append(name, btn);
      blocksEl.appendChild(row);
    }
  } catch (e) {
    const err = document.createElement("div");
    err.className = "empty";
    err.textContent = `blocks unavailable: ${e.message}`;
    blocksEl.appendChild(err);
  }
}

const RANDOM_NAME_A = ["drifter","nomad","cipher","static","void","paper","salt","ember","foghorn","meridian","packet","quiet","rust","tide","umbra"];
const RANDOM_NAME_B = ["fox","whale","monk","engine","letter","sparrow","vault","signal","anchor","drift","cipher","field","harbor","lantern","current","moth"];

function randomUsername() {
  const a = RANDOM_NAME_A[Math.floor(Math.random() * RANDOM_NAME_A.length)];
  const b = RANDOM_NAME_B[Math.floor(Math.random() * RANDOM_NAME_B.length)];
  const n = Math.floor(Math.random() * 900 + 100);
  return `${a}_${b}${n}`;
}

async function claimUsernameFromUI() {
  const input = $("username-input");
  const username = input.value.trim();
  if (!username) {
    log("enter a username first", "warn");
    return;
  }
  try {
    await claimUsername(username);
    input.value = "";
    log(`claimed @${username}`);
    renderStatus();
    await renderAccount();
  } catch (e) {
    log(`claim: ${e.message}`, "err");
  }
}

async function blockOrReport(kind) {
  const id = await getIdentity();
  if (!id.username) {
    log("claim a username first", "warn");
    return;
  }
  const target = await resolveUserTarget($("block-target"));
  if (!target) {
    log("user not found", "warn");
    return;
  }
  if (target === id.userId) {
    log("that is you", "warn");
    return;
  }
  try {
    if (kind === "block") {
      await api(`/api/users/${encodeURIComponent(target)}/block`, {
        method: "POST",
        body: JSON.stringify({ reason: "blocked via web" }),
      });
      log(`blocked ${target.slice(0, 12)}… — their keys won't receive your bottles`);
    } else {
      const reason = prompt("report reason (optional)") || "";
      await api(`/api/users/${encodeURIComponent(target)}/report`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      log(`reported ${target.slice(0, 12)}…`);
    }
    await renderAccount();
  } catch (e) {
    log(`${kind}: ${e.message}`, "err");
  }
}

async function init() {
  db = await openDB();
  identityRecord = await getIdentity().catch(() => null);
  await loadKeys();
  await renderInbox();
  updateTTLDesc();
  ttlInputEl.addEventListener("input", updateTTLDesc);
  $("btn-keys").addEventListener("click", () => generateAndDeposit().catch((e) => log(`keys: ${e.message}`, "err")));
  $("btn-drop").addEventListener("click", () => dropBottle().catch((e) => log(`drop: ${e.message}`, "err")));
  $("btn-check").addEventListener("click", () => checkBottles().catch((e) => log(`check: ${e.message}`, "err")));
  $("btn-export").addEventListener("click", () => exportVault().catch((e) => log(`export: ${e.message}`, "err")));
  $("btn-import").addEventListener("click", () => $("vault-file").click());
  $("btn-pool").addEventListener("click", () => togglePoolPanel().catch((e) => log(`pool: ${e.message}`, "err")));
  $("btn-account").addEventListener("click", () => toggleAccountPanel().catch((e) => log(`account: ${e.message}`, "err")));
  $("btn-claim").addEventListener("click", () => claimUsernameFromUI().catch((e) => log(`claim: ${e.message}`, "err")));
  $("btn-random-name").addEventListener("click", () => {
    $("username-input").value = randomUsername();
  });
  $("btn-block").addEventListener("click", () => blockOrReport("block").catch((e) => log(`block: ${e.message}`, "err")));
  $("btn-report").addEventListener("click", () => blockOrReport("report").catch((e) => log(`report: ${e.message}`, "err")));
  statusEl.addEventListener("click", (e) => {
    if (e.target?.id === "dep-count") toggleMyKeysPanel();
  });
  $("vault-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      await importVaultFile(file);
    } catch (err) {
      log(`import: ${err.message || "failed"}`, "err");
    }
  });
  try {
    await api("/api/health", { auth: false });
    log("relay online");
  } catch (e) {
    log(`relay offline: ${e.message}`, "err");
  }
  checkBottles().catch((e) => log(`auto-check: ${e.message}`, "err"));
}

init().catch((e) => log(`boot: ${e.message}`, "err"));
