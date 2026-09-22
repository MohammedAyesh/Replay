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

## Admin preview
Admin clip viewing should use the authenticated Bunny HLS proxy and the source clip window directly. It must not require a background FFmpeg export, because export-only branding or FFmpeg failures can make an otherwise playable clip appear unavailable.

**Why:** The admin modal previously ignored its available HLS URL and waited for an MP4 export; a production export failed in the branding filter while the source video remained playable.

**How to apply:** Keep FFmpeg export for downloads and sharing, but use a proxied HLS `playbackUrl` for staff preview and seek/stop at the stored normalized clip bounds.

## Diagnostic caution
Current workspace secret-presence checks may not describe the environment that produced an older workflow or deployment log. Treat historical successful uploads as evidence of that runtime only, and verify the active process environment before attributing a failure to missing Bunny credentials.

**Why:** A development inspection reported only the CDN URL present even though retained workflow logs showed successful Bunny uploads; the observations came from different runtime contexts.

**How to apply:** When investigating export reliability, compare the active workflow/deployment process environment with the log timestamps instead of using the current workspace view as a retroactive explanation.
