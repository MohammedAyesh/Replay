---
name: VAR HLS wall clock
description: Wall-clock and live-edge rules for HLS VAR playback with discontinuous playlists.
---

For live VAR playlists, media time is not a continuous wall-clock axis. Derive the displayed playback time from `hls.playingDate` or the fragment containing the current media position, carrying a fragment's program date time only across untagged adjacent fragments. Derive the live clock from the newest playlist fragment's wall-clock end, and seek Go Live using `hls.liveSyncPosition`.

**Why:** Camera playlists can contain holes and wall-clock jumps. First-program-date-time plus `currentTime` produces large timestamp and latency errors and can make catch-up logic seek backward.

**How to apply:** Keep program-date mapping fragment-aware, skip or recover short unbuffered holes, and reload at the live-sync position when playlist media sequence numbers move backward after a server restart.