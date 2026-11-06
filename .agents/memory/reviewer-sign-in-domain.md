---
name: Reviewer sign-in domain
description: Canonical public origin for Clerk reviewer sign-in links.
---

Build reviewer sign-in links from the configured public base URL via `publicBaseUrl()`, not `REPLIT_DOMAINS`.

**Why:** Production Clerk is configured on `clerk.replayjo.com`; a link on a different app domain may not complete sign-in.

**How to apply:** Use the shared public URL helper for reviewer-link origins, then keep HTTPS and origin-only validation.
