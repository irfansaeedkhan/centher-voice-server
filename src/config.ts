/**
 * Environment-driven configuration. All secrets arrive via env vars —
 * nothing is hardcoded and values are never logged.
 */
import os from "os";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const DEFAULT_ORIGINS = [
  "https://centher-app.vercel.app",
  "http://localhost:3000",
];

export const config = {
  port: intEnv("PORT", 3001),

  allowedOrigins: (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  /** Shared Neon DB (read-only session lookups for auth). */
  databaseUrl: process.env.DATABASE_URL || "",

  mediasoup: {
    /** Workers are round-robined; capped so the free-tier VM isn't starved. */
    numWorkers: Math.min(intEnv("MEDIASOUP_NUM_WORKERS", os.cpus().length), 4),
    /** Public IP (or resolvable hostname) of this host — baked into ICE. */
    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || "127.0.0.1",
    rtcMinPort: intEnv("MEDIASOUP_RTC_MIN_PORT", 40000),
    rtcMaxPort: intEnv("MEDIASOUP_RTC_MAX_PORT", 49999),
  },
};

/**
 * Fail fast on missing required config. Called once at boot.
 * Never prints secret values.
 */
export function validateConfig(): void {
  if (!config.databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set — the voice server cannot verify sessions without it.",
    );
  }
  if (!config.allowedOrigins.length) {
    throw new Error("ALLOWED_ORIGINS resolved empty — refusing to start.");
  }
  if (config.mediasoup.rtcMinPort >= config.mediasoup.rtcMaxPort) {
    throw new Error("MEDIASOUP_RTC_MIN_PORT must be < MEDIASOUP_RTC_MAX_PORT.");
  }
}
