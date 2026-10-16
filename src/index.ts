/**
 * Entry point: validate config, boot mediasoup, start listening.
 */
import "dotenv/config";
import { config, validateConfig } from "./config";
import { MediasoupManager } from "./mediasoup";
import { createVoiceServer } from "./server";

async function main(): Promise<void> {
  validateConfig();

  const media = new MediasoupManager();
  await media.init();

  const server = await createVoiceServer(media);
  server.httpServer.listen(config.port, () => {
    console.log(`[voice] listening on :${config.port}`);
    console.log(`[voice] allowed origins: ${config.allowedOrigins.join(", ")}`);
    console.log(
      `[voice] mediasoup announcedIp=${config.mediasoup.announcedIp} ` +
        `rtc=${config.mediasoup.rtcMinPort}-${config.mediasoup.rtcMaxPort}`,
    );
  });

  const shutdown = async (signal: string) => {
    console.log(`[voice] ${signal} — shutting down`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    console.error("[voice] unhandled rejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[voice] uncaught exception:", err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("[voice] boot failed:", (err as Error).message);
  process.exit(1);
});
