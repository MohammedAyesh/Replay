import type { JerseySidecar } from "@workspace/api-client-react";
import type { Group } from "./model";

export type ShirtIdentity = {
  number: string;
  kitKey: string;
};

export type GroupShirtIdentity = {
  groupId: string;
  number: string | null;
  kitKey: string | null;
  uncertain: boolean;
  /** A shirt number is an identity only when paired with a known kit key. */
  identity: ShirtIdentity | null;
};

/**
 * Resolve one shirt identity per pipeline group. Conflicting readings are
 * weighted by the number of frames on which each track's number was seen.
 */
export function groupShirtIdentities(
  groups: readonly Group[],
  jersey: JerseySidecar | null,
): GroupShirtIdentity[] {
  return groups.map((group) => {
    const framesByNumber = new Map<string, number>();
    for (const trackId of group.members) {
      const reading = jersey?.tracks[trackId];
      if (!reading || !reading.number || !Number.isFinite(reading.seenFrames) || reading.seenFrames <= 0) continue;
      framesByNumber.set(
        reading.number,
        (framesByNumber.get(reading.number) ?? 0) + reading.seenFrames,
      );
    }

    const rankedNumbers = [...framesByNumber.entries()].sort(
      ([numberA, framesA], [numberB, framesB]) => framesB - framesA || numberA.localeCompare(numberB),
    );
    const number = rankedNumbers[0]?.[0] ?? null;
    const kitKey = group.team;

    return {
      groupId: group.cid,
      number,
      kitKey,
      uncertain: framesByNumber.size > 1,
      identity: number !== null && kitKey ? { number, kitKey } : null,
    };
  });
}