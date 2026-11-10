import { api, API_BASE, getServerOffsetSec, noteServerTime } from "./api";
export { getServerOffsetSec };
import {
  BOTTLE_QUOTA,
  MAX_LOCAL_KEYS,
  MAX_THREAD_DEPTH,
  REPLY_PREFIX,
  SELF_PREFIX,
  decodePlaintext,
  decryptPayload,
  decryptSyncRecord,
  derivePickupProof,
  deriveReplyKeyPair,
  encodePlaintext,
  encryptSyncRecord,
  makeKeyRecord,
  syncRecordKey,
  unwrapSessionKey,
  wrapSessionKey,
} from "./crypto";
import { idbClear, idbDelete, idbGet, idbGetAll, idbPut, KEY_STORE, KV_STORE, META_STORE } from "./idb";
import { claimUsername, computeProof, deriveUserId, fetchNonce, getIdentity, getIdentityRecord, getServerPub, kidProofDigest, resetIdentityCache } from "./identity";
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
  // unix ms of the most recent SSE bottle event — drives the "something
  // bit" toast. 0 until the first event this session.
  lastCatchAt: number;
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
  lastCatchAt: 0,
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
  setState({ logs: [entry, ...state.logs.slice(0, 199)] });
}

// ---------- keys ----------

let profileSynced = false;

// syncProfile reconciles the local identity record with PG — the users
// table is the source of truth for username/userId. Runs once per session
// on load so IndexedDB never drifts from server-side identity.
export async function syncProfile() {
  if (profileSynced) return;
  profileSynced = true;
  try {
    const id = await getIdentity();
    if (!id.username) return; // the username gate forces a claim, which syncs
    const { user } = await api<{ user?: { id?: string; username?: string } }>("/api/me");
    if (!user?.username) return;
    if (user.username !== id.username || (user.id && user.id !== id.userId)) {
      id.username = user.username;
      id.userId = user.id || id.userId;
      await idbPut(META_STORE, id);
      log(`profile synced: @${user.username}`);
    }
  } catch {
    profileSynced = false; // retry on next load
  }
}

export async function loadKeys() {
  const keyRecords = (await idbGetAll<KeyRecord>(KEY_STORE)) as KeyRecord[];
  keyRecords.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  setState({ keys: keyRecords });
  await refreshActivePoolKeys();
  syncProfile().catch(() => {});
  pullSyncRecords().catch(() => {});
}

// ---------- encrypted per-record sync ----------
// readAt/dismissedAt sync across devices as individual AES-GCM records.
// Storage keys are salted SHA-256 hashes (server can't tell which fields
// exist); blobs carry {fieldKey, ts} ciphertext the server can't read.
// Pulled once per session after loadKeys; pushed (debounced) for dirty
// fields whenever read/dismiss state changes.

// syncReadAt caches read timestamps by meta record id so bottles fetched
// AFTER the pull still land with their read state applied.
const syncReadAt = new Map<string, number>();
const syncDirty = new Set<string>(); // fieldKeys: "<recordId>" reads, "bait:<kid>" dismissals
let syncPulled = false;
let syncPushTimer: ReturnType<typeof setTimeout> | null = null;

function markSyncDirty(fieldKey: string) {
  syncDirty.add(fieldKey);
  scheduleSyncPush();
}

async function syncAuthFields() {
  const id = await getIdentity();
  const userId = await deriveUserId(id.publicJwk);
  const [serverPub, nonce] = await Promise.all([getServerPub(), fetchNonce(userId)]);
  const { ts, proof } = await computeProof(id.privateJwk, serverPub, userId, nonce);
  return {
    publicKey: JSON.stringify(id.publicJwk),
    userId,
    ts,
    nonce,
    proof,
  };
}

interface SyncRemoteRecord {
  key: string;
  blob: string;
  updatedAt?: number; // server unix seconds
}

async function pullSyncRecords() {
  if (syncPulled) return;
  syncPulled = true;
  // Delta pull: only records written after our last watermark. First pull
  // (no cursor) fetches everything. A 1s overlap guards same-second writes.
  const cursor = await idbGet<{ ts?: number }>(KV_STORE, "sync:cursor").catch(() => null);
  const since = cursor?.ts ? Math.max(0, cursor.ts - 1) : 0;
  const auth = await syncAuthFields();
  const res = await api<{ records?: SyncRemoteRecord[] }>("/api/sync/records", {
    method: "POST",
    body: JSON.stringify({ ...auth, since }),
  });
  const records = res?.records || [];
  let maxUpdated = since;
  for (const r of records) {
    if (r.updatedAt && r.updatedAt > maxUpdated) maxUpdated = r.updatedAt;
  }
  if (records.length) {
    await idbPut(KV_STORE, { id: "sync:cursor", ts: maxUpdated }).catch(() => {});
  }
  if (!records.length) return;
  const id = await getIdentity();
  const meta = (await idbGetAll<ThreadRecord>(META_STORE).catch(() => [])) as ThreadRecord[];
  const byId = new Map(meta.map((r) => [r.id, r]));
  let keysDirty = false;
  for (const rec of records) {
    const plain = await decryptSyncRecord(id.privateJwk, rec.blob);
    if (!plain) continue;
    if (plain.k.startsWith("bait:")) {
      const kid = plain.k.slice(5);
      const k = state.keys.find((k) => k.kid === kid);
      if (k && plain.t > (k.dismissedAt || 0)) {
        k.dismissedAt = plain.t;
        keysDirty = true;
        await idbPut(KEY_STORE, k).catch(() => {});
      }
      continue;
    }
    // read receipt: field key is the meta record id ("caught:x"/"sent:x")
    syncReadAt.set(plain.k, Math.max(syncReadAt.get(plain.k) || 0, plain.t));
    const local = byId.get(plain.k);
    if (local && plain.t > (local.readAt || 0)) {
      local.readAt = plain.t;
      local.repliesSeenAt = Math.max(local.repliesSeenAt || 0, plain.t);
      await idbPut(META_STORE, local).catch(() => {});
    }
  }
  if (keysDirty) setState({ keys: [...state.keys] });
  await renderInbox();
}

async function pushSyncRecords() {
  const id = await getIdentity().catch(() => null);
  if (!id?.privateJwk || !syncDirty.size) return;
  const userId = await deriveUserId(id.publicJwk);
  const fields = [...syncDirty];
  syncDirty.clear();
  const records: { key: string; blob: string }[] = [];
  for (const fieldKey of fields) {
    let ts = 0;
    if (fieldKey.startsWith("bait:")) {
      ts = state.keys.find((k) => k.kid === fieldKey.slice(5))?.dismissedAt || 0;
    } else {
      const rec = await idbGet<ThreadRecord>(META_STORE, fieldKey).catch(() => null);
      ts = rec?.readAt || 0;
    }
    if (!ts) continue;
    const [key, blob] = await Promise.all([
      syncRecordKey(userId, fieldKey),
      encryptSyncRecord(id.privateJwk, fieldKey, ts),
    ]);
    records.push({ key, blob });
  }
  if (!records.length) return;
  const auth = await syncAuthFields();
  // chunk to stay well under request limits
  for (let i = 0; i < records.length; i += 200) {
    await api("/api/sync/records", {
      method: "POST",
      body: JSON.stringify({ ...auth, records: records.slice(i, i + 200) }),
    });
  }
}

function scheduleSyncPush() {
  if (syncPushTimer) return;
  syncPushTimer = setTimeout(() => {
    syncPushTimer = null;
    pushSyncRecords().catch(() => {});
  }, 2000);
}

function keyByKidMap(): Map<string, KeyRecord> {
  return new Map(state.keys.map((k) => [k.kid, k]));
}

export async function refreshActivePoolKeys() {
  const count = await ownKeysInPool();
  setState({ activePoolKeys: count });
}

// baitStatus derives the persisted pool-state of a key record. "lost" is only
// assigned by fetchPoolStatus (server-verified absent-but-alive); locally we
// can't distinguish eaten from lost without asking the server.
export type BaitStatus = "pending" | "active" | "eaten" | "expired" | "lost";

export function baitStatus(k: KeyRecord, inPool?: boolean): BaitStatus {
  if (!k.depositedAt) return "pending";
  if (k.expiresAt && k.expiresAt <= Date.now()) return "expired";
  if (inPool ?? ownPoolKidsHas(k.kid)) return "active";
  return "eaten";
}

function ownPoolKidsHas(kid: string): boolean {
  return state.ownPoolKids.has(kid);
}

// syncBaitStatuses recomputes status for every key after a pool refresh and
// persists the ones that changed, so IndexedDB always carries the last known
// state even across reloads.
async function syncBaitStatuses(inPool: Set<string>): Promise<void> {
  const now = Date.now();
  const changed: KeyRecord[] = [];
  const next = state.keys.map((k) => {
    let s: BaitStatus;
    if (!k.depositedAt) s = "pending";
    else if (k.expiresAt && k.expiresAt <= now) s = "expired";
    else if (inPool.has(k.kid)) s = "active";
    else s = k.status === "lost" ? "lost" : "eaten";
    if (s === k.status) return k;
    const rec = { ...k, status: s };
    changed.push(rec);
    return rec;
  });
  if (!changed.length) return;
  setState({ keys: next });
  await Promise.all(changed.map((k) => idbPut(KEY_STORE, k)));
}

