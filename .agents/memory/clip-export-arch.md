---
name: Clip export architecture
description: FFmpeg clip export pipeline, Bunny Storage config quirks, and download proxy setup.
---

# Clip Export Architecture

## Pipeline
Background export: FFmpeg render → Bunny Storage upload → DB stores exportedUrl → client polls export-status → downloads via server proxy.

## Bunny Storage credentials (required env vars)
- `BUNNY_STORAGE_ZONE` — just the zone name (`galaxyfield`), NOT the full URL. Code in `bunny.ts` strips URL prefix defensively.
- `BUNNY_STORAGE_HOSTNAME` — use `storage.bunnycdn.com` (main endpoint). Regional hostnames like `de.storage.bunnycdn.com` are NOT resolvable from Replit's network even though the zone is in Frankfurt.
- `BUNNY_STORAGE_API_KEY` — the per-zone Password from Bunny dashboard → Storage → FTP & API Access tab. It is a non-standard 6-segment UUID format (e.g. `xxxxxxxx-xxxx-xxxx-xxxxxxxxxxxx-xxxx-xxxx`), NOT the account API key.
- `BUNNY_STORAGE_CDN_URL` — the base URL for exported file URLs. May be the storage API URL (auth required) rather than a public CDN pull zone.

**Why:** `requestEnvVar` prompts don't reliably inject secrets into the running process. Use `setEnvVars` for non-sensitive values, then restart the workflow to pick them up. Verify with `/proc/<pid>/environ`.

## Download proxy
`GET /user-clips/:id/download` fetches from `clip.exportedUrl` using `AccessKey: BUNNY_STORAGE_API_KEY` header — required because `BUNNY_STORAGE_CDN_URL` may point to the storage API (not a public pull zone).

## Dedup / in-flight guard
`inFlight: Set<number>` in route module prevents concurrent renders for same clip. DB `exportStatus` column: `null` → `pending` → `done` / `error`.
