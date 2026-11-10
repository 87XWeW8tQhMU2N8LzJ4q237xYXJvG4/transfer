import {
  deriveShareToken,
  generateObjectKey,
  generateShareId,
  generateUploadAttemptId,
  hashShareToken,
  MIN_UPLOAD_KEY_LENGTH,
  parseCreateUpload,
  parseMaxUploadBytes,
  parseShareId,
  parseShareToken,
  parseUploadKey,
  type ShareDescriptor,
  type TokenHash,
  type UploadKey,
} from "./domain";
import {
  ShareToken,
} from "./share-token";
import {
  createObjectStore,
  ObjectStoreConfigError,
  ObjectStoreError,
  type ObjectStore,
} from "./storage";

export { ShareToken } from "./share-token";

const CREATE_UPLOAD_PATH = "/v1/uploads";
const LIMITS_PATH = "/v1/limits";
const UPLOAD_PATH = /^\/v1\/uploads\/([0-9a-f]{64})$/;
const COMPLETE_PATH = /^\/v1\/uploads\/([0-9a-f]{64})\/complete$/;
const SHARE_PATH = /^\/s\/([0-9a-f]{64})$/;
const DOWNLOAD_PATH = /^\/s\/([0-9a-f]{64})\/download$/;

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof ObjectStoreConfigError) {
        console.error(JSON.stringify({ message: error.message }));
      }
      return jsonError(500, "Internal server error");
    }
  },
} satisfies ExportedHandler<Env>;

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/v1/")) {
    const uploadKey = parseUploadKey(env.UPLOAD_KEY);
    if (!uploadKey.ok) {
      console.error(
        JSON.stringify({
          message: "upload API disabled: UPLOAD_KEY rejected",
          reason: uploadKey.reason,
        }),
      );
      return jsonError(
        503,
        `Upload API is disabled until UPLOAD_KEY is set to a random value of at least ${MIN_UPLOAD_KEY_LENGTH} characters`,
      );
    }
    if (!(await hasUploadAuthorization(request, uploadKey.value))) {
      return new Response(null, {
        status: 401,
        headers: {
          "Cache-Control": "no-store",
          "WWW-Authenticate": "Bearer",
        },
      });
    }
    if (url.pathname === LIMITS_PATH) {
      return uploadLimits(request, env);
    }
    return routeUploadApi(request, env, url);
  }

  const downloadMatch = DOWNLOAD_PATH.exec(url.pathname);
  if (downloadMatch !== null) {
    return request.method === "POST"
      ? download(request, env, ctx, downloadMatch[1] ?? "")
      : methodNotAllowed("POST", true);
  }

  const shareMatch = SHARE_PATH.exec(url.pathname);
  if (shareMatch !== null) {
    if (request.method === "GET" || request.method === "HEAD") {
      return showShare(env, shareMatch[1] ?? "", request.method === "HEAD");
    }
    return methodNotAllowed("GET, HEAD", true);
  }

  return new Response("Not found", { status: 404 });
}

async function routeUploadApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (url.pathname === CREATE_UPLOAD_PATH) {
    return request.method === "POST"
      ? createUpload(request, env)
      : methodNotAllowed("POST");
  }

  const completeMatch = COMPLETE_PATH.exec(url.pathname);
  if (completeMatch !== null) {
    return request.method === "POST"
      ? completeUpload(request, env, completeMatch[1] ?? "")
      : methodNotAllowed("POST");
  }

  const uploadMatch = UPLOAD_PATH.exec(url.pathname);
  if (uploadMatch !== null) {
    const id = uploadMatch[1] ?? "";
    if (request.method === "PUT") {
      return uploadObject(request, env, id);
    }
    if (request.method === "DELETE") {
      return revokeUpload(env, id);
    }
    return methodNotAllowed("PUT, DELETE");
  }

  return jsonError(404, "Not found");
}

function uploadLimits(request: Request, env: Env): Response {
  return request.method === "GET"
    ? Response.json(
        { maxUploadBytes: parseMaxUploadBytes(env.MAX_UPLOAD_BYTES) },
        { headers: { "Cache-Control": "no-store" } },
      )
    : methodNotAllowed("GET");
}

