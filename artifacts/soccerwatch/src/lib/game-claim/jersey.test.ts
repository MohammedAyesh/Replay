import { describe, expect, it } from "vitest";
import type { JerseySidecar } from "@workspace/api-client-react";
import type { Group } from "./model";
import { groupShirtIdentities } from "./jersey";

function group(cid: string, team: string, members: string[]): Group {
  return { cid, dur: 60, team, members, junctions: [], nb: [] };
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
});