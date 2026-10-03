import { describe, expect, it } from "vitest";
import { claimCountsForGroups, claimStatusForGroup, otherClaimOwners } from "./claim-status";

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

  it("names only the other players who picked a person, never the viewer", () => {
    const shared = [
      { id: "identity-a", name: "Rami", parts: [{ trackId: "s0:t1" }] },
      { id: "identity-self", name: "Sami", parts: [{ trackId: "s0:t1" }] },
      { id: "identity-b", name: "Omar", parts: [{ trackId: "s0:t9" }] },
    ];
    expect(otherClaimOwners(["s0:t1"], shared, "identity-self", "Sami"))
      .toEqual([{ identityId: "identity-a", name: "Rami" }]);
    expect(otherClaimOwners(["s0:t1", "s0:t9"], shared, "identity-self", "Sami").map((owner) => owner.name))
      .toEqual(["Rami", "Omar"]);
    // Only the viewer picked it: nothing to confirm.
    expect(otherClaimOwners(["s0:t2"], identities, "identity-self", "Sami")).toEqual([]);
    // A viewer with no identity yet sees every named owner as someone else.
    expect(otherClaimOwners(["s0:t1"], shared, null, null).map((owner) => owner.name)).toEqual(["Rami", "Sami"]);
    expect(otherClaimOwners(["s0:t3"], shared, "identity-self", "Sami")).toEqual([]);
  });
});