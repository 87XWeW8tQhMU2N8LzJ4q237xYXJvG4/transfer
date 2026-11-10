import { env, exports } from "cloudflare:workers";
import {
  createExecutionContext,
  reset,
  runDurableObjectAlarm,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_TTL_SECONDS,
  MIN_UPLOAD_KEY_LENGTH,
  UPLOAD_KEY_PLACEHOLDER,
} from "../src/domain";
import worker from "../src/index";

const API_ORIGIN = "https://transfer.test";
const AUTHORIZATION = `Bearer ${env.UPLOAD_KEY}`;

type CreatedUpload = {
  id: string;
  uploadURL: string;
};

type CompletedUpload = {
  shareURL: string;
  expiresAt: string;
};

type ReadyShare = CompletedUpload & {
  id: string;
  token: string;
  body: Uint8Array;
};

let objects: Map<string, Uint8Array>;
let deletedObjects: string[];

beforeEach(() => {
  objects = new Map();
  deletedObjects = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input, init): Promise<Response> => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const authorization = request.headers.get("Authorization");
      if (
        url.origin !== "https://s3.test" ||
        !url.pathname.startsWith("/transfer-test/objects/") ||
        !authorization?.startsWith("AWS4-HMAC-SHA256 ")
      ) {
        return new Response(null, { status: 403 });
      }

      if (request.method === "PUT") {
        if (
          request.headers.get("X-Amz-Content-Sha256") !== "UNSIGNED-PAYLOAD"
        ) {
          return new Response(null, { status: 400 });
        }
        objects.set(
          url.pathname,
          new Uint8Array(await request.arrayBuffer()),
        );
        return new Response(null, { status: 200 });
      }
      if (request.method === "GET") {
        const body = objects.get(url.pathname);
        return body === undefined
          ? new Response(null, { status: 404 })
          : new Response(body, { status: 200 });
      }
      if (request.method === "DELETE") {
        deletedObjects.push(url.pathname);
        objects.delete(url.pathname);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    },
  );
});

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

