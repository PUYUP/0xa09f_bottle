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
const BOTTLE_QUOTA = 5;
const MAX_LOCAL_KEYS = 75;
const caughtThisSession = new Set();

function log(msg, cls = "") {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
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
}

function renderStatus() {
  const total = keyRecords.length;
  const deposited = keyRecords.filter((k) => k.depositedAt).length;
  statusEl.textContent = `keys ${total} · deposited ${deposited} · pool cap ${MAX_LOCAL_KEYS} · quota ${BOTTLE_QUOTA} · e2ee`;
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
  const pending = keyRecords.filter((k) => !k.depositedAt);
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
  const now = Date.now();
  for (const k of pending) {
    k.depositedAt = now;
    await idbPut(KEY_STORE, k);
  }
  await loadKeys();
  return pending.length;
}

async function ownKeysInPool() {
  try {
    const { kids = [] } = await api("/api/pool/kids?limit=20000");
    const pool = new Set(kids);
    return keyRecords.filter((k) => pool.has(k.kid)).length;
  } catch {
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
  log(`generated key material; deposited ${n} blind public key(s) (${inPool + n}/${MAX_LOCAL_KEYS} in pool)`);
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

async function wrapSessionKey(bottleId, recipientPublicKeyJwk, rawSessionKey) {
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
  return {
    kid: null,
    authorPublicKey: JSON.stringify(authorPublicJwk),
    wrapIv: bytesToB64(iv),
    wrappedKey: bytesToB64(new Uint8Array(wrapped)),
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

async function dropBottle() {
  const text = messageEl.value.trim();
  if (!text) {
    log("message is empty", "warn");
    return;
  }
  const { size = 0 } = await api("/api/pool/kids?limit=1").catch(() => ({ size: 0 }));
  if (size < 1) {
    log("blind pool is empty; deposit keys first", "err");
    return;
  }
  const fetched = await api("/api/pool/fetch", {
    method: "POST",
    body: JSON.stringify({ count: BOTTLE_QUOTA }),
  });
  const poolKeys = fetched.keys || [];
  if (poolKeys.length < 1) {
    log("blind pool returned no keys; deposit more keys and retry", "err");
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
    const env = await wrapSessionKey(bottleId, recipientJwk, rawSessionKey);
    env.kid = pk.kid;
    envelopes.push(env);
  }

  await api("/api/bottles", {
    method: "POST",
    body: JSON.stringify({
      id: bottleId,
      createdAt: Date.now(),
      depth: 1,
      maxDeliveries: envelopes.length,
      payloadIv: bytesToB64(payloadIV),
      ciphertext: bytesToB64(new Uint8Array(ciphertext)),
      envelopes,
    }),
  });

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
  const env = await wrapSessionKey(bottleId, parentPlain.reply, rawSessionKey);
  env.kid = `${REPLY_PREFIX}${parent.id}`;
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
      envelopes: [env],
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

async function claimBottle(bottleId, kid) {
  return api(`/api/bottles/${encodeURIComponent(bottleId)}/pickup`, {
    method: "POST",
    body: JSON.stringify({ kid }),
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
  const depth = bottle.depth || 1;
  if (plain.reply && depth < MAX_THREAD_DEPTH && claim?.status !== "SENT" && !sentIds?.has(bottle.id)) {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = "[ reply ]";
    btn.addEventListener("click", () => {
      const text = prompt("reply message");
      if (!text?.trim()) return;
      replyBottle(bottle, plain, text.trim()).catch((e) => log(`reply: ${e.message}`, "err"));
    });
    node.appendChild(btn);
  }
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
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "no messages yet";
    inboxEl.appendChild(empty);
    return;
  }
  for (const r of roots) inboxEl.appendChild(buildThreadEl(r, childrenOf, !!r.bottle.parentId, sentIds));
}

async function checkBottles() {
  const { bottles = [] } = await api("/api/bottles?limit=100");
  let caught = 0;
  for (const bottle of bottles) {
    if (caughtThisSession.has(bottle.id)) continue;
    let claimed = false;
    for (const envelope of bottle.envelopes || []) {
      let record = keyByKid.get(envelope.kid);
      if (!record && typeof envelope.kid === "string" && envelope.kid.startsWith(REPLY_PREFIX)) {
        const replyRec = await idbGet(META_STORE, envelope.kid).catch(() => null);
        if (replyRec?.privateJwk) record = { privateJwk: replyRec.privateJwk };
      }
      if (!record) continue;
      try {
        const rawSession = await unwrapSessionKey(bottle, envelope, record);
        const plain = decodePlaintext(await decryptPayload(bottle, rawSession));
        const claim = await claimBottle(bottle.id, envelope.kid).catch((e) => ({ ok: false, error: e.message }));
        await idbPut(META_STORE, {
          id: `caught:${bottle.id}`,
          bottle,
          plain,
          kid: envelope.kid,
          claim,
          caughtAt: Date.now(),
        }).catch(() => {});
        if ((bottle.depth || 1) >= MAX_THREAD_DEPTH && bottle.parentId) {
          await idbDelete(META_STORE, `${REPLY_PREFIX}${bottle.parentId}`).catch(() => {});
        }
        caughtThisSession.add(bottle.id);
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
  await renderInbox();
  log(`checked ${bottles.length} active bottle(s); caught ${caught}`);
}

async function vaultKeysPayload() {
  const keys = await idbGetAll(KEY_STORE);
  const meta = await idbGetAll(META_STORE).catch(() => []);
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    keys: keys.map((k) => ({
      kid: k.kid,
      privateJwk: k.privateJwk,
      publicJwk: k.publicJwk,
      createdAt: k.createdAt,
      depositedAt: k.depositedAt,
    })),
    meta,
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
  if (!payload.keys.length) {
    log("no local keys to export", "warn");
    return;
  }
  const passphrase = prompt("vault passphrase");
  if (!passphrase) return;
  const encrypted = await encryptVault(JSON.stringify(payload), passphrase);
  downloadJson("0xa09f-identity.json", encrypted);
  log(`exported encrypted vault with ${payload.keys.length} key(s)`);
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
    });
  }
  let metaCount = 0;
  for (const m of payload.meta || []) {
    if (!m?.id) continue;
    await idbPut(META_STORE, m);
    metaCount += 1;
  }
  await loadKeys();
  await renderInbox();
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

async function togglePoolPanel() {
  const panel = $("pool-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) await refreshPoolKeys();
}

async function refreshPoolKeys() {
  const { keys = [], size = 0 } = await api("/api/pool/keys?limit=200");
  $("pool-count").textContent = `(${size} in pool)`;
  const list = $("pool-keys");
  list.innerHTML = "";
  if (!keys.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "no keys in pool";
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

async function init() {
  db = await openDB();
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
    await api("/api/health");
    log("relay online");
  } catch (e) {
    log(`relay offline: ${e.message}`, "err");
  }
  checkBottles().catch((e) => log(`auto-check: ${e.message}`, "err"));
}

init().catch((e) => log(`boot: ${e.message}`, "err"));
