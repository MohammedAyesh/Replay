export type IdentityBoardPart = {
  trackId: string;
  fromFrame: number;
  toFrame: number;
};

export type IdentityBoardRow = {
  id: string;
  name: string;
  parts: IdentityBoardPart[];
};

export type IdentityBoardSnapshot = {
  rows: IdentityBoardRow[];
  same: Set<string>;
  different: Set<string>;
};

/**
 * Return the last server-accepted board as fresh state objects.
 * Never reuse the attempted rows after a save failure: edits made while
 * preparing the rejected request must not become the next edit's baseline.
 */
export function restoreAcceptedBoard(snapshot: IdentityBoardSnapshot): IdentityBoardSnapshot {
  return {
    rows: snapshot.rows.map((row) => ({
      ...row,
      parts: row.parts.map((part) => ({ ...part })),
    })),
    same: new Set(snapshot.same),
    different: new Set(snapshot.different),
  };
}