---
name: Orval input path
description: Orval code generation runs from the workspace root in this monorepo and needs an absolute OpenAPI input path.
---

Use `path.resolve(__dirname, "openapi.yaml")` for Orval input targets instead of a package-relative-looking `./openapi.yaml`.

**Why:** The filtered package command can still resolve Orval's input relative to the workspace root. A relative target causes Orval to clean generated outputs and then fail to resolve the spec.

**How to apply:** When changing the OpenAPI spec, run the api-spec codegen command and confirm both generated client and Zod outputs are present before typechecking.