async function ownKeysInPool(): Promise<number> {
  try {
    const { kids = [] } = await api<{ kids?: string[] }>("/api/pool/kids?limit=20000", { auth: false });
    const pool = new Set(kids);
    const own = new Set(state.keys.filter((k) => pool.has(k.kid)).map((k) => k.kid));
    setState({ ownPoolKids: own });
    await syncBaitStatuses(own);
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
  // Owner tag = hash of our identity pubkey: the pool hands out at most one
  // key per owner per fetch, so a single cast can't drain several of our
  // keys. Self-declared and pseudonymous — spoofing only skews our own odds.
  const idt = await getIdentity().catch(() => null);
  const owner = idt?.publicJwk ? await deriveUserId(idt.publicJwk) : "";
  await api("/api/pool/deposit", {
    method: "POST",
    body: JSON.stringify({
      keys: pending.map((k) => ({
        kid: k.kid,
        publicKey: JSON.stringify(k.publicJwk),
        ttlSeconds: ttl,
        tzOffset: -new Date().getTimezoneOffset(),
        owner,
      })),
    }),
  });
  const expiresAt = now + ttl * 1000;
  for (const k of pending) {
    k.depositedAt = now;
    k.expiresAt = expiresAt;
    k.status = "active";
    await idbPut(KEY_STORE, k);
  }
  await loadKeys();
  // Refresh the browsable pool list so a just-deposited key shows up
  // without a page reload.
  refreshPoolKeys(0).catch(() => {});
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
      // Multi-recipient cast: up to BOTTLE_QUOTA keys, but the pool fetch
      // dedupes by owner tag so a single cast takes at most one key per
      // user — it can't drain several keys deposited by the same person.
      count: BOTTLE_QUOTA,
      exclude: state.keys.map((k) => k.kid),
      tzOffset: -new Date().getTimezoneOffset(),
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

  // createdAt in unix seconds — the unit the server stores and the unit
  // lastChildAt stats use, so inbox ordering stays consistent.
  const bottle: Bottle = {
    id: bottleId,
    createdAt: Math.floor(Date.now() / 1000),
    depth: 1,
    rootId: "",
    maxDeliveries: envelopes.length,
    payloadIv: bytesToB64(payloadIV),
    ciphertext: bytesToB64(new Uint8Array(ciphertext)),
    envelopes: [...envelopes, selfEnv],
  };

  // Optimistic: the sent record renders immediately; the POST reconciles
  // in the background and rolls back the local copy on failure.
  await storeSentRecord(bottleId, {
    id: bottleId,
    createdAt: Math.floor(Date.now() / 1000),
    depth: 1,
    rootId: "",
    maxDeliveries: envelopes.length,
    status: "ACTIVE",
  }, { v: 1, text: trimmed, reply: replyPair.publicJwk }, "");
  await renderInbox();
  // New bottle id → new reply:<id> kid — resubscribe SSE immediately so
  // replies to it notify us without waiting for the 60s reconnect.
  connectEvents().catch(() => {});
  log(`dropped bottle ${bottleId} to ${envelopes.length} blind recipients`);
  api("/api/bottles", {
    method: "POST",
    body: JSON.stringify(bottle),
  }).catch(async (e) => {
    await idbDelete(META_STORE, `sent:${bottleId}`).catch(() => {});
    await renderInbox();
    const err = (e as { data?: { error?: string } }).data?.error;
    if (err === "blocked_key_conflict" && !retried) {
      log("some recipients are blocked; refetching pool keys", "warn");
      dropBottle(text, ttlRaw, true).catch(() => {});
      return;
    }
    log(`cast failed: ${(e as Error).message}`, "warn");
  });
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
  // rootId = the thread's first message id: inherit the parent's rootId,
  // or use the parent's own id when replying to a root (or a legacy reply
  // that predates the field).
  const rootId = bottle.rootId || bottle.id;
  // Optimistic: show the reply immediately; the POST reconciles in the
  // background and removes the local record if the server rejects it.
  await storeSentRecord(bottleId, {
    id: bottleId,
    createdAt: Math.floor(Date.now() / 1000),
    depth,
    parentId: bottle.id,
    rootId,
    maxDeliveries: 1,
    status: "ACTIVE",
  }, { v: 1, text: text.trim(), reply: replyJwk }, env.kid!);
  await renderInbox();
  connectEvents().catch(() => {});
  log(`replied to ${bottle.id.slice(0, 8)} (depth ${depth}/${MAX_THREAD_DEPTH})`);
  api("/api/bottles", {
    method: "POST",
    body: JSON.stringify({
      id: bottleId,
      createdAt: Math.floor(Date.now() / 1000),
      depth,
      parentId: bottle.id,
      rootId,
      maxDeliveries: 1,
      payloadIv: bytesToB64(payloadIV),
      ciphertext: bytesToB64(new Uint8Array(ciphertext)),
      envelopes: [env, selfEnv],
    }),
  }).catch(async (e) => {
    await idbDelete(META_STORE, `sent:${bottleId}`).catch(() => {});
    await renderInbox();
    const err = (e as { data?: { error?: string } }).data?.error;
    if (err === "blocked_thread") {
      log("reply blocked — a block exists between you and this user", "warn");
      return;
    }
    log(`reply failed: ${(e as Error).message}`, "warn");
  });
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
    repliesSeenAt: Date.now(),
  }).catch(() => {});
}

// dismissEatenBait clears a consumed bait from the bait line: marks any
// unread catches addressed to that kid as read, then stamps dismissedAt on
// the key record so the slot stops rendering. Local-only state.
export async function dismissEatenBait(kid: string) {
  const now = Date.now();
  const all = (await idbGetAll<ThreadRecord>(META_STORE).catch(() => [])) as ThreadRecord[];
  for (const r of all) {
    if (typeof r.id === "string" && r.id.startsWith("caught:") && r.kid === kid && !r.readAt) {
      r.readAt = now;
      await idbPut(META_STORE, r).catch(() => {});
    }
  }
  const k = state.keys.find((k) => k.kid === kid);
  if (k && !k.dismissedAt) {
    k.dismissedAt = now;
    await idbPut(KEY_STORE, k).catch(() => {});
    setState({ keys: [...state.keys] });
  }
  await renderInbox();
  markSyncDirty(`bait:${kid}`);
}

// markBottleDeleted turns local records into placeholders: plaintext is
// stripped (crypto-shredded locally too) but the record stays so threads
// show "[message deleted]" instead of silently vanishing.
async function markBottleDeleted(bottleId: string) {
  for (const prefix of ["caught:", "sent:"]) {
    const rec = await idbGet<ThreadRecord>(META_STORE, `${prefix}${bottleId}`).catch(() => null);
    if (!rec || rec.deleted) continue;
    delete rec.plain;
    rec.deleted = true;
    await idbPut(META_STORE, rec).catch(() => {});
  }
  await renderInbox();
}

// deleteBottle removes the author's own message server-side (crypto-shredded
// tombstone) and marks local records as deleted placeholders. Only bottles
// we sent can be deleted — authorship is enforced server-side via the
// self:<uid> marker.
export async function deleteBottle(bottleId: string) {
  if (!window.confirm("delete this message for everyone? this cannot be undone — recipients will see a tombstone.")) return;
  // Optimistic tombstone: hide the content immediately, restore on failure.
  const backups: ThreadRecord[] = [];
  for (const prefix of ["caught:", "sent:"]) {
    const rec = await idbGet<ThreadRecord>(META_STORE, `${prefix}${bottleId}`).catch(() => null);
    if (rec && !rec.deleted) backups.push(JSON.parse(JSON.stringify(rec)) as ThreadRecord);
  }
  await markBottleDeleted(bottleId);
  try {
    await api(`/api/bottles/${encodeURIComponent(bottleId)}`, { method: "DELETE" });
  } catch (e) {
    for (const rec of backups) await idbPut(META_STORE, rec).catch(() => {});
    await renderInbox();
    log(`delete failed: ${(e as Error).message}`, "warn");
    return;
  }
  log(`deleted bottle ${bottleId.slice(0, 8)}`);
}

const REPORT_CATEGORIES = [
  "spam",
  "harassment",
  "hate speech",
  "illegal content",
  "impersonation",
  "other",
];

function askReportReason(): string {
  const hint = `report category — ${REPORT_CATEGORIES.join(", ")}\n(add details after a dash, e.g. "spam — crypto scam")`;
  const raw = (window.prompt(hint) || "").trim();
  if (!raw) return "other";
  const first = raw.split(/[\s—-]/)[0].toLowerCase();
  const cat = REPORT_CATEGORIES.find((c) => c === first || c.startsWith(first) || first.startsWith(c.split(" ")[0]));
  return cat ? raw.slice(0, 280) : `other — ${raw}`.slice(0, 280);
}

