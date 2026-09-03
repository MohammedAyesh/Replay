---
name: HLS.js seek-on-load duration
description: Why seeking a clip to its start fraction must not happen at MANIFEST_PARSED
---

Clips store start/end as 0–1 fractions of total video duration. To position a clip,
playback seeks to `startTime * video.duration` on load.

**Rule:** Never compute that seek at `Hls.Events.MANIFEST_PARSED`. At that moment
`video.duration` is frequently `0`/`NaN` (media playlist not loaded yet), so
`startTime * 0 = 0` → the clip plays from the beginning, and if the code also gated
`video.play()` behind `dur > 0`, playback is skipped entirely → clip appears frozen.

**Why:** MANIFEST_PARSED fires after the master manifest parses but before duration
is known. This produced the "clip starts from the beginning and does not move" bug
across watch/player/my-clips.

**How to apply:** Use a guarded once-only `seekToStart` that validates
`dur > 0 && isFinite(dur)` and is invoked from whichever of `loadedmetadata`,
`durationchange`, and MANIFEST_PARSED fires first with a valid duration. Register
`loadedmetadata`/`durationchange` on the video element (they reliably carry duration);
keep MANIFEST_PARSED only as an extra trigger. Same pattern applies to local blob
(mp4/webm) sources.

For claim-match resume, keep the saved tracking position separate from the live
playhead and apply it once per recording/media source after the video is ready.
Do not put an unguarded `video.currentTime = currentTime` effect on the live
playhead, or normal playback and manual seeks will be repeatedly overridden.

When tracking frame zero starts partway through a long recording, initialize
HLS.js with that absolute video time as `startPosition`, register
`MEDIA_ATTACHED` before attaching the element, and load the source from that
event. Do not rely only on a later React effect to jump from segment zero.

**Why:** Loading from the start of a long recording can leave the Claim player
with buffered bytes and overlays but no frame from the tracked window.

**How to apply:** Convert the initial tracking position to absolute video time
before creating HLS.js; still keep the loaded-metadata seek as a guarded
fallback.
