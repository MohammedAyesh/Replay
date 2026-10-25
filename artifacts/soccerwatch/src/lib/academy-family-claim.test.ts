import { describe, expect, it } from "vitest";
import { nextFamilyClaimKey } from "./academy-family-claim";

describe("nextFamilyClaimKey", () => {
  it("sends a token once per attempt", () => {
    const first = nextFamilyClaimKey(null, "abc", 0);
    expect(first).not.toBeNull();
    expect(nextFamilyClaimKey(first, "abc", 0)).toBeNull();
  });

  it("sends the same token again after Try again bumps the attempt", () => {
    const first = nextFamilyClaimKey(null, "abc", 0);
    const retry = nextFamilyClaimKey(first, "abc", 1);
    expect(retry).not.toBeNull();
    expect(retry).not.toBe(first);
    expect(nextFamilyClaimKey(retry, "abc", 1)).toBeNull();
  });

  it("sends a new token and never an empty one", () => {
    const first = nextFamilyClaimKey(null, "abc", 0);
    expect(nextFamilyClaimKey(first, "def", 0)).not.toBeNull();
    expect(nextFamilyClaimKey(null, "", 0)).toBeNull();
  });
});
