import type { ClaimQueueAction } from "./claim-match-storage";

export type ClaimQueueFlushResult = {
  changed: boolean;
  remaining: ClaimQueueAction[];
  succeeded: ClaimQueueAction[];
  discarded: ClaimQueueAction[];
  stoppedOnFailure: boolean;
};

export function isPermanentClaimQueueError(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : NaN;
  if (!Number.isInteger(status)) return false;
  // Client errors normally describe an invalid queued payload. These statuses
  // remain retryable because the request may become valid later.
  return status >= 400
    && status < 500
    && ![408, 409, 425, 429].includes(status);
}

export async function flushClaimQueue({
  readActions,
  removeAction,
  syncAction,
}: {
  readActions: () => Promise<ClaimQueueAction[]>;
  removeAction: (id: string) => Promise<void>;
  syncAction: (action: ClaimQueueAction) => Promise<void>;
}): Promise<ClaimQueueFlushResult> {
  const actions = await readActions();
  const succeeded: ClaimQueueAction[] = [];
  const discarded: ClaimQueueAction[] = [];
  let stoppedOnFailure = false;

  for (const action of actions) {
    try {
      await syncAction(action);
      await removeAction(action.id);
      succeeded.push(action);
    } catch (error) {
      if (isPermanentClaimQueueError(error)) {
        await removeAction(action.id);
        discarded.push(action);
        continue;
      }
      stoppedOnFailure = true;
      break;
    }
  }

  return {
    changed: succeeded.length > 0 || discarded.length > 0,
    remaining: await readActions(),
    succeeded,
    discarded,
    stoppedOnFailure,
  };
}

export function createClaimQueueFlushController() {
  let inFlight: Promise<ClaimQueueFlushResult> | null = null;

  return {
    waitForFlush(): Promise<void> {
      return inFlight?.then(() => undefined, () => undefined) ?? Promise.resolve();
    },
    flush(
      task: () => Promise<ClaimQueueFlushResult>,
    ): Promise<ClaimQueueFlushResult> {
      if (inFlight) return inFlight;

      let current: Promise<ClaimQueueFlushResult>;
      try {
        current = task();
      } catch (error) {
        current = Promise.reject(error);
      }
      inFlight = current;
      current.then(
        () => {
          if (inFlight === current) inFlight = null;
        },
        () => {
          if (inFlight === current) inFlight = null;
        },
      );
      return current;
    },
  };
}