async function createUpload(request: Request, env: Env): Promise<Response> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return jsonError(400, "Request body must be valid JSON");
  }

  const parsed = parseCreateUpload(
    input,
    parseMaxUploadBytes(env.MAX_UPLOAD_BYTES),
  );
  if (!parsed.ok) {
    return jsonError(parsed.status, parsed.error);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = generateShareId();
    const token = await deriveShareToken(id);
    const tokenHash = await hashShareToken(token);
    const stub = shareStub(env, tokenHash);
    const initialized = await stub.initialize({
      tokenHash: tokenHash.value,
      objectKey: generateObjectKey().value,
      name: parsed.value.name,
      contentType: parsed.value.contentType,
      size: parsed.value.size,
      expiresAt: Date.now() + parsed.value.ttlSeconds * 1000,
    });
    if (initialized.kind === "created") {
      return Response.json(
        {
          id: id.value,
          uploadURL: absoluteUrl(request.url, `/v1/uploads/${id.value}`),
        },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  return jsonError(503, "Could not allocate an upload");
}

async function uploadObject(
  request: Request,
  env: Env,
  rawId: string,
): Promise<Response> {
  const id = parseShareId(rawId);
  if (id === null) {
    return jsonError(404, "Not found");
  }
  const token = await deriveShareToken(id);
  const tokenHash = await hashShareToken(token);
  const stub = shareStub(env, tokenHash);
  const store = createObjectStore(env);
  const attemptId = generateUploadAttemptId();
  const objectKey = generateObjectKey();
  const begin = await stub.beginUpload({
    tokenHash: tokenHash.value,
    attemptId: attemptId.value,
    objectKey: objectKey.value,
  });
  if (begin.kind === "conflict") {
    return jsonError(409, "Upload is no longer pending");
  }
  if (begin.kind === "not-found") {
    return jsonError(404, "Not found");
  }
  if (begin.kind === "gone") {
    return jsonError(410, "Upload has expired");
  }

  const contentLength = request.headers.get("Content-Length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) ||
      Number(contentLength) !== begin.expectedSize)
  ) {
    await cleanupUploadAttempt(
      store,
      stub,
      tokenHash.value,
      attemptId.value,
      objectKey.value,
    );
    return jsonError(400, "Upload byte count does not match the declared size");
  }
  if (request.body === null && begin.expectedSize !== 0) {
    await cleanupUploadAttempt(
      store,
      stub,
      tokenHash.value,
      attemptId.value,
      objectKey.value,
    );
    return jsonError(400, "Upload body is required");
  }

  const counter = { bytes: 0, exceeded: false, complete: false };
  const source =
    request.body ??
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  const counted = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        counter.bytes += chunk.byteLength;
        if (counter.bytes > begin.expectedSize) {
          counter.exceeded = true;
          throw new Error("Upload byte count exceeded");
        }
        controller.enqueue(chunk);
      },
      flush() {
        counter.complete = true;
      },
    }),
  );
  const fixedLength = new FixedLengthStream(begin.expectedSize);
  const pumping = counted.pipeTo(fixedLength.writable);

  try {
    await Promise.all([
      store.put({
        objectKey: objectKey.value,
        body: fixedLength.readable,
        contentType: begin.contentType,
      }),
      pumping,
    ]);
  } catch (error) {
    const byteMismatch =
      counter.exceeded ||
      (counter.complete && counter.bytes !== begin.expectedSize);
    if (!byteMismatch) {
      reportObjectStoreError("upload failed", error);
    }
    await cleanupUploadAttempt(
      store,
      stub,
      tokenHash.value,
      attemptId.value,
      objectKey.value,
    );
    return byteMismatch
      ? jsonError(400, "Upload byte count does not match the declared size")
      : jsonError(502, "Object storage rejected the upload");
  }

  if (counter.bytes !== begin.expectedSize) {
    await cleanupUploadAttempt(
      store,
      stub,
      tokenHash.value,
      attemptId.value,
      objectKey.value,
    );
    return jsonError(400, "Upload byte count does not match the declared size");
  }

  const committed = await stub.commitUpload({
    tokenHash: tokenHash.value,
    attemptId: attemptId.value,
  });
  if (committed.kind === "committed") {
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  }

  await cleanupUploadAttempt(
    store,
    stub,
    tokenHash.value,
    attemptId.value,
    objectKey.value,
  );
  return committed.kind === "gone"
    ? jsonError(410, "Upload has expired")
    : jsonError(409, "Upload is no longer pending");
}

