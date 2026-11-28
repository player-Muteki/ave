import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
  type JsonWebKey,
} from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const scopes =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const random = () => randomBytes(32).toString("base64url");

export interface SecretStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface Session {
  client: string;
  sub: string;
  label: string;
  token: string;
  refresh: string;
  expires: number;
  scope: string;
}

function writeAtomic(file: string, value: Buffer | string) {
  const tmp = file + "." + randomUUID();
  try {
    writeFileSync(tmp, value, { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

class InvalidGrant extends Error {}

async function official(url: string, options: RequestInit = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)])
      : AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (body?.error === "invalid_grant")
      throw new InvalidGrant("授权已失效，请重新登录");
    if (response.status === 429)
      throw new Error("已达到用量限制，请查看 ChatGPT 用量");
    throw new Error("OpenAI 请求失败（HTTP " + response.status + "）");
  }
  return response;
}

async function trustedEndpoint(key: string) {
  const metadata = await (
    await official(issuer + "/.well-known/openid-configuration")
  ).json();
  const endpoint = new URL(metadata[key]);
  if (endpoint.origin !== issuer || metadata.issuer !== issuer)
    throw new Error("OpenAI 服务身份不匹配");
  return endpoint.href;
}

export async function validateIdentity(
  jwt: string,
  client: string,
  nonce: string,
  keys: Array<JsonWebKey & { kid?: string }>,
) {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("无效的身份令牌");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  const key = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (
    header.alg !== "RS256" ||
    !key ||
    !verify(
      "RSA-SHA256",
      Buffer.from(parts[0] + "." + parts[1]),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(parts[2], "base64url"),
    )
  )
    throw new Error("身份签名无效");
  const p = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  const audiences = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (
    p.iss !== issuer ||
    !audiences.includes(client) ||
    (audiences.length > 1 && p.azp !== client) ||
    p.nonce !== nonce ||
    typeof p.exp !== "number" ||
    p.exp <= Date.now() / 1000 ||
    typeof p.sub !== "string" ||
    !p.sub
  ) {
    throw new Error("账号身份校验失败");
  }
  return {
    sub: p.sub as string,
    label: typeof p.email === "string" ? p.email : "ChatGPT 账号",
  };
}

