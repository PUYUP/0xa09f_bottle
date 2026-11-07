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
  wrapIv: string;
  wrappedKey: string;
  pickupHash: string;
}

export interface Bottle {
  id: string;
  createdAt: number;
  depth?: number;
  parentId?: string;
  maxDeliveries: number;
  payloadIv?: string;
  ciphertext?: string;
  envelopes?: Envelope[];
  status?: string;
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
