export type VideoCacheUpdate = {
  kind: "ready" | "stored" | "hit" | "error";
  resource?: "manifest" | "segment";
  cachedCount?: number;
  detail?: string;
};

type VideoCacheMessage = {
  type?: string;
  update?: VideoCacheUpdate;
};

function cacheSupported() {
  return typeof window !== "undefined"
    && typeof navigator !== "undefined"
    && "serviceWorker" in navigator
    && window.isSecureContext;
}

function basePath() {
  const raw = import.meta.env.BASE_URL || "/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}

function serviceWorkerUrl() {
  return new URL(`${basePath()}video-cache-sw.js`, window.location.href).href;
}

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

function getRegistration() {
  if (!cacheSupported()) return Promise.resolve(null);
  if (!registrationPromise) {
    registrationPromise = navigator.serviceWorker
      .register(serviceWorkerUrl(), { scope: basePath() })
      .catch(() => null);
  }
  return registrationPromise;
}

export async function primeVideoCacheWorker(): Promise<boolean> {
  return Boolean(await getRegistration());
}

export function subscribeToVideoCache(listener: (update: VideoCacheUpdate) => void) {
  if (!cacheSupported()) return () => undefined;
  const onMessage = (event: MessageEvent<VideoCacheMessage>) => {
    if (event.data?.type !== "replay-video-cache" || !event.data.update) return;
    listener(event.data.update);
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}

/**
 * Registers the worker and tells it which stream is active before HLS starts.
 * This only waits for the worker to become available, never for any video
 * bytes, so the first playback request is not delayed by a full download.
 */
export async function prepareVideoCache(sourceUrl: string): Promise<boolean> {
  const registration = await getRegistration();
  if (!registration) return false;

  if (!navigator.serviceWorker.controller) {
    await Promise.race([
      new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
      }),
      new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
    ]);
  }
  const worker = navigator.serviceWorker.controller;
  if (!worker) return false;

  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(resolve, 1200);
    channel.port1.onmessage = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    worker.postMessage({ type: "video-cache-source", sourceUrl }, [channel.port2]);
  });

  // HLS may have fetched its manifest while the player was still paused.
  // Re-request only that tiny playlist after Play so it enters Cache Storage;
  // media and init segments remain progressive and are cached only if requested.
  void fetch(sourceUrl, { cache: "no-cache", credentials: "include" }).catch(() => undefined);
  return true;
}