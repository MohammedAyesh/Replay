---
name: Bunny CDN Referer requirement
description: Bunny CDN returns 403 to direct browser requests without a self-referrer; all client-facing URLs must be proxied.
---

## Rule

Direct browser playback of Bunny HLS can work when requests carry the app's origin
as the `Referer` and the CDN CORS policy allows that origin. Requests without a
suitable `Referer` may still return 403.

- For ordinary recordings in HLS.js browsers, use direct Bunny playback first
  with `crossOrigin="anonymous"`; keep the same recording's proxy URL as fallback.
- Prefer the proxy from the outset on native-HLS-only browsers when direct playback
  is not reliable.
- Keep proxy URLs for features that depend on the service-worker cache or
  same-origin clip/export flows. Do not remove the proxy route or treat every
  browser-facing playback URL as proxy-only.
- Do not change server API response conventions globally without checking which
  client features rely on the proxy URL.

**Why:** Testing confirmed that Bunny accepts direct playback with the site's
`Referer` and CORS, but requests missing that referrer fail. This supersedes the
earlier blanket assumption that all browser playback must use the proxy.

**How to apply:** When a UI owns both URLs for a Bunny recording, give the player
the direct URL and a proxy URL separately. Keep the proxy available for fallback,
native HLS, cache preparation, and client-side export paths.
