import { api } from "./api";
import {
  BOTTLE_QUOTA,
  MAX_LOCAL_KEYS,
  MAX_THREAD_DEPTH,
  REPLY_PREFIX,
  SELF_PREFIX,
  decodePlaintext,
  decryptPayload,
  derivePickupProof,
  deriveReplyKeyPair,
  encodePlaintext,
  makeKeyRecord,
  unwrapSessionKey,
  wrapSessionKey,
} from "./crypto";
import { idbGet, idbGetAll, idbPut, KEY_STORE, META_STORE } from "./idb";
import { claimUsername, deriveUserId, getIdentity, getIdentityRecord, resetIdentityCache } from "./identity";
import type {
  BlockEntry,
  Bottle,
  Claim,
  Envelope,
  JWK,
  KeyRecord,
  Plain,
  PoolKeyInfo,
  ThreadRecord,
} from "./types";
import { b64ToBytes, bytesToB64, randBytes, textBytes } from "./util";

export interface LogEntry {
  id: number;
  time: string;
  msg: string;
  cls: "" | "warn" | "err";
}

export interface AppState {
  ready: boolean;
  keys: KeyRecord[];
  ownPoolKids: Set<string>;
  activePoolKeys: number | null;
  poolKeys: PoolKeyInfo[] | null;
  poolSize: number | null;
  blocks: BlockEntry[] | null;
  records: ThreadRecord[];
  logs: LogEntry[];
}

let state: AppState = {
  ready: false,
  keys: [],
  ownPoolKids: new Set(),
  activePoolKeys: null,
  poolKeys: null,
  poolSize: null,
  blocks: null,
  records: [],
  logs: [],
};

const listeners = new Set<() => void>();
let logId = 0;

