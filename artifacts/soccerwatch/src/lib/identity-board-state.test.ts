import { describe, expect, it } from "vitest";
import { restoreAcceptedBoard, type IdentityBoardSnapshot } from "./identity-board-state";

describe("restoreAcceptedBoard", () => {
  it("restores the last accepted grouping after a refused save", () => {
    const accepted: IdentityBoardSnapshot = {
      rows: [
        { id: "person-a", name: "A", parts: [{ trackId: "track-1", fromFrame: 0, toFrame: 9 }] },
        { id: "person-b", name: "B", parts: [{ trackId: "track-2", fromFrame: 0, toFrame: 9 }] },
      ],
      excludedRows: [
        { id: "spectator", name: "Spectator", excluded: true, parts: [{ trackId: "track-3", fromFrame: 0, toFrame: 9 }] },
      ],
      same: new Set(["track-1:0-9|track-1:10-19"]),
      different: new Set(["track-1:0-9|track-2:0-9"]),
    };
    const attempted: IdentityBoardSnapshot = {
      rows: [
        { id: "person-a", name: "A", parts: [{ trackId: "track-1", fromFrame: 0, toFrame: 9 }, { trackId: "track-2", fromFrame: 0, toFrame: 9 }] },
      ],
      excludedRows: [
        { id: "spectator", name: "Spectator", excluded: true, parts: [{ trackId: "track-3", fromFrame: 0, toFrame: 9 }] },
      ],
      same: new Set(["track-1:0-9|track-2:0-9"]),
      different: new Set(),
    };

    const visibleAfterRefusal = restoreAcceptedBoard(accepted);

    expect(visibleAfterRefusal.rows).toEqual(accepted.rows);
    expect(visibleAfterRefusal.rows).not.toEqual(attempted.rows);
    expect(visibleAfterRefusal.excludedRows).toEqual(accepted.excludedRows);
    expect(visibleAfterRefusal.same).toEqual(accepted.same);
    expect(visibleAfterRefusal.different).toEqual(accepted.different);
  });
});