import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/api-client-react", () => ({ useListClaimMatchClips: vi.fn(), getListClaimMatchClipsQueryKey: vi.fn() }));
vi.mock("@/lib/match-api", () => ({ useMatchClips: vi.fn(), useMatchReplay: vi.fn() }));

import { matchReelPath, reelMatchFromSearch } from "./match-reel";

describe("match reel links", () => {
  it("opens My Clips on Reels for one match, and reads the match back", () => {
    const path = matchReelPath("SNLEJH");
    expect(path).toBe("/my-clips?tab=reels&match=SNLEJH");
    expect(reelMatchFromSearch(path.split("?")[1])).toBe("SNLEJH");
  });

  it("ignores a missing or malformed match code", () => {
    expect(reelMatchFromSearch("tab=reels")).toBeNull();
    expect(reelMatchFromSearch("match=<script>")).toBeNull();
    expect(reelMatchFromSearch("match=snlejh")).toBe("SNLEJH");
  });
});
