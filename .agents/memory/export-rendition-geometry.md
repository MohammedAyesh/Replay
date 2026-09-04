---
name: Export rendition geometry
description: Clip exports must select HLS variants by declared pixels and reject buffered files with the wrong decoded geometry
---

Select the Bunny HLS variant whose master playlist declares 3840x1080. Never infer geometry from rendition folder names or choose the highest available label.

**Why:** Bunny can place different dimensions behind the same folder label depending on the upload ladder; adaptive master selection can silently render crop keyframes against the wrong scale.

**How to apply:** Keep crop math and the buffered-file decoded-frame guard on the same 3840x1080 constants. If no matching variant exists, fail with the seen geometries instead of falling back to the master playlist or another rendition.