async function completeUpload(
  request: Request,
  env: Env,
  rawId: string,
): Promise<Response> {
  const id = parseShareId(rawId);
  if (id === null) {
    return jsonError(404, "Not found");
  }
  const token = await deriveShareToken(id);
  const tokenHash = await hashShareToken(token);
  const result = await shareStub(env, tokenHash).complete(tokenHash.value);
  switch (result.kind) {
    case "complete":
      return Response.json(
        {
          shareURL: absoluteUrl(request.url, `/s/${token.value}`),
          expiresAt: new Date(result.share.expiresAt).toISOString(),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    case "not-ready":
      return jsonError(409, "Upload has not been verified");
    case "not-found":
      return jsonError(404, "Not found");
    case "gone":
      return jsonError(410, "Upload is no longer available");
  }
  throw new Error("Unexpected complete result");
}

async function revokeUpload(
  env: Env,
  rawId: string,
): Promise<Response> {
  const id = parseShareId(rawId);
  if (id === null) {
    return jsonError(404, "Not found");
  }
  const token = await deriveShareToken(id);
  const tokenHash = await hashShareToken(token);
  const result = await shareStub(env, tokenHash).revoke(tokenHash.value);
  return result.kind === "not-found"
    ? jsonError(404, "Not found")
    : new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
}

async function showShare(
  env: Env,
  rawToken: string,
  head: boolean,
): Promise<Response> {
  const token = parseShareToken(rawToken);
  if (token === null) {
    return shareStatus(404, head);
  }
  const tokenHash = await hashShareToken(token);
  const result = await shareStub(env, tokenHash).describe(tokenHash.value);
  switch (result.kind) {
    case "available": {
      const html = renderInterstitial(token.value, result.share);
      const headers = shareHeaders();
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      );
      return new Response(head ? null : html, { headers });
    }
    case "not-found":
      return shareStatus(404, head);
    case "gone":
      return shareStatus(410, head);
  }
  throw new Error("Unexpected share result");
}

async function download(
  _request: Request,
  env: Env,
  ctx: ExecutionContext,
  rawToken: string,
): Promise<Response> {
  const token = parseShareToken(rawToken);
  if (token === null) {
    return shareStatus(404, false);
  }
  const tokenHash = await hashShareToken(token);
  const stub = shareStub(env, tokenHash);
  const store = createObjectStore(env);
  const claimed = await stub.claim(tokenHash.value);
  if (claimed.kind === "not-found") {
    return shareStatus(404, false);
  }
  if (claimed.kind === "gone") {
    return shareStatus(410, false);
  }

  let stored: Response | null;
  try {
    stored = await store.get(claimed.share.objectKey);
  } catch {
    return shareStatus(502, false);
  }
  if (stored === null) {
    return shareStatus(502, false);
  }

  const headers = shareHeaders();
  headers.set("Content-Type", claimed.share.contentType);
  headers.set("Content-Length", claimed.share.size.toString());
  headers.set("Content-Disposition", attachmentHeader(claimed.share.name));

  if (stored.body === null) {
    ctx.waitUntil(deleteWithoutThrow(store, claimed.share.objectKey));
    return new Response(null, { headers });
  }

  const transfer = new TransformStream<Uint8Array, Uint8Array>();
  ctx.waitUntil(
    stored.body
      .pipeTo(transfer.writable)
      .catch(() => undefined)
      .then(() => deleteWithoutThrow(store, claimed.share.objectKey)),
  );
  return new Response(transfer.readable, { headers });
}

async function cleanupUploadAttempt(
  store: ObjectStore,
  stub: DurableObjectStub<ShareToken>,
  tokenHash: string,
  attemptId: string,
  objectKey: string,
): Promise<void> {
  try {
    await store.delete(objectKey);
    await stub.discardUploadAttempt({ tokenHash, attemptId });
  } catch {
    return;
  }
}

async function deleteWithoutThrow(
  store: ObjectStore,
  objectKey: string,
): Promise<void> {
  try {
    await store.delete(objectKey);
  } catch {
    return;
  }
}

function reportObjectStoreError(message: string, error: unknown): void {
  console.error(
    JSON.stringify({
      message,
      operation:
        error instanceof ObjectStoreError ? error.operation : "unknown",
      status: error instanceof ObjectStoreError ? error.status : null,
    }),
  );
}

function shareStub(
  env: Env,
  tokenHash: TokenHash,
): DurableObjectStub<ShareToken> {
  return env.SHARE_TOKENS.getByName(tokenHash.value);
}

async function hasUploadAuthorization(
  request: Request,
  expected: UploadKey,
): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  const prefix = "Bearer ";
  const hasBearer = authorization?.startsWith(prefix) ?? false;
  const provided = hasBearer ? (authorization?.slice(prefix.length) ?? "") : "";
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected.value)),
  ]);
  return (
    hasBearer &&
    provided.length > 0 &&
    crypto.subtle.timingSafeEqual(providedHash, expectedHash)
  );
}

function absoluteUrl(requestUrl: string, pathname: string): string {
  const url = new URL(requestUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function jsonError(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function methodNotAllowed(allow: string, share = false): Response {
  const headers = share ? shareHeaders() : new Headers({ "Cache-Control": "no-store" });
  headers.set("Allow", allow);
  return new Response(null, { status: 405, headers });
}

function shareStatus(status: 404 | 410 | 502, head: boolean): Response {
  const body =
    status === 404 ? "Not found" : status === 410 ? "Gone" : "Bad gateway";
  return new Response(head ? null : body, {
    status,
    headers: shareHeaders(),
  });
}

function shareHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
  });
}

function attachmentHeader(name: string): string {
  return `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function renderInterstitial(
  token: string,
  share: ShareDescriptor,
): string {
  const name = escapeHtml(share.name);
  const size = new Intl.NumberFormat("en-US").format(share.size);
  const action = `/s/${token}/download`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Download ${name}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(32rem, calc(100% - 2rem)); text-align: center; }
    h1 { overflow-wrap: anywhere; font-size: 1.5rem; }
    p { color: GrayText; }
    button { border: 0; border-radius: 0.6rem; padding: 0.8rem 1.2rem; background: LinkText; color: Canvas; font: inherit; font-weight: 650; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>${name}</h1>
    <p>${size} bytes</p>
    <form method="post" action="${action}">
      <button type="submit">Download</button>
    </form>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}
