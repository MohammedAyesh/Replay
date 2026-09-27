import { describe, expect, it } from "vitest";
import { claimCountsForGroups, claimStatusForGroup } from "./claim-status";

describe("whole-game claim gallery status", () => {
  const identities = [
    { id: "identity-a", name: "Rami", parts: [{ trackId: "s0:t1" }] },
    { id: "identity-self", name: null, parts: [{ trackId: "s0:t2" }] },
  ];

  it("marks named and own groups as taken, leaves other groups free, and counts each kit", () => {
    const groups = [
      { members: ["s0:t1"] },
      { members: ["s0:t2"] },
      { members: ["s0:t3"] },
    ];

    expect(claimStatusForGroup(groups[0].members, identities, "identity-self", "Sami"))
      .toEqual({ taken: true, owners: [{ identityId: "identity-a", name: "Rami" }] });
    expect(claimStatusForGroup(groups[1].members, identities, "identity-self", "Sami"))
      .toEqual({ taken: true, owners: [{ identityId: "identity-self", name: "Sami" }] });
    expect(claimStatusForGroup(groups[2].members, identities, "identity-self", "Sami"))
      .toEqual({ taken: false, owners: [] });
    expect(claimCountsForGroups(groups, identities, "identity-self", "Sami"))
      .toEqual({ free: 1, taken: 2 });
  });
});