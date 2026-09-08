import { describe, expect, it } from "vitest";
import { liveBindings, partitionPinned, reattachPinned } from "./pin-vouched";

const part = (trackId: string, fromFrame: number, toFrame: number) => ({ trackId, fromFrame, toFrame });
const binding = (personId: string, state: string, ...frags: Array<[string, number, number]>) => ({
  personId, state,
  vouchedFragments: frags.map(([trackId, fromFrame, toFrame]) => ({ trackId, fromFrame, toFrame })),
});

describe("pinning a claimant's vouched frames out of regrouping", () => {
  it("sets aside exactly the parts a live claimant vouched for", () => {
    const pieces = [part("A", 0, 100), part("A", 101, 200), part("B", 0, 300), part("C", 50, 60)];
    const { pinned, free } = partitionPinned(pieces, [binding("claim:x", "confirmed", ["A", 0, 200])]);
    expect(pinned.get("claim:x")).toEqual([part("A", 0, 100), part("A", 101, 200)]);
    expect(free).toEqual([part("B", 0, 300), part("C", 50, 60)]);
  });

  it("a released binding pins nothing -- that is what release is for", () => {
    const pieces = [part("A", 0, 100)];
    const { pinned, free } = partitionPinned(pieces, [binding("claim:x", "released", ["A", 0, 100])]);
    expect(pinned.size).toBe(0);
    expect(free).toEqual(pieces);
    expect(liveBindings([binding("z", "rejected")])).toEqual([]);
  });

  it("a part that merely overlaps a vouched fragment is pinned too", () => {
    // Regrouping half of a vouched fragment away would break its coverage
    // under the claimant, which the server refuses.
    const { pinned } = partitionPinned([part("A", 90, 150)], [binding("claim:x", "confirmed", ["A", 0, 100])]);
    expect(pinned.get("claim:x")).toEqual([part("A", 90, 150)]);
  });

  it("puts pinned parts back under the claimant's own row id, keeping their name", () => {
    const prior = [{ id: "claim:x", name: "Mohammed", parts: [part("A", 0, 200)] }];
    const regrouped = [{ id: "p-B-0", name: "", parts: [part("B", 0, 300)] }];
    const pinned = new Map([["claim:x", [part("A", 101, 200), part("A", 0, 100)]]]);
    const rows = reattachPinned(regrouped, pinned, prior, (id, name, parts) => ({ id, name, parts }));
    expect(rows).toEqual([
      { id: "claim:x", name: "Mohammed", parts: [part("A", 0, 100), part("A", 101, 200)] },
      { id: "p-B-0", name: "", parts: [part("B", 0, 300)] },
    ]);
  });

  it("absorbs into a regrouped row that already carries the claimant's id", () => {
    const regrouped = [{ id: "claim:x", name: "Mohammed", parts: [part("D", 250, 300)] }];
    const pinned = new Map([["claim:x", [part("A", 0, 100)]]]);
    const rows = reattachPinned(regrouped, pinned, [], (id, name, parts) => ({ id, name, parts }));
    expect(rows).toHaveLength(1);
    expect(rows[0].parts).toEqual([part("A", 0, 100), part("D", 250, 300)]);
  });
});