export async function reportBottle(bottleId: string) {
  const reason = askReportReason();
  await api(`/api/bottles/${encodeURIComponent(bottleId)}/report`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
  log(`reported bottle ${bottleId.slice(0, 8)}`);
}

// fetchBottleChildren returns direct replies to a bottle, oldest-first,
// merged from the server's active set and archive.
export async function fetchBottleChildren(parentId: string, token: string, limit = 200): Promise<Bottle[]> {
  const { bottles = [] } = await api<{ bottles?: Bottle[] }>(
    `/api/bottles/${encodeURIComponent(parentId)}/children?token=${encodeURIComponent(token)}&limit=${limit}`,
    { auth: false }
  );
  return bottles;
}

// fetchThreadBottles returns the whole thread subtree (root + all
// descendants) in one request — the server filters by the pop token's kid
// set, so only bottles addressed to kids we proved come back.
export async function fetchThreadBottles(rootId: string, token: string, limit = 500): Promise<Bottle[]> {
  const { bottles = [] } = await api<{ bottles?: Bottle[] }>(
    `/api/bottles/${encodeURIComponent(rootId)}/thread?root=${encodeURIComponent(rootId)}&token=${encodeURIComponent(token)}&limit=${limit}`,
    { auth: false }
  );
  return bottles;
}

// fetchThreadStats returns aggregate reply stats for many thread roots in a
// single request — used for unread badges so the client doesn't have to
// fetch every thread subtree just to know activity changed.
// Server clock offset lives in api.ts — learned from the HTTP Date header
// on every response (and refined by the stats endpoint's `now` field).
// bottle.createdAt/threadLastAt are server-stamped while repliesSeenAt uses
// the local clock, so badge comparisons normalize via getServerOffsetSec.
async function fetchThreadStats(
  roots: string[],
  token: string
): Promise<Record<string, { count: number; lastAt: number }>> {
  const res = await api<{ stats?: Record<string, { count: number; lastAt: number }>; now?: number }>(
    `/api/threads/stats?roots=${encodeURIComponent(roots.join(","))}&token=${encodeURIComponent(token)}`,
    { auth: false }
  );
  if (typeof res.now === "number") {
    noteServerTime(res.now);
  }
  return res.stats || {};
}

const caughtThisSession = new Set<string>();

// catchKidsParam builds the kid set for the inbox scan and SSE subscription:
// deposited pool keys + self:<userId> (own sent bottles). Reply kids are
// deliberately excluded — replies are fetched lazily per thread via
// fetchThreadChildren, so the pop-token kid set stays small and constant no
// matter how many threads exist.
async function catchKidsParam(): Promise<string> {
  const parts = state.keys.filter((k) => k.depositedAt).map((k) => k.kid);
  const idt = await getIdentity().catch(() => null);
  if (!idt?.publicJwk) return "";
  parts.push(`${SELF_PREFIX}${await deriveUserId(idt.publicJwk)}`);
  return parts.join(",");
}

// eventKidsParam extends the inbox kid set with reply:<id> kids for every
// bottle we authored (most recent 200). The SSE subscription uses it so the
// server pushes an event the moment a reply addressed to our reply key
// lands — replies otherwise never trigger events and chats feel dead.
// The inbox scan keeps using catchKidsParam: reply bottles belong to their
// thread, not the root list.
async function eventKidsParam(): Promise<string> {
  const base = await catchKidsParam();
  const parts = base ? base.split(",") : [];
  const meta = await idbGetAll<ThreadRecord>(META_STORE).catch(() => [] as ThreadRecord[]);
  const replyKids = meta
    .filter((m) => typeof m.id === "string" && m.id.startsWith("sent:") && m.bottle?.id)
    .sort((a, b) => (b.bottle?.createdAt || 0) - (a.bottle?.createdAt || 0))
    .slice(0, 200)
    .map((m) => `${REPLY_PREFIX}${m.bottle!.id}`);
  return [...parts, ...replyKids].join(",");
}

// ---------- proof-of-possession ----------
// Bottle listings require a pop token: the client proves control of each
// kid's private key (ECDH challenge vs the server identity key) and gets a
// short-lived token bound to exactly that kid set.

// replyPrivateJwkCandidates returns private JWK candidates for a reply:
// kid, best first. Reply keys are deterministic per (identity, parent
// bottle), but legacy vault imports can carry stored reply:<id> records
// whose key doesn't match — the parent's plaintext embeds the reply
// pubkey replies are wrapped to, so candidates are ordered by whose
// public half (x/y) matches it.
async function replyPrivateJwkCandidates(kid: string): Promise<JWK[]> {
  const parentId = kid.slice(REPLY_PREFIX.length);
  const out: JWK[] = [];
  const seen = new Set<string>();
  const push = (j: JWK | null | undefined) => {
    if (j && j.kty === "EC" && j.crv === "P-256" && j.d && !seen.has(j.d)) {
      seen.add(j.d);
      out.push(j);
    }
  };
  const idt = await getIdentity().catch(() => null);
  if (idt?.privateJwk && parentId) {
    try {
      push((await deriveReplyKeyPair(idt.privateJwk, parentId)).privateJwk);
    } catch (e) {
      log(`pop proof: reply key derive failed for ${kid.slice(0, 24)}: ${(e as Error).message}`, "warn");
    }
  }
  const stored = await idbGet<ThreadRecord>(META_STORE, kid).catch(() => null);
  push(stored?.privateJwk);
  const parentRec =
    (await idbGet<ThreadRecord>(META_STORE, `sent:${parentId}`).catch(() => null)) ??
    (await idbGet<ThreadRecord>(META_STORE, `caught:${parentId}`).catch(() => null));
  const target = parentRec?.plain?.reply;
  if (target?.x && target?.y) {
    const matchIdx = out.findIndex((c) => c.x === target.x && c.y === target.y);
    log(
      `reply keys ${kid.slice(0, 24)}: ${out.length} candidates, parentPubkey match=${matchIdx}`,
      matchIdx < 0 ? "warn" : ""
    );
    out.sort(
      (a, b) =>
        Number(b.x === target.x && b.y === target.y) - Number(a.x === target.x && a.y === target.y)
    );
  } else {
    log(`reply keys ${kid.slice(0, 24)}: ${out.length} candidates, no parent reply pubkey`, "warn");
  }
  return out;
}

async function privateJwkForKid(kid: string): Promise<JWK | null> {
  if (kid.startsWith(SELF_PREFIX)) {
    const idt = await getIdentity().catch(() => null);
    return idt?.privateJwk ?? null;
  }
  if (kid.startsWith(REPLY_PREFIX)) {
    const cands = await replyPrivateJwkCandidates(kid);
    if (!cands.length) {
      const idt = await getIdentity().catch(() => null);
      if (!idt?.privateJwk) log(`pop proof: no identity for ${kid.slice(0, 24)}`, "warn");
    }
    return cands[0] ?? null;
  }
  const rec = state.keys.find((k) => k.kid === kid);
  return rec?.privateJwk ?? null;
}

// popTokens caches one token per kid-set signature: the inbox set (pool +
// self) and each lazily-fetched thread set (inbox kids + reply:<parentId>)
// coexist without evicting each other.
const popTokens = new Map<string, { token: string; exp: number; verified: Set<string> }>();
const sharedBitsCache = new Map<string, ArrayBuffer>();

async function popTokenFor(kids: string[]): Promise<string | null> {
  if (!kids.length) return null;
  const kidsKey = [...kids].sort().join(",");
  // Reuse the cached token only while it still covers every kid we care
  // about. Kids the server could not verify yet (e.g. a reply key whose
  // first bottle just landed, or a legacy key missing from the registry)
  // force a fresh proof round so their bottles aren't invisible for the
  // whole token lifetime.
  const cached = popTokens.get(kidsKey);
  if (
    cached &&
    cached.exp > Date.now() &&
    kids.every((k) => cached.verified.has(k))
  ) {
    return cached.token;
  }
  const serverPub = await getServerPub();

  // The server's verified-kid memory is ephemeral (Redis popset, 7d TTL,
  // lost on rebuild) while our pop:verified cache is persistent — when they
  // diverge the first token covers only self: and the inbox looks empty.
  // So after each issuance, if the token doesn't cover every requested kid,
  // retry once forcing proofs for the missing kids (+ self: to re-bind the
  // identity) instead of waiting for the next refresh to self-heal.
  let forceKids: Set<string> | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const proofs: Record<string, { ts: number; proof: string }> = {};
    // The server remembers kids it has already verified under this identity
    // (bound via the self:<userId> proof), so we only re-prove kids it has
    // never seen — usually just newly deposited bait. When everything is
    // already verified we still send one proof (self preferred) because the
    // server requires at least one valid proof per issuance.
    const knownVerified = forceKids ? new Set<string>() : await loadPopVerified();
    const toProve = forceKids
      ? [...forceKids]
      : kids.filter((k) => !knownVerified.has(k));
    if (!toProve.length) {
      toProve.push(kids.find((k) => k.startsWith(SELF_PREFIX)) ?? kids[0]);
    }
    // Always prove self:<userId> when present: the server only merges the
    // remembered popset into the issued token when a self: kid verifies in
    // the SAME request. Without it a reply-only proof round issues a token
    // covering just that kid, and the next round's popset merge silently
    // drops it — children then filter out our own replies.
    const selfToProve = kids.find((k) => k.startsWith(SELF_PREFIX));
    if (selfToProve && !toProve.includes(selfToProve)) toProve.push(selfToProve);
    if (toProve.some((k) => k.startsWith(REPLY_PREFIX))) {
      log(`pop proof: attempt=${attempt} toProve=${toProve.length} replyKids=[${toProve.filter((k) => k.startsWith(REPLY_PREFIX)).join(",")}]`, "warn");
    }
    // The ECDH shared secret per kid is time-invariant — cache it so repeat
    // proof rounds only recompute the cheap SHA-256 digest, not key agreement.
    await Promise.all(
      toProve.map(async (kid) => {
        const priv = await privateJwkForKid(kid);
        if (!priv) return;
        try {
          let shared = sharedBitsCache.get(kid);
          if (!shared) {
            const privKey = await crypto.subtle.importKey(
              "jwk",
              priv,
              { name: "ECDH", namedCurve: "P-256" },
              false,
              ["deriveBits"]
            );
            shared = await crypto.subtle.deriveBits({ name: "ECDH", public: serverPub }, privKey, 256);
            sharedBitsCache.set(kid, shared);
          }
          const ts = Math.floor(Date.now() / 1000);
          proofs[kid] = { ts, proof: await kidProofDigest(shared, kid, ts) };
        } catch (e) {
          log(`pop proof: crypto failed for ${kid.slice(0, 24)}: ${(e as Error).message}`, "warn");
        }
      })
    );
    if (toProve.some((k) => k.startsWith(REPLY_PREFIX))) {
      const replyProofs = Object.keys(proofs).filter((k) => k.startsWith(REPLY_PREFIX));
      log(`pop proof: generated ${Object.keys(proofs).length}/${toProve.length} proofs, replyProofs=[${replyProofs.join(",")}]`, replyProofs.length ? "" : "warn");
    }
    const { token, kids: verifiedKids, expiresIn } = await api<{
      token?: string;
      kids?: string[];
      expiresIn?: number;
    }>("/api/auth/pop-token", { method: "POST", body: JSON.stringify({ kids, proofs }) });
    if (!token) return null;
    const verified = new Set(verifiedKids || []);
    popTokens.set(kidsKey, {
      token,
      exp: Date.now() + ((expiresIn || 600) - 60) * 1000,
      verified,
    });
    // Server is authoritative for the verified set — replace, don't merge,
    // so a flushed server-side set self-heals on the next round.
    await idbPut(KV_STORE, { id: "pop:verified", kids: verifiedKids || [] }).catch(() => {});
    const missing = kids.filter((k) => !verified.has(k));
    if (!missing.length) return token;
    // Force proofs for exactly the kids the server couldn't cover — plus
    // self: so the identity binding (and popset expansion) is re-established
    // even when the server forgot everything.
    forceKids = new Set(missing);
    const selfKid = kids.find((k) => k.startsWith(SELF_PREFIX));
    if (selfKid) forceKids.add(selfKid);
  }
  // Second token still doesn't cover every kid (e.g. an unprovable legacy
  // key) — return it anyway; the covered subset still works.
  return popTokens.get(kidsKey)?.token ?? null;
}

