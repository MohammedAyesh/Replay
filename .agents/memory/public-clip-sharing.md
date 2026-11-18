---
name: Public clip sharing
description: Durable design rules for public clip pages, posters, and token-protected media delivery.
---

Public clip shares use a deterministic HMAC token derived from the clip id. Invalid tokens, missing clips, and admin-hidden clips must intentionally collapse to the same 404 response so the route does not become a clip-existence oracle. After authorization, playable MP4s redirect directly to the public Bunny pull zone; API routes must not stream export bytes to the player.

**Why:** Share pages need to be fetchable by crawlers without an authenticated cookie. Export playback should load from Bunny rather than consuming API bandwidth or cutting through Replit.

**How to apply:** Keep the HTML share page outside `/api` so API no-store middleware does not suppress crawler previews. Validate share tokens before redirecting to Bunny, return an explicit unavailable response for exports without a direct CDN object, and never expose Storage credentials in the page.