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

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void main();
