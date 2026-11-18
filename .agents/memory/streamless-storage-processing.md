---
name: Streamless Storage source rules
description: Rendition selection, authorization, and timing rules for streamless Storage processing and match-room playback.
---

For server-side recording reads, segment fetches, posters, and FFmpeg cuts of streamless Storage footage, select `/vod/<guid>/h264.m3u8` first and use `/4k.m3u8` only when the H.264 playlist is missing. Never use `/8k.m3u8` for processing. H.264 and 4K share the recording's zero-based timeline, so preserve existing card and video offsets.

For a match-room full recording, use direct CDN 4K by default, allow direct H.264 as the compatibility fallback, and do not use the owner-share proxy or 8K. Expose those direct URLs only after confirming the share token and match code refer to the same active Storage booking.

**Why:** H.264 is the lighter server decode source while keeping the required 3840×1080 geometry; changing source clocks would move saved moments. Room playback is intentionally different: direct 4K avoids proxy overhead while keeping the match code and share token tied together.

**How to apply:** Resolve the stored recording URL at each processing boundary. Keep cache identity and already-cut files unchanged. Keep the room's direct-playback authorization separate from general owner-share playback.
