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

## Progressive MP4 range behavior

A measured 650 MB Bunny MP4 returned 500 through the proxy with no `Range` or
an open-ended range such as `bytes=0-`; a bounded `bytes=0-65535` request
returned 206 with a correct `Content-Range` in 351 ms. For progressive MP4
fallbacks, translate no-range and open-ended client requests into bounded
upstream requests, stream the bounded responses in order, and advertise
`Accept-Ranges: bytes`. Return a normal full-response status for a client that
sent no range, and a 206 with the full requested range for an open-ended range.

**Why:** Bunny's large-file proxy path does not accept unbounded upstream
requests, so forwarding the browser's open-ended range unchanged reproduces the
500. Bounded range requests are known to work and let the proxy stream without
buffering the entire recording.

**How to apply:** Keep the workaround scoped to the progressive MP4 fallback,
not HLS segments. Direct Bunny MP4 playback remains unverified: `readyState ===
0` after 15 seconds is inconclusive. Do not switch to that route unless
`loadedmetadata` and a finite duration are confirmed.
