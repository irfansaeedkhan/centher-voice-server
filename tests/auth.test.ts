/**
 * Voice JWT auth tests (Judge F1 fix).
 *
 * Locked contract with the web app (GET /api/voice/token):
 *   HS256, secret = AUTH_JWT_SECRET (== app's BETTER_AUTH_SECRET),
 *   payload { sub: userId, aud: "centher-voice", iat, exp: now+15min }.
 *
 * Fail-closed: anything off — bad signature, wrong secret, expired,
 * wrong audience, malformed — is null, never a throw.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SignJWT } from "jose";
import { parseBearerToken, verifyBearerToken } from "../src/auth";

const SECRET = "test-auth-jwt-secret-please-ignore";
const WRONG_SECRET = "a-different-secret";

async function mintJwt(opts: {
  sub?: string;
  secret?: string;
  audience?: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const {
    secret = SECRET,
    audience = "centher-voice",
    expiresInSeconds = 900,
  } = opts;
  // NOTE: `sub` has NO default — passing sub: undefined must mint a token
  // with no subject (that's what the test exercises).
  const builder = new SignJWT({}).setProtectedHeader({ alg: "HS256" });
  builder.setIssuedAt();
  if (opts.sub !== undefined) builder.setSubject(opts.sub);
  if (audience !== undefined) builder.setAudience(audience);
  if (expiresInSeconds !== undefined)
    builder.setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds);
  return builder.sign(new TextEncoder().encode(secret));
}

describe("parseBearerToken", () => {
  it("extracts the token from a Bearer header", () => {
    expect(parseBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the scheme", () => {
    expect(parseBearerToken("bearer abc123")).toBe("abc123");
  });

  it("returns null for missing/malformed headers", () => {
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken("")).toBeNull();
    expect(parseBearerToken("Token abc123")).toBeNull();
    expect(parseBearerToken("Bearer ")).toBeNull();
  });

  it("never returns the scheme itself as the token", () => {
    expect(parseBearerToken("Bearer")).toBeNull();
  });
});

describe("verifyBearerToken (JWT)", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_JWT_SECRET", SECRET);
  });

  it("accepts a valid voice JWT and returns the sub as userId", async () => {
    const token = await mintJwt({ sub: "user-1" });
    await expect(verifyBearerToken(`Bearer ${token}`)).resolves.toEqual({
      userId: "user-1",
    });
  });

  it("rejects a token signed with the wrong secret (fail-closed)", async () => {
    const token = await mintJwt({ secret: WRONG_SECRET });
    await expect(verifyBearerToken(`Bearer ${token}`)).resolves.toBeNull();
  });

  it("rejects an expired token (fail-closed)", async () => {
    const token = await mintJwt({ expiresInSeconds: -60 });
    await expect(verifyBearerToken(`Bearer ${token}`)).resolves.toBeNull();
  });

  it("rejects a token with the wrong audience (fail-closed)", async () => {
    const token = await mintJwt({ audience: "someone-else" });
    await expect(verifyBearerToken(`Bearer ${token}`)).resolves.toBeNull();
  });

  it("rejects garbage (fail-closed, never throws)", async () => {
    await expect(
      verifyBearerToken("Bearer not.a.jwt.at.all"),
    ).resolves.toBeNull();
  });

  it("rejects a token with no sub (fail-closed)", async () => {
    const token = await mintJwt({ sub: undefined });
    await expect(verifyBearerToken(`Bearer ${token}`)).resolves.toBeNull();
  });

  it("returns null for a malformed header", async () => {
    await expect(verifyBearerToken("not-a-bearer")).resolves.toBeNull();
  });

  it("fail-closed when AUTH_JWT_SECRET is not configured", async () => {
    vi.stubEnv("AUTH_JWT_SECRET", "");
    const token = await mintJwt({ sub: "user-1" });
    await expect(verifyBearerToken(`Bearer ${token}`)).resolves.toBeNull();
  });
});
