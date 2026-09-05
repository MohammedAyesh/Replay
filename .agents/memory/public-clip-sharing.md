---
name: Public clip sharing
description: Durable design rules for public clip pages, posters, and token-protected media delivery.
---

Public clip shares use a deterministic HMAC token derived from the clip id. Invalid tokens, missing clips, and admin-hidden clips must intentionally collapse to the same 404 response so the route does not become a clip-existence oracle.

**Why:** Share pages need to be fetchable by crawlers without an authenticated cookie, while rendered MP4s and generated posters still need an authenticated server-side Bunny request and Range support.

**How to apply:** Keep the HTML share page and media proxy outside `/api` so the API no-store policy does not suppress crawler previews. Generate posters asynchronously from the existing share-count path, and expose only absolute public proxy URLs in metadata.