/**
 * Socket authentication via short-lived JWTs.
 *
 * The web app's SocketClientService fetches a token from
 * GET /api/voice/token (Better Auth session required) and sends it as
 * `Authorization: Bearer <token>` in the polling transport's extraHeaders.
 *
 * Locked contract (both sides must match exactly):
 * - HS256, secret = AUTH_JWT_SECRET env (MUST equal the app's
 *   BETTER_AUTH_SECRET)
 * - payload: { sub: <better-auth userId>, aud: "centher-voice",
 *              iat, exp: now+15min }
 *
 * Fail-closed: any verification error (missing secret, bad signature,
 * wrong audience, expired, malformed) means "not authenticated" — the
 * socket is rejected with a clean error the client surfaces as
 * "Could not connect to the voice server."
 */
import { jwtVerify } from "jose";
import { config } from "./config";

export const VOICE_TOKEN_AUDIENCE = "centher-voice";

export function parseBearerToken(
  authorizationHeader: string | undefined,
): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
  return match ? match[1] : null;
}

/**
 * Returns the authenticated userId, or null when the token is missing,
 * malformed, expired, has the wrong audience, or fails signature
 * verification. Never throws — fail-closed by contract.
 */
export async function verifyBearerToken(
  authorizationHeader: string | undefined,
): Promise<{ userId: string } | null> {
  const token = parseBearerToken(authorizationHeader);
  if (!token) return null;
  const secret = config.authJwtSecret;
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      { audience: VOICE_TOKEN_AUDIENCE },
    );
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    return { userId: payload.sub };
  } catch {
    return null;
  }
}
