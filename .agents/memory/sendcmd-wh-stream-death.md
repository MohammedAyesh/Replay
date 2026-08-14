---
name: sendcmd w/h changes kill video stream
description: In FFmpeg 7.1, using sendcmd to change crop@dyn w or h mid-stream silently terminates the video stream (encoder exits 0, audio continues, last frame frozen for the remaining duration). Only x/y changes via sendcmd are safe.
---

# sendcmd w/h changes on crop@dyn kill the video stream (FFmpeg 7.1)

## The Rule
Never use sendcmd to change `w` or `h` on a `crop@dyn` filter. Changing only `x` and `y` via sendcmd is safe and works correctly.

**Why:** sendcmd w/h changes trigger mid-stream format renegotiation in the filter pipeline. In FFmpeg 7.1, this silently terminates the video stream — FFmpeg exits 0, stderr shows nothing, but the video freezes at the last frame while audio continues. This was discovered at the first w/h change at t≈17.83s of a 74s clip: the video died at frame 537 (17.83s) every time.

**How to apply:** For zoom animation (variable crop w/h), encode w and h as FFmpeg `if()` expression chains embedded directly in the filter string (e.g., `crop@dyn=W_expr:H_expr:initX:initY`). FFmpeg negotiates the variable output size with downstream filters at pipeline setup time and handles it correctly. Use sendcmd only for x/y pan animation.

## Verified approach (ffmpegExport.ts)
- **Zoom (w/h):** `if()` expression chains from ~28 downsampled keyframes, embedded in the `crop@dyn` filter string. Correct per-frame zoom with no stream death.
- **Pan (x/y):** sendcmd file, one `crop@dyn x N, crop@dyn y N` entry per output frame (30 fps), using the full keyframe path (no downsampling). Zero w/h entries in the file.
- **Filter chain:** `[pad,]sendcmd=f=FILE,crop@dyn=W_EXPR:H_EXPR:initX:initY,scale=OUT_W:OUT_H:force_original_aspect_ratio=disable`

## Test results that established this
- Test A (static crop at edge position x=1918): PASSES — confirms x position near boundary is not the issue
- Test B (sendcmd x/y-only, no w/h): PASSES — confirms x/y sendcmd is safe
- Old sendcmd (all 4 params including w/h): FAILS at first w/h change every time (frame 537)
- Test C (expression w/h + sendcmd x/y): PASSES — 2222 frames, 74s, dup=741, drop=0, zero freeze events
