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

export type ShirtNumberOption = {
  number: string;
  kitKey: string;
  /** Total on-camera seconds covered by groups carrying this identity. */
  coverageSeconds: number;
  uncertain: boolean;
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
    const kitKey = group.kitKey ?? group.team;

    return {
      groupId: group.cid,
      number,
      kitKey,
      uncertain: framesByNumber.size > 1,
      identity: number !== null && kitKey ? { number, kitKey } : null,
    };
  });
}

/** Number choices for one known kit, ranked by how much of this chunk they cover. */
export function shirtNumbersForKit(
  groups: readonly Group[],
  jersey: JerseySidecar | null,
  kitKey: string | null,
): ShirtNumberOption[] {
  if (!kitKey) return [];

  const groupsById = new Map(groups.map((group) => [group.cid, group]));
  const options = new Map<string, ShirtNumberOption>();
  for (const shirt of groupShirtIdentities(groups, jersey)) {
    if (shirt.kitKey !== kitKey || shirt.number === null || shirt.identity === null) continue;
    const group = groupsById.get(shirt.groupId);
    if (!group) continue;

    const coverageSeconds = Number.isFinite(group.dur) ? Math.max(0, group.dur) : 0;
    const current = options.get(shirt.number);
    if (current) {
      current.coverageSeconds += coverageSeconds;
      current.uncertain ||= shirt.uncertain;
    } else {
      options.set(shirt.number, {
        number: shirt.number,
        kitKey,
        coverageSeconds,
        uncertain: shirt.uncertain,
      });
    }
  }

  return [...options.values()].sort(
    (a, b) => b.coverageSeconds - a.coverageSeconds || a.number.localeCompare(b.number),
  );
}

/** Groups in a loaded chunk that match a confirmed number-and-kit identity. */
export function groupsForShirtIdentity(
  groups: readonly Group[],
  jersey: JerseySidecar | null,
  identity: ShirtIdentity | null | undefined,
): GroupShirtIdentity[] {
  if (!identity?.number || !identity.kitKey) return [];

  const durations = new Map(groups.map((group) => [
    group.cid,
    Number.isFinite(group.dur) ? group.dur : 0,
  ]));
  return groupShirtIdentities(groups, jersey)
    .filter((shirt) => shirt.identity?.number === identity.number && shirt.identity.kitKey === identity.kitKey)
    .sort(
      (a, b) => (durations.get(b.groupId) ?? 0) - (durations.get(a.groupId) ?? 0)
        || a.groupId.localeCompare(b.groupId),
    );
}