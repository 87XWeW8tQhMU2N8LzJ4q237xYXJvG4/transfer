import { DurableObject } from "cloudflare:workers";

import {
  isShareState,
  type ShareDescriptor,
  type ShareState,
} from "./domain";
import { createObjectStore } from "./storage";

const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const OBJECT_KEY_PATTERN = /^objects\/[0-9a-f-]{36}$/;
const CLEANUP_RETRY_MS = 60_000;

type StoredShareRow = {
  token_hash: string;
  object_key: string;
  name: string;
  content_type: string;
  size: number;
  expires_at: number;
  state: string;
};

type UploadAttemptRow = {
  attempt_id: string;
  object_key: string;
};

type StoredShare = Readonly<{
  tokenHash: string;
  objectKey: string;
  name: string;
  contentType: string;
  size: number;
  expiresAt: number;
  state: ShareState;
}>;

export type InitializeShareInput = Readonly<{
  tokenHash: string;
  objectKey: string;
  name: string;
  contentType: string;
  size: number;
  expiresAt: number;
}>;

export type InitializeShareResult =
  | Readonly<{ kind: "created" }>
  | Readonly<{ kind: "exists" }>;

export type BeginUploadInput = Readonly<{
  tokenHash: string;
  attemptId: string;
  objectKey: string;
}>;

export type BeginUploadResult =
  | Readonly<{
      kind: "ready";
      expectedSize: number;
      contentType: string;
    }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "gone" }>;

export type CommitUploadInput = Readonly<{
  tokenHash: string;
  attemptId: string;
}>;

export type CommitUploadResult =
  | Readonly<{ kind: "committed" }>
  | Readonly<{ kind: "rejected" }>
  | Readonly<{ kind: "gone" }>;

export type CompleteShareResult =
  | Readonly<{ kind: "complete"; share: ShareDescriptor }>
  | Readonly<{ kind: "not-ready" }>
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "gone" }>;

export type DescribeShareResult =
  | Readonly<{ kind: "available"; share: ShareDescriptor }>
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "gone" }>;

export type ClaimShareResult =
  | Readonly<{ kind: "claimed"; share: ShareDescriptor }>
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "gone" }>;

export type RevokeShareResult =
  | Readonly<{ kind: "revoked" }>
  | Readonly<{ kind: "not-found" }>;

