export type ClaimQueueAction =
  | {
      id: string;
      kind: "progress";
      recordingId: number;
      payload: Record<string, unknown>;
      createdAt: number;
    }
  | {
      id: string;
      kind: "correction";
      recordingId: number;
      payload: Record<string, unknown>;
      createdAt: number;
    }
  | {
      id: string;
      kind: "undo";
      recordingId: number;
      correctionId: number;
      createdAt: number;
    }
  | {
      id: string;
      kind: "offPitchCreate";
      recordingId: number;
      payload: Record<string, unknown>;
      createdAt: number;
    }
  | {
      id: string;
      kind: "offPitchDelete";
      recordingId: number;
      clientId: string;
      createdAt: number;
    };

const STORAGE_KEY = "replay-claim-match-queue";

function readFallback(): ClaimQueueAction[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as ClaimQueueAction[] : [];
  } catch {
    return [];
  }
}

function writeFallback(actions: ClaimQueueAction[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(actions));
  } catch {
    // The queue is best effort when storage is unavailable (private browsing).
  }
}

export function filterClaimActionsForRecording(
  actions: ClaimQueueAction[],
  recordingId: number,
): ClaimQueueAction[] {
  return actions.filter((action) => action.recordingId !== recordingId);
}

export async function readClaimQueue(): Promise<ClaimQueueAction[]> {
  if (typeof indexedDB === "undefined") return readFallback();
  return new Promise((resolve) => {
    const request = indexedDB.open("replay-claim-match", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("queue", { keyPath: "id" });
    };
    request.onerror = () => resolve(readFallback());
    request.onsuccess = () => {
      const transaction = request.result.transaction("queue", "readonly");
      const getAll = transaction.objectStore("queue").getAll();
      getAll.onerror = () => resolve(readFallback());
      getAll.onsuccess = () => resolve((getAll.result as ClaimQueueAction[]).sort((a, b) => a.createdAt - b.createdAt));
    };
  });
}

export async function enqueueClaimAction(action: ClaimQueueAction): Promise<void> {
  const actions = await readClaimQueue();
  const next = [...actions.filter((item) => item.id !== action.id), action];
  if (typeof indexedDB === "undefined") {
    writeFallback(next);
    return;
  }
  await new Promise<void>((resolve) => {
    const request = indexedDB.open("replay-claim-match", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("queue", { keyPath: "id" });
    request.onerror = () => { writeFallback(next); resolve(); };
    request.onsuccess = () => {
      const transaction = request.result.transaction("queue", "readwrite");
      transaction.objectStore("queue").put(action);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => { writeFallback(next); resolve(); };
    };
  });
}

export async function removeClaimAction(id: string): Promise<void> {
  const actions = await readClaimQueue();
  const next = actions.filter((item) => item.id !== id);
  if (typeof indexedDB === "undefined") {
    writeFallback(next);
    return;
  }
  await new Promise<void>((resolve) => {
    const request = indexedDB.open("replay-claim-match", 1);
    request.onerror = () => { writeFallback(next); resolve(); };
    request.onsuccess = () => {
      const transaction = request.result.transaction("queue", "readwrite");
      transaction.objectStore("queue").delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => { writeFallback(next); resolve(); };
    };
  });
}

export async function removeClaimActionsForRecording(recordingId: number): Promise<void> {
  const actions = await readClaimQueue();
  const next = filterClaimActionsForRecording(actions, recordingId);
  if (typeof indexedDB === "undefined") {
    writeFallback(next);
    return;
  }
  await new Promise<void>((resolve) => {
    const request = indexedDB.open("replay-claim-match", 1);
    request.onerror = () => { writeFallback(next); resolve(); };
    request.onsuccess = () => {
      const transaction = request.result.transaction("queue", "readwrite");
      const store = transaction.objectStore("queue");
      for (const action of actions) {
        if (action.recordingId === recordingId) store.delete(action.id);
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => { writeFallback(next); resolve(); };
    };
  });
}