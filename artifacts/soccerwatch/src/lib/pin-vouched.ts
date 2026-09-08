/**
 * Keep a claimant's vouched frames out of the identity board's regrouping.
 *
 * buildRows regroups every part by reachability, claim rows included, and the
 * server refuses any save that moves a vouched frame off its claim row. So
 * once one player had claimed, Recompute and Save were both dead on that
 * recording until every claim was released -- the board froze exactly when
 * someone wanted to tidy it.
 *
 * Pure, and independent of buildRows: partition first, regroup only the free
 * parts, then put the pinned ones back under their claimant's row id, which is
 * what the server will insist on anyway.
 */

type PartLike = { trackId: string; fromFrame: number; toFrame: number };
type RowLike<P extends PartLike> = { id: string; name: string; parts: P[] };
type BindingLike = {
  personId: string;
  state: string;
  vouchedFragments: Array<{ trackId: string; fromFrame: number; toFrame: number }>;
};

/** Bindings that still lock frames. Released and rejected ones lock nothing. */
export function liveBindings<B extends BindingLike>(bindings: B[]): B[] {
  return bindings.filter((b) => b.state !== "released" && b.state !== "rejected");
}

/** Split parts into those a live claimant vouched for (by claimant) and the rest. */
export function partitionPinned<P extends PartLike>(
  pieces: P[],
  bindings: BindingLike[],
): { pinned: Map<string, P[]>; free: P[] } {
  const live = liveBindings(bindings);
  const pinned = new Map<string, P[]>();
  const free: P[] = [];
  for (const part of pieces) {
    const owner = live.find((b) => b.vouchedFragments.some((f) =>
      f.trackId === part.trackId && part.fromFrame <= f.toFrame && part.toFrame >= f.fromFrame));
    if (!owner) { free.push(part); continue; }
    const list = pinned.get(owner.personId) ?? [];
    list.push(part);
    pinned.set(owner.personId, list);
  }
  return { pinned, free };
}

/**
 * Put pinned parts back, each group under its claimant's row id. The name
 * comes from the prior row of that id when there is one. A regrouped row that
 * already carries that id absorbs the parts rather than being duplicated.
 */
export function reattachPinned<P extends PartLike, R extends RowLike<P>>(
  rows: R[],
  pinned: Map<string, P[]>,
  priorRows: R[],
  makeRow: (id: string, name: string, parts: P[]) => R,
): R[] {
  const byFrame = (a: P, b: P) => a.fromFrame - b.fromFrame || a.trackId.localeCompare(b.trackId);
  const out = rows.map((row) => ({ ...row }));
  for (const [personId, parts] of pinned) {
    const sorted = [...parts].sort(byFrame);
    const existing = out.find((row) => row.id === personId);
    if (existing) {
      existing.parts = [...existing.parts, ...sorted].sort(byFrame);
      continue;
    }
    const prior = priorRows.find((row) => row.id === personId);
    out.push(makeRow(personId, prior?.name ?? "", sorted));
  }
  // Tie-break on id so the order is a property of the data, not of insertion.
  return out.sort((a, b) =>
    (a.parts[0]?.fromFrame ?? 0) - (b.parts[0]?.fromFrame ?? 0) || a.id.localeCompare(b.id));
}