async function loadPopVerified(): Promise<Set<string>> {
  const rec = await idbGet<{ kids?: string[] }>(KV_STORE, "pop:verified").catch(() => null);
  return new Set(rec?.kids || []);
}

// applyBottleStats persists the server's per-bottle reply aggregates
// (childCount/lastChildAt) onto local records so the inbox can badge and
// sort threads by reply activity without fetching children eagerly.
async function applyBottleStats(bottle: Bottle) {
  if (bottle.status === "DELETED") return;
  const hasChild = bottle.lastChildAt || bottle.childCount;
  const hasThread = bottle.threadLastAt || bottle.threadCount;
  if (!hasChild && !hasThread) return;
  // Direct-child stats belong to this bottle's own record; thread aggregates
  // belong to the thread ROOT's record (rootId, or the bottle itself when
  // it's a root) so inbox badges reflect activity at any depth.
  const targets: { id: string; child: boolean; thread: boolean }[] = [];
  if (hasChild) targets.push({ id: bottle.id, child: true, thread: false });
  if (hasThread) {
    const rootId = bottle.rootId || bottle.id;
    if (targets.some((t) => t.id === rootId)) {
      targets.find((t) => t.id === rootId)!.thread = true;
    } else {
      targets.push({ id: rootId, child: false, thread: true });
    }
  }
  for (const t of targets) {
    for (const prefix of ["caught:", "sent:"]) {
      const rec = await idbGet<ThreadRecord>(META_STORE, `${prefix}${t.id}`).catch(() => null);
      if (!rec) continue;
      let dirty = false;
      if (t.child) {
        if (bottle.childCount != null && rec.childCount !== bottle.childCount) {
          rec.childCount = bottle.childCount;
          dirty = true;
        }
        if (bottle.lastChildAt && rec.lastChildAt !== bottle.lastChildAt) {
          rec.lastChildAt = bottle.lastChildAt;
          dirty = true;
        }
      }
      if (t.thread) {
        if (bottle.threadCount != null && rec.threadCount !== bottle.threadCount) {
          rec.threadCount = bottle.threadCount;
          dirty = true;
        }
        if (bottle.threadLastAt && rec.threadLastAt !== bottle.threadLastAt) {
          rec.threadLastAt = bottle.threadLastAt;
          dirty = true;
        }
      }
      if (dirty) await idbPut(META_STORE, rec).catch(() => {});
    }
  }
}