describe("upload limits", () => {
  it("returns the configured upload limit", async () => {
    const response = await exports.default.fetch(`${API_ORIGIN}/v1/limits`, {
      headers: { Authorization: AUTHORIZATION },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ maxUploadBytes: 1024 });
  });

  it("rejects a limits request without authorization", async () => {
    const response = await exports.default.fetch(`${API_ORIGIN}/v1/limits`);

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("rejects POST to the limits route", async () => {
    const response = await exports.default.fetch(`${API_ORIGIN}/v1/limits`, {
      method: "POST",
      headers: { Authorization: AUTHORIZATION },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });
});

describe("upload API", () => {
  it("rejects missing upload authorization with 401", async () => {
    const response = await exports.default.fetch(`${API_ORIGIN}/v1/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "note.txt",
        size: 4,
        type: "text/plain",
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("rejects an upload over the configured limit with 413", async () => {
    const response = await createRequest({
      name: "large.bin",
      size: 1025,
      type: "application/octet-stream",
    });

    expect(response.status).toBe(413);
  });

  it("clamps ttlSeconds to seven days", async () => {
    const before = Date.now();
    const share = await createReadyShare(
      new TextEncoder().encode("ttl"),
      MAX_TTL_SECONDS + 500,
    );
    const after = Date.now();
    const expiresAt = Date.parse(share.expiresAt);

    expect(expiresAt).toBeGreaterThanOrEqual(
      before + MAX_TTL_SECONDS * 1000,
    );
    expect(expiresAt).toBeLessThanOrEqual(
      after + MAX_TTL_SECONDS * 1000,
    );
  });

  it("rejects a body whose byte count differs from the declared size", async () => {
    const created = await createUpload({
      name: "short.txt",
      size: 5,
      type: "text/plain",
    });
    const response = await exports.default.fetch(created.uploadURL, {
      method: "PUT",
      headers: { Authorization: AUTHORIZATION },
      body: "four",
    });

    expect(response.status).toBe(400);
    expect(objects.size).toBe(0);
    const complete = await completeRequest(created.id);
    expect(complete.status).toBe(409);
  });

  it("returns the same share URL when complete is retried", async () => {
    const share = await createReadyShare(new TextEncoder().encode("same"));
    const repeated = await completeRequest(share.id);
    const repeatedBody = await repeated.json<CompletedUpload>();

    expect(repeated.status).toBe(200);
    expect(repeatedBody).toEqual({
      shareURL: share.shareURL,
      expiresAt: share.expiresAt,
    });
  });

  it("revokes an active share", async () => {
    const share = await createReadyShare(new TextEncoder().encode("revoke"));
    const revoked = await exports.default.fetch(
      `${API_ORIGIN}/v1/uploads/${share.id}`,
      {
        method: "DELETE",
        headers: { Authorization: AUTHORIZATION },
      },
    );
    const lookup = await exports.default.fetch(share.shareURL);

    expect(revoked.status).toBe(204);
    expect(lookup.status).toBe(410);
    expect(objects.size).toBe(0);
  });
});

describe("one-time share", () => {
  it("serves an interstitial and HEAD does not consume the share", async () => {
    const share = await createReadyShare(new TextEncoder().encode("download"));
    const page = await exports.default.fetch(share.shareURL);
    const head = await exports.default.fetch(share.shareURL, {
      method: "HEAD",
    });
    const download = await exports.default.fetch(
      `${share.shareURL}/download`,
      { method: "POST" },
    );

    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<button type=\"submit\">Download</button>");
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(share.body);
  });

  it("allows exactly one of two concurrent downloads", async () => {
    const share = await createReadyShare(
      new TextEncoder().encode("one winner"),
    );
    const responses = await Promise.all([
      exports.default.fetch(`${share.shareURL}/download`, { method: "POST" }),
      exports.default.fetch(`${share.shareURL}/download`, { method: "POST" }),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    const winner = responses.find((response) => response.status === 200);

    expect(statuses).toEqual([200, 410]);
    if (winner === undefined) {
      throw new Error("Concurrent download had no winner");
    }
    expect(new Uint8Array(await winner.arrayBuffer())).toEqual(share.body);
  });

  it("returns 410 after a successful download", async () => {
    const share = await createReadyShare(new TextEncoder().encode("once"));
    const first = await exports.default.fetch(`${share.shareURL}/download`, {
      method: "POST",
    });
    await first.arrayBuffer();
    const second = await exports.default.fetch(`${share.shareURL}/download`, {
      method: "POST",
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(410);
  });

  it("expires with 410 and the alarm deletes the object", async () => {
    const share = await createReadyShare(
      new TextEncoder().encode("expires"),
      1,
    );
    const tokenHash = await sha256Hex(share.token);
    const stub = env.SHARE_TOKENS.getByName(tokenHash);

    expect(objects.size).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await runDurableObjectAlarm(stub);

    const response = await exports.default.fetch(share.shareURL);
    expect(response.status).toBe(410);
    expect(objects.size).toBe(0);
    expect(deletedObjects.length).toBeGreaterThan(0);
  });

  it("returns 404 for an unknown token", async () => {
    const response = await exports.default.fetch(
      `${API_ORIGIN}/s/${"a".repeat(64)}`,
    );

    expect(response.status).toBe(404);
  });
});

describe("upload key guard", () => {
  const rejectedKeys = [
    ["the example placeholder", UPLOAD_KEY_PLACEHOLDER],
    ["a short key", "x".repeat(MIN_UPLOAD_KEY_LENGTH - 1)],
    ["an empty key", ""],
  ] as const;

  const v1Requests: ReadonlyArray<readonly [string, RequestInit]> = [
    ["/v1/limits", { method: "GET" }],
    [
      "/v1/uploads",
      {
        method: "POST",
        body: JSON.stringify({ name: "a.txt", size: 1, type: "text/plain" }),
      },
    ],
    [`/v1/uploads/${"a".repeat(64)}`, { method: "PUT", body: "a" }],
    [`/v1/uploads/${"a".repeat(64)}/complete`, { method: "POST" }],
    [`/v1/uploads/${"a".repeat(64)}`, { method: "DELETE" }],
  ];

  it.each(rejectedKeys)(
    "fails every /v1/ route closed for %s, even with a matching bearer",
    async (_label, key) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      for (const [path, init] of v1Requests) {
        const response = await fetchWithKey(key, `${API_ORIGIN}${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${key}` },
        });
        const body = await response.text();

        expect(response.status, path).toBe(503);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(JSON.parse(body)).toEqual({
          error: `Upload API is disabled until UPLOAD_KEY is set to a random value of at least ${MIN_UPLOAD_KEY_LENGTH} characters`,
        });
        if (key.length > 0) {
          expect(body).not.toContain(key);
        }
      }
      expect(errors).toHaveBeenCalled();
      for (const call of errors.mock.calls) {
        const logged = call.map(String).join(" ");
        expect(logged).toContain("UPLOAD_KEY rejected");
        if (key.length > 0) {
          expect(logged).not.toContain(key);
        }
      }
      expect(objects.size).toBe(0);
    },
  );

  it("keeps existing shares downloadable once while the key is rejected", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const share = await createReadyShare(new TextEncoder().encode("kept"));

    const page = await fetchWithKey(UPLOAD_KEY_PLACEHOLDER, share.shareURL);
    const download = await fetchWithKey(
      UPLOAD_KEY_PLACEHOLDER,
      `${share.shareURL}/download`,
      { method: "POST" },
    );
    const body = new Uint8Array(await download.arrayBuffer());
    expect(objects.size).toBe(0);
    const again = await fetchWithKey(
      UPLOAD_KEY_PLACEHOLDER,
      `${share.shareURL}/download`,
      { method: "POST" },
    );

    expect(page.status).toBe(200);
    expect(download.status).toBe(200);
    expect(body).toEqual(share.body);
    expect(again.status).toBe(410);
  });
});

async function fetchWithKey(
  uploadKey: string,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(url, init),
    { ...env, UPLOAD_KEY: uploadKey },
    ctx,
  );
  const body = await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return new Response(body.byteLength > 0 ? body : null, response);
}

async function createReadyShare(
  body: Uint8Array,
  ttlSeconds?: number,
): Promise<ReadyShare> {
  const created = await createUpload({
    name: "fixture.txt",
    size: body.byteLength,
    type: "text/plain",
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
  });
  const upload = await exports.default.fetch(created.uploadURL, {
    method: "PUT",
    headers: { Authorization: AUTHORIZATION },
    body,
  });
  expect(upload.status).toBe(204);

  const complete = await completeRequest(created.id);
  expect(complete.status).toBe(200);
  const completed = await complete.json<CompletedUpload>();
  const token = new URL(completed.shareURL).pathname.split("/").at(-1);
  if (token === undefined) {
    throw new Error("Share URL has no token");
  }
  return { ...created, ...completed, token, body };
}

async function createUpload(input: {
  name: string;
  size: number;
  type: string;
  ttlSeconds?: number;
}): Promise<CreatedUpload> {
  const response = await createRequest(input);
  expect(response.status).toBe(201);
  return response.json<CreatedUpload>();
}

function createRequest(input: {
  name: string;
  size: number;
  type: string;
  ttlSeconds?: number;
}): Promise<Response> {
  return exports.default.fetch(`${API_ORIGIN}/v1/uploads`, {
    method: "POST",
    headers: {
      Authorization: AUTHORIZATION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

function completeRequest(id: string): Promise<Response> {
  return exports.default.fetch(`${API_ORIGIN}/v1/uploads/${id}/complete`, {
    method: "POST",
    headers: { Authorization: AUTHORIZATION },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
