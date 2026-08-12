---
name: Clerk auth card surface
description: Clerk auth card and footer are separate appearance surfaces, and development badge suppression needs a runtime-scoped UI guard.
---

Clerk renders the auth content card and its footer as separate elements; style the shared card container when the footer must visually belong to the same panel. The development badge may not honor the appearance warning flag on an existing development instance, so suppress only the exact badge text within the Clerk card when the product requires it.

**Why:** Appearance selectors that target the inner card alone leave the sign-in/sign-up footer outside the reference surface, while existing Clerk development instances can continue rendering the badge despite the documented flag.

**How to apply:** Keep the guard scoped to `.cl-cardBox` and an exact `Development mode` text match. Do not change auth state, routing, or form handlers.