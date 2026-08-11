---
name: Auth-page shell scrolling
description: Why auth and onboarding routes must bypass the shared app shell's fixed-height clipping.
---

Auth and onboarding screens can exceed one viewport, especially during verification or profile completion. The shared app shell is intentionally fixed and clipped for feed-style pages, so those routes must use a `min-height`/visible-overflow branch rather than inheriting the clipped shell.

**Why:** A fixed `100dvh` ancestor paired with `overflow-hidden` prevents the browser from scrolling taller auth content, even when the page component itself uses normal document flow.

**How to apply:** When adding or restyling an auth/onboarding route, preserve the route-specific scrollable shell exception and verify the browser can reach the full form without relying on an inner scroll container.