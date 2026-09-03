// Bump this whenever the proxy/media response contract changes. A prior
// generation could contain placeholder/error bodies that were returned with a
// successful HTTP status and would otherwise be replayed forever.
const CACHE_PREFIX = "replay-video-v2-";
const RETIRED_CACHE_PREFIXES = ["replay-video-v1-"];
const writableScopeByClient = new Map();

function hashScope(scope) {
  let hash = 2166136261;
  for (let index = 0; index < scope.length; index += 1) {
    hash ^= scope.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${CACHE_PREFIX}${(hash >>> 0).toString(16)}`;
}

function streamScope(urlLike) {
  try {
    const proxyUrl = new URL(urlLike, self.location.origin);
    const raw = proxyUrl.searchParams.get("url");
    const upstream = raw ? new URL(raw) : proxyUrl;
    const parts = upstream.pathname.split("/").filter(Boolean);
    return `${upstream.hostname}/${parts[0] || upstream.pathname}`;
  } catch {
    return null;
  }
}

function cacheableResource(request) {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.includes("/api/hls-proxy/")) return null;
  if (url.pathname.includes("/manifest")) return { kind: "manifest", scope: streamScope(url.href) };
  if (url.pathname.includes("/segment")) return { kind: "segment", scope: streamScope(url.href) };
  return null;
}

async function cacheStats(cache) {
  return { cachedCount: (await cache.keys()).length };
}

async function notify(event, update) {
  try {
    if (!event.clientId) return;
    const client = await self.clients.get(event.clientId);
    client?.postMessage({ type: "replay-video-cache", update });
  } catch {
    // Status reporting is optional and must never affect playback.
  }
}

async function storeResponse(cache, request, response, event, resource) {
  try {
    await cache.put(request, response.clone());
    const stats = await cacheStats(cache);
    await notify(event, { kind: "stored", resource, ...stats });
  } catch (error) {
    await notify(event, {
      kind: "error",
      resource,
      detail: error instanceof Error ? error.message : "Browser storage quota reached",
    });
  }
}

async function respondWithCache(request, event, resource, extendLifetime) {
  if (!resource.scope) return fetch(request);

  let cache;
  try {
    cache = await caches.open(hashScope(resource.scope));
    const cached = await cache.match(request);
    if (cached) {
      extendLifetime((async () => {
        try {
          const stats = await cacheStats(cache);
          await notify(event, { kind: "hit", resource: resource.kind, ...stats });
        } catch {
          // A cached response is still valid when status enumeration fails.
        }
      })());
      return cached;
    }
  } catch (error) {
    await notify(event, {
      kind: "error",
      resource: resource.kind,
      detail: error instanceof Error ? error.message : "Browser cache is unavailable",
    });
    return fetch(request);
  }

  try {
    const response = await fetch(request);
    if (response.ok && writableScopeByClient.get(event.clientId) === resource.scope) {
      extendLifetime(storeResponse(cache, request, response, event, resource.kind));
    }
    return response;
  } catch (error) {
    await notify(event, {
      kind: "error",
      resource: resource.kind,
      detail: error instanceof Error ? error.message : "Video request failed",
    });
    throw error;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      await Promise.all(
        (await caches.keys())
          .filter((name) => RETIRED_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)))
          .map((name) => caches.delete(name)),
      );
    } catch {
      // Cache cleanup is best effort; a storage failure must not prevent the
      // new worker from taking control and falling back to the network.
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "video-cache-source") return;
  const scope = streamScope(event.data.sourceUrl);
  if (!scope) return;
  if (event.source?.id) writableScopeByClient.set(event.source.id, scope);
  const name = hashScope(scope);
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(name);
      const stats = await cacheStats(cache);
      if (event.source?.id) {
        event.source.postMessage({
          type: "replay-video-cache",
          update: { kind: "ready", ...stats },
        });
      }
    } catch (error) {
      event.source?.postMessage({
        type: "replay-video-cache",
        update: {
          kind: "error",
          detail: error instanceof Error ? error.message : "Browser cache is unavailable",
        },
      });
    } finally {
      event.ports?.[0]?.postMessage({ ready: true });
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const resource = cacheableResource(event.request);
  if (!resource) return;

  let pendingTasks = 1;
  let resolveLifetime;
  const lifetime = new Promise((resolve) => { resolveLifetime = resolve; });
  const finishTask = () => {
    pendingTasks -= 1;
    if (pendingTasks === 0) resolveLifetime();
  };
  const extendLifetime = (task) => {
    pendingTasks += 1;
    Promise.resolve(task).finally(finishTask);
  };

  // Register both promises synchronously during FetchEvent dispatch.
  event.waitUntil(lifetime);
  event.respondWith(
    respondWithCache(event.request, event, resource, extendLifetime).finally(finishTask),
  );
});