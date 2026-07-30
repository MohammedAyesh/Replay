---
name: Clip intro — playback vs export
description: Intro is hardcoded off for all playback responses; export still prepends it at correct output dimensions.
---

## Rule
`introVideoUrl` is **always `null`** in every API response a browser uses for playback. This is hardcoded — not a flag, not configurable at runtime.

`resolveIntroVideoUrl()` in `artifacts/api-server/src/routes/userClips.ts` still works normally and is called only by the export path (FFmpeg render). Do not gate it.

**Why:** The intro is a Bunny Storage file that requires server-side authentication to stream. Handing its URL (even a proxied one) to a browser `<video>` element means the browser must buffer the entire intro before the user's own clip starts — several seconds of black. Moving the intro to export-only means the viewer never waits; they only see it in the downloaded MP4.

**How to apply:**
- Playback sites (create, update, list, feed responses in `userClips.ts`; `buildClip` in `clips.ts`): hardcode `introVideoUrl = null` and skip all intro-related DB queries in list/feed paths.
- Export site (`POST /user-clips/:id/export` background job): call `resolveIntroVideoUrl(clip.academyId)` as before; pass `introUrl` and `introReferer` to `renderClip`.
- To re-enable intro in playback in the future: remove the hardcoded nulls and restore `introPlaybackPath(...)` calls. The infrastructure (DB columns, admin upload, proxy route, export logic) is fully intact.
