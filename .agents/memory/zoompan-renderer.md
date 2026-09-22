---
name: Zoompan renderer geometry
description: Constraints for animating crop zoom and pan with FFmpeg zoompan on the wide source canvas.
---

## Rule

For animated crop exports, map the wide source onto an aspect-matched working canvas before supersampled `zoompan`; keep long generated filter graphs in a temporary filter-script file rather than a process argument.

**Why:** `zoompan` samples an input window, so a raw panoramic source distorts the crop. Supersampling reduces integer pan stepping, while filter scripts avoid OS argument-size limits on long keyframe paths.

**How to apply:** Derive zoom from the same interpolated width curve used by geometry validation, keep pan and window bounds inside the working canvas, and clean the script on every render outcome.

When branding is enabled, read the multi-keyframe crop graph back from its filter-script file before wrapping it in the overlay graph. The inline filter string is intentionally empty for script-backed zoompan exports.

**Why:** Passing the empty inline string into the branding wrapper produced `[0:v]` followed by an empty filter and FFmpeg failed with `No such filter: ''`.

**How to apply:** Build the overlay `filter_complex` from the script contents for multi-keyframe crops; keep the standalone crop script cleanup in the same render lifecycle.