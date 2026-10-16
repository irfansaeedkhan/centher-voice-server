/**
 * Socket authentication.
 *
 * The web app's SocketClientService sends `Authorization: Bearer <token>`
 * in the polling transport's extraHeaders. The token is the Better Auth
 * session token (the same one the app's own API validates via
 * `auth.api.getSession`). We verify it with a READ-ONLY lookup against the
 * shared Neon DB: `session.token` must exist and not be expired.
 *
 * Fail-closed: any error (no DB URL, query failure, expired token) means
 * "not authenticated" — the socket is rejected with a clean error the
 * client surfaces as "Could not connect to the voice server."
 */
import { neon } from "@neondatabase/serverless";
import { config } from "./config";

/** Injectable DB lookup so tests don't need a real database. */
export type SessionLookup = (
  token: string,
) => Promise<{ userId: string } | null>;

function defaultSessionLookup(databaseUrl: string): SessionLookup {
  const sql = neon(databaseUrl);
  return async (token: string) => {
    const rows = (await sql`
      SELECT user_id AS "userId" FROM session
      WHERE token = ${token} AND expires_at > NOW()
      LIMIT 1
    `) as Array<{ userId: string }>;
    if (!rows.length) return null;
    return { userId: rows[0].userId };
  };
}

export function parseBearerToken(
  authorizationHeader: string | undefined,
): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
  return match ? match[1] : null;
}

/**
 * Returns the authenticated userId, or null when the token is missing,
 * malformed, unknown, or expired.
 */
export async function verifyBearerToken(
  authorizationHeader: string | undefined,
  lookup?: SessionLookup,
): Promise<{ userId: string } | null> {
  const token = parseBearerToken(authorizationHeader);
  if (!token) return null;
  if (!config.databaseUrl && !lookup) return null;
  try {
    const doLookup = lookup ?? defaultSessionLookup(config.databaseUrl);
    return await doLookup(token);
  } catch (err) {
    console.error("[auth] session lookup failed:", (err as Error).message);
    return null;
  }
}
