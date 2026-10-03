---
name: Orval Zod response arrays
description: Avoid runtime initialization-order failures in generated Zod schemas for OpenAPI array responses.
---

When an OpenAPI array response references a component that is also reused by another response, Orval can emit the array alias before the generated item schema. TypeScript may pass while module evaluation fails with a temporal-dead-zone `ReferenceError`.

**Why:** The generated response item was emitted after the list schema that referenced it, so importing the generated module crashed SoccerWatch at runtime.

**How to apply:** Give the array response its own named item component when it shares a component with another response. Keep the shape equivalent, rerun codegen, inspect declaration order, and verify the app in a browser.