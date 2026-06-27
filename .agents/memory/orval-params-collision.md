---
name: Orval query-param type collision
description: Query parameters in OpenAPI ops cause TS2308 collisions in the lib/api-zod barrel between generated/api.ts and generated/types/.
---

When an OpenAPI operation has query parameters, Orval generates `<OperationIdPascal>Params` as both a Zod schema (in `generated/api.ts`) and a TypeScript interface (in `generated/types/`). The `lib/api-zod` barrel re-exports both with `export *`, producing:

```
error TS2308: Module "./generated/api" has already exported a member named 'GetFieldRecordingsParams'.
```

**Why:** Orval emits param types to both locations — the Zod schema for server-side validation and the TS type for client-side usage. Names collide in the barrel.

**How to apply:** Remove all query parameters from OpenAPI operations (both query-only and mixed path+query). Handle filtering client-side in the frontend, or use separate dedicated endpoints without query params. Body schemas follow the same rule — use entity-shaped names (`NoteInput` not `CreateNoteBody`).
