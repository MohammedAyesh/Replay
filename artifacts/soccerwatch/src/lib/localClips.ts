const DB_NAME = "SoccerWatchLocalClips";
const DB_VERSION = 1;
const STORE_NAME = "clips";

interface LocalClipRecord {
  clipId: number;
  userId: number;
  title: string;
  blob: Blob;
  mimeType: string;
  startTime: number;
  endTime: number;
  cropPath: { t: number; x: number; y: number; w: number; h: number }[];
  aspectRatio: string;
  downloadedAt: string;
  playbackUrl: string | null;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("IDB open failed"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "clipId" });
        store.createIndex("userId", "userId", { unique: false });
      }
    };
  });
}

export async function saveLocalClip(record: LocalClipRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("IDB put failed"));
    tx.oncomplete = () => db.close();
  });
}

export async function getLocalClip(clipId: number): Promise<LocalClipRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(clipId);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error ?? new Error("IDB get failed"));
    tx.oncomplete = () => db.close();
  });
}

export async function listLocalClips(userId: number): Promise<LocalClipRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index("userId");
    const req = idx.getAll(userId);
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error ?? new Error("IDB getAll failed"));
    tx.oncomplete = () => db.close();
  });
}

export async function deleteLocalClip(clipId: number): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(clipId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("IDB delete failed"));
    tx.oncomplete = () => db.close();
  });
}

export function createLocalBlobUrl(record: LocalClipRecord): string {
  return URL.createObjectURL(record.blob);
}

export function revokeLocalBlobUrl(url: string): void {
  URL.revokeObjectURL(url);
}
