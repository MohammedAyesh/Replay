---
name: Bunny CDN Referer requirement
description: Bunny CDN returns 403 to direct browser requests without a self-referrer; all client-facing URLs must be proxied.
---

## Rule
Never return raw `https://vz-*.b-cdn.net/…` URLs in API responses that reach a browser. Always wrap them with the server-side HLS proxy.

- `playbackUrl` → `/api/hls-proxy/manifest?url=${encodeURIComponent(rawCdnUrl)}`
- `thumbnailUrl` → `/api/hls-proxy/segment?url=${encodeURIComponent(rawCdnUrl)}`

Helper functions: `getBunnyProxiedPlaybackUrl(videoId)` and `getBunnyProxiedThumbnailUrl(videoId, time?)` in `artifacts/api-server/src/lib/bunny.ts`.

Raw CDN URL functions (`getBunnyPlaybackUrl`, `getBunnyThumbnailUrl`) are **only** for server-side use (FFmpeg export, Bunny API calls).

**Why:** Bunny CDN enforces `Referer: https://<cdn-hostname>/` — a self-referrer a browser cannot send. The HLS proxy (`artifacts/api-server/src/routes/hlsProxy.ts`) adds this header before forwarding. Without it, every manifest, segment, and thumbnail request returns 403, leaving the player and card thumbnails black.

**How to apply:** Any new endpoint that builds a `playbackUrl` or `thumbnailUrl` for a client response must use the proxied helpers. The export path (`artifacts/api-server/src/routes/userClips.ts` around `const videoUrl = getBunnyPlaybackUrl(videoId)`) is the single intentional exception — FFmpeg runs server-side and sets the referer manually.

The `bunnyPlaybackUrl` field on field clips (`artifacts/api-server/src/routes/clips.ts`) is also a raw CDN URL — intentional because `field-detail.tsx` wraps it client-side at line 915 before passing it to HLS.js.
