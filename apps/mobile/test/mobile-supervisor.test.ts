import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { MOBILE_SUPERVISOR_CAPABILITIES, MobileSupervisorSession } from "../src/index.js";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  while (servers.length) {
    const wss = servers.pop()!;
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

describe("@ave/mobile supervisor boundary & SDK session", () => {
  it("disables timeline editing and mask refinement on mobile supervisor", () => {
    expect(MOBILE_SUPERVISOR_CAPABILITIES).toEqual({
      timelineEditing: false,
      maskRefinement: false,
      preview: true,
      approvals: true,
      cancelJob: true,
      verifiedDownload: true,
    });
  });

  it("connects via paired device credential, approves/rejects/cancels over client-sdk", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/ws" });
    servers.push(wss);
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const port = (wss.address() as { port: number }).port;

    const seenMethods: string[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { kind: string; id?: string; method?: string };
        if (msg.kind === "hello") {
          ws.send(
            JSON.stringify({
              kind: "hello_ack",
              protocolVersion: "1",
              principal: { principalId: "dev-1", role: "operator", projectIds: ["p1"] },
              serverTime: new Date().toISOString(),
            }),
          );
          return;
        }
        if (msg.kind === "request") {
          seenMethods.push(msg.method!);
          if (msg.method === "video.v1.list_projects") {
            ws.send(
              JSON.stringify({
                kind: "response",
                id: msg.id,
                ok: true,
                result: { projects: [{ projectId: "p1", title: "Mobile Supervision", revision: "0" }] },
              }),
            );
          } else {
            ws.send(
              JSON.stringify({
                kind: "response",
                id: msg.id,
                ok: true,
                result: { ok: true },
              }),
            );
          }
        }
      });
    });

    const session = await MobileSupervisorSession.pairAndConnect({
      url: `ws://127.0.0.1:${port}/ws`,
      device: { deviceId: "dev-1", credential: "secret" },
      WebSocketImpl: WebSocket as unknown as new (url: string) => never,
      reconnect: false,
    });

    const list = await session.listProjects();
    expect(list.projects).toHaveLength(1);

    await session.approve("ap-1", "0", "req-approve");
    await session.cancelJob("p1", "job-1", "req-cancel");
    expect(seenMethods).toEqual([
      "video.v1.list_projects",
      "video.v1.decide_approval",
      "video.v1.control_job",
    ]);
    session.close();
  });
});
