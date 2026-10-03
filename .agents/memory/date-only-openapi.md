---
name: Date-only OpenAPI fields
description: Preserve database date-only values across OpenAPI code generation.
---

When an API field represents a database date rather than an instant, define it as a nullable string with a `YYYY-MM-DD` pattern instead of OpenAPI `format: date`.

**Why:** With the current Orval setup, `format: date` generates Zod date coercion. Parsing a database date string then changes the wire value into a full ISO timestamp, while request types become `Date` and no longer match Drizzle's string-mode date column.

**How to apply:** Use a pattern-constrained string for date-only inputs and outputs; use `format: date-time` for actual instants.