export class ShareToken extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS share (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        token_hash TEXT NOT NULL,
        object_key TEXT NOT NULL,
        name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'uploaded', 'active', 'claimed', 'expired', 'revoked')
        )
      );
      CREATE TABLE IF NOT EXISTS upload_attempt (
        attempt_id TEXT PRIMARY KEY,
        object_key TEXT NOT NULL UNIQUE
      );
    `);
  }

  async initialize(
    input: InitializeShareInput,
  ): Promise<InitializeShareResult> {
    validateInitializeInput(input);
    const existing = this.#readShare();
    if (existing !== null) {
      await this.#ensureAlarm(existing.expiresAt);
      return { kind: "exists" };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO share (
        singleton, token_hash, object_key, name, content_type, size, expires_at, state
      ) VALUES (1, ?, ?, ?, ?, ?, ?, 'pending')`,
      input.tokenHash,
      input.objectKey,
      input.name,
      input.contentType,
      input.size,
      input.expiresAt,
    );
    await this.ctx.storage.setAlarm(input.expiresAt);
    return { kind: "created" };
  }

  async beginUpload(input: BeginUploadInput): Promise<BeginUploadResult> {
    validateTokenHash(input.tokenHash);
    validateAttempt(input.attemptId, input.objectKey);
    const share = this.#readMatchingShare(input.tokenHash);
    if (share === null) {
      return { kind: "not-found" };
    }
    if (Date.now() >= share.expiresAt) {
      await this.#expire(share);
      return { kind: "gone" };
    }
    if (share.state !== "pending") {
      return isTerminal(share.state)
        ? { kind: "gone" }
        : { kind: "conflict" };
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO upload_attempt (attempt_id, object_key) VALUES (?, ?)",
      input.attemptId,
      input.objectKey,
    );
    return {
      kind: "ready",
      expectedSize: share.size,
      contentType: share.contentType,
    };
  }

  async commitUpload(input: CommitUploadInput): Promise<CommitUploadResult> {
    validateTokenHash(input.tokenHash);
    const share = this.#readMatchingShare(input.tokenHash);
    const attempt = this.#readUploadAttempt(input.attemptId);
    if (share === null || attempt === null) {
      return { kind: "rejected" };
    }
    if (Date.now() >= share.expiresAt) {
      this.#markExpired();
      return { kind: "gone" };
    }
    if (share.state !== "pending") {
      return isTerminal(share.state)
        ? { kind: "gone" }
        : { kind: "rejected" };
    }

    this.ctx.storage.sql.exec(
      "UPDATE share SET object_key = ?, state = 'uploaded' WHERE singleton = 1 AND state = 'pending'",
      attempt.object_key,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM upload_attempt WHERE attempt_id = ?",
      input.attemptId,
    );
    return { kind: "committed" };
  }

  discardUploadAttempt(input: {
    tokenHash: string;
    attemptId: string;
  }): void {
    validateTokenHash(input.tokenHash);
    const share = this.#readMatchingShare(input.tokenHash);
    if (share === null) {
      return;
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM upload_attempt WHERE attempt_id = ?",
      input.attemptId,
    );
  }

  async complete(tokenHash: string): Promise<CompleteShareResult> {
    validateTokenHash(tokenHash);
    const share = this.#readMatchingShare(tokenHash);
    if (share === null) {
      return { kind: "not-found" };
    }
    if (Date.now() >= share.expiresAt) {
      await this.#expire(share);
      return { kind: "gone" };
    }

    if (share.state === "uploaded") {
      this.ctx.storage.sql.exec(
        "UPDATE share SET state = 'active' WHERE singleton = 1 AND state = 'uploaded'",
      );
      return { kind: "complete", share: descriptor(share) };
    }
    if (share.state === "active") {
      return { kind: "complete", share: descriptor(share) };
    }
    if (share.state === "pending") {
      return { kind: "not-ready" };
    }
    return { kind: "gone" };
  }

  async describe(tokenHash: string): Promise<DescribeShareResult> {
    validateTokenHash(tokenHash);
    const share = this.#readMatchingShare(tokenHash);
    if (share === null) {
      return { kind: "not-found" };
    }
    if (Date.now() >= share.expiresAt) {
      await this.#expire(share);
      return { kind: "gone" };
    }
    if (share.state === "active") {
      return { kind: "available", share: descriptor(share) };
    }
    return isTerminal(share.state)
      ? { kind: "gone" }
      : { kind: "not-found" };
  }

  async claim(tokenHash: string): Promise<ClaimShareResult> {
    validateTokenHash(tokenHash);
    const share = this.#readMatchingShare(tokenHash);
    if (share === null) {
      return { kind: "not-found" };
    }
    if (Date.now() >= share.expiresAt) {
      this.#markExpired();
      await this.#cleanupWithoutThrow();
      return { kind: "gone" };
    }
    if (share.state !== "active") {
      return isTerminal(share.state)
        ? { kind: "gone" }
        : { kind: "not-found" };
    }

    const claimed = this.ctx.storage.sql
      .exec<{ state: string }>(
        `UPDATE share
         SET state = 'claimed'
         WHERE singleton = 1 AND state = 'active' AND expires_at > ?
         RETURNING state`,
        Date.now(),
      )
      .toArray();
    return claimed.length === 1
      ? { kind: "claimed", share: descriptor(share) }
      : { kind: "gone" };
  }

  async revoke(tokenHash: string): Promise<RevokeShareResult> {
    validateTokenHash(tokenHash);
    const share = this.#readMatchingShare(tokenHash);
    if (share === null) {
      return { kind: "not-found" };
    }
    if (!isTerminal(share.state)) {
      this.ctx.storage.sql.exec(
        "UPDATE share SET state = 'revoked' WHERE singleton = 1",
      );
    }
    await this.#cleanupWithoutThrow();
    return { kind: "revoked" };
  }

  async alarm(): Promise<void> {
    const share = this.#readShare();
    if (share === null) {
      return;
    }
    if (!isTerminal(share.state) && Date.now() < share.expiresAt) {
      await this.ctx.storage.setAlarm(share.expiresAt);
      return;
    }
    if (!isTerminal(share.state)) {
      this.#markExpired();
    }

    try {
      await this.#cleanupObjects();
    } catch (error) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RETRY_MS);
      throw error;
    }
  }

  #readMatchingShare(tokenHash: string): StoredShare | null {
    const share = this.#readShare();
    return share?.tokenHash === tokenHash ? share : null;
  }

  #readShare(): StoredShare | null {
    const row = this.ctx.storage.sql
      .exec<StoredShareRow>(
        `SELECT token_hash, object_key, name, content_type, size, expires_at, state
         FROM share WHERE singleton = 1`,
      )
      .toArray()[0];
    if (row === undefined) {
      return null;
    }
    if (
      !isShareState(row.state) ||
      !Number.isSafeInteger(row.size) ||
      !Number.isSafeInteger(row.expires_at)
    ) {
      throw new Error("Stored share record is invalid");
    }
    return {
      tokenHash: row.token_hash,
      objectKey: row.object_key,
      name: row.name,
      contentType: row.content_type,
      size: row.size,
      expiresAt: row.expires_at,
      state: row.state,
    };
  }

  #readUploadAttempt(attemptId: string): UploadAttemptRow | null {
    return (
      this.ctx.storage.sql
        .exec<UploadAttemptRow>(
          "SELECT attempt_id, object_key FROM upload_attempt WHERE attempt_id = ?",
          attemptId,
        )
        .toArray()[0] ?? null
    );
  }

  #markExpired(): void {
    this.ctx.storage.sql.exec(
      `UPDATE share SET state = 'expired'
       WHERE singleton = 1 AND state IN ('pending', 'uploaded', 'active')`,
    );
  }

  async #expire(share: StoredShare): Promise<void> {
    if (!isTerminal(share.state)) {
      this.#markExpired();
    }
    await this.#cleanupWithoutThrow();
  }

  async #cleanupWithoutThrow(): Promise<void> {
    try {
      await this.#cleanupObjects();
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RETRY_MS);
    }
  }

  async #cleanupObjects(): Promise<void> {
    const share = this.#readShare();
    if (share === null) {
      return;
    }
    const attemptRows = this.ctx.storage.sql
      .exec<UploadAttemptRow>(
        "SELECT attempt_id, object_key FROM upload_attempt",
      )
      .toArray();
    const objectKeys = new Set([
      share.objectKey,
      ...attemptRows.map((attempt) => attempt.object_key),
    ]);
    const store = createObjectStore(this.env);
    await Promise.all(
      [...objectKeys].map((objectKey) => store.delete(objectKey)),
    );
    this.ctx.storage.sql.exec("DELETE FROM upload_attempt");
  }

  async #ensureAlarm(expiresAt: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) {
      await this.ctx.storage.setAlarm(expiresAt);
    }
  }
}

function validateInitializeInput(input: InitializeShareInput): void {
  validateTokenHash(input.tokenHash);
  if (
    !OBJECT_KEY_PATTERN.test(input.objectKey) ||
    input.name.length === 0 ||
    input.contentType.length === 0 ||
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    !Number.isSafeInteger(input.expiresAt)
  ) {
    throw new Error("Invalid share initialization");
  }
}

function validateTokenHash(tokenHash: string): void {
  if (!TOKEN_HASH_PATTERN.test(tokenHash)) {
    throw new Error("Invalid token hash");
  }
}

function validateAttempt(attemptId: string, objectKey: string): void {
  if (
    !/^[0-9a-f-]{36}$/.test(attemptId) ||
    !OBJECT_KEY_PATTERN.test(objectKey)
  ) {
    throw new Error("Invalid upload attempt");
  }
}

function descriptor(share: StoredShare): ShareDescriptor {
  return {
    objectKey: share.objectKey,
    name: share.name,
    contentType: share.contentType,
    size: share.size,
    expiresAt: share.expiresAt,
  };
}

function isTerminal(state: ShareState): boolean {
  return state === "claimed" || state === "expired" || state === "revoked";
}
