---
name: Public demo authentication
description: Keep the public sales demo outside Clerk and suppress authenticated locale lookups.
---

The `/demo` page must not initialize Clerk or issue `/api/auth/me` requests. Bypassing the Clerk provider alone is insufficient when a shared locale provider still runs its authenticated `useGetMe` query.

**Why:** The public page is viewed by prospects; a background auth lookup generated an unnecessary 401 even though the page itself was outside Clerk.

**How to apply:** When routing a standalone public page through the main app, also disable authenticated provider queries for that route. Do not weaken server-side auth on protected endpoints.
