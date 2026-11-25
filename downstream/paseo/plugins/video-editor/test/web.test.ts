import { describe, expect, it } from "vitest";
import { Platform } from "react-native";
import { digestSource } from "../client/web.js";

// digestSource is the web workbench SHA-256 source-verification path (goal: shared
// desktop/web source import). Node exposes crypto.subtle, and react-native is
// stubbed to Platform.OS="web"; the non-web gate is exercised by mutating the stub.

const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("digestSource", () => {
  it("matches the SHA-256 known-answer vectors", async () => {
    expect(await digestSource(new TextEncoder().encode("abc").buffer)).toBe(ABC_SHA256);
    expect(await digestSource(new ArrayBuffer(0))).toBe(EMPTY_SHA256);
  });

  it("emits 64 lowercase hex characters", async () => {
    const digest = await digestSource(new TextEncoder().encode("video").buffer);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed on a non-web platform", async () => {
    const original = Platform.OS;
    Platform.OS = "android";
    try {
      await expect(digestSource(new ArrayBuffer(0))).rejects.toThrow(/当前工作台不支持文件校验/);
    } finally {
      Platform.OS = original;
    }
  });
});