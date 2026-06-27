---
name: HEVC→H264 HLS transcode pipeline
description: How to transcode HEVC HLS streams to H264 for Chrome playback in the SoccerWatch API server.
---

## Rule
Use `-hls_fmp4_init_filename` (NOT `-hls_init_filename`) for fMP4 segment output in FFmpeg 6.1.x.

**Why:** `-hls_init_filename` is not recognized by FFmpeg 6.1.2; it causes immediate process exit with "Unrecognized option" error.

**How to apply:** Any FFmpeg command using `-hls_segment_type fmp4` must use `-hls_fmp4_init_filename <name>`.

## Performance benchmarks (Replit CPU, cam9 OSS Middle East)
- Download init.mp4 (1.4KB): ~0.9s
- Download first segment (3.8MB): ~2.2s
- Software HEVC decode + H264 encode for first 12.5s chunk: ~14s total
- **First segment ready: ~17s end-to-end** (network + decode + encode)
- Cached (second request same URL): ~25ms

## Architecture (hlsTranscode.ts)
- `GET /api/hls/start?url=<master_m3u8>` — starts FFmpeg job writing to `/tmp/hls_<sha256id>/`, polls for `seg0.m4s` existence, returns `{jobId}` when ready
- `GET /api/hls/stream/:jobId/:filename` — serves files from `/tmp/hls_<jobId>/`
- Jobs cached in a Map by SHA256 of URL (first 16 chars); reused on repeat requests
- FFmpeg command: `v0/index.m3u8` (HEVC video+audio) → libx264 ultrafast crf28 scale=1280:-2 + AAC 96k → HLS fMP4 4s targets
- HEVC NAL and AAC decode warnings are non-fatal; segments are still valid

## Frontend (oss-player.tsx)
- `entry.isHLS = true` triggers the transcode flow
- Fetch `/api/hls/start?url=...` with AbortController for cleanup
- Shows "Converting stream… H.265 → H.264 · first play takes ~20 s" spinner
- On success: creates HLS.js instance pointed at `/api/hls/stream/<jobId>/playlist.m3u8`
- Plain MP4 entries use `video.src` directly (no HLS.js)
