export type FindDecisionLabelIdentity = {
  userId: number;
  recordingId: number;
  bundleFingerprint: string;
  kind: "switch" | "lost" | "confirm";
  atFrame: number;
  wrongTrackId: string | null;
  rightTrackId: string | null;
};

export type FindDecisionLabelTransaction<Row extends FindDecisionLabelIdentity> = {
  exists: (identity: FindDecisionLabelIdentity) => Promise<boolean>;
  insert: (row: Row) => Promise<void>;
};

export type FindDecisionLabelStore<Row extends FindDecisionLabelIdentity> = {
  withDecisionLock<T>(
    key: string,
    action: (transaction: FindDecisionLabelTransaction<Row>) => Promise<T>,
  ): Promise<T>;
};

export function findDecisionLabelKey(identity: FindDecisionLabelIdentity): string {
  return JSON.stringify([
    identity.userId,
    identity.recordingId,
    identity.bundleFingerprint,
    identity.kind,
    identity.atFrame,
    identity.wrongTrackId,
    identity.rightTrackId,
  ]);
}

/**
 * Record one explicit decision through a transaction-scoped store.
 *
 * The caller supplies the lock and row operations so this same decision
 * boundary can be exercised with a stub store without connecting to Postgres.
 */
export async function writeFindDecisionLabelOnce<Row extends FindDecisionLabelIdentity>(
  row: Row,
  store: FindDecisionLabelStore<Row>,
): Promise<boolean> {
  const key = findDecisionLabelKey(row);
  return store.withDecisionLock(key, async (transaction) => {
    if (await transaction.exists(row)) return true;
    await transaction.insert(row);
    return true;
  });
}