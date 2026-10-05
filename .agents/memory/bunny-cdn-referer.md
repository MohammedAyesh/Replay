---
name: Bunny CDN playback routing
description: Archived Bunny playback should use the same-origin HLS proxy first and surface fatal player diagnostics.
---

## Rule

Direct browser playback of Bunny HLS can work when requests carry the app's origin
as the `Referer` and the CDN CORS policy allows that origin. The development
preview origin is not necessarily allowed: an actual public Jordan Galaxy
recording returned 403 directly even with the preview's Referer, while the
authorized HLS proxy served its master, rendition, and segments.

- For archived recordings handled by the shared clip player, use the app's HLS
  proxy first whenever one is available. Do not silently switch to direct Bunny
  after the proxy fails; report the HLS.js diagnostic and let the viewer retry.
- Direct Bunny playback remains appropriate only for flows that explicitly need
  it and have verified CDN access for their origin.
- Keep proxy URLs for features that depend on the service-worker cache or
  same-origin clip/export flows. Do not remove the proxy route or treat every
  browser-facing playback URL as proxy-only.
- Do not change server API response conventions globally without checking which
  client features rely on the proxy URL.

**Why:** Repeated field-detail failures showed that fetching Bunny playlists
directly can stall before any segment reaches the decoder, even when the playlist
and segments are valid and the viewer's network is fast. The proxy provides a
same-origin path and exposes a useful recovery boundary.

**How to apply:** When a UI passes both URLs to the shared clip player, make the
proxy the initial source. Keep direct playback for explicitly verified flows,
not as an automatic rung after the proxy.