// processBottle tries every envelope of a fetched bottle against our local
// keys and stores the first successful decryption as a caught:/sent:
// record. Returns true when a new record was written this session.
async function processBottle(bottle: Bottle, byKid: Map<string, KeyRecord>): Promise<boolean> {
  if (caughtThisSession.has(bottle.id)) return false;
  // Tombstoned bottles propagate through listings so clients drop local
  // copies even if they missed the SSE delete event.
  if (bottle.status === "DELETED") {
    await markBottleDeleted(bottle.id);
    return false;
  }
  // Already decrypted locally? Skip the ECDH unwrap + AES-GCM decrypt +
  // claim round-trip — the overlap window re-scans recent bottles every
  // session and this is the dominant per-bottle cost. Records whose claim
  // failed (ok === false) are retried so transient claim errors heal.
  const existing =
    (await idbGet<ThreadRecord>(META_STORE, `caught:${bottle.id}`).catch(() => null)) ??
    (await idbGet<ThreadRecord>(META_STORE, `sent:${bottle.id}`).catch(() => null));
  if (existing?.plain && existing.claim?.ok !== false) {
    caughtThisSession.add(bottle.id);
    // Reconcile the server-stamped createdAt onto the local record: our
    // optimistic sent: copy carries the client clock, and unread-badge math
    // compares it against server timestamps — without this our own replies
    // can look "newer than ourselves" whenever send+receive crosses a
    // second boundary.
    if (existing.bottle && bottle.createdAt && existing.bottle.createdAt !== bottle.createdAt) {
      existing.bottle.createdAt = bottle.createdAt;
      await idbPut(META_STORE, existing).catch(() => {});
    }
    return false;
  }
  for (const envelope of bottle.envelopes || []) {
    const isSelf = typeof envelope.kid === "string" && envelope.kid.startsWith(SELF_PREFIX);
    // Private-key candidates for this envelope, best first. Reply kids can
    // have both a deterministic key and a stale stored one — try each
    // until the wrap actually unwraps.
    let privJwks: JWK[] = [];
    if (isSelf) {
      const id = await getIdentity().catch(() => null);
      if (id?.privateJwk) privJwks = [id.privateJwk];
    } else if (typeof envelope.kid === "string" && envelope.kid) {
      if (envelope.kid.startsWith(REPLY_PREFIX)) {
        privJwks = await replyPrivateJwkCandidates(envelope.kid);
      } else {
        const rec = byKid.get(envelope.kid);
        if (rec?.privateJwk) privJwks = [rec.privateJwk];
      }
    }
    if (!privJwks.length) {
      if (envelope.kid) {
        log(`decrypt skip ${bottle.id.slice(0, 8)}: no key for kid=${envelope.kid.slice(0, 40)}`, "warn");
      }
      continue;
    }
    try {
      let rawSession: ArrayBuffer | null = null;
      let plain: Plain | null = null;
      for (const jwk of privJwks) {
        try {
          const rs = await unwrapSessionKey(bottle.id, envelope as Envelope, jwk);
          const p = decodePlaintext(await decryptPayload(bottle, rs));
          rawSession = rs;
          plain = p;
          break;
        } catch {
          // wrong candidate key — try the next
        }
      }
      if (!rawSession || !plain) {
        log(
          `decrypt fail ${bottle.id.slice(0, 8)}: kid=${envelope.kid ?? "?"} tried=${privJwks.length} keys depth=${bottle.depth}`,
          "warn"
        );
        continue;
      }
      if (isSelf) {
        // Our own sent bottle: recover plaintext locally, no pickup claim.
        // Merge onto any existing record so repliesSeenAt/readAt/stats
        // survive a server-side re-fetch (e.g. after a vault import).
        const prev = await idbGet<ThreadRecord>(META_STORE, `sent:${bottle.id}`).catch(() => null);
        const remoteRead = syncReadAt.get(`sent:${bottle.id}`);
        await idbPut(META_STORE, {
          ...(prev || {}),
          id: `sent:${bottle.id}`,
          bottle,
          plain,
          kid: envelope.kid,
          claim: { status: "SENT" },
          caughtAt: Date.now(),
          repliesSeenAt: prev?.repliesSeenAt ?? remoteRead ?? 0,
          readAt: prev?.readAt ?? remoteRead,
          lastChildAt: prev?.lastChildAt,
          childCount: prev?.childCount,
        }).catch(() => {});
        caughtThisSession.add(bottle.id);
        return true;
      }
      const { token: pickupToken } = await derivePickupProof(rawSession, bottle.id, envelope.kid || "");
      let claim: Claim;
      try {
        claim = await claimBottle(bottle.id, envelope.kid || "", pickupToken);
      } catch (e) {
        claim = { ok: false, error: (e as Error).message };
      }
      const remoteRead = syncReadAt.get(`caught:${bottle.id}`);
      await idbPut(META_STORE, {
        id: `caught:${bottle.id}`,
        bottle,
        plain,
        kid: envelope.kid,
        claim,
        caughtAt: Date.now(),
        readAt: remoteRead,
        repliesSeenAt: remoteRead,
      }).catch(() => {});
      // note: reply keys are NOT burned at max depth — reply:<parentId>
      // decrypts every reply addressed to that parent (all same depth),
      // so sibling replies may still need it.
      if (claim?.ok !== false) {
        caughtThisSession.add(bottle.id);
      }
      log(
        `caught bottle ${bottle.id.slice(0, 8)} (${claim?.status || claim?.error || "claimed"})`,
        claim?.ok === false ? "warn" : ""
      );
      return true;
    } catch {
      // not ours or corrupted envelope; keep scanning
    }
  }
  return false;
}

// bumpThreadActivity propagates a bottle's activity timestamp to its parent
// and thread-root records. Incremental scans only fetch new bottles, so the
// root record is rarely re-listed — without this, replies at any depth would
// never bump the root's threadLastAt and the unread badge would go stale.
async function bumpThreadActivity(bottle: Bottle) {
  const ts = bottle.createdAt || 0;
  if (!ts) return;
  const targets = new Set<string>();
  if (bottle.parentId) targets.add(bottle.parentId);
  if (bottle.rootId) {
    targets.add(bottle.rootId);
  } else if (bottle.parentId) {
    // Legacy reply without rootId: walk up the parent chain via stored
    // bottle records (bounded) to find the thread root.
    let cur = bottle.parentId;
    for (let hops = 0; cur && hops < 25; hops++) {
      let next = "";
      for (const prefix of ["caught:", "sent:"]) {
        const rec = await idbGet<ThreadRecord>(META_STORE, `${prefix}${cur}`).catch(() => null);
        if (rec?.bottle?.rootId) {
          targets.add(rec.bottle.rootId);
          next = "";
          break;
        }
        if (rec?.bottle?.parentId) next = rec.bottle.parentId;
      }
      if (!next) break;
      targets.add(next);
      cur = next;
    }
  }
  // Replies we authored ourselves must not count as inbound activity —
  // otherwise sending a reply would light the unread badge on the root.
  const ownReply = bottle.parentId
    ? !!(await idbGet<ThreadRecord>(META_STORE, `sent:${bottle.id}`).catch(() => null))
    : false;
  for (const tid of targets) {
    for (const prefix of ["caught:", "sent:"]) {
      const rec = await idbGet<ThreadRecord>(META_STORE, `${prefix}${tid}`).catch(() => null);
      if (!rec) continue;
      let dirty = false;
      if (tid === bottle.parentId && (rec.lastChildAt || 0) < ts) {
        rec.lastChildAt = ts;
        dirty = true;
      }
      // Track the newest reply in this subtree so opening the thread can
      // scroll straight to it. Only replies count (parentId set) and only
      // when this bottle is at least as new as the recorded activity.
      if (bottle.parentId && ts >= (rec.threadLastAt || 0)) {
        rec.lastReplyId = bottle.id;
        dirty = true;
      }
      if (bottle.parentId && !ownReply && (rec.lastInboundAt || 0) < ts) {
        rec.lastInboundAt = ts;
        dirty = true;
      }
      if ((rec.threadLastAt || 0) < ts) {
        rec.threadLastAt = ts;
        dirty = true;
      }
      if (dirty) await idbPut(META_STORE, rec).catch(() => {});
    }
  }
}

// fetchThreadChildren lazily loads direct replies to a bottle. The token
// covers the inbox kid set plus reply:<parentId> — provable only when we
// authored the parent, which is exactly the case where replies are ours to
// read. Children we authored ourselves still match via self:<userId>.
export async function fetchThreadChildren(parentId: string): Promise<number> {
  const root = await catchKidsParam();
  const kids = root ? root.split(",") : [];
  kids.push(`${REPLY_PREFIX}${parentId}`);
  const token = await popTokenFor(kids).catch(() => null);
  if (!token) {
    log(`thread ${parentId.slice(0, 8)}: no pop token — replies not provable`, "warn");
    return 0;
  }
  const children = await fetchBottleChildren(parentId, token).catch(() => []);
  const byKid = keyByKidMap();
  let n = 0;
  for (const b of children) {
    await applyBottleStats(b);
    await bumpThreadActivity(b);
    if (await processBottle(b, byKid)) n++;
  }
  if (children.length && !n) {
    log(`thread ${parentId.slice(0, 8)}: ${children.length} bottle(s) fetched but none decrypted`, "warn");
  } else {
    log(`thread ${parentId.slice(0, 8)}: ${n}/${children.length} repl${children.length === 1 ? "y" : "ies"} loaded`);
  }
  if (n) await renderInbox();
  return n;
}

// fetchThreadInto pulls the whole readable subtree of a thread and processes
// every bottle (stats + decrypt). Shared by openThread (which then marks the
// thread seen) and refreshThreadActivity (background badge/count refresh).
async function fetchThreadInto(threadRoot: string) {
  const meta = await idbGetAll<ThreadRecord>(META_STORE).catch(() => [] as ThreadRecord[]);
  const replyKids = meta
    .filter(
      (m) =>
        typeof m.id === "string" &&
        m.id.startsWith("sent:") &&
        m.bottle &&
        (m.bottle.id === threadRoot || m.bottle.rootId === threadRoot)
    )
    .map((m) => `${REPLY_PREFIX}${m.bottle!.id}`);
  const inbox = await catchKidsParam();
  const kids = [...(inbox ? inbox.split(",") : []), ...replyKids];
  const token = await popTokenFor(kids).catch(() => null);
  if (!token) return;
  const bottles = await fetchThreadBottles(threadRoot, token).catch(() => []);
  const byKid = keyByKidMap();
  for (const b of bottles) {
    await applyBottleStats(b);
    await bumpThreadActivity(b);
    await processBottle(b, byKid);
  }
  await renderInbox();
}

// applyThreadStatsRoot writes server thread aggregates onto the root
// bottle's local records (caught:/sent:) — same targets as applyBottleStats.
async function applyThreadStatsRoot(rootId: string, count: number, lastAt: number) {
  for (const prefix of ["caught:", "sent:"]) {
    const rec = await idbGet<ThreadRecord>(META_STORE, `${prefix}${rootId}`).catch(() => null);
    if (!rec) continue;
    let dirty = false;
    if (count > 0 && rec.threadCount !== count) {
      rec.threadCount = count;
      dirty = true;
    }
    if (lastAt > 0 && rec.threadLastAt !== lastAt) {
      rec.threadLastAt = lastAt;
      dirty = true;
    }
    if (dirty) await idbPut(META_STORE, rec).catch(() => {});
  }
}

const normTs = (v: number) => (v > 1e11 ? Math.floor(v / 1000) : v);

