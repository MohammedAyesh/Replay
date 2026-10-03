---
name: Wouter query strings
description: Read URL query state with Wouter's separate search hook.
---

Wouter's `useLocation()` returns the pathname, while `useSearch()` tracks the query string separately. Splitting `?` from `useLocation()` will not reliably read query state.

**Why:** Academy attendance deep links changed the URL with a session ID, but the selection logic never saw it when it read only `useLocation()`.

**How to apply:** Use `useSearch()` with `URLSearchParams` for query-driven selection or filters, and use `useLocation()` for pathname navigation.