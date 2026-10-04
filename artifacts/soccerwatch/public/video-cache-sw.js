// Bump this whenever the proxy/media response contract changes. A prior
// generation could contain placeholder/error bodies that were returned with a
// successful HTTP status and would otherwise be replayed forever.
const CACHE_PREFIX = "replay-video-v2-";
const RETIRED_CACHE_PREFIXES = ["replay-video-v1-"];
const MAX_CACHE_BUCKETS = 12;
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const ACTIVE_STREAM_LEASE_MS = 10 * 60 * 1000;
const CACHE_TOUCH_INTERVAL_MS = 30 * 1000;
const CACHE_METADATA_URL = new URL("/__replay-video-cache-metadata-v2__", self.location.origin).href;
const CACHE_METADATA_REQUEST = new Request(CACHE_METADATA_URL);
const writableScopeByClient = new Map();
const lastTouchByCache = new Map();
let cacheWriteQueue = Promise.resolve();

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
  if (url.pathname.startsWith("/proto/")) return null;
  if (url.origin !== self.location.origin || !url.pathname.includes("/api/hls-proxy/")) return null;
  if (url.pathname.includes("/manifest")) return { kind: "manifest", scope: streamScope(url.href) };
  if (url.pathname.includes("/segment")) return { kind: "segment", scope: streamScope(url.href) };
  return null;
}

async function cacheStats(cache) {
  const keys = await cache.keys();
  return { cachedCount: keys.filter((request) => request.url !== CACHE_METADATA_URL).length };
}

async function readBodyLength(response) {
  if (!response.body) return 0;
  const reader = response.body.getReader();
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return length;
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

async function measureResponseBytes(response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength.trim())) {
    const length = Number(declaredLength);
    if (Number.isSafeInteger(length)) return length;
  }
  return readBodyLength(response.clone());
}

async function measureCacheBytes(cache, keys) {
  let total = 0;
  for (const request of keys) {
    if (request.url === CACHE_METADATA_URL) continue;
    const response = await cache.match(request);
    if (response) total += await measureResponseBytes(response);
  }
  return total;
}

async function saveCacheMetadata(cache, metadata) {
  await cache.put(
    CACHE_METADATA_REQUEST,
    new Response(JSON.stringify(metadata), {
      headers: { "content-type": "application/json" },
    }),
  );
}

async function getCacheMetadata(cache) {
  const keys = await cache.keys();
  const cachedCount = keys.filter((request) => request.url !== CACHE_METADATA_URL).length;
  let previous = null;
  try {
    const response = await cache.match(CACHE_METADATA_REQUEST);
    if (response) previous = await response.json();
  } catch {
    // Rebuild missing or unreadable metadata from the cache entries.
  }

  const hasValidUsage = Number.isFinite(previous?.lastUsedAt)
    && Number.isFinite(previous?.activeUntil);
  if (
    hasValidUsage
    && Number.isFinite(previous?.bytes)
    && previous.bytes >= 0
    && previous.cachedCount === cachedCount
  ) {
    return {
      lastUsedAt: previous.lastUsedAt,
      activeUntil: previous.activeUntil,
      bytes: previous.bytes,
      cachedCount,
    };
  }

  const metadata = {
    // Existing buckets have no reliable usage order; treat them as oldest
    // until this worker records a real access time.
    lastUsedAt: hasValidUsage ? previous.lastUsedAt : 0,
    activeUntil: hasValidUsage ? previous.activeUntil : 0,
    bytes: await measureCacheBytes(cache, keys),
    cachedCount,
  };
  try {
    await saveCacheMetadata(cache, metadata);
  } catch {
    // Accounting metadata is best effort and must not block playback.
  }
  return metadata;
}

function serializeCacheWrite(task) {
  const queued = cacheWriteQueue.then(task, task);
  cacheWriteQueue = queued.catch(() => undefined);
  return queued;
}

async function touchBucket(cacheName, cache, force = false) {
  return serializeCacheWrite(async () => {
    try {
      const now = Date.now();
      const lastTouch = lastTouchByCache.get(cacheName) || 0;
      if (!force && now - lastTouch < CACHE_TOUCH_INTERVAL_MS) return;

      const metadata = await getCacheMetadata(cache);
      metadata.lastUsedAt = now;
      metadata.activeUntil = now + ACTIVE_STREAM_LEASE_MS;
      await saveCacheMetadata(cache, metadata);
      lastTouchByCache.set(cacheName, now);
    } catch {
      // Timestamp writes are optional and must not affect playback.
    }
  });
}

async function activeScopes() {
  try {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const liveClientIds = new Set(clients.map((client) => client.id));
    for (const clientId of writableScopeByClient.keys()) {
      if (!liveClientIds.has(clientId)) writableScopeByClient.delete(clientId);
    }
  } catch {
    // The in-memory scopes still protect streams while this worker is alive.
  }
  return new Set(writableScopeByClient.values());
}