// Throttle: checkBottles can fire on every SSE event, but the stats poll
// (and any fallback subtree fetches) only needs to run periodically.
let lastActivityRefresh = 0;
const ACTIVITY_REFRESH_MS = 30_000;

// Force-refresh scheduling for SSE bottle events: replies addressed to our
// reply kids arrive as events too, so a forced stats+thread refresh makes
// open chats update without waiting for the 30s throttle.
let activityTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleActivityRefresh() {
  if (activityTimer) return;
  activityTimer = setTimeout(() => {
    activityTimer = null;
    refreshThreadActivity(true).catch(() => {});
  }, 500);
}

// refreshThreadActivity keeps unread badges and reply data fresh for threads
// we participate in. One bulk stats request updates threadLastAt on every
// followed root; only threads whose activity actually advanced get their
// subtree fetched (to decrypt new replies for counts/details).
export async function refreshThreadActivity(force = false) {
  const now = Date.now();
  if (!force && now - lastActivityRefresh < ACTIVITY_REFRESH_MS) return;
  lastActivityRefresh = now;
  const meta = await idbGetAll<ThreadRecord>(META_STORE).catch(() => [] as ThreadRecord[]);
  const lastAtByRoot = new Map<string, number>();
  const participated = new Set<string>();
  for (const m of meta) {
    if (!m.bottle) continue;
    const root = m.bottle.rootId || (m.bottle.parentId ? "" : m.bottle.id);
    if (!root) continue;
    const last = normTs(m.threadLastAt || m.lastChildAt || m.bottle.createdAt || 0);
    lastAtByRoot.set(root, Math.max(lastAtByRoot.get(root) || 0, last));
    if (typeof m.id === "string" && m.id.startsWith("sent:")) participated.add(root);
  }
  const list = [...participated]
    .map((id) => ({ id, last: lastAtByRoot.get(id) || 0 }))
    .sort((a, b) => b.last - a.last)
    .slice(0, 100)
    .map((e) => e.id);
  if (list.length === 0) return;
  const inbox = await catchKidsParam();
  const kids = inbox ? inbox.split(",") : [];
  const token = await popTokenFor(kids).catch(() => null);
  if (!token) return;
  const stats = await fetchThreadStats(list, token).catch(() => null);
  if (!stats) {
    console.log("[activity] stats endpoint unavailable — fallback subtree fetch");
    // Stats endpoint unavailable — fall back to fetching a few subtrees.
    for (const root of list.slice(0, 8)) {
      await fetchThreadInto(root).catch(() => {});
    }
    return;
  }
  const changed: string[] = [];
  for (const root of list) {
    const st = stats[root];
    if (!st) continue;
    await applyThreadStatsRoot(root, st.count, st.lastAt);
    if (st.lastAt > (lastAtByRoot.get(root) || 0)) changed.push(root);
  }
  if (changed.length) console.log("[activity] threads changed:", changed.map((id) => id.slice(0, 8)));
  await renderInbox();
  for (const root of changed.slice(0, 8)) {
    await fetchThreadInto(root).catch(() => {});
  }
}

// openThread fetches unseen replies for a bottle and marks the thread as
// seen so the new-activity badge clears.
export async function openThread(bottleId: string) {
  const opened =
    (await idbGet<ThreadRecord>(META_STORE, `sent:${bottleId}`).catch(() => null)) ??
    (await idbGet<ThreadRecord>(META_STORE, `caught:${bottleId}`).catch(() => null));
  const threadRoot = opened?.bottle?.rootId || bottleId;
  await fetchThreadInto(threadRoot);
  const seen = Date.now();
  // Mark both the opened bottle and its thread root as seen — the unread
  // badge lives on the root record's threadLastAt.
  const ids = new Set([bottleId, threadRoot]);
  for (const prefix of ["caught:", "sent:"]) {
    const rec = await idbGet<ThreadRecord>(META_STORE, `${prefix}${bottleId}`).catch(() => null);
    if (rec?.bottle?.rootId) ids.add(rec.bottle.rootId);
  }
  for (const id of ids) {
    for (const prefix of ["caught:", "sent:"]) {
      const rec = await idbGet<ThreadRecord>(META_STORE, `${prefix}${id}`).catch(() => null);
      if (rec) {
        rec.repliesSeenAt = seen;
        rec.readAt = seen;
        await idbPut(META_STORE, rec).catch(() => {});
        markSyncDirty(rec.id);
      }
    }
  }
  await renderInbox();
}