function setState(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getState(): AppState {
  return state;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function log(msg: string, cls: LogEntry["cls"] = "") {
  const entry: LogEntry = {
    id: ++logId,
    time: new Date().toLocaleTimeString(),
    msg,
    cls,
  };
  setState({ logs: [...state.logs.slice(-199), entry] });
}

// ---------- keys ----------

export async function loadKeys() {
  const keyRecords = (await idbGetAll<KeyRecord>(KEY_STORE)) as KeyRecord[];
  keyRecords.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  setState({ keys: keyRecords });
  await refreshActivePoolKeys();
}

function keyByKidMap(): Map<string, KeyRecord> {
  return new Map(state.keys.map((k) => [k.kid, k]));
}

export async function refreshActivePoolKeys() {
  const count = await ownKeysInPool();
  setState({ activePoolKeys: count });
}

async function ownKeysInPool(): Promise<number> {
  try {
    const { kids = [] } = await api<{ kids?: string[] }>("/api/pool/kids?limit=20000", { auth: false });
    const pool = new Set(kids);
    const own = new Set(state.keys.filter((k) => pool.has(k.kid)).map((k) => k.kid));
    setState({ ownPoolKids: own });
    return own.size;
  } catch {
    setState({ ownPoolKids: new Set() });
    return state.keys.filter((k) => k.depositedAt).length;
  }
}

export function formatTTL(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "expires in —";
  const s = Math.round(seconds);
  const fmt = (n: number) => String(Math.round(n * 100) / 100);
  const unit = (value: number, singular: string, plural: string) =>
    `${fmt(value)} ${value === 1 ? singular : plural}`;
  if (s >= 86400) return `expires in ${unit(s / 86400, "day", "days")}`;
  if (s >= 3600) return `expires in ${unit(s / 3600, "hour", "hours")}`;
  if (s >= 60) return `expires in ${unit(s / 60, "minute", "minutes")}`;
  return `expires in ${s} second${s === 1 ? "" : "s"}`;
}

export function formatExpiry(expiresAt?: number | null): string {
  if (!expiresAt) return "no expiry";
  const ms = expiresAt * 1000 - Date.now();
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  if (s >= 86400) return `expires in ${Math.floor(s / 86400)}d`;
  if (s >= 3600) return `expires in ${Math.floor(s / 3600)}h`;
  if (s >= 60) return `expires in ${Math.floor(s / 60)}m`;
  return `expires in ${s}s`;
}

export function readTTLSeconds(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(2592000, Math.max(60, n));
}

function depositTTLSeconds(ttlRaw: string): number {
  return readTTLSeconds(ttlRaw) ?? 86400;
}

export async function depositUndeposited(ttlRaw: string): Promise<number> {
  const now = Date.now();
  const ttl = depositTTLSeconds(ttlRaw);
  const pending = state.keys.filter(
    (k) => !k.depositedAt || (k.expiresAt && k.expiresAt <= now)
  );
  if (!pending.length) return 0;
  await api("/api/pool/deposit", {
    method: "POST",
    body: JSON.stringify({
      keys: pending.map((k) => ({
        kid: k.kid,
        publicKey: JSON.stringify(k.publicJwk),
        ttlSeconds: ttl,
      })),
    }),
  });
  const expiresAt = now + ttl * 1000;
  for (const k of pending) {
    k.depositedAt = now;
    k.expiresAt = expiresAt;
    await idbPut(KEY_STORE, k);
  }
  await loadKeys();
  return pending.length;
}

export async function generateAndDeposit(ttlRaw: string) {
  const inPool = await ownKeysInPool();
  if (inPool >= MAX_LOCAL_KEYS) {
    log(`pool key limit reached (${MAX_LOCAL_KEYS}); consumed keys free up slots`, "warn");
    return;
  }
  const rec = await makeKeyRecord();
  await idbPut(KEY_STORE, rec);
  await loadKeys();
  const n = await depositUndeposited(ttlRaw);
  const capLabel = Number.isFinite(MAX_LOCAL_KEYS) ? `/${MAX_LOCAL_KEYS}` : "";
  log(`generated key material; deposited ${n} blind public key(s) (${inPool + n}${capLabel} in pool)`);
}

// ---------- bottles ----------

export async function dropBottle(text: string, ttlRaw: string, retried = false) {
  const trimmed = text.trim();
  if (!trimmed) {
    log("message is empty", "warn");
    return;
  }
  const { size = 0 } = await api<{ size?: number }>("/api/pool/kids?limit=1", { auth: false }).catch(() => ({ size: 0 }));
  if (size < 1) {
    log("bait pool is empty; throw bait first", "err");
    return;
  }
  const fetched = await api<{ keys?: { kid: string; publicKey: string }[] }>("/api/pool/fetch", {
    method: "POST",
    body: JSON.stringify({
      count: BOTTLE_QUOTA,
      exclude: state.keys.map((k) => k.kid),
    }),
  });
  const allPoolKeys = fetched.keys || [];
  const byKid = keyByKidMap();
  const poolKeys = allPoolKeys.filter((pk) => !byKid.has(pk.kid));
  if (poolKeys.length < 1) {
    if (allPoolKeys.length > 0) {
      log("all fetched keys belong to this device; generate keys on another device", "warn");
    } else {
      log("bait pool returned no keys; throw more bait and retry", "err");
    }
    return;
  }

  const bottleId = crypto.randomUUID();
  const identity = await getIdentity();
  const replyPair = await deriveReplyKeyPair(identity.privateJwk, bottleId);
  const sessionKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"]
  );
  const payloadIV = randBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: payloadIV },
    sessionKey,
    textBytes(encodePlaintext(trimmed, replyPair.publicJwk))
  );
  const rawSessionKey = await crypto.subtle.exportKey("raw", sessionKey);

  const envelopes = [];
  for (const pk of poolKeys) {
    const recipientJwk = JSON.parse(pk.publicKey) as JWK;
    const env = await wrapSessionKey(bottleId, recipientJwk, rawSessionKey, pk.kid);
    env.kid = pk.kid;
    envelopes.push(env);
  }
  // Self archive envelope: wraps the session key to our identity key so any
  // device holding it can recover sent plaintext from the server copy.
  // kid is self:<userId> — deterministic across devices so the server-side
  // kids filter can match our own sent bottles without knowing bottle ids.
  const selfKid = `${SELF_PREFIX}${await deriveUserId(identity.publicJwk)}`;
  const selfEnv = await wrapSessionKey(bottleId, identity.publicJwk, rawSessionKey, selfKid);
  selfEnv.kid = selfKid;

  const bottle: Bottle = {
    id: bottleId,
    createdAt: Date.now(),
    depth: 1,
    maxDeliveries: envelopes.length,
    payloadIv: bytesToB64(payloadIV),
    ciphertext: bytesToB64(new Uint8Array(ciphertext)),
    envelopes: [...envelopes, selfEnv],
  };

  try {
    await api("/api/bottles", {
      method: "POST",
      body: JSON.stringify(bottle),
    });
  } catch (e) {
    if ((e as { data?: { error?: string } }).data?.error === "blocked_key_conflict" && !retried) {
      log("some recipients are blocked; refetching pool keys", "warn");
      return dropBottle(text, ttlRaw, true);
    }
    throw e;
  }

  await storeSentRecord(bottleId, {
    id: bottleId,
    createdAt: Date.now(),
    depth: 1,
    maxDeliveries: envelopes.length,
    status: "ACTIVE",
  }, { v: 1, text: trimmed, reply: replyPair.publicJwk }, "");
  await renderInbox();
  log(`dropped bottle ${bottleId} to ${envelopes.length} blind recipients`);
}

