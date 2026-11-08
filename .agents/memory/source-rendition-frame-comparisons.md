---
name: Source rendition frame comparisons
description: Comparing Stream and camera-original HLS frames at identical source times.
---

For cross-rendition frame comparisons, align both sources by the requested source-time window through their normal production readers; do not treat PTS from manually concatenated TS segments as playlist-relative time. For crop rectangles, apply the renderer's aspect, source-bound clamping, and even-pixel rules independently to each resolution rather than scaling one rectangle blindly.

**Why:** The Stream transport stream and camera-original HLS can have different timestamp origins, and portrait crops can hit different source bounds. A manual seek can select another moment, and nominal crop sizes can vary slightly from the raw 4096/3840 ratio.

**How to apply:** Build equivalent source-time windows first, then sample identical clip-relative offsets and report actual source-pixel rectangles and explicit metric color format.
