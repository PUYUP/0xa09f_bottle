export interface JWK {
  kty: string;
  crv: string;
  x: string;
  y: string;
  d?: string;
}

export interface KeyRecord {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
  createdAt: number;
  depositedAt: number | null;
  expiresAt?: number | null;
  // last synced bait status: "pending" | "active" | "eaten" | "expired" | "lost"
  status?: string;
  // local UI dismissal: set when the user taps an eaten bait to clear it
  // from the bait line. Never leaves the device (not in vault exports).
  dismissedAt?: number | null;
}

export interface IdentityRecord {
  id: string;
  privateJwk: JWK;
  publicJwk: JWK;
  username?: string;
  userId?: string;
}

export interface Envelope {
  kid: string | null;
  authorPublicKey: string;
  recipientPublicKey?: string;
  wrapIv: string;
  wrappedKey: string;
  pickupHash: string;
}

export interface Bottle {
  id: string;
  createdAt: number;
  depth?: number;
  parentId?: string;
  rootId?: string;
  maxDeliveries: number;
  payloadIv?: string;
  ciphertext?: string;
  envelopes?: Envelope[];
  status?: string;
  childCount?: number;
  lastChildAt?: number;
  threadCount?: number;
  threadLastAt?: number;
}

export interface Plain {
  v: number;
  text: string;
  reply: JWK | null;
}

export interface Claim {
  ok?: boolean;
  status?: string;
  deliveries?: number;
  error?: string;
}

export interface ThreadRecord {
  id: string; // "caught:<bottleId>" | "sent:<bottleId>" | "reply:<id>" | "identity"
  bottle?: Bottle;
  plain?: Plain;
  kid?: string;
  claim?: Claim;
  caughtAt?: number;
  childCount?: number;
  lastChildAt?: number;
  threadCount?: number;
  threadLastAt?: number;
  repliesSeenAt?: number;
  readAt?: number;
  // id of the newest reply bottle seen in this record's subtree — used to
  // scroll+highlight the latest reply when a thread is opened.
  lastReplyId?: string;
  // timestamp of the newest reply NOT authored by us — drives the unread
  // badge so our own replies never mark a thread as new.
  lastInboundAt?: number;
  // set when the author deleted the bottle server-side: the record stays as
  // a placeholder ("[message deleted]") with plaintext stripped locally.
  deleted?: boolean;
  privateJwk?: JWK;
  publicJwk?: JWK;
  createdAt?: number;
  username?: string;
  userId?: string;
}

export interface PoolKeyInfo {
  kid: string;
  publicKey: string;
  expiresAt?: number;
}

export interface BlockEntry {
  blockedUserId: string;
  username: string;
  reason?: string;
}
