import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ChatGptAccount, validateIdentity } from "../src/chatgpt-account.js";

const nativeFetch = globalThis.fetch;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = { ...pair.publicKey.export({ format: "jwk" }), kid: "test" };
const issuer = "https://auth.openai.com";
const dirList: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirList.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function jwt(nonce: string) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const data =
    encode({ kid: key.kid, alg: "RS256" }) +
    "." +
    encode({
      iss: issuer,
      aud: "issued",
      sub: "user",
      email: "test@example.org",
      nonce,
      exp: Date.now() / 1000 + 60,
    });
  return (
    data +
    "." +
    sign("RSA-SHA256", Buffer.from(data), pair.privateKey).toString("base64url")
  );
}
it("rejects a wrong nonce, audience or modified signature", async () => {
  const signed = jwt("good");
  await expect(
    validateIdentity(signed, "issued", "bad", [key]),
  ).rejects.toThrow();
  await expect(
    validateIdentity(signed, "other", "good", [key]),
  ).rejects.toThrow();
  await expect(
    validateIdentity(
      signed.slice(0, signed.lastIndexOf(".") + 1) + "AAAA",
      "issued",
      "good",
      [key],
    ),
  ).rejects.toThrow();
});
it.each([true, false])(
  "completes PKCE on loopback and supports persistent=%s",
  async (persistent) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ave-account-"));
    dirList.push(dir);
    let nonce = "",
      challenge = "",
      scope = "openid",
      refreshCount = 0,
      revokeCount = 0;
    const storage = {
      isEncryptionAvailable: () => persistent,
      getSelectedStorageBackend: () => "gnome_libsecret",
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString(),
    };
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/openid-configuration"))
        return Response.json({
          issuer,
          jwks_uri: issuer + "/keys",
          revocation_endpoint: issuer + "/revoke",
        });
      if (url === issuer + "/keys") return Response.json({ keys: [key] });
      if (url === issuer + "/revoke") {
        revokeCount++;
        return new Response();
      }
      if (url.endsWith("/oauth/token")) {
        const form = init.body as URLSearchParams;
        expect(form.get("client_id")).toBe("issued");
        if (form.get("grant_type") === "refresh_token") {
          refreshCount++;
          expect(form.get("refresh_token")).toBe("refresh1");
          return Response.json({
            access_token: "fresh",
            refresh_token: "refresh2",
            expires_in: 3600,
          });
        }
        expect(
          createHash("sha256")
            .update(form.get("code_verifier")!)
            .digest("base64url"),
        ).toBe(challenge);
        return Response.json({
          access_token: "access",
          id_token: jwt(nonce),
          scope,
          expires_in: 1,
          ...(scope.includes("direct") ? { refresh_token: "refresh1" } : {}),
        });
      }
      throw new Error("unexpected network destination");
    });
    const open = async (href: string) => {
      const auth = new URL(href);
      expect(auth.origin).toBe(issuer);
      nonce = auth.searchParams.get("nonce")!;
      challenge = auth.searchParams.get("code_challenge")!;
      const url = new URL(auth.searchParams.get("redirect_uri")!);
      url.search = new URLSearchParams({
        code: "mock",
        client_id: "issued",
        state: "other",
      }).toString();
      expect((await nativeFetch(url)).status).toBe(400);
      url.searchParams.set("state", auth.searchParams.get("state")!);
      expect((await nativeFetch(url)).status).toBe(200);
    };
    const account = new ChatGptAccount(dir, storage, open);
    await account.login();
    expect(account.status().enabled).toBe(false);
    scope += " resource.invoke chatgpt.tokens.use.direct";
    await account.login();
    expect(account.status().enabled).toBe(true);
    expect(await Promise.all([account.access(), account.access()])).toEqual([
      "fresh",
      "fresh",
    ]);
    expect(refreshCount).toBe(1);
    expect(new ChatGptAccount(dir, storage, open).status().enabled).toBe(
      persistent,
    );
    expect(readdirSync(dir).includes("session.enc")).toBe(persistent);
    await account.logout();
    expect(revokeCount).toBe(1);
    expect(new ChatGptAccount(dir, storage, open).status().account).toBeNull();
  },
);
