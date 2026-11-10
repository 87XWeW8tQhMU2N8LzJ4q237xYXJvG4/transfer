# Transfer backend

This Cloudflare Worker creates one-time download links. The default storage is the R2 binding `FILES`. Set `STORAGE_BACKEND` to `s3` to use an S3-compatible store through `aws4fetch`. MinIO is the local S3 target. Wasabi is a later S3 target.

Each share has one Durable Object keyed by the token hash. The object owns the upload state, expiry, atomic download claim, and cleanup alarm. The Durable Object never stores the raw token.

## Requirements

- Node.js 22 or later
- npm
- MinIO and `mc` for the smoke test

Install the local tools with Homebrew:

```sh
brew install minio minio-mc
```

Install the package dependencies:

```sh
npm install
```

## Configure local development

The default local worker uses R2. Copy the example file and replace the upload key. The example value is `replace-with-a-random-key`. The worker rejects that value and any key shorter than 32 characters, so every `/v1/` route returns 503 until you replace it. Generate a key with `openssl rand -base64 32`.

```sh
cp .dev.vars.example .dev.vars
npm run dev
```

`npm run dev` runs `wrangler dev --local`. `STORAGE_BACKEND` is `r2`.

For local S3, copy the s3 example and start the s3 environment. Start MinIO first. The example points at MinIO on `127.0.0.1:9000`. The smoke script starts MinIO for you.

```sh
cp .dev.vars.s3.example .dev.vars.s3
npx wrangler dev --local --env s3
```

Wrangler reads these bindings.

| Binding | Purpose |
| --- | --- |
| `UPLOAD_KEY` | Bearer secret for every `/v1/` route |
| `STORAGE_BACKEND` | `r2` for the FILES bucket, or `s3` for the S3 secrets |
| `FILES` | R2 bucket `transfer-files` on the default worker |
| `SHARE_TOKENS` | Durable Object namespace for share state |
| `MAX_UPLOAD_BYTES` | Maximum declared upload size. The default is 104857600 bytes |
| `S3_ENDPOINT` | S3 origin for the s3 environment |
| `S3_REGION` | SigV4 region for the s3 environment |
| `S3_BUCKET` | Bucket name for the s3 environment |
| `S3_ACCESS_KEY_ID` | Access key for the s3 environment |
| `S3_SECRET_ACCESS_KEY` | Secret key for the s3 environment |

The S3 adapter uses path-style URLs in the form `S3_ENDPOINT/S3_BUCKET/object-key`. This shape works with local MinIO, R2 S3 endpoints, and Wasabi S3 endpoints.

## API

Every `/v1/` request requires `Authorization: Bearer <UPLOAD_KEY>`.

| Request | Result |
| --- | --- |
| `GET /v1/limits` | Returns `{maxUploadBytes}` for the configured upload size limit |
| `POST /v1/uploads` | Creates an upload from `{name,size,type,ttlSeconds}` and returns `{id,uploadURL}` |
| `PUT /v1/uploads/:id` | Streams the request body to object storage and accepts it only when the byte count matches |
| `POST /v1/uploads/:id/complete` | Activates a verified upload and returns `{shareURL,expiresAt}` |
| `DELETE /v1/uploads/:id` | Revokes the upload or active share |
| `GET /s/:token` | Returns the download interstitial without consuming the share |
| `HEAD /s/:token` | Checks the share without consuming it |
| `POST /s/:token/download` | Atomically claims and streams the object once |

`ttlSeconds` defaults to 86400 seconds and clamps at 604800 seconds. Unknown tokens return 404. Expired, revoked, or consumed tokens return 410.

The interstitial has no analytics or external scripts. Share responses set `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Wrangler observability is disabled because share tokens appear in request paths.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/87XWeW8tQhMU2N8LzJ4q237xYXJvG4/transfer/tree/main/backend)

The repository must be public. The `backend` directory must be self-contained, because the button uses that directory as the new repository root.

The button provisions these resources.

- Worker `transfer-backend`
- Durable Object namespace `SHARE_TOKENS` with sqlite migration v1
- R2 bucket `transfer-files`
- workers.dev URL

Deploy the default worker with `npm run deploy`. That command targets the top-level environment. The button prompts for `UPLOAD_KEY`. You can also set it with `npx wrangler secret put UPLOAD_KEY`.

After deploy, confirm the upload key. Use the output of `openssl rand -base64 32`. The worker fails closed when `UPLOAD_KEY` is the example placeholder `replace-with-a-random-key` or shorter than 32 characters. Every `/v1/` route then returns 503 with an error that names the requirement and never the key. The worker logs only the rejection reason. Existing share links keep working. Check the key with `curl -H "Authorization: Bearer <UPLOAD_KEY>" https://<worker-host>/v1/limits`. A 503 means you must set a new key with `npx wrangler secret put UPLOAD_KEY`.

To use a custom domain, attach the hostname, then set `workers_dev` to `false`. Set `TRANSFER_BASE_URL` in `app/project.yml` to the worker URL.

For S3 or Wasabi, run `wrangler deploy --env s3`. Set `UPLOAD_KEY`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` with `wrangler secret put --env s3`. That environment deploys as a separate worker named `transfer-backend-s3`. Wrangler warns that `FILES` is missing from the s3 environment. Leave that binding unset. The s3 worker does not use R2.

### Open questions

- `MAX_UPLOAD_BYTES` stays 104857600, which is 100 MiB. The zone limit is documented as 100 MB. It is unclear whether that documented limit is decimal. Uploads near the cap may be rejected by the edge. The value is intentionally unchanged.
- S3 put and get run in the Worker. The Durable Object only sends S3 DELETE during cleanup. The 100 MiB Durable Object outbound body limit does not apply to those transfers today. It would apply if the transfers moved into the Durable Object.
- It is unverified whether the deploy button sets `UPLOAD_KEY` before the first `wrangler deploy`. `secrets.required` makes that deploy fail when the secret is missing. The button order was not verified offline. If the deploy fails, run `npx wrangler secret put UPLOAD_KEY` and run the build again.

## Deployment placeholders

Keep the public origin and the secrets out of `wrangler.jsonc`. No account id and no hostname are configured there.

The public origin placeholder is `https://transfer.example.invalid`. Attach that hostname as a custom domain when you want a stable origin. Then set `workers_dev` to `false`. Set `TRANSFER_BASE_URL` in `app/project.yml` to that same origin. The Worker builds share URLs from the request origin. It has no base-URL variable.

The default worker has one secret, `UPLOAD_KEY`. Its placeholder is `<UPLOAD_KEY>`.

The s3 environment uses these placeholders.

- `S3_ENDPOINT` is `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` for an R2 S3 endpoint. For Wasabi, `S3_ENDPOINT` is `https://s3.<WASABI_REGION>.wasabisys.com`.
- `S3_REGION` is `auto` for an R2 S3 endpoint.
- `S3_BUCKET` is `<TRANSFER_BUCKET>`.
- `S3_ACCESS_KEY_ID` is `<R2_ACCESS_KEY_ID>`.
- `S3_SECRET_ACCESS_KEY` is `<R2_SECRET_ACCESS_KEY>`.
- `UPLOAD_KEY` is `<UPLOAD_KEY>`.

`MAX_UPLOAD_BYTES` is a Worker var. The open question above covers the documented 100 MB zone limit.

## Verify

Run the type check, the test suite, and the offline deploy check.

```sh
npm run typecheck
npm test
npm run check:deploy
```

Run the end-to-end smoke test.

```sh
./scripts/smoke.sh
```

The smoke script starts MinIO on `127.0.0.1:9000` and Wrangler on `127.0.0.1:8787`. It uses the s3 environment. It stores MinIO data under `.minio`, stores Wrangler state under `.wrangler`, and stops both processes on exit.

## Test runtime compatibility

The project uses `@cloudflare/vitest-pool-workers` as required. Cloudflare renamed this package to `@cloudflare/vitest-plugin` in August 2026 and no longer updates the old package. Version 0.23.0 bundles a runtime that supports compatibility dates through `2026-08-22`, so `vitest.config.ts` pins only the test runtime to that date. `wrangler.jsonc` keeps the Worker compatibility date at `2026-11-08`.
