export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
// .dev.vars.example and README.md must use this exact string; test/upload-key.test.ts enforces it.
export const UPLOAD_KEY_PLACEHOLDER = "replace-with-a-random-key";
export const MIN_UPLOAD_KEY_LENGTH = 32;

const MAX_NAME_LENGTH = 1024;
const MAX_CONTENT_TYPE_LENGTH = 255;
const HEX_256_PATTERN = /^[0-9a-f]{64}$/;

export type ShareId = Readonly<{
  kind: "share-id";
  value: string;
}>;

export type ShareTokenValue = Readonly<{
  kind: "share-token";
  value: string;
}>;

export type TokenHash = Readonly<{
  kind: "token-hash";
  value: string;
}>;

export type ObjectKey = Readonly<{
  kind: "object-key";
  value: string;
}>;

export type UploadAttemptId = Readonly<{
  kind: "upload-attempt-id";
  value: string;
}>;

export type CreateUpload = Readonly<{
  name: string;
  size: number;
  contentType: string;
  ttlSeconds: number;
}>;

export type UploadKey = Readonly<{
  kind: "upload-key";
  value: string;
}>;

export type ParseUploadKeyResult =
  | Readonly<{ ok: true; value: UploadKey }>
  | Readonly<{ ok: false; reason: "missing" | "placeholder" | "too-short" }>;

export type ParseUploadResult =
  | Readonly<{ ok: true; value: CreateUpload }>
  | Readonly<{ ok: false; status: 400 | 413; error: string }>;

export type ShareState =
  | "pending"
  | "uploaded"
  | "active"
  | "claimed"
  | "expired"
  | "revoked";

export type ShareDescriptor = Readonly<{
  objectKey: string;
  name: string;
  contentType: string;
  size: number;
  expiresAt: number;
}>;

export function parseCreateUpload(
  input: unknown,
  maxUploadBytes: number,
): ParseUploadResult {
  if (!isRecord(input)) {
    return invalid("Request body must be a JSON object");
  }

  const { name, size, type, ttlSeconds } = input;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    !hasValidUnicode(name)
  ) {
    return invalid("name must be a non-empty string of at most 1024 characters");
  }
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    return invalid("size must be a non-negative integer");
  }
  if (size > maxUploadBytes) {
    return { ok: false, status: 413, error: "Upload exceeds the size limit" };
  }
  if (
    typeof type !== "string" ||
    type.length === 0 ||
    type.length > MAX_CONTENT_TYPE_LENGTH ||
    /[\r\n\0]/.test(type)
  ) {
    return invalid("type must be a valid non-empty media type");
  }

  if (
    ttlSeconds !== undefined &&
    (typeof ttlSeconds !== "number" ||
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 1)
  ) {
    return invalid("ttlSeconds must be a positive integer");
  }

  return {
    ok: true,
    value: {
      name,
      size,
      contentType: type,
      ttlSeconds: Math.min(ttlSeconds ?? DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS),
    },
  };
}

export function parseMaxUploadBytes(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("MAX_UPLOAD_BYTES must be a positive integer");
  }
  return parsed;
}

export function parseUploadKey(value: string | undefined): ParseUploadKeyResult {
  if (value === undefined || value.length === 0) {
    return { ok: false, reason: "missing" };
  }
  if (value === UPLOAD_KEY_PLACEHOLDER) {
    return { ok: false, reason: "placeholder" };
  }
  if (value.length < MIN_UPLOAD_KEY_LENGTH) {
    return { ok: false, reason: "too-short" };
  }
  return { ok: true, value: { kind: "upload-key", value } };
}

export function generateShareId(): ShareId {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return { kind: "share-id", value: bytesToHex(bytes) };
}

export function parseShareId(value: string): ShareId | null {
  return HEX_256_PATTERN.test(value)
    ? { kind: "share-id", value }
    : null;
}

export function parseShareToken(value: string): ShareTokenValue | null {
  return HEX_256_PATTERN.test(value)
    ? { kind: "share-token", value }
    : null;
}

export async function deriveShareToken(
  id: ShareId,
): Promise<ShareTokenValue> {
  const value = await sha256Hex(`transfer-share-token-v1\0${id.value}`);
  return { kind: "share-token", value };
}

export async function hashShareToken(
  token: ShareTokenValue,
): Promise<TokenHash> {
  return { kind: "token-hash", value: await sha256Hex(token.value) };
}

export function generateObjectKey(): ObjectKey {
  return {
    kind: "object-key",
    value: `objects/${crypto.randomUUID()}`,
  };
}

export function generateUploadAttemptId(): UploadAttemptId {
  return { kind: "upload-attempt-id", value: crypto.randomUUID() };
}

export function isShareState(value: string): value is ShareState {
  switch (value) {
    case "pending":
    case "uploaded":
    case "active":
    case "claimed":
    case "expired":
    case "revoked":
      return true;
    default:
      return false;
  }
}

function invalid(error: string): ParseUploadResult {
  return { ok: false, status: 400, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasValidUnicode(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}
