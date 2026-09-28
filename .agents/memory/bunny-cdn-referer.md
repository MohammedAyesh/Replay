---
name: Bunny CDN Referer requirement
description: Bunny HLS direct playback depends on the allowed Referer origin; development preview may need the proxy.
---

## Rule

Direct browser playback of Bunny HLS can work when requests carry the app's origin
as the `Referer` and the CDN CORS policy allows that origin. The development
preview origin is not necessarily allowed: an actual public Jordan Galaxy
recording returned 403 directly even with the preview's Referer, while the
authorized HLS proxy served its master, rendition, and segments.

- For ordinary recordings in HLS.js browsers, use direct Bunny playback first
  with `crossOrigin="anonymous"` only on origins where it has been verified;
  keep the same recording's proxy URL as fallback.
- For demos or preview origins that have not been approved by the CDN, use the
  authorized proxy as the primary source rather than showing a stalled player.
- Prefer the proxy from the outset on native-HLS-only browsers when direct playback
  is not reliable.
- Keep proxy URLs for features that depend on the service-worker cache or
  same-origin clip/export flows. Do not remove the proxy route or treat every
  browser-facing playback URL as proxy-only.
- Do not change server API response conventions globally without checking which
  client features rely on the proxy URL.

**Why:** Production-site tests confirmed direct playback with the site's Referer
and CORS, but development-preview testing found that a valid Referer alone does
not ensure access. CDN allowlisting can differ by origin.

**How to apply:** When a UI owns both URLs for a Bunny recording, give the player
the direct URL and a proxy URL separately. Choose primary order for the current
origin, and keep the proxy available for fallback, native HLS, cache preparation,
and client-side export paths.
