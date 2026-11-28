import {
  StartPlanningRunInputSchema,
  describeEditorError,
} from "@ave/contracts";
import { randomUUID } from "node:crypto";
import { AveDaemon } from "./daemon.js";

async function main(): Promise<void> {
  const daemon = await AveDaemon.create({
    aveHome: process.env.AVE_HOME,
    host: process.env.AVE_HOST ?? "127.0.0.1",
    port: process.env.AVE_PORT ? Number(process.env.AVE_PORT) : 0,
    ownerToken: process.env.AVE_OWNER_TOKEN,
  });

  const addr = await daemon.start();
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      aveHome: addr.aveHome,
      wsUrl: addr.wsUrl,
      healthUrl: addr.healthUrl,
      port: addr.port,
    })}\n`,
  );

  if (process.send) {
    const waiting = new Map<string, (token?: string) => void>();
    process.on("disconnect", () => {
      void daemon.stop().finally(() => process.exit(0));
    });
    process.on(
      "message",
      async (msg: {
        kind?: string;
        id?: string;
        input?: unknown;
        token?: string;
      }) => {
        if (msg?.kind === "desktop-logout") {
          for (const finish of waiting.values()) finish();
          await daemon.planner.stopDesktopRuns();
          return;
        }
        if (!msg || typeof msg.id !== "string") return;
        if (msg.kind === "credential") {
          waiting.get(msg.id)?.(msg.token);
          return;
        }
        if (msg.kind !== "desktop-start") return;
        const id = msg.id;
        try {
          const input = StartPlanningRunInputSchema.parse(msg.input);
          if (input.model?.provider !== "chatgpt")
            throw new Error("Unknown desktop provider");
          const result = await daemon.planner.startRun(
            input,
            daemon.ownerPrincipal(),
            () =>
              new Promise((resolve, reject) => {
                const exchange = randomUUID();
                const finish = (token?: string) => {
                  clearTimeout(timer);
                  waiting.delete(exchange);
                  if (token) resolve(token);
                  else reject(new Error("ChatGPT 授权不可用"));
                };
                const timer = setTimeout(finish, 30000);
                waiting.set(exchange, finish);
                process.send?.({ kind: "need-credential", id, exchange });
              }),
          );
          process.send?.({ kind: "desktop-result", id, result });
        } catch (err) {
          process.send?.({
            kind: "desktop-result",
            id,
            error: describeEditorError(err).sanitizedDetail,
          });
        }
      },
    );
  }

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void main();
