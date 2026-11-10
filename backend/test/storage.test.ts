import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import {
  createObjectStore,
  ObjectStoreConfigError,
  ObjectStoreError,
  R2ObjectStore,
  S3ObjectStore,
} from "../src/storage";

const API_ORIGIN = "https://transfer.test";

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

describe("R2ObjectStore", () => {
  it("round-trips bytes", async () => {
    const store = new R2ObjectStore(filesBucket());
    const key = objectKey();
    const bytes = new TextEncoder().encode("round-trip");
    await putFixed(store, key, bytes);

    const stored = await store.get(key);
    if (stored === null) {
      throw new Error("stored object is missing");
    }
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
  });

  it("returns null for a missing key", async () => {
    const store = new R2ObjectStore(filesBucket());
    expect(await store.get(objectKey())).toBeNull();
  });

  it("deletes a stored object and a missing key", async () => {
    const store = new R2ObjectStore(filesBucket());
    const key = objectKey();
    await putFixed(store, key, new TextEncoder().encode("delete-me"));

    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it("rejects a FixedLengthStream that closes short", async () => {
    const store = new R2ObjectStore(filesBucket());
    const fixed = new FixedLengthStream(4);
    const writer = fixed.writable.getWriter();
    const write = writer
      .write(new Uint8Array([1, 2]))
      .then(() => writer.close())
      .then(
        () => undefined,
        () => undefined,
      );

    await expect(
      store.put({
        objectKey: objectKey(),
        body: fixed.readable,
        contentType: "application/octet-stream",
      }),
    ).rejects.toBeInstanceOf(ObjectStoreError);
    await write;
  });

  it("rejects an unknown-length stream", async () => {
    const store = new R2ObjectStore(filesBucket());
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    await expect(
      store.put({
        objectKey: objectKey(),
        body,
        contentType: "application/octet-stream",
      }),
    ).rejects.toBeInstanceOf(ObjectStoreError);
  });
});

describe("storage selection", () => {
  it("selects R2 or S3 from STORAGE_BACKEND", () => {
    expect(createObjectStore({ ...env, STORAGE_BACKEND: "r2" })).toBeInstanceOf(
      R2ObjectStore,
    );
    expect(createObjectStore({ ...env, STORAGE_BACKEND: "s3" })).toBeInstanceOf(
      S3ObjectStore,
    );
  });

  it("rejects an invalid STORAGE_BACKEND", () => {
    expect(() =>
      createObjectStore({ ...env, STORAGE_BACKEND: "file" }),
    ).toThrow(ObjectStoreConfigError);
    expect(() =>
      createObjectStore({ ...env, STORAGE_BACKEND: "file" }),
    ).toThrow(/STORAGE_BACKEND/);
  });

  it("rejects a missing STORAGE_BACKEND", () => {
    const { STORAGE_BACKEND: _backend, ...missing } = env;
    expect(() => createObjectStore(missing)).toThrow(ObjectStoreConfigError);
    expect(() => createObjectStore(missing)).toThrow(/STORAGE_BACKEND/);
  });

  it("rejects r2 without the FILES binding", () => {
    const { FILES: _files, ...missing } = env;
    expect(() =>
      createObjectStore({ ...missing, STORAGE_BACKEND: "r2" }),
    ).toThrow(ObjectStoreConfigError);
    expect(() =>
      createObjectStore({ ...missing, STORAGE_BACKEND: "r2" }),
    ).toThrow(/FILES/);
  });

  it("rejects s3 without S3_ENDPOINT", () => {
    const { S3_ENDPOINT: _endpoint, ...missing } = env;
    expect(() =>
      createObjectStore({ ...missing, STORAGE_BACKEND: "s3" }),
    ).toThrow(ObjectStoreConfigError);
    expect(() =>
      createObjectStore({ ...missing, STORAGE_BACKEND: "s3" }),
    ).toThrow(/S3_ENDPOINT/);
  });
});

describe("R2 worker", () => {
  it("uploads once and then removes the object", async () => {
    const before = await listKeys();
    const body = new TextEncoder().encode("r2-once");
    const share = await createReadyShare(body);
    const key = await createdKey(before);

    const first = await dispatch(`${share.shareURL}/download`, { method: "POST" }, r2Env());
    const second = await dispatch(`${share.shareURL}/download`, { method: "POST" }, r2Env());

    expect(first.status).toBe(200);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(body);
    expect(second.status).toBe(410);
    expect(await filesBucket().get(key)).toBeNull();
  });

  it("does not consume a share when storage config is invalid", async () => {
    const body = new TextEncoder().encode("still-there");
    const share = await createReadyShare(body);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const invalid = withBackend("nope");

    const failed = await dispatch(
      `${share.shareURL}/download`,
      { method: "POST" },
      invalid,
    );
    const downloaded = await dispatch(
      `${share.shareURL}/download`,
      { method: "POST" },
      r2Env(),
    );

    expect(failed.status).toBe(500);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0]).toEqual([
      JSON.stringify({ message: "STORAGE_BACKEND must be r2 or s3" }),
    ]);
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(body);
  });
});

function r2Env(): Env {
  return { ...env, STORAGE_BACKEND: "r2" };
}

function withBackend(storageBackend: string): Env {
  return { ...env, STORAGE_BACKEND: storageBackend } as Env;
}

function filesBucket(): R2Bucket {
  if (env.FILES === undefined) {
    throw new Error("FILES binding is missing");
  }
  return env.FILES;
}

function objectKey(): string {
  return `unit/${crypto.randomUUID()}`;
}

async function listKeys(): Promise<Set<string>> {
  const listed = await filesBucket().list();
  return new Set(listed.objects.map((object) => object.key));
}

async function createdKey(before: ReadonlySet<string>): Promise<string> {
  const listed = await filesBucket().list();
  const created = listed.objects.filter((object) => !before.has(object.key));
  const key = created[0]?.key;
  if (key === undefined || created.length !== 1) {
    throw new Error(`expected one new object, found ${created.length}`);
  }
  return key;
}

async function putFixed(
  store: R2ObjectStore,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  const fixed = new FixedLengthStream(bytes.byteLength);
  const writer = fixed.writable.getWriter();
  await Promise.all([
    store.put({
      objectKey: key,
      body: fixed.readable,
      contentType: "text/plain",
    }),
    writer.write(bytes).then(() => writer.close()),
  ]);
}

async function dispatch(
  input: string,
  init: RequestInit | undefined,
  bindings: Env,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(input, init), bindings, ctx);
  const bytes = await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return new Response(response.status === 204 ? null : bytes, {
    status: response.status,
    headers: response.headers,
  });
}

async function createReadyShare(body: Uint8Array): Promise<{ shareURL: string }> {
  const created = await dispatch(
    `${API_ORIGIN}/v1/uploads`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.UPLOAD_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "fixture.txt",
        size: body.byteLength,
        type: "text/plain",
      }),
    },
    r2Env(),
  );
  expect(created.status).toBe(201);
  const { uploadURL, id } = await created.json<{ id: string; uploadURL: string }>();
  const uploaded = await dispatch(
    uploadURL,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${env.UPLOAD_KEY}` },
      body,
    },
    r2Env(),
  );
  expect(uploaded.status).toBe(204);
  const completed = await dispatch(
    `${API_ORIGIN}/v1/uploads/${id}/complete`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.UPLOAD_KEY}` },
    },
    r2Env(),
  );
  expect(completed.status).toBe(200);
  return completed.json<{ shareURL: string }>();
}
