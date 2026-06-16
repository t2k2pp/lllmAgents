import { describe, it, expect } from "vitest";
import { isLikelyPermanentToolError } from "../../src/agent/tool-error-classification.js";

describe("isLikelyPermanentToolError", () => {
  it("HTTP 認証/権限系は恒久と判定", () => {
    expect(isLikelyPermanentToolError("Request failed with status 401")).toBe(true);
    expect(isLikelyPermanentToolError("HTTP 403 Forbidden")).toBe(true);
    expect(isLikelyPermanentToolError("401 Unauthorized")).toBe(true);
    expect(isLikelyPermanentToolError("Forbidden")).toBe(true);
    expect(isLikelyPermanentToolError("Invalid Webhook Token")).toBe(true);
    expect(isLikelyPermanentToolError("認証に失敗しました")).toBe(true);
    expect(isLikelyPermanentToolError("permission denied")).toBe(true);
    expect(isLikelyPermanentToolError("権限確認がタイムアウトしました (300s)")).toBe(true);
  });

  it("一過性 (ネット断・タイムアウト) は恒久としない", () => {
    expect(isLikelyPermanentToolError("ECONNRESET")).toBe(false);
    expect(isLikelyPermanentToolError("socket hang up")).toBe(false);
    expect(isLikelyPermanentToolError("request timed out after 30s")).toBe(false);
    expect(isLikelyPermanentToolError("ETIMEDOUT")).toBe(false);
    expect(isLikelyPermanentToolError("500 Internal Server Error")).toBe(false);
    expect(isLikelyPermanentToolError("file not found")).toBe(false);
  });

  it("空・未定義は false (情報なし → 一過性扱いで安全側にリトライ)", () => {
    expect(isLikelyPermanentToolError("")).toBe(false);
    expect(isLikelyPermanentToolError(undefined)).toBe(false);
  });

  it("数値の部分一致 (4011 等) を 401/403 と誤検知しない", () => {
    expect(isLikelyPermanentToolError("processed 4011 records")).toBe(false);
    expect(isLikelyPermanentToolError("port 4030 in use")).toBe(false);
  });
});
