---
name: Creative HLS window timeline
description: Preserve absolute recording time and byte-range offsets when serving a bounded HLS playlist.
---

When trimming a VOD playlist to a smaller window, treat the returned media timeline as zero-based but preserve the absolute recording offset separately. Convert every implicit byte-range offset in the selected segments to an explicit offset before removing earlier segments.

**Why:** The creative framer overlays ball/tracking data and clip boundaries on absolute recording timestamps; the HLS window starts at a local zero, and dropping earlier byte ranges changes how the browser reads the shared MP4.

**How to apply:** Return the first selected segment's absolute start with the windowed manifest, map video time back to recording time for seeking, looping, and overlays, and adjust the playlist media sequence when slicing.