export async function checkBottles() {
  let caught = 0;
  let scanned = 0;
  let cursor = "";
  const byKid = keyByKidMap();

  // Recipient filter: prove possession of our kids and get a pop token;
  // the server only returns bottles addressed to kids we control. The kid
  // set is just pool keys + self — replies are fetched lazily per thread.
  const kidsParam = await catchKidsParam();
  const kids = kidsParam ? kidsParam.split(",") : [];
  const token = await popTokenFor(kids).catch((e) => {
    log(`pop token failed: ${(e as Error).message}`, "warn");
    return null;
  });
  if (!token) {
    log("no provable keys; throw bait first", "warn");
    return;
  }

  // Incremental scan: bottles arrive newest-first, so we only walk pages
  // until we reach bottles older than the last scan's watermark (minus a
  // small overlap for same-second arrivals). First run — or a cleared IDB —
  // has no cursor and scans the full history once.
  const SCAN_OVERLAP_SEC = 3;
  const cursorRec = await idbGet<{ ca?: number }>(KV_STORE, "scan:cursor").catch(() => null);
  const stopBefore = cursorRec?.ca ? cursorRec.ca - SCAN_OVERLAP_SEC : 0;
  let maxSeen = cursorRec?.ca || 0;
  let hitOld = false;

  for (let page = 0; page < 100 && !hitOld; page++) {
    const { bottles = [], nextCursor = "" } = await api<{ bottles?: Bottle[]; nextCursor?: string }>(
      `/api/bottles?limit=100&token=${encodeURIComponent(token)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      { auth: false }
    );
    if (!bottles.length) break;
    scanned += bottles.length;
    for (const bottle of bottles) {
      if (stopBefore && bottle.createdAt < stopBefore) {
        hitOld = true;
        break;
      }
      if (bottle.createdAt > maxSeen) maxSeen = bottle.createdAt;
      await applyBottleStats(bottle);
      await bumpThreadActivity(bottle);
      if (await processBottle(bottle, byKid)) caught++;
    }
    if (hitOld || !nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  if (maxSeen > 0) {
    await idbPut(KV_STORE, { id: "scan:cursor", ca: maxSeen }).catch(() => {});
  }
  await renderInbox();
  await refreshActivePoolKeys();
  // Refresh threads we participate in so reply stats/badges/counts stay
  // fresh even though replies never appear in the inbox scan itself.
  refreshThreadActivity().catch(() => {});
  connectEvents().catch(() => {});
  evictMetaOverflow().catch(() => {});
  log(`checked ${scanned} bottle(s); caught ${caught}`);
}

// META_STORE is a decryption cache — the ciphertext lives on the server, so
// evicting old records loses nothing permanent. Cap total records and drop
// the oldest by caughtAt, but never evict a record that a kept record still
// references as parent/root (prevents orphaning thread branches).
const META_RECORD_CAP = 5000;

async function evictMetaOverflow() {
  const all = (await idbGetAll<ThreadRecord>(META_STORE).catch(() => [])) as ThreadRecord[];
  if (all.length <= META_RECORD_CAP) return;
  const excess = all.length - META_RECORD_CAP;
  const sorted = [...all].sort((a, b) => (a.caughtAt || 0) - (b.caughtAt || 0));
  // Bottle ids referenced as parent/root by kept records must survive.
  const referenced = new Set<string>();
  for (const r of sorted.slice(excess)) {
    if (r?.bottle?.parentId) referenced.add(r.bottle.parentId);
    if (r?.bottle?.rootId) referenced.add(r.bottle.rootId);
  }
  let dropped = 0;
  for (const r of sorted) {
    if (dropped >= excess) break;
    const bid = r?.bottle?.id;
    if (!r?.id || (bid && referenced.has(bid))) continue;
    await idbDelete(META_STORE, r.id).catch(() => {});
    dropped++;
  }
  if (dropped) log(`evicted ${dropped} old message record(s) from local cache`);
}

// ---------- realtime (SSE) ----------
// Server pushes `event: bottle` when a new bottle matches our kid filter;
// we debounce and run a normal scan — crypto path stays identical to polling.
let eventsSource: EventSource | null = null;
let eventsUrl = "";
let scanTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCatchScan() {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    checkBottles().catch(() => {});
  }, 800);
}

export async function connectEvents() {
  const kidsParam = await eventKidsParam();
  const token = kidsParam ? await popTokenFor(kidsParam.split(",")).catch(() => null) : null;
  const url = token ? `${API_BASE}/api/events?token=${encodeURIComponent(token)}` : "";
  if (!url) {
    eventsSource?.close();
    eventsSource = null;
    eventsUrl = "";
    return;
  }
  if (url === eventsUrl && eventsSource) return;
  eventsSource?.close();
  eventsUrl = url;
  console.log("[sse] subscribing, kids:", kidsParam.split(",").length);
  try {
    eventsSource = new EventSource(url);
    eventsSource.addEventListener("bottle", (ev) => {
      // Payload is {"id":..., "deleted":bool}; deletions mark local
      // records as placeholders instead of waiting for a scan that may
      // never surface the tombstone incrementally.
      try {
        const data = JSON.parse((ev as MessageEvent).data || "{}") as { id?: string; deleted?: boolean };
        if (data.deleted && data.id) {
          void markBottleDeleted(data.id);
          return;
        }
        console.log("[sse] bottle event", data.id?.slice(0, 8));
      } catch {
        // fall through to scan
      }
      setState({ lastCatchAt: Date.now() });
      scheduleCatchScan();
      scheduleActivityRefresh();
    });
    eventsSource.onerror = () => console.log("[sse] connection error — will retry");
  } catch {
    eventsSource = null;
  }
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

// Ordering: newest thread activity first — a root's position is driven by
// its own timestamp or the latest reply the server reported (lastChildAt),
// so threads with fresh replies float to the top like a messaging inbox.
// bottle.createdAt and lastChildAt share the server's unix-second unit.
function recOrderKey(r: ThreadRecord): number {
  // threadLastAt covers reply activity at any depth; lastChildAt is the
  // direct-children fallback for records predating thread stats.
  return Math.max(r.bottle?.createdAt || 0, r.threadLastAt || r.lastChildAt || 0);
}

export async function buildThreads(): Promise<ThreadBundle> {
  const all = (await idbGetAll<ThreadRecord>(META_STORE).catch(() => [])) as ThreadRecord[];
  // Legacy records stored bottle.createdAt in milliseconds while the server
  // and lastChildAt use unix seconds — normalize in place so ordering is
  // consistent across old and new data.
  for (const r of all) {
    const c = r.bottle?.createdAt || 0;
    if (c > 1e11) r.bottle!.createdAt = Math.floor(c / 1000);
    // Same ms→s normalization for activity stats — a millisecond
    // threadLastAt would sort/badge as infinitely-new activity.
    for (const f of ["threadLastAt", "lastChildAt", "lastInboundAt"] as const) {
      const v = r[f];
      if (typeof v === "number" && v > 1e11) r[f] = Math.floor(v / 1000);
    }
  }
  const recs = all
    .filter(
      (r) =>
        typeof r.id === "string" &&
        (r.id.startsWith("caught:") || r.id.startsWith("sent:")) &&
        r.bottle &&
        r.plain
    )
    .sort((a, b) => recOrderKey(b) - recOrderKey(a));
  const byBottle = new Map<string, ThreadRecord>();
  for (const r of recs) {
    const prev = byBottle.get(r.bottle!.id);
    if (!prev || (isSentRecord(prev) && !isSentRecord(r))) byBottle.set(r.bottle!.id, r);
  }
  const unique = [...byBottle.values()].sort((a, b) => recOrderKey(b) - recOrderKey(a));
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
  // Children render chronologically inside a thread even though roots are
  // sorted by latest activity.
  for (const list of childrenOf.values()) {
    list.sort((a, b) => (a.bottle?.createdAt || 0) - (b.bottle?.createdAt || 0));
  }

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
  const idMeta = identity as unknown as { username?: string; userId?: string } | undefined;
  const replies = meta.filter(
    (m) => typeof m?.id === "string" && m.id.startsWith(REPLY_PREFIX) && m.privateJwk
  );
  return {
    version: 4,
    keys: keys.map((k) => ({ kid: k.kid, jwk: k.privateJwk })),
    identity: identity?.privateJwk || null,
    // username/userId ride along so an import restores the full profile —
    // without them the gate would force a re-claim (which the server
    // resolves to the canonical name anyway, but only after a round-trip).
    identityMeta:
      idMeta?.username ? { username: idMeta.username, userId: idMeta.userId } : null,
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
  downloadJson("a09f-identity.json", encrypted);
  await idbPut(KV_STORE, { id: "vault:lastExport", ts: Date.now() }).catch(() => {});
  log(`exported encrypted vault with ${payload.keys.length} pool key(s)`);
}

// Vault backup reminder: without an export, losing the device means losing
// every message forever. We nudge once the app has been used for a few days
// without a recent export, and let the user snooze for a week.
const REMINDER_MIN_AGE_MS = 3 * 24 * 3600 * 1000;
const REMINDER_EXPORT_STALE_MS = 30 * 24 * 3600 * 1000;
const REMINDER_SNOOZE_MS = 7 * 24 * 3600 * 1000;

async function kvTs(id: string): Promise<number> {
  const rec = await idbGet<{ ts?: number }>(KV_STORE, id).catch(() => null);
  return rec?.ts || 0;
}

export interface VaultReminder {
  due: boolean;
  lastExport: number; // unix ms, 0 = never
}

export async function vaultReminderState(): Promise<VaultReminder> {
  const [firstSeen, lastExport, snooze] = await Promise.all([
    kvTs("app:firstSeen"),
    kvTs("vault:lastExport"),
    kvTs("vault:reminderSnooze"),
  ]);
  const now = Date.now();
  const stale = !lastExport || now - lastExport > REMINDER_EXPORT_STALE_MS;
  const snoozed = snooze && now - snooze < REMINDER_SNOOZE_MS;
  const due =
    !!firstSeen &&
    now - firstSeen > REMINDER_MIN_AGE_MS &&
    stale &&
    !snoozed;
  return { due, lastExport };
}

export async function snoozeVaultReminder() {
  await idbPut(KV_STORE, { id: "vault:reminderSnooze", ts: Date.now() }).catch(() => {});
}

// Vault imports restore the identity JWK, but older vaults lack the local
// username/userId fields. The public profile endpoint needs no auth, so
// resolve the canonical profile straight from the server — same result as
// re-claiming, without making the user pick a name first.
async function restoreIdentityProfile() {
  const id = await getIdentity().catch(() => null);
  if (!id?.publicJwk || id.username) return;
  const userId = await deriveUserId(id.publicJwk);
  try {
    const { user } = await api<{ user?: { id?: string; username?: string } }>(
      `/api/users/${userId}`
    );
    if (user?.username) {
      id.username = user.username;
      id.userId = user.id || userId;
      await idbPut(META_STORE, id).catch(() => {});
    }
  } catch {
    // never registered server-side — the username gate handles the claim
  }
}

export async function importVaultFile(file: File) {
  const passphrase = window.prompt("vault passphrase");
  if (!passphrase) return;
  const text = await file.text();
  const blob = JSON.parse(text) as Parameters<typeof decryptVault>[0];
  const payload = (await decryptVault(blob, passphrase)) as {
    version?: number;
    keys?: { kid?: string; jwk?: JWK; privateJwk?: JWK; publicJwk?: JWK; createdAt?: number; depositedAt?: number | null; expiresAt?: number | null; status?: string }[];
    identity?: JWK | null;
    identityMeta?: { username?: string; userId?: string } | null;
    replies?: { id?: string; jwk?: JWK }[];
    meta?: ThreadRecord[];
  };
  // Clean slate: wipe both stores before restoring so no stale keys,
  // records, or reply material from the previous identity survives the
  // import. Runs only after the vault decrypted successfully.
  await idbClear(KEY_STORE);
  await idbClear(META_STORE);
  popTokens.clear();
  sharedBitsCache.clear();
  caughtThisSession.clear();
  profileSynced = false;
  syncPulled = false;
  syncReadAt.clear();
  syncDirty.clear();
  await idbDelete(KV_STORE, "sync:cursor").catch(() => {});
  await idbDelete(KV_STORE, "pop:verified").catch(() => {});
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
        status: "pending",
      });
      restored++;
    }
    if (payload.identity) {
      await idbPut(META_STORE, {
        id: "identity",
        privateJwk: payload.identity,
        publicJwk: publicFromPrivate(payload.identity),
        username: payload.identityMeta?.username,
        userId: payload.identityMeta?.userId,
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
        status: k.status || (k.depositedAt ? "active" : "pending"),
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
  await restoreIdentityProfile();
  await loadKeys();
  await hydrateKeyMetadata();
  await renderInbox();
  log(`imported vault with ${restored} key(s) restored`);
  return restored;
}

// ---------- panels ----------

export interface PoolKeyStatus {
  kid: string;
  inPool: boolean;
  registered: boolean;
  consumed: boolean;
  createdAt?: number; // unix seconds — first deposit time
  expiresAt: number; // unix seconds, 0 when unregistered
}

// fetchPoolStatus asks the server to compare our kids against the live Redis
// pool and the Postgres registry — the authoritative way to spot keys lost
// from the pool (e.g. after a Redis collapse) versus legitimately consumed.
export async function fetchPoolStatus(kids: string[]): Promise<PoolKeyStatus[]> {
  const out: PoolKeyStatus[] = [];
  for (let i = 0; i < kids.length; i += 200) {
    const { kids: res = [] } = await api<{ kids?: PoolKeyStatus[] }>("/api/pool/status", {
      method: "POST",
      body: JSON.stringify({ kids: kids.slice(i, i + 200) }),
    });
    out.push(...res);
  }
  // Persist server-verified states: a key absent from the pool that the
  // registry says is neither consumed nor expired is "lost" (e.g. Redis
  // collapse) — everything else falls back to the locally derived status.
  const byKid = new Map(out.map((s) => [s.kid, s]));
  const nowSec = Math.floor(Date.now() / 1000);
  const writes: Promise<unknown>[] = [];
  const next = state.keys.map((k) => {
    const s = byKid.get(k.kid);
    if (!s || s.inPool) return k;
    let status: BaitStatus;
    if (s.expiresAt && s.expiresAt <= nowSec) status = "expired";
    else if (s.consumed) status = "eaten";
    else status = "lost";
    if (status === k.status) return k;
    const rec = { ...k, status };
    writes.push(idbPut(KEY_STORE, rec));
    return rec;
  });
  if (writes.length) {
    setState({ keys: next });
    await Promise.all(writes);
  }
  return out;
}

// hydrateKeyMetadata rebuilds depositedAt/expiresAt/status from the server
// after a vault import. The vault carries only private key material by
// design; the pool registry (PG) + Redis membership are the source of truth
// for pool metadata, so a wiped IndexedDB fully recovers key state.
async function hydrateKeyMetadata() {
  const kids = state.keys.map((k) => k.kid);
  if (!kids.length) return;
  let statuses: PoolKeyStatus[];
  try {
    statuses = await fetchPoolStatus(kids);
  } catch {
    return; // offline — keys stay pending until the next status check
  }
  const byKid = new Map(statuses.map((s) => [s.kid, s]));
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const writes: Promise<unknown>[] = [];
  const next = state.keys.map((k) => {
    const s = byKid.get(k.kid);
    if (!s) return k;
    const known = s.registered || s.inPool;
    const depositedAt = s.createdAt ? s.createdAt * 1000 : nowMs;
    const expiresAt = s.expiresAt ? s.expiresAt * 1000 : k.expiresAt ?? null;
    let status: BaitStatus = "pending";
    if (known) {
      if (s.inPool) status = "active";
      else if (s.expiresAt && s.expiresAt <= nowSec) status = "expired";
      else if (s.consumed) status = "eaten";
      else status = "lost";
    }
    const rec: KeyRecord = {
      ...k,
      depositedAt: known ? depositedAt : null,
      expiresAt: known ? expiresAt : k.expiresAt ?? null,
      status,
    };
    if (
      rec.depositedAt !== k.depositedAt ||
      rec.expiresAt !== k.expiresAt ||
      rec.status !== k.status
    ) {
      writes.push(idbPut(KEY_STORE, rec));
    }
    return rec;
  });
  if (writes.length) {
    setState({ keys: next });
    await Promise.all(writes);
  }
}

// restorePoolKeys re-deposits the given key records with their remaining
// TTL — the recovery path for pool members lost from Redis. depositedAt and
// expiresAt are refreshed client-side to match.
export async function restorePoolKeys(records: KeyRecord[]) {
  if (!records.length) return 0;
  const now = Date.now();
  const idt = await getIdentity().catch(() => null);
  const owner = idt?.publicJwk ? await deriveUserId(idt.publicJwk) : "";
  await api("/api/pool/deposit", {
    method: "POST",
    body: JSON.stringify({
      keys: records.map((k) => ({
        kid: k.kid,
        publicKey: JSON.stringify(k.publicJwk),
        ttlSeconds: k.expiresAt
          ? Math.min(2592000, Math.max(60, Math.ceil((k.expiresAt - now) / 1000)))
          : 86400,
        tzOffset: -new Date().getTimezoneOffset(),
        owner,
      })),
    }),
  });
  for (const k of records) {
    const ttl = k.expiresAt
      ? Math.min(2592000, Math.max(60, Math.ceil((k.expiresAt - now) / 1000)))
      : 86400;
    k.depositedAt = now;
    k.expiresAt = now + ttl * 1000;
    k.status = "active";
    await idbPut(KEY_STORE, k);
  }
  await loadKeys();
  refreshPoolKeys(0).catch(() => {});
  return records.length;
}

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

export interface UserStats {
  memberSince: number;
  casts: number;
  replies: number;
  castsDelivered: number;
  castsExhausted: number;
  received: number;
  claims: number;
  keysDeposited: number;
  firstActivity: number;
  lastActivity: number;
  reportsFiled: number;
  timesReported: number;
  usersBlocked: number;
}

export async function fetchMyStats(): Promise<UserStats | null> {
  try {
    const { stats } = await api<{ stats?: UserStats }>("/api/me/stats");
    return stats || null;
  } catch {
    return null;
  }
}

// ClientMeta is everything the browser itself can honestly report about
// this device/session, plus the server-observed IP.
export interface ClientMeta {
  ip?: string;
  userAgent?: string;
  language?: string;
  languages?: string;
  platform?: string;
  timezone?: string;
  timezoneOffset?: number;
  datetime?: string;
  screen?: string;
  cores?: number;
  memoryGB?: number;
  connection?: string;
  cookies?: boolean;
  doNotTrack?: string;
  touch?: boolean;
  online?: boolean;
}

export async function getClientMeta(): Promise<ClientMeta> {
  const meta: ClientMeta = {
    userAgent: navigator.userAgent,
    language: navigator.language,
    languages: navigator.languages?.join(", "),
    platform: (navigator as { platform?: string }).platform || "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    timezoneOffset: -new Date().getTimezoneOffset(),
    datetime: new Date().toString(),
    screen: `${screen.width}×${screen.height} @${screen.colorDepth}bit`,
    cores: navigator.hardwareConcurrency || 0,
    connection: (navigator as { connection?: { effectiveType?: string } }).connection?.effectiveType || "",
    cookies: navigator.cookieEnabled,
    doNotTrack: navigator.doNotTrack || "",
    touch: "ontouchstart" in window || navigator.maxTouchPoints > 0,
    online: navigator.onLine,
  };
  const mem = (navigator as { deviceMemory?: number }).deviceMemory;
  if (mem) meta.memoryGB = mem;
  try {
    const { ip } = await api<{ ip?: string }>("/api/ip", { auth: false });
    meta.ip = ip || "";
  } catch {
    meta.ip = "";
  }
  return meta;
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

// changeUsernameUI renames the account (server enforces a 7-day cooldown)
// and updates the local identity record so the UI reflects it instantly.
export async function changeUsernameUI(username: string) {
  const v = username.trim();
  if (!v) return;
  const res = await api<{ user?: { username?: string } }>("/api/me/username", {
    method: "POST",
    body: JSON.stringify({ username: v }),
  });
  const id = await getIdentity();
  if (id && res?.user?.username) {
    id.username = res.user.username; // mutates the cached record in place
    await idbPut(META_STORE, id).catch(() => {});
    setState({}); // notify subscribers so panels re-read the identity record
  }
  log(`username changed to @${res?.user?.username || v}`);
}

export interface DeviceInfo {
  deviceId: string;
  userAgent: string;
  firstSeen: number;
  lastSeen: number;
  revoked: boolean;
  current: boolean;
}

export async function fetchDevices(): Promise<DeviceInfo[]> {
  const { devices = [] } = await api<{ devices?: DeviceInfo[] }>("/api/me/devices");
  return devices;
}

export async function revokeDevice(deviceId: string) {
  await api(`/api/me/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
}

// deleteAccount permanently removes the server-side account (username,
// identity, key ownership, blocks, reports, sync records) then wipes all
// local data and reloads into a fresh anonymous state. Encrypted bottles
// already delivered stay — the server never could read them anyway.
export async function deleteAccount() {
  await api("/api/me", { method: "DELETE" });
  await idbClear(KEY_STORE);
  await idbClear(META_STORE);
  await idbClear(KV_STORE);
  resetIdentityCache();
  location.reload();
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
    const reason = askReportReason();
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
  // First-run marker for the vault-backup reminder — set once, never reset.
  const seen = await kvTs("app:firstSeen");
  if (!seen) await idbPut(KV_STORE, { id: "app:firstSeen", ts: Date.now() }).catch(() => {});
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
  // Re-subscribe periodically so the kid filter picks up newly known
  // threads and rotated pool keys even if the tab stays open for days.
  setInterval(() => connectEvents().catch(() => {}), 60000);
  // Polling safety net: SSE is best-effort — if the stream stalls or the
  // proxy buffers events, inbox scan + thread stats still refresh every
  // 20s so badges and chats update without a manual refresh.
  setInterval(() => {
    if (document.visibilityState === "visible") {
      checkBottles().catch(() => {});
    }
  }, 20000);
}

export { getIdentityRecord };
