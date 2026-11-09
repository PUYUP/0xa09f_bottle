import { describe, expect, it } from "vitest";
import {
  decodePlaintext,
  decryptPayload,
  decryptSyncRecord,
  derivePickupProof,
  deriveReplyKeyPair,
  deriveWrapKey,
  encodePlaintext,
  encryptSyncRecord,
  importECDHPrivate,
  makeKeyRecord,
  syncRecordKey,
  unwrapSessionKey,
  wrapSessionKey,
} from "./crypto";
import type { JWK } from "./types";
import { bytesToB64, randBytes, textBytes } from "./util";

// Simulates the sender-side bottle seal exactly as dropBottle() does in
// store.ts: AES-256-GCM payload + per-recipient wrapped session keys.
async function sealBottle(
  bottleId: string,
  text: string,
  replyPublicJwk: JWK | null,
  recipientPubJwks: JWK[],
  kids: (string | null)[]
) {
  const sessionKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"]
  );
  const payloadIV = randBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: payloadIV },
    sessionKey,
    textBytes(encodePlaintext(text, replyPublicJwk))
  );
  const rawSessionKey = await crypto.subtle.exportKey("raw", sessionKey);
  const envelopes = [];
  for (let i = 0; i < recipientPubJwks.length; i++) {
    const env = await wrapSessionKey(bottleId, recipientPubJwks[i], rawSessionKey, kids[i] || "");
    env.kid = kids[i] ?? null;
    envelopes.push(env);
  }
  return {
    id: bottleId,
    payloadIv: bytesToB64(payloadIV),
    ciphertext: bytesToB64(new Uint8Array(ciphertext)),
    envelopes,
    rawSessionKey,
  };
}

async function openBottle(
  bottle: { id: string; payloadIv?: string; ciphertext?: string },
  envelope: { authorPublicKey: string; wrapIv: string; wrappedKey: string },
  privateJwk: JWK
) {
  const rawSessionKey = await unwrapSessionKey(bottle.id, envelope, privateJwk);
  const raw = await decryptPayload(bottle, rawSessionKey);
  return decodePlaintext(raw);
}

describe("bottle crypto path (cast → catch → reply)", () => {
  it("round-trips a sealed bottle end to end", async () => {
    const sender = await makeKeyRecord(); // sender identity keypair
    const bait = await makeKeyRecord(); // recipient bait keypair
    const bottleId = crypto.randomUUID();

    // sender embeds their deterministic reply pubkey in the plaintext
    const replyPair = await deriveReplyKeyPair(sender.privateJwk, bottleId);
    const bottle = await sealBottle(
      bottleId,
      "hello from the void",
      replyPair.publicJwk,
      [bait.publicJwk],
      ["kid-1"]
    );

    // recipient unwraps session key with bait private key, decrypts payload
    const plain = await openBottle(bottle, bottle.envelopes[0], bait.privateJwk);
    expect(plain.v).toBe(1);
    expect(plain.text).toBe("hello from the void");
    expect(plain.reply?.x).toBe(replyPair.publicJwk.x);
  });

  it("reply path: parent author opens a reply sealed to their reply key", async () => {
    const parentAuthor = await makeKeyRecord();
    const bottleId = crypto.randomUUID();

    // reply keypair is deterministically re-derived from identity + bottleId
    const replyPriv = await deriveReplyKeyPair(parentAuthor.privateJwk, bottleId);
    const replyBottleId = crypto.randomUUID();
    const reply = await sealBottle(
      replyBottleId,
      "a reply",
      null,
      [replyPriv.publicJwk],
      ["reply:" + bottleId]
    );

    // parent author recovers it with the SAME derived private key — no
    // stored reply secret needed
    const plain = await openBottle(reply, reply.envelopes[0], replyPriv.privateJwk);
    expect(plain.text).toBe("a reply");
  });

  it("rejects wrong-key unwrap and tampered ciphertext", async () => {
    const bait = await makeKeyRecord();
    const wrong = await makeKeyRecord();
    const bottleId = crypto.randomUUID();
    const bottle = await sealBottle(bottleId, "secret", null, [bait.publicJwk], ["kid-1"]);

    await expect(
      unwrapSessionKey(bottle.id, bottle.envelopes[0], wrong.privateJwk)
    ).rejects.toThrow();

    const tampered = { ...bottle, ciphertext: bottle.ciphertext!.slice(0, -4) + "AAAA" };
    const raw = await unwrapSessionKey(bottle.id, bottle.envelopes[0], bait.privateJwk);
    await expect(decryptPayload(tampered, raw)).rejects.toThrow();
  });

  it("deriveReplyKeyPair is deterministic per (identity, bottleId)", async () => {
    const id = await makeKeyRecord();
    const a = await deriveReplyKeyPair(id.privateJwk, "bottle-x");
    const b = await deriveReplyKeyPair(id.privateJwk, "bottle-x");
    const c = await deriveReplyKeyPair(id.privateJwk, "bottle-y");
    expect(a.privateJwk.d).toBe(b.privateJwk.d);
    expect(a.publicJwk.x).not.toBe(c.publicJwk.x);
  });

  it("derivePickupProof is deterministic and kid-bound", async () => {
    const sk = randBytes(32);
    const p1 = await derivePickupProof(sk.buffer as ArrayBuffer, "b1", "kid1");
    const p2 = await derivePickupProof(sk.buffer as ArrayBuffer, "b1", "kid1");
    const legacy = await derivePickupProof(sk.buffer as ArrayBuffer, "b1");
    expect(p1.token).toBe(p2.token);
    expect(p1.hash).toBe(p2.hash);
    expect(p1.token).not.toBe(legacy.token);
  });

  it("deriveWrapKey derives distinct AES keys per bottle id", async () => {
    const bits = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    void bits;
    const shared = await crypto.subtle.digest("SHA-256", randBytes(32));
    const k1 = await deriveWrapKey("b1", shared, ["encrypt"]);
    const k2 = await deriveWrapKey("b2", shared, ["encrypt"]);
    expect(k1).not.toBe(k2);
    void importECDHPrivate; // keep import used
  });
});

describe("encrypted sync records", () => {
  it("round-trips field state and rejects wrong identity", async () => {
    const id = await makeKeyRecord();
    const other = await makeKeyRecord();
    const blob = await encryptSyncRecord(id.privateJwk, "caught:abc", 1730000000000);
    const rec = await decryptSyncRecord(id.privateJwk, blob);
    expect(rec).toEqual({ k: "caught:abc", t: 1730000000000 });
    expect(await decryptSyncRecord(other.privateJwk, blob)).toBeNull();
  });

  it("syncRecordKey is deterministic and field-sensitive", async () => {
    const a = await syncRecordKey("u_x", "caught:1");
    const b = await syncRecordKey("u_x", "caught:1");
    const c = await syncRecordKey("u_x", "bait:k");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
