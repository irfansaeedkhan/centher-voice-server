import { describe, it, expect } from "vitest";
import { parseBearerToken, verifyBearerToken } from "../src/auth";

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

describe("verifyBearerToken", () => {
  const lookup = async (token: string) => {
    if (token === "good-token") return { userId: "user-1" };
    return null;
  };

  it("returns the userId for a valid session token", async () => {
    const res = await verifyBearerToken("Bearer good-token", lookup);
    expect(res).toEqual({ userId: "user-1" });
  });

  it("returns null for an unknown token", async () => {
    expect(await verifyBearerToken("Bearer bad-token", lookup)).toBeNull();
  });

  it("returns null for a malformed header", async () => {
    expect(await verifyBearerToken("not-a-bearer", lookup)).toBeNull();
  });

  it("returns null when the lookup throws (fail closed)", async () => {
    const boom = async () => {
      throw new Error("db down");
    };
    expect(await verifyBearerToken("Bearer good-token", boom)).toBeNull();
  });
});
