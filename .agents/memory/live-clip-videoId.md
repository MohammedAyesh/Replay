---
name: Live clip synthetic videoId
description: Live-stream clips store "live:<cameraId>" as videoId — not a real Bunny GUID — breaking URL generation and export.
---

## Rule
When `videoId.startsWith("live:")`, skip all Bunny URL generation (return `null` for `playbackUrl` and `thumbnailUrl`) and reject export with HTTP 400.

**Why:** The academy live-stream clip flow (`academies.tsx`) synthesises `live:camera1` / `live:camera2` as the videoId because no real Bunny Stream GUID exists at clip-creation time. The server was building `https://{CDN}/live:camera2/playlist.m3u8` — a 404 URL — causing clips to appear broken in playback and export.

**How to apply:**
- `userClips.ts`: `isLiveVideoId(videoId)` helper guards every spot that calls `getBunnyPlaybackUrl` / `getBunnyThumbnailUrl`, and the export route rejects live clips with a clear 400.
- `my-clips.tsx`: `UserClipCard` shows a "Live recording / Playback available once the recording uploads" overlay when `!clip.playbackUrl`.
- `academies.tsx`: save toast explains playback won't be immediate for live clips.
- Long-term fix: task "Let cameras auto-upload footage and create clips without manual steps" (task #6) will replace the synthetic ID with the real Bunny GUID once the recording is uploaded.