export async function replyBottle(parent: ThreadRecord, text: string) {
  const bottle = parent.bottle!;
  const parentPlain = parent.plain!;
  const depth = (bottle.depth || 1) + 1;
  if (depth > MAX_THREAD_DEPTH) {
    log(`thread depth limit reached (${MAX_THREAD_DEPTH})`, "err");
    return;
  }
  if (!parentPlain?.reply) {
    log("parent bottle has no reply address", "err");
    return;
  }
  const bottleId = crypto.randomUUID();
  let replyJwk: JWK | null = null;
  if (depth < MAX_THREAD_DEPTH) {
    const idt = await getIdentity();
    const replyPair = await deriveReplyKeyPair(idt.privateJwk, bottleId);
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
    textBytes(encodePlaintext(text.trim(), replyJwk))
  );
  const rawSessionKey = await crypto.subtle.exportKey("raw", sessionKey);
  const replyKid = `${REPLY_PREFIX}${bottle.id}`;
  const env = await wrapSessionKey(bottleId, parentPlain.reply, rawSessionKey, replyKid);
  env.kid = replyKid;
  const identity = await getIdentity();
  const selfKid = `${SELF_PREFIX}${await deriveUserId(identity.publicJwk)}`;
  const selfEnv = await wrapSessionKey(bottleId, identity.publicJwk, rawSessionKey, selfKid);
  selfEnv.kid = selfKid;
  await api("/api/bottles", {
    method: "POST",
    body: JSON.stringify({
      id: bottleId,
      createdAt: Date.now(),
      depth,
      parentId: bottle.id,
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
    parentId: bottle.id,
    maxDeliveries: 1,
    status: "ACTIVE",
  }, { v: 1, text: text.trim(), reply: replyJwk }, env.kid!);
  await renderInbox();
  log(`replied to ${bottle.id.slice(0, 8)} (depth ${depth}/${MAX_THREAD_DEPTH})`);
}

export async function claimBottle(bottleId: string, kid: string, pickupToken: string): Promise<Claim> {
  return api<Claim>(`/api/bottles/${encodeURIComponent(bottleId)}/pickup`, {
    method: "POST",
    body: JSON.stringify({ kid, pickupToken }),
  });
}

async function storeSentRecord(
  bottleId: string,
  bottle: Bottle,
  plain: Plain,
  kid: string
): Promise<void> {
  await idbPut(META_STORE, {
    id: `sent:${bottleId}`,
    bottle,
    plain,
    kid: kid || "",
    claim: { status: "SENT" },
    caughtAt: Date.now(),
  }).catch(() => {});
}

export async function reportBottle(bottleId: string) {
  const reason = window.prompt("report reason (optional)") || "";
  await api(`/api/bottles/${encodeURIComponent(bottleId)}/report`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
  log(`reported bottle ${bottleId.slice(0, 8)}`);
}

const caughtThisSession = new Set<string>();

export async function checkBottles() {
  let caught = 0;
  let scanned = 0;
  let cursor = "";
  const byKid = keyByKidMap();

  // Recipient filter: ask the server for only bottles addressed to us —
  // pool kids + self:<userId> (own sent bottles) + reply:<parentId> for every
  // thread bottle we already know. With zero known thread records we skip
  // the filter entirely: one bootstrap scan discovers everything, then all
  // later scans stay filtered.
  const metas = (await idbGetAll<ThreadRecord>(META_STORE).catch(() => [])) as ThreadRecord[];
  const knownIds = new Set<string>();
  for (const r of metas) {
    if ((r.id.startsWith("caught:") || r.id.startsWith("sent:")) && r.bottle?.id) {
      knownIds.add(r.bottle.id);
    }
  }
  let kidsParam = "";
  if (knownIds.size > 0) {
    // Only kids still able to receive NEW bottles: currently in-pool keys
    // (consumed/expired kids can never be targeted again — their old bottles
    // are already in local records or covered by the bootstrap scan).
    const liveKids = state.ownPoolKids.size > 0
      ? [...state.ownPoolKids]
      : state.keys.filter((k) => k.depositedAt && (!k.expiresAt || k.expiresAt > Date.now())).map((k) => k.kid);
    const parts: string[] = liveKids;
    const idt = await getIdentity().catch(() => null);
    if (idt?.publicJwk) {
      parts.push(`${SELF_PREFIX}${await deriveUserId(idt.publicJwk)}`);
      for (const bid of [...knownIds].slice(0, 120)) parts.push(`${REPLY_PREFIX}${bid}`);
      kidsParam = parts.join(",");
    }
  }
  const kidsQuery = kidsParam ? `&kids=${encodeURIComponent(kidsParam)}` : "";

  for (let page = 0; page < 100; page++) {
    const { bottles = [], nextCursor = "" } = await api<{ bottles?: Bottle[]; nextCursor?: string }>(
      `/api/bottles?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${kidsQuery}`,
      { auth: false }
    );
    if (!bottles.length) break;
    scanned += bottles.length;
    for (const bottle of bottles) {
      if (caughtThisSession.has(bottle.id)) continue;
      let claimed = false;
      for (const envelope of bottle.envelopes || []) {
        const isSelf = typeof envelope.kid === "string" && envelope.kid.startsWith(SELF_PREFIX);
        let record = envelope.kid && !isSelf ? byKid.get(envelope.kid) : undefined;
        if (!record && !isSelf && typeof envelope.kid === "string" && envelope.kid.startsWith(REPLY_PREFIX)) {
          // stored reply keys (legacy/random) first, then deterministic derive
          const replyRec = await idbGet<ThreadRecord>(META_STORE, envelope.kid).catch(() => null);
          if (replyRec?.privateJwk) {
            record = { privateJwk: replyRec.privateJwk } as KeyRecord;
          } else {
            const parentId = envelope.kid.slice(REPLY_PREFIX.length);
            const idt = await getIdentity().catch(() => null);
            if (idt?.privateJwk && parentId) {
              const kp = await deriveReplyKeyPair(idt.privateJwk, parentId);
              record = { privateJwk: kp.privateJwk } as KeyRecord;
            }
          }
        }
        let privJwk: JWK | undefined = record?.privateJwk;
        if (isSelf) {
          const id = await getIdentity().catch(() => null);
          privJwk = id?.privateJwk;
        }
        if (!privJwk) continue;
        try {
          const rawSession = await unwrapSessionKey(bottle.id, envelope as Envelope, privJwk);
          const plain = decodePlaintext(await decryptPayload(bottle, rawSession));
          if (isSelf) {
            // Our own sent bottle: recover plaintext locally, no pickup claim.
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
            break;
          }
          const { token: pickupToken } = await derivePickupProof(rawSession, bottle.id, envelope.kid || "");
          let claim: Claim;
          try {
            claim = await claimBottle(bottle.id, envelope.kid || "", pickupToken);
          } catch (e) {
            claim = { ok: false, error: (e as Error).message };
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
          // so sibling replies may still need it.
          if (claim?.ok !== false) {
            caughtThisSession.add(bottle.id);
          }
          caught += 1;
          claimed = true;
          log(
            `caught bottle ${bottle.id.slice(0, 8)} (${claim?.status || claim?.error || "claimed"})`,
            claim?.ok === false ? "warn" : ""
          );
          break;
        } catch {
          // not ours or corrupted envelope; keep scanning
        }
      }
      void claimed;
    }
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  await renderInbox();
  await refreshActivePoolKeys();
  log(`checked ${scanned} bottle(s); caught ${caught}`);
}

// ---------- inbox / threads ----------

function isSentRecord(r: ThreadRecord): boolean {
  return typeof r.id === "string" && r.id.startsWith("sent:");
}

export interface ThreadNode {
  rec: ThreadRecord;
  children: ThreadNode[];
}

export interface ThreadBundle {
  roots: ThreadNode[];
  recs: ThreadRecord[];
}

export async function buildThreads(): Promise<ThreadBundle> {
  const all = (await idbGetAll<ThreadRecord>(META_STORE).catch(() => [])) as ThreadRecord[];
  const recs = all
    .filter(
      (r) =>
        typeof r.id === "string" &&
        (r.id.startsWith("caught:") || r.id.startsWith("sent:")) &&
        r.bottle &&
        r.plain
    )
    .sort((a, b) => (a.caughtAt || 0) - (b.caughtAt || 0));
  const byBottle = new Map<string, ThreadRecord>();
  for (const r of recs) {
    const prev = byBottle.get(r.bottle!.id);
    if (!prev || (isSentRecord(prev) && !isSentRecord(r))) byBottle.set(r.bottle!.id, r);
  }
  const unique = [...byBottle.values()].sort((a, b) => (a.caughtAt || 0) - (b.caughtAt || 0));
  const byId = new Map(unique.map((r) => [r.bottle!.id, r]));
  const childrenOf = new Map<string, ThreadRecord[]>();
  const roots: ThreadRecord[] = [];
  for (const r of unique) {
    const pid = r.bottle!.parentId;
    if (pid && byId.has(pid)) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid)!.push(r);
    } else {
      roots.push(r);
    }
  }
  for (const r of unique) caughtThisSession.add(r.bottle!.id);
  const sentIds = new Set(recs.filter(isSentRecord).map((r) => r.bottle!.id));
  void sentIds;

  const toNode = (r: ThreadRecord): ThreadNode => ({
    rec: r,
    children: (childrenOf.get(r.bottle!.id) || []).map(toNode),
  });
  const nodes = roots.map(toNode);
  return { roots: nodes, recs };
}

export async function renderInbox() {
  const { recs } = await buildThreads();
  setState({ records: recs });
}

// ---------- vault ----------

export async function vaultKeysPayload() {
  const keys = await idbGetAll<KeyRecord>(KEY_STORE);
  const meta = await idbGetAll<ThreadRecord>(META_STORE).catch(() => []);
  // Vault v4: secret key material ONLY. No metadata — the server already
  // holds all bottle/thread/user data; the vault just carries the private
  // keys needed to unlock it. publicJwk is omitted (derivable from the
  // private JWK's x/y); deterministic reply keys need no storage at all.
  const identity = meta.find((m) => m?.id === "identity");
  const replies = meta.filter(
    (m) => typeof m?.id === "string" && m.id.startsWith(REPLY_PREFIX) && m.privateJwk
  );
  return {
    version: 4,
    keys: keys.map((k) => ({ kid: k.kid, jwk: k.privateJwk })),
    identity: identity?.privateJwk || null,
    replies: replies.map((m) => ({ id: m.id, jwk: m.privateJwk })),
  };
}

function publicFromPrivate(jwk: JWK): JWK {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

async function encryptVault(plaintext: string, passphrase: string) {
  const salt = randBytes(16);
  const iv = randBytes(12);
  const baseKey = await crypto.subtle.importKey("raw", textBytes(passphrase), "PBKDF2", false, ["deriveKey"]);
  const wrapKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, textBytes(plaintext));
  return {
    v: 1,
    kdf: { name: "PBKDF2", iterations: 200000, hash: "SHA-256", salt: bytesToB64(salt) },
    cipher: "AES-GCM-256",
    iv: bytesToB64(iv),
    ciphertext: bytesToB64(new Uint8Array(ciphertext)),
  };
}

async function decryptVault(blob: {
  kdf: { salt: string; iterations?: number };
  iv: string;
  ciphertext: string;
}, passphrase: string) {
  const salt = b64ToBytes(blob.kdf.salt);
  const iv = b64ToBytes(blob.iv);
  const baseKey = await crypto.subtle.importKey("raw", textBytes(passphrase), "PBKDF2", false, ["deriveKey"]);
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
  return JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportVault() {
  const payload = await vaultKeysPayload();
  // Identity key alone is worth exporting — it preserves the username,
  // auth proofs, reply-key derivation and self-envelope recovery even with
  // zero pool keys.
  const hasIdentity = !!payload.identity;
  if (!payload.keys.length && !hasIdentity) {
    log("no local keys to export", "warn");
    return;
  }
  const passphrase = window.prompt("vault passphrase");
  if (!passphrase) return;
  const encrypted = await encryptVault(JSON.stringify(payload), passphrase);
  downloadJson("saltleak-identity.json", encrypted);
  log(`exported encrypted vault with ${payload.keys.length} pool key(s)`);
}

export async function importVaultFile(file: File) {
  const passphrase = window.prompt("vault passphrase");
  if (!passphrase) return;
  const text = await file.text();
  const blob = JSON.parse(text) as Parameters<typeof decryptVault>[0];
  const payload = (await decryptVault(blob, passphrase)) as {
    version?: number;
    keys?: { kid?: string; jwk?: JWK; privateJwk?: JWK; publicJwk?: JWK; createdAt?: number; depositedAt?: number | null; expiresAt?: number | null }[];
    identity?: JWK | null;
    replies?: { id?: string; jwk?: JWK }[];
    meta?: ThreadRecord[];
  };
  let restored = 0;

  if (payload.version === 4) {
    // v4: pure secret key material — {kid, jwk} pool keys, identity jwk,
    // legacy reply jwks. Everything else is rebuilt from the server.
    for (const k of payload.keys || []) {
      if (!k.kid || !k.jwk) continue;
      await idbPut(KEY_STORE, {
        kid: k.kid,
        privateJwk: k.jwk,
        publicJwk: publicFromPrivate(k.jwk),
        createdAt: Date.now(),
        depositedAt: null,
      });
      restored++;
    }
    if (payload.identity) {
      await idbPut(META_STORE, {
        id: "identity",
        privateJwk: payload.identity,
        publicJwk: publicFromPrivate(payload.identity),
      });
      restored++;
    }
    for (const r of payload.replies || []) {
      if (!r.id || !r.jwk) continue;
      await idbPut(META_STORE, {
        id: r.id,
        privateJwk: r.jwk,
        publicJwk: publicFromPrivate(r.jwk),
        createdAt: Date.now(),
      });
      restored++;
    }
  } else {
    // legacy vault shapes (v1–v3): keys carry full records, meta holds
    // identity + reply records.
    for (const k of payload.keys || []) {
      if (!k.kid || !k.privateJwk || !k.publicJwk) continue;
      await idbPut(KEY_STORE, {
        kid: k.kid,
        privateJwk: k.privateJwk,
        publicJwk: k.publicJwk,
        createdAt: k.createdAt || Date.now(),
        depositedAt: k.depositedAt || null,
        expiresAt: k.expiresAt || null,
      });
      restored++;
    }
    let metaCount = 0;
    for (const m of payload.meta || []) {
      if (!m?.id) continue;
      await idbPut(META_STORE, m);
      metaCount += 1;
    }
    restored += metaCount;
  }
  resetIdentityCache();
  await getIdentity().catch(() => null);
  await loadKeys();
  await renderInbox();
  log(`imported vault with ${restored} key(s) restored`);
}

// ---------- panels ----------

export async function refreshPoolKeys(offset = 0) {
  const { keys = [], size = 0 } = await api<{ keys?: PoolKeyInfo[]; size?: number }>(
    `/api/pool/keys?limit=500&offset=${offset}`,
    { auth: false }
  );
  const prev = offset === 0 ? [] : (getState().poolKeys ?? []);
  setState({ poolKeys: [...prev, ...keys], poolSize: size });
}

export async function resolveUserTarget(input: string): Promise<string | null> {
  const v = input.trim();
  if (!v) return null;
  if (v.startsWith("u_")) return v;
  const { user } = await api<{ user?: { id: string } }>(`/api/users/by-username/${encodeURIComponent(v)}`);
  return user?.id || null;
}

export async function refreshBlocks() {
  const { blocks = [] } = await api<{ blocks?: BlockEntry[] }>("/api/me/blocks");
  setState({ blocks });
}

export async function unblockUser(blockedUserId: string) {
  await api(`/api/users/${encodeURIComponent(blockedUserId)}/block`, { method: "DELETE" });
  log(`unblocked ${blockedUserId.slice(0, 12)}…`);
  await refreshBlocks();
}

export async function claimUsernameUI(username: string) {
  await claimUsername(username);
  log(`claimed @${username}`);
}

export async function blockOrReportUser(kind: "block" | "report", targetInput: string) {
  const id = await getIdentity();
  if (!id.username) {
    log("claim a username first", "warn");
    return;
  }
  const target = await resolveUserTarget(targetInput);
  if (!target) {
    log("user not found", "warn");
    return;
  }
  if (target === id.userId) {
    log("that is you", "warn");
    return;
  }
  if (kind === "block") {
    await api(`/api/users/${encodeURIComponent(target)}/block`, {
      method: "POST",
      body: JSON.stringify({ reason: "blocked via web" }),
    });
    log(`blocked ${target.slice(0, 12)}… — their keys won't receive your bottles`);
  } else {
    const reason = window.prompt("report reason (optional)") || "";
    await api(`/api/users/${encodeURIComponent(target)}/report`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    log(`reported ${target.slice(0, 12)}…`);
  }
  await refreshBlocks();
}

// ---------- init ----------

export async function init() {
  setState({ ready: false });
  await getIdentity().catch(() => null);
  await loadKeys();
  await renderInbox();
  try {
    await api("/api/health", { auth: false });
    log("relay online");
  } catch (e) {
    log(`relay offline: ${(e as Error).message}`, "err");
  }
  setState({ ready: true });
  checkBottles().catch((e) => log(`auto-check: ${(e as Error).message}`, "err"));
}

export { getIdentityRecord };
