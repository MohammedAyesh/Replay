import { describe, expect, it } from "vitest";
import {
  clerkKeyPairMatches,
  decodeClerkKeyIdentity,
  decodeSessionClaims,
} from "./clerkAuthDiagnostics";

function fakeKey(kind: "pk" | "sk", mode: "test" | "live", domain: string): string {
  const encodedDomain = Buffer.from(`${domain}$`).toString("base64").replace(/=+$/, "");
  return `${kind}_${mode}_${encodedDomain}`;
}

describe("Clerk auth diagnostics helpers", () => {
  it("decodes only key prefix, mode, and frontend API domain", () => {
    const identity = decodeClerkKeyIdentity(fakeKey("pk", "test", "dev-123.clerk.accounts.dev"));

    expect(identity).toEqual({
      prefix: "pk_test_",
      mode: "test",
      frontendApiDomain: "dev-123.clerk.accounts.dev",
    });
  });

  it("reports whether server key modes and frontend API domains match", () => {
    const publishable = decodeClerkKeyIdentity(fakeKey("pk", "live", "clerk.example.com"));
    const matchingSecret = decodeClerkKeyIdentity(fakeKey("sk", "live", "clerk.example.com"));
    const mismatchedSecret = decodeClerkKeyIdentity(fakeKey("sk", "test", "clerk.example.com"));

    expect(clerkKeyPairMatches(publishable, matchingSecret)).toBe(true);
    expect(clerkKeyPairMatches(publishable, mismatchedSecret)).toBe(false);
    expect(clerkKeyPairMatches(publishable, decodeClerkKeyIdentity(undefined))).toBeNull();
  });

  it("decodes session claim metadata without returning the token or full session id", () => {
    const nowMs = 1_700_000_000_000;
    const payload = Buffer.from(JSON.stringify({
      iss: "https://clerk.example.com",
      azp: "https://soccerwatch.example",
      sid: "sess_sensitive-session-id",
      iat: 1_699_999_000,
      exp: 1_700_000_600,
    })).toString("base64url");
    const token = `header.${payload}.signature`;
    const result = decodeSessionClaims(token, nowMs);

    expect(result).toMatchObject({
      tokenPresent: true,
      decodeStatus: "decoded",
      decodedWithoutVerification: true,
      iss: "https://clerk.example.com",
      azp: "https://soccerwatch.example",
      sidPrefix: "sess_sen",
      iat: 1_699_999_000,
      exp: 1_700_000_600,
      secondsUntilExpiry: 600,
      serverNowUtc: new Date(nowMs).toISOString(),
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("sess_sensitive-session-id");
  });

  it("marks malformed session values without echoing their contents", () => {
    const malformedToken = "secret-cookie-value";
    const result = decodeSessionClaims(malformedToken, 1_700_000_000_000);

    expect(result.decodeStatus).toBe("malformed");
    expect(JSON.stringify(result)).not.toContain(malformedToken);
  });
});