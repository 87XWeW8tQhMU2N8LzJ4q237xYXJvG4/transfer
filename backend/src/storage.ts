import { AwsClient } from "aws4fetch";

export type ObjectStoreConfig = Readonly<{
  endpoint: URL;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}>;

type ObjectStoreEnv = Readonly<{
  STORAGE_BACKEND?: unknown;
  FILES?: R2Bucket;
  S3_ENDPOINT?: unknown;
  S3_REGION?: unknown;
  S3_BUCKET?: unknown;
  S3_ACCESS_KEY_ID?: unknown;
  S3_SECRET_ACCESS_KEY?: unknown;
}>;

export interface ObjectStore {
  put(input: {
    objectKey: string;
    body: ReadableStream<Uint8Array> | null;
    contentType: string;
  }): Promise<void>;
  get(objectKey: string): Promise<Response | null>;
  delete(objectKey: string): Promise<void>;
}

export class ObjectStoreError extends Error {
  constructor(
    readonly operation: "put" | "get" | "delete",
    readonly status: number | null,
  ) {
    super(
      status === null
        ? `Object store ${operation} request failed`
        : `Object store ${operation} request returned ${status}`,
    );
    this.name = "ObjectStoreError";
  }
}

export class ObjectStoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectStoreConfigError";
  }
}

export class R2ObjectStore implements ObjectStore {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  async put(input: {
    objectKey: string;
    body: ReadableStream<Uint8Array> | null;
    contentType: string;
  }): Promise<void> {
    try {
      await this.#bucket.put(input.objectKey, input.body, {
        httpMetadata: { contentType: input.contentType },
      });
    } catch {
      throw new ObjectStoreError("put", null);
    }
  }

  async get(objectKey: string): Promise<Response | null> {
    try {
      const object = await this.#bucket.get(objectKey);
      if (object === null) {
        return null;
      }
      return new Response(object.body);
    } catch {
      throw new ObjectStoreError("get", null);
    }
  }

  async delete(objectKey: string): Promise<void> {
    try {
      await this.#bucket.delete(objectKey);
    } catch {
      throw new ObjectStoreError("delete", null);
    }
  }
}

export class S3ObjectStore implements ObjectStore {
  readonly #config: ObjectStoreConfig;
  readonly #client: AwsClient;

  constructor(config: ObjectStoreConfig) {
    this.#config = config;
    this.#client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: config.region,
      retries: 0,
    });
  }

  async put(input: {
    objectKey: string;
    body: ReadableStream<Uint8Array> | null;
    contentType: string;
  }): Promise<void> {
    let response: Response;
    try {
      response = await this.#client.fetch(this.#objectUrl(input.objectKey), {
        method: "PUT",
        headers: {
          "Content-Type": input.contentType,
          "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
        },
        body: input.body,
        cache: "no-store",
      });
    } catch {
      throw new ObjectStoreError("put", null);
    }

    if (!response.ok) {
      await discardBody(response);
      throw new ObjectStoreError("put", response.status);
    }
    await discardBody(response);
  }

  async get(objectKey: string): Promise<Response | null> {
    let response: Response;
    try {
      response = await this.#client.fetch(this.#objectUrl(objectKey), {
        method: "GET",
        cache: "no-store",
      });
    } catch {
      throw new ObjectStoreError("get", null);
    }

    if (response.status === 404) {
      await discardBody(response);
      return null;
    }
    if (!response.ok) {
      await discardBody(response);
      throw new ObjectStoreError("get", response.status);
    }
    return response;
  }

  async delete(objectKey: string): Promise<void> {
    let response: Response;
    try {
      response = await this.#client.fetch(this.#objectUrl(objectKey), {
        method: "DELETE",
        cache: "no-store",
      });
    } catch {
      throw new ObjectStoreError("delete", null);
    }

    if (!response.ok && response.status !== 404) {
      await discardBody(response);
      throw new ObjectStoreError("delete", response.status);
    }
    await discardBody(response);
  }

  #objectUrl(objectKey: string): URL {
    const url = new URL(this.#config.endpoint);
    const basePath = url.pathname.replace(/\/+$/, "");
    const encodedKey = objectKey
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    url.pathname = `${basePath}/${encodeURIComponent(this.#config.bucket)}/${encodedKey}`;
    return url;
  }
}

export function objectStoreConfigFromEnv(
  env: ObjectStoreEnv,
): ObjectStoreConfig {
  const endpoint = parseEndpoint(requireString(env.S3_ENDPOINT, "S3_ENDPOINT"));
  const bucket = requireString(env.S3_BUCKET, "S3_BUCKET");
  const region = requireString(env.S3_REGION, "S3_REGION");
  const accessKeyId = requireString(env.S3_ACCESS_KEY_ID, "S3_ACCESS_KEY_ID");
  const secretAccessKey = requireString(
    env.S3_SECRET_ACCESS_KEY,
    "S3_SECRET_ACCESS_KEY",
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/.test(bucket)) {
    throw new ObjectStoreConfigError("S3_BUCKET is invalid");
  }
  if (!/^[A-Za-z0-9-]+$/.test(region)) {
    throw new ObjectStoreConfigError("S3_REGION is invalid");
  }

  return {
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
  };
}

export function createObjectStore(env: ObjectStoreEnv): ObjectStore {
  switch (readStorageBackend(env)) {
    case "r2": {
      if (env.FILES === undefined) {
        throw new ObjectStoreConfigError("FILES is required");
      }
      return new R2ObjectStore(env.FILES);
    }
    case "s3":
      return new S3ObjectStore(objectStoreConfigFromEnv(env));
  }
}

function readStorageBackend(env: ObjectStoreEnv): "r2" | "s3" {
  const backend = env.STORAGE_BACKEND;
  if (backend === "r2" || backend === "s3") {
    return backend;
  }
  throw new ObjectStoreConfigError(
    typeof backend === "string" && backend.length > 0
      ? "STORAGE_BACKEND must be r2 or s3"
      : "STORAGE_BACKEND is required",
  );
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new ObjectStoreConfigError(`${name} is required`);
  }
  if (value.length === 0) {
    throw new ObjectStoreConfigError(`${name} must not be empty`);
  }
  return value;
}

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ObjectStoreConfigError("S3_ENDPOINT must be an absolute URL");
  }
  if (
    (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new ObjectStoreConfigError("S3_ENDPOINT is invalid");
  }
  return endpoint;
}

async function discardBody(response: Response): Promise<void> {
  if (response.body !== null) {
    try {
      await response.body.cancel();
    } catch {
      return;
    }
  }
}
