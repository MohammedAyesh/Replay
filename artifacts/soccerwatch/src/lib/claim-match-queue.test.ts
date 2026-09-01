import { describe, expect, it } from "vitest";
import {
  createClaimQueueFlushController,
  flushClaimQueue,
} from "./claim-match-queue";
import type { ClaimQueueAction } from "./claim-match-storage";

const progressAction: ClaimQueueAction = {
  id: "progress-1",
  kind: "progress",
  recordingId: 1,
  payload: { stage: "following" },
  createdAt: 1,
};

const correctionAction: ClaimQueueAction = {
  id: "correction-1",
  kind: "correction",
  recordingId: 1,
  payload: { clientId: "client-1" },
  createdAt: 2,
};

const undoAction: ClaimQueueAction = {
  id: "undo-1",
  kind: "undo",
  recordingId: 1,
  correctionId: 10,
  createdAt: 3,
};

function queueFixture(actions: ClaimQueueAction[]) {
  const pending = [...actions];
  const removed: string[] = [];
  return {
    readActions: async () => [...pending],
    removeAction: async (id: string) => {
      removed.push(id);
      const index = pending.findIndex((action) => action.id === id);
      if (index >= 0) pending.splice(index, 1);
    },
    pending,
    removed,
  };
}

describe("Claim Match queue flushing", () => {
  it("removes only successful actions and leaves a failed action plus later actions queued", async () => {
    const fixture = queueFixture([progressAction, correctionAction, undoAction]);
    const attempted: string[] = [];

    const result = await flushClaimQueue({
      ...fixture,
      syncAction: async (action) => {
        attempted.push(action.id);
        if (action.id === correctionAction.id) throw new Error("offline");
      },
    });

    expect(attempted).toEqual([progressAction.id, correctionAction.id]);
    expect(fixture.removed).toEqual([progressAction.id]);
    expect(result.succeeded.map((action) => action.id)).toEqual([progressAction.id]);
    expect(result.remaining.map((action) => action.id)).toEqual([
      correctionAction.id,
      undoAction.id,
    ]);
    expect(result.stoppedOnFailure).toBe(true);
  });

  it("can retry a failed action after the first flush has settled", async () => {
    const fixture = queueFixture([correctionAction]);
    let attempts = 0;

    const first = await flushClaimQueue({
      ...fixture,
      syncAction: async () => {
        attempts += 1;
        throw new Error("offline");
      },
    });
    const second = await flushClaimQueue({
      ...fixture,
      syncAction: async () => {
        attempts += 1;
      },
    });

    expect(attempts).toBe(2);
    expect(first.remaining).toHaveLength(1);
    expect(second.remaining).toEqual([]);
    expect(fixture.removed).toEqual([correctionAction.id]);
  });

  it("shares one in-flight flush when called concurrently", async () => {
    const controller = createClaimQueueFlushController();
    let resolveTask: (() => void) | undefined;
    let calls = 0;
    const task = () =>
      new Promise<{
        changed: boolean;
        remaining: ClaimQueueAction[];
        succeeded: ClaimQueueAction[];
        stoppedOnFailure: boolean;
      }>((resolve) => {
        calls += 1;
        resolveTask = () =>
          resolve({
            changed: false,
            remaining: [],
            succeeded: [],
            stoppedOnFailure: false,
          });
      });

    const first = controller.flush(task);
    const second = controller.flush(task);

    expect(second).toBe(first);
    expect(calls).toBe(1);
    resolveTask?.();
    await first;
  });

  it("allows a new flush after the previous one completes", async () => {
    const controller = createClaimQueueFlushController();
    let calls = 0;
    const result = {
      changed: false,
      remaining: [],
      succeeded: [],
      stoppedOnFailure: false,
    } satisfies {
      changed: boolean;
      remaining: ClaimQueueAction[];
      succeeded: ClaimQueueAction[];
      stoppedOnFailure: boolean;
    };

    await controller.flush(async () => {
      calls += 1;
      return result;
    });
    await controller.flush(async () => {
      calls += 1;
      return result;
    });

    expect(calls).toBe(2);
  });
});