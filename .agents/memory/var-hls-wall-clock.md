---
name: VAR HLS wall clock
description: Wall-clock and live-edge rules for HLS VAR playback with discontinuous playlists.
---

For live VAR playlists, media time is not a continuous wall-clock axis. For a timestamp tied to the playhead, use the program date time on the newest-start fragment covering that media position plus the offset within that fragment. If that active fragment has no program date time, report the playhead time as unknown; never reuse a prior fragment's date or a stale `hls.playingDate` across a discontinuity. Derive the live clock from the newest playlist fragment's wall-clock end, and seek Go Live using `hls.liveSyncPosition`.

**Why:** Camera playlists can contain holes and wall-clock jumps. First-program-date-time plus `currentTime` produces large timestamp and latency errors; reusing stale wall time can shift live clips into the wrong moment.

**How to apply:** Keep playhead timestamps fragment-aware and treat missing active-fragment metadata as unknown. Keep the separate live-edge clock tied to the newest fragment and reload at the live-sync position when playlist media sequence numbers move backward after a server restart.