export class ChatGptAccount {
  private session?: Session;
  private pending?: AbortController;
  private refreshing?: Promise<string>;
  private readonly file: string;
  private readonly registrationFile: string;
  private readonly host: string;
  private registration?: { client: string; sub: string };
  private persistent = false;
  private generation = 0;
  constructor(
    directory: string,
    private storage: SecretStorage,
    private open: (url: string) => Promise<void>,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, "session.enc");
    this.registrationFile = path.join(directory, "registration.json");
    const hostFile = path.join(directory, "host");
    if (!existsSync(hostFile))
      writeAtomic(hostFile, "urn:uuid:" + randomUUID());
    this.host = readFileSync(hostFile, "utf8");
    if (existsSync(this.registrationFile))
      this.registration = JSON.parse(
        readFileSync(this.registrationFile, "utf8"),
      );
    try {
      this.persistent =
        storage.isEncryptionAvailable() &&
        (process.platform !== "linux" ||
          ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(
            storage.getSelectedStorageBackend?.() ?? "",
          ));
      if (this.persistent && existsSync(this.file))
        this.session = JSON.parse(
          storage.decryptString(readFileSync(this.file)),
        );
    } catch {
      this.persistent = false;
    }
  }
  get sessionVersion() {
    return this.generation;
  }
  status() {
    return {
      account: this.session?.label ?? null,
      enabled:
        this.session?.scope
          .split(/\s+/)
          .includes("chatgpt.tokens.use.direct") ?? false,
      persistent: this.persistent,
      pending: Boolean(this.pending),
    };
  }
  private save(session: Session) {
    if (this.persistent) {
      try {
        writeAtomic(
          this.file,
          this.storage.encryptString(JSON.stringify(session)),
        );
      } catch {
        rmSync(this.file, { force: true });
        this.persistent = false;
      }
    }
    this.session = session;
  }
  cancel() {
    this.pending?.abort();
  }
  async login() {
    this.cancel();
    const attempt = new AbortController();
    this.pending = attempt;
    const signal = AbortSignal.any([
      attempt.signal,
      AbortSignal.timeout(180000),
    ]);
    const state = random(),
      nonce = random(),
      verifier = random();
    const server = createServer();
    try {
      await new Promise<void>((ok, fail) =>
        server.once("error", fail).listen(0, "127.0.0.1", ok),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("无法启动本机回调");
      const redirect = "http://127.0.0.1:" + address.port + "/auth/callback";
      const registration = this.registration;
      const needsConsent = this.session && !this.status().enabled;
      const auth = new URL(issuer + "/api/accounts/authorize");
      auth.search = new URLSearchParams({
        client_id: registration?.client ?? "dynamic_agent_client",
        ...(registration ? {} : { agent_name_hint: "AVE" }),
        ...(needsConsent ? { prompt: "consent" } : {}),
        response_type: "code",
        redirect_uri: redirect,
        resource,
        scope: scopes,
        state,
        nonce,
        ext_agent_host_id: this.host,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
      }).toString();
      const result = await new Promise<URLSearchParams>((ok, fail) => {
        signal.addEventListener(
          "abort",
          () => fail(new Error("登录已取消或超时")),
          { once: true },
        );
        if (signal.aborted) return fail(new Error("登录已取消"));
        server.on("request", (req, res) => {
          let url: URL;
          try {
            url = new URL(req.url ?? "/", redirect);
          } catch {
            res.writeHead(400).end();
            return;
          }
          if (
            req.method !== "GET" ||
            req.headers.host !== new URL(redirect).host ||
            url.pathname !== "/auth/callback" ||
            url.searchParams.get("state") !== state
          ) {
            res.writeHead(400).end();
            return;
          }
          res
            .writeHead(200, {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
            })
            .end("请返回 AVE 查看登录结果。");
          server.close();
          ok(url.searchParams);
        });
        void this.open(auth.href).catch(fail);
      });
      const code = result.get("code"),
        client = result.get("client_id") ?? registration?.client;
      if (
        !code ||
        !client ||
        client === "dynamic_agent_client" ||
        (registration && registration.client !== client)
      )
        throw new Error("授权未完成");
      const tokens = await this.exchange(
        {
          grant_type: "authorization_code",
          client_id: client,
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
        },
        signal,
      );
      const jwks = await (
        await official(await trustedEndpoint("jwks_uri"), { signal })
      ).json();
      const identity = await validateIdentity(
        tokens.id_token,
        client,
        nonce,
        jwks.keys,
      );
      signal.throwIfAborted();
      if (registration && registration.sub !== identity.sub)
        throw new Error("登录账号与注册记录不匹配");
      const session = this.fromTokens(tokens, { client, ...identity });
      writeAtomic(
        this.registrationFile,
        JSON.stringify({ client, sub: identity.sub }),
      );
      this.registration = { client, sub: identity.sub };
      this.generation++;
      this.save(session);
      return this.status();
    } finally {
      server.close();
      server.closeAllConnections();
      if (this.pending === attempt) this.pending = undefined;
    }
  }
  private async exchange(fields: Record<string, string>, signal?: AbortSignal) {
    return (
      await official(issuer + "/api/accounts/oauth/token", {
        method: "POST",
        body: new URLSearchParams({ ...fields, resource }),
        signal,
      })
    ).json();
  }
  private fromTokens(
    t: Record<string, unknown>,
    identity: Pick<Session, "client" | "sub" | "label">,
    prior?: Session,
  ): Session {
    const refresh = t.refresh_token ?? prior?.refresh ?? "";
    const scope = t.scope ?? prior?.scope;
    if (
      typeof t.access_token !== "string" ||
      !t.access_token ||
      typeof refresh !== "string" ||
      typeof scope !== "string" ||
      typeof t.expires_in !== "number" ||
      t.expires_in <= 0
    )
      throw new Error("OpenAI 返回的授权信息不完整");
    return {
      ...identity,
      token: t.access_token,
      refresh,
      scope,
      expires: Date.now() + 1000 * t.expires_in,
    };
  }
  async access() {
    const s = this.session;
    if (!s || !this.status().enabled)
      throw new Error("请先授权使用 ChatGPT 套餐");
    if (s.expires > Date.now() + 60000) return s.token;
    if (!s.refresh) throw new Error("请重新登录 ChatGPT");
    if (!this.refreshing) {
      const version = this.generation;
      const operation: Promise<string> = this.exchange({
        grant_type: "refresh_token",
        client_id: s.client,
        refresh_token: s.refresh,
      })
        .then((t) => {
          if (this.generation !== version) throw new Error("账号已变更");
          const next = this.fromTokens(t, s, s);
          this.save(next);
          if (!this.status().enabled) throw new Error("请重新授权使用套餐");
          return next.token;
        })
        .catch((err) => {
          if (err instanceof InvalidGrant && this.generation === version) {
            this.generation++;
            this.session = undefined;
            rmSync(this.file, { force: true });
          }
          throw err;
        })
        .finally(() => {
          if (this.refreshing === operation) this.refreshing = undefined;
        });
      this.refreshing = operation;
    }
    return this.refreshing;
  }
  async models(): Promise<Array<{ id: string; name: string }>> {
    const token = await this.access();
    const body = await (
      await official(resource + "/models", {
        headers: { authorization: "Bearer " + token },
      })
    ).json();
    return body.models
      .filter(
        (m: Record<string, unknown>) =>
          m.visibility === "list" && typeof m.slug === "string",
      )
      .map((m: { slug: string; display_name?: string }) => ({
        id: m.slug,
        name: m.display_name ?? m.slug,
      }));
  }
  async logout() {
    this.cancel();
    const old = this.session;
    this.generation++;
    this.session = undefined;
    rmSync(this.file, { force: true });
    if (!old?.refresh) return;
    try {
      await official(await trustedEndpoint("revocation_endpoint"), {
        method: "POST",
        body: new URLSearchParams({
          token: old.refresh,
          token_type_hint: "refresh_token",
          client_id: old.client,
        }),
      });
    } catch {
      throw new Error("本机已退出，远端撤销尚未确认");
    }
  }
}