async function trimCurrentCaches(protectedScopes = new Set(), incomingBytes = 0) {
  try {
    const names = (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX));
    const buckets = [];
    for (const name of names) {
      const cache = await caches.open(name);
      buckets.push({ name, cache, ...(await getCacheMetadata(cache)) });
    }

    const now = Date.now();
    const protectedNames = new Set([...protectedScopes].map(hashScope));
    for (const bucket of buckets) {
      if (bucket.activeUntil > now) protectedNames.add(bucket.name);
    }

    let totalBytes = buckets.reduce((total, bucket) => total + bucket.bytes, 0);
    let projectedBytes = Math.max(0, totalBytes + incomingBytes);
    while (buckets.length > MAX_CACHE_BUCKETS || projectedBytes > MAX_CACHE_BYTES) {
      const candidates = buckets
        .filter((bucket) => !protectedNames.has(bucket.name))
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.name.localeCompare(b.name));
      const oldest = candidates[0];
      if (!oldest) return false;

      await caches.delete(oldest.name);
      lastTouchByCache.delete(oldest.name);
      totalBytes -= oldest.bytes;
      projectedBytes = Math.max(0, totalBytes + incomingBytes);
      buckets.splice(buckets.indexOf(oldest), 1);
    }
    return true;
  } catch {
    // Trimming is best effort; a storage failure must never block playback.
    return false;
  }
}

async function validatedResponseBytes(response, kind) {
  if (kind === "manifest") {
    const text = await response.clone().text();
    const playlist = text.replace(/^\uFEFF/, "");
    const firstLine = playlist.split(/\r?\n/).find((line) => line.trim())?.trim();
    const hasPlaylistTag = /(?:^|\r?\n)#(?:EXTINF:|EXT-X-STREAM-INF:|EXT-X-I-FRAME-STREAM-INF:|EXT-X-MEDIA:|EXT-X-TARGETDURATION:|EXT-X-ENDLIST|EXT-X-PART:|EXT-X-MAP:)/m.test(playlist);
    if (firstLine !== "#EXTM3U" || !hasPlaylistTag) return null;
    return new TextEncoder().encode(text).byteLength;
  }

  const declaredLength = response.headers.get("content-length");
  if (!declaredLength || !/^\d+$/.test(declaredLength.trim())) return null;
  const expectedLength = Number(declaredLength);
  if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0) return null;
  const actualLength = await readBodyLength(response.clone());
  return actualLength === expectedLength ? actualLength : null;
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

async function storeResponse(cache, cacheName, request, response, event, resource) {
  try {
    // Clone before yielding so page playback cannot consume the response before
    // Cache.put gets its own body stream.
    const responseForCache = response.clone();
    const incomingBytes = await validatedResponseBytes(responseForCache, resource.kind);
    if (incomingBytes === null) return;

    await serializeCacheWrite(async () => {
      const metadata = await getCacheMetadata(cache);
      const previous = await cache.match(request, { ignoreVary: true });
      const previousBytes = previous ? await measureResponseBytes(previous) : 0;
      const byteDelta = incomingBytes - previousBytes;
      const protectedStreams = await activeScopes();
      protectedStreams.add(resource.scope);
      if (!(await trimCurrentCaches(protectedStreams, byteDelta))) return;

      await cache.put(request, responseForCache);
      const stats = await cacheStats(cache);
      const now = Date.now();
      try {
        await saveCacheMetadata(cache, {
          lastUsedAt: now,
          activeUntil: now + ACTIVE_STREAM_LEASE_MS,
          bytes: Math.max(0, metadata.bytes + byteDelta),
          cachedCount: stats.cachedCount,
        });
        lastTouchByCache.set(cacheName, now);
      } catch {
        // A later trim will rebuild accounting if the metadata write failed.
      }
      await notify(event, { kind: "stored", resource: resource.kind, ...stats });
    });
  } catch (error) {
    await notify(event, {
      kind: "error",
      resource: resource.kind,
      detail: error instanceof Error ? error.message : "Browser storage quota reached",
    });
  }
}

async function respondWithCache(request, event, resource, extendLifetime) {
  if (!resource.scope) return fetch(request);

  const cacheName = hashScope(resource.scope);
  let cache;
  try {
    cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    extendLifetime(touchBucket(cacheName, cache));
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
      extendLifetime(storeResponse(cache, cacheName, request, response, event, resource));
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
    await serializeCacheWrite(async () => {
      await trimCurrentCaches(await activeScopes());
    });
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "video-cache-source") return;
  const scope = streamScope(event.data.sourceUrl);
  if (!scope) return;
  const previousScope = event.source?.id
    ? writableScopeByClient.get(event.source.id)
    : null;
  if (event.source?.id) writableScopeByClient.set(event.source.id, scope);
  const name = hashScope(scope);
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(name);
      await touchBucket(name, cache, true);
      const protectedStreams = await activeScopes();
      protectedStreams.add(scope);
      if (previousScope && previousScope !== scope && !protectedStreams.has(previousScope)) {
        const previousName = hashScope(previousScope);
        if ((await caches.keys()).includes(previousName)) {
          const previousCache = await caches.open(previousName);
          await serializeCacheWrite(async () => {
            try {
              const metadata = await getCacheMetadata(previousCache);
              metadata.activeUntil = 0;
              await saveCacheMetadata(previousCache, metadata);
            } catch {
              // A stale activity lease only affects eviction priority.
            }
          });
        }
      }
      await serializeCacheWrite(async () => {
        await trimCurrentCaches(protectedStreams);
      });
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