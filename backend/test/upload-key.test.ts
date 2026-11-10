import { describe, expect, it } from "vitest";

import devVarsExample from "../.dev.vars.example?raw";
import s3DevVarsExample from "../.dev.vars.s3.example?raw";
import readme from "../README.md?raw";
import smokeScript from "../scripts/smoke.sh?raw";
import {
  MIN_UPLOAD_KEY_LENGTH,
  parseUploadKey,
  UPLOAD_KEY_PLACEHOLDER,
} from "../src/domain";

function uploadKeyIn(text: string): string | undefined {
  return /^UPLOAD_KEY="?([^"\s#]*)"?/m.exec(text)?.[1];
}

describe("parseUploadKey", () => {
  it.each([
    [undefined, "missing"],
    ["", "missing"],
    [UPLOAD_KEY_PLACEHOLDER, "placeholder"],
    ["x".repeat(MIN_UPLOAD_KEY_LENGTH - 1), "too-short"],
  ] as const)("rejects %j as %s", (value, reason) => {
    expect(parseUploadKey(value)).toEqual({ ok: false, reason });
  });

  it("accepts a key at the minimum length", () => {
    const value = "x".repeat(MIN_UPLOAD_KEY_LENGTH);
    expect(parseUploadKey(value)).toEqual({
      ok: true,
      value: { kind: "upload-key", value },
    });
  });

  it("accepts a key from openssl rand -base64 32", () => {
    expect(
      parseUploadKey("q9Z1m0bW6v8Yc3Jt2rXs5Kp7Hn4Ld0Fg1Ae8Ui6Oy2Q=").ok,
    ).toBe(true);
  });
});

describe("upload key fixtures", () => {
  it(".dev.vars.example uses the guarded placeholder", () => {
    expect(uploadKeyIn(devVarsExample)).toBe(UPLOAD_KEY_PLACEHOLDER);
  });

  it("README names the guarded placeholder and minimum length", () => {
    expect(readme).toContain(`\`${UPLOAD_KEY_PLACEHOLDER}\``);
    expect(readme).toContain(`${MIN_UPLOAD_KEY_LENGTH} characters`);
  });

  it.each([
    [".dev.vars.s3.example", s3DevVarsExample],
    ["scripts/smoke.sh", smokeScript],
  ])("%s uses a key the guard accepts", (_name, text) => {
    expect(parseUploadKey(uploadKeyIn(text)).ok).toBe(true);
  });
});
