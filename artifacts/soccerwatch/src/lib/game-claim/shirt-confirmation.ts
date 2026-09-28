import type { Group } from "./model";

export type ShirtConfirmationUiState = {
  selectedCids: string[];
  removedPieceIds: string[];
};

export type ShirtConfirmationPayload = {
  primaryCid: string;
  addedCids: string[];
  removedPieceIds: string[];
};

export type ShirtCardPictures = {
  cid: string;
  photoIds: readonly string[];
};

export function emptyShirtConfirmationState(): ShirtConfirmationUiState {
  return { selectedCids: [], removedPieceIds: [] };
}

export function toggleShirtGroupSelection(
  state: ShirtConfirmationUiState,
  cid: string,
  photoIds: readonly string[],
): ShirtConfirmationUiState {
  const removed = new Set(state.removedPieceIds);
  if (!photoIds.some((id) => !removed.has(id))) {
    return { ...state, selectedCids: state.selectedCids.filter((selected) => selected !== cid) };
  }

  const selected = new Set(state.selectedCids);
  if (selected.has(cid)) selected.delete(cid);
  else selected.add(cid);
  return { ...state, selectedCids: [...selected] };
}

export function toggleShirtPictureRemoval(
  state: ShirtConfirmationUiState,
  cid: string,
  pieceId: string,
  photoIds: readonly string[],
): ShirtConfirmationUiState {
  if (!photoIds.includes(pieceId)) return state;

  const removed = new Set(state.removedPieceIds);
  if (removed.has(pieceId)) removed.delete(pieceId);
  else removed.add(pieceId);

  const hasRemainingPicture = photoIds.some((id) => !removed.has(id));
  return {
    selectedCids: hasRemainingPicture
      ? state.selectedCids
      : state.selectedCids.filter((selected) => selected !== cid),
    removedPieceIds: [...removed],
  };
}

export function selectAllShirtGroups(
  state: ShirtConfirmationUiState,
  cards: readonly ShirtCardPictures[],
): ShirtConfirmationUiState {
  const removed = new Set(state.removedPieceIds);
  return {
    ...state,
    selectedCids: [...new Set(cards
      .filter((card) => card.photoIds.some((id) => !removed.has(id)))
      .map((card) => card.cid))],
  };
}

/** Keep only selected, still-visible cards; the longest on-camera group is primary. */
export function prepareShirtConfirmation(
  groups: readonly Group[],
  state: ShirtConfirmationUiState,
  photoIdsByCid: ReadonlyMap<string, readonly string[]>,
): ShirtConfirmationPayload | null {
  const selected = new Set(state.selectedCids);
  const removed = new Set(state.removedPieceIds);
  const ordered = groups
    .map((group, index) => ({ group, index, photoIds: photoIdsByCid.get(group.cid) ?? [] }))
    .filter(({ group, photoIds }) => selected.has(group.cid) && photoIds.some((id) => !removed.has(id)))
    .sort((a, b) => {
      const aDuration = Number.isFinite(a.group.dur) ? Math.max(0, a.group.dur) : 0;
      const bDuration = Number.isFinite(b.group.dur) ? Math.max(0, b.group.dur) : 0;
      return bDuration - aDuration || a.index - b.index;
    });
  const primary = ordered[0];
  if (!primary) return null;

  return {
    primaryCid: primary.group.cid,
    addedCids: ordered.slice(1).map(({ group }) => group.cid),
    removedPieceIds: [...new Set(ordered.flatMap(({ photoIds }) => photoIds.filter((id) => removed.has(id))))],
  };
}

/** Apply deferred shirt-screen extras after the primary group has been picked. */
export function applyShirtConfirmationParts(
  answers: { added: string[]; out: string[] },
  selection: Pick<ShirtConfirmationPayload, "addedCids" | "removedPieceIds">,
): void {
  for (const cid of selection.addedCids) {
    if (!answers.added.includes(cid)) answers.added.push(cid);
  }
  for (const pieceId of selection.removedPieceIds) {
    if (!answers.out.includes(pieceId)) answers.out.push(pieceId);
  }
}