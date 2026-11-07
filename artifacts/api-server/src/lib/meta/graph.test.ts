import { afterEach, describe, expect, it, vi } from "vitest";
import { graphGet, MetaGraphError } from "./graph";
import type { MetaConfig } from "./config";

const testConfig: MetaConfig = {
  token: null,
  adAccountId: null,
  appSecret: null,
  graphVersion: "v26.0",
  appId: "test-app",
  businessId: "test-business",
  loginConfigId: "test-login-config",
  instagramLoginConfigId: "test-instagram-config",
  instagramLoginEnabled: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Meta Graph error details", () => {
  it("preserves the complete Graph error without logging or exposing the token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        message: "(#200) Missing Permissions",
        type: "OAuthException",
        code: 200,
        error_subcode: 181,
        fbtrace_id: "trace-graph-test",
      },
    }), { status: 403 }));

    const error = await graphGet("me/adaccounts", {}, { token: "test-access-token", config: testConfig })
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(MetaGraphError);
    expect(error).toMatchObject({
      status: 403,
      code: 200,
      subcode: 181,
      type: "OAuthException",
      fbtraceId: "trace-graph-test",
      message: "(#200) Missing Permissions",
    });
    expect(fetchSpy.mock.calls[0]?.[0]?.toString()).toContain("me/adaccounts");
  });
});
