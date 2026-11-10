import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const bindings = {
  STORAGE_BACKEND: "s3",
  MAX_UPLOAD_BYTES: "1024",
  UPLOAD_KEY: "test-upload-key-for-vitest-only-0000",
  S3_ENDPOINT: "https://s3.test",
  S3_REGION: "us-east-1",
  S3_BUCKET: "transfer-test",
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_SECRET_ACCESS_KEY: "test-secret-key",
};

Object.assign(process.env, bindings);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        compatibilityDate: "2026-08-22",
        bindings,
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
