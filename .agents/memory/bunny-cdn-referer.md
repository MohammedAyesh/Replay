---
name: Bunny CDN playback routing
description: Archived Bunny playback should use the same-origin HLS proxy first and surface fatal player diagnostics.
---

## Recorded HLS routing

Keep the playlist request on the same-origin HLS proxy so the server can check
view access. On the accepted production origin, recorded-video playlists can
point segments directly to Bunny first; if direct segments fail, switch to the
fully proxied relay playlist. Preview origins that Bunny does not accept should
receive proxied segments. Keep the relay route available for this fallback and
for flows that depend on same-origin media URLs.

**Why:** Bunny's access and CORS behavior depends on the request origin. Direct
segments reduce relay traffic on the accepted origin, while preview hosts and
CDN failures still need the authorized relay path.

**How to apply:** Preserve the order “proxied manifest with direct Bunny
segments → fully relayed playlist.” Do not bypass the manifest access check or
remove the relay fallback when changing recorded-video players.

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

## HLS range corruption after cache replacement

On 2026-11-09, purging the pull-zone cache changed a tested 4K recording from
31/40 corrupt boundary-crossing pieces to 0/40. A 45:01 piece decoded with zero
errors, and eight other recordings tested at 0/20 each.

**Why:** The corruption disappeared after clearing cached range responses, so
playback resets alone are not evidence of incorrect crop timing or scaling.

**How to apply:** For 4K playback corruption, verify range integrity and cache
state before changing timestamps, offsets, crop scaling, or framing curves.
