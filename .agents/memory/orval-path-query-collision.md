---
name: Orval path and query parameter collisions
description: Orval can generate duplicate parameter exports when one operation combines path and query parameters.
---

When an OpenAPI operation uses both path and query parameters, run code generation and the generated-library typecheck immediately. Orval may emit the same `*Params` export name for both parameter groups. If that happens, adjust the contract or generator naming rather than hand-editing generated files.

**Why:** This caused a generated TypeScript export collision; keeping the family endpoint's access token and date window in query parameters made codegen pass.

**How to apply:** Check generated names for any operation with mixed parameter locations before wiring its frontend hook. Keep bearer-token URLs protected by the server's request-log redaction.
