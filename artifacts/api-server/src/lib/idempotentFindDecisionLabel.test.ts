import { describe, expect, it } from "vitest";
import {
  findDecisionLabelKey,
  writeFindDecisionLabelOnce,
  type FindDecisionLabelIdentity,
  type FindDecisionLabelStore,
} from "./idempotentFindDecisionLabel";

type StubRow = FindDecisionLabelIdentity & { payload: string };

function sameIdentity(a: FindDecisionLabelIdentity, b: FindDecisionLabelIdentity): boolean {
  return a.userId === b.userId
    && a.recordingId === b.recordingId
    && a.bundleFingerprint === b.bundleFingerprint
    && a.kind === b.kind
    && a.atFrame === b.atFrame
    && a.wrongTrackId === b.wrongTrackId
    && a.rightTrackId === b.rightTrackId;
}

function stubStore() {
  const rows: StubRow[] = [];
  const lockKeys: string[] = [];
  const store: FindDecisionLabelStore<StubRow> = {
    withDecisionLock: async (key, action) => {
      lockKeys.push(key);
      return action({
        exists: async (identity) => rows.some((row) => sameIdentity(row, identity)),
        insert: async (row) => { rows.push(row); },
      });
    },
  };
  return { rows, lockKeys, store };
}

describe("idempotent /find decision labels", () => {
  it("keeps one row for an identical decision and adds a distinct later decision", async () => {
    const { rows, lockKeys, store } = stubStore();
    const first: StubRow = {
      userId: 7,
      recordingId: 42,
      bundleFingerprint: "bundle-a",
      kind: "lost",
      atFrame: 50,
      wrongTrackId: "track-1",
      rightTrackId: null,
      payload: "first",
    };
    const later: StubRow = {
      userId: 7,
      recordingId: 42,
      bundleFingerprint: "bundle-a",
      kind: "confirm",
      atFrame: 120,
      wrongTrackId: null,
      rightTrackId: "track-2",
      payload: "later",
    };

    expect(await writeFindDecisionLabelOnce(first, store)).toBe(true);
    expect(await writeFindDecisionLabelOnce(first, store)).toBe(true);
    expect(rows).toEqual([first]);

    expect(await writeFindDecisionLabelOnce(later, store)).toBe(true);
    expect(rows).toEqual([first, later]);
    expect(lockKeys).toEqual([
      findDecisionLabelKey(first),
      findDecisionLabelKey(first),
      findDecisionLabelKey(later),
    ]);
  });
});