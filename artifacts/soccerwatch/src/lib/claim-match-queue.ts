import type { ClaimQueueAction } from "./claim-match-storage";

export type ClaimQueueFlushResult = {
  changed: boolean;
  remaining: ClaimQueueAction[];
  succeeded: ClaimQueueAction[];
  stoppedOnFailure: boolean;
};

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
  let stoppedOnFailure = false;

  for (const action of actions) {
    try {
      await syncAction(action);
      await removeAction(action.id);
      succeeded.push(action);
    } catch {
      stoppedOnFailure = true;
      break;
    }
  }

  return {
    changed: succeeded.length > 0,
    remaining: await readActions(),
    succeeded,
    stoppedOnFailure,
  };
}

export function createClaimQueueFlushController() {
  let inFlight: Promise<ClaimQueueFlushResult> | null = null;

  return {
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