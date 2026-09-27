import { describe, expect, it } from "vitest";
import type { JerseySidecar } from "@workspace/api-client-react";
import type { Group } from "./model";
import { groupShirtIdentities, groupsForShirtIdentity, shirtNumberCandidateForKit, shirtNumbersForKit } from "./jersey";

function group(cid: string, team: string | null, members: string[], dur = 60): Group {
  return { cid, dur, team, members, junctions: [], nb: [] };
}

function sidecar(tracks: JerseySidecar["tracks"]): JerseySidecar {
  return { v: 1, tracks, numbers: {} };
}

describe("group shirt identities", () => {
  it("keeps the same shirt number in different kits as two identities", () => {
    const result = groupShirtIdentities(
      [group("dark-player", "dark", ["dark-track"]), group("light-player", "light", ["light-track"])],
      sidecar({
        "dark-track": { number: "10", seenFrames: 24, confidence: 0.9 },
        "light-track": { number: "10", seenFrames: 18, confidence: 0.9 },
      }),
    );

    expect(result.map(({ identity }) => identity)).toEqual([
      { number: "10", kitKey: "dark" },
      { number: "10", kitKey: "light" },
    ]);
  });

  it("chooses the number with the most supporting frames and marks disagreement uncertain", () => {
    const [result] = groupShirtIdentities(
      [group("mixed-readings", "dark", ["ten-a", "ten-b", "seven"])],
      sidecar({
        "ten-a": { number: "10", seenFrames: 4, confidence: 0.9 },
        "ten-b": { number: "10", seenFrames: 8, confidence: 0.9 },
        seven: { number: "7", seenFrames: 20, confidence: 0.7 },
      }),
    );

    expect(result).toMatchObject({
      number: "7",
      kitKey: "dark",
      uncertain: true,
      identity: { number: "7", kitKey: "dark" },
    });
  });

  it("returns no number for a group without numbered tracks", () => {
    const [emptySidecarResult] = groupShirtIdentities(
      [group("unread", "light", ["unread-track"])],
      sidecar({}),
    );
    const [missingSidecarResult] = groupShirtIdentities(
      [group("unread", "light", ["unread-track"])],
      null,
    );

    expect(emptySidecarResult).toMatchObject({
      number: null,
      kitKey: "light",
      uncertain: false,
      identity: null,
    });
    expect(missingSidecarResult).toMatchObject({
      number: null,
      kitKey: "light",
      uncertain: false,
      identity: null,
    });
  });

  it("offers only numbers that resolve to the selected kit", () => {
    const options = shirtNumbersForKit(
      [
        group("dark-ten", "dark", ["dark-ten-track"]),
        group("light-ten", "light", ["light-ten-track"]),
        group("unlabelled-eight", null, ["unlabelled-track"]),
      ],
      sidecar({
        "dark-ten-track": { number: "10", seenFrames: 8, confidence: 0.9 },
        "light-ten-track": { number: "10", seenFrames: 7, confidence: 0.9 },
        "unlabelled-track": { number: "8", seenFrames: 9, confidence: 0.8 },
      }),
      "dark",
    );

    expect(options.map(({ number, kitKey }) => ({ number, kitKey }))).toEqual([
      { number: "10", kitKey: "dark" },
    ]);
    expect(shirtNumbersForKit([], sidecar({}), null)).toEqual([]);
  });

  it("orders shirt numbers by combined on-camera coverage", () => {
    const options = shirtNumbersForKit(
      [
        group("ten-a", "dark", ["ten-a-track"], 31),
        group("ten-b", "dark", ["ten-b-track"], 19),
        group("seven", "dark", ["seven-track"], 65),
      ],
      sidecar({
        "ten-a-track": { number: "10", seenFrames: 20, confidence: 0.9 },
        "ten-b-track": { number: "10", seenFrames: 12, confidence: 0.8 },
        "seven-track": { number: "7", seenFrames: 10, confidence: 0.8 },
      }),
      "dark",
    );

    expect(options.map(({ number, coverageSeconds }) => ({ number, coverageSeconds }))).toEqual([
      { number: "7", coverageSeconds: 65 },
      { number: "10", coverageSeconds: 50 },
    ]);
  });

  it("matches a later chunk by both number and kit", () => {
    const laterGroups = [
      group("other-kit-ten", "light", ["other-kit-track"], 90),
      group("same-identity-ten", "dark", ["same-identity-track"], 40),
      group("unlabelled-ten", null, ["unlabelled-track"], 80),
    ];
    const jersey = sidecar({
      "other-kit-track": { number: "10", seenFrames: 15, confidence: 0.9 },
      "same-identity-track": { number: "10", seenFrames: 12, confidence: 0.9 },
      "unlabelled-track": { number: "10", seenFrames: 20, confidence: 0.9 },
    });

    expect(groupsForShirtIdentity(laterGroups, jersey, { number: "10", kitKey: "dark" }).map(({ groupId }) => groupId))
      .toEqual(["same-identity-ten"]);
    expect(groupsForShirtIdentity(laterGroups, jersey, { number: "10", kitKey: "bib" })).toEqual([]);
  });

  it("re-binds a carried number to the current recording's kit label", () => {
    const groups = [group("current-kit-ten", "new-recording-kit", ["track-ten"])];
    const jersey = sidecar({
      "track-ten": { number: "10", seenFrames: 12, confidence: 0.9 },
    });

    expect(shirtNumberCandidateForKit(groups, jersey, "10", "new-recording-kit"))
      .toEqual({ number: "10", kitKey: "new-recording-kit" });
    expect(shirtNumberCandidateForKit(groups, jersey, "10", "old-recording-kit")).toBeNull();
  });
});