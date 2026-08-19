---
name: Zoompan renderer geometry
description: Constraints for animating crop zoom and pan with FFmpeg zoompan on the wide source canvas.
---

## Rule

For animated crop exports, map the wide source onto an aspect-matched working canvas before supersampled `zoompan`; keep long generated filter graphs in a temporary filter-script file rather than a process argument.

**Why:** `zoompan` samples an input window, so a raw panoramic source distorts the crop. Supersampling reduces integer pan stepping, while filter scripts avoid OS argument-size limits on long keyframe paths.

**How to apply:** Derive zoom from the same interpolated width curve used by geometry validation, keep pan and window bounds inside the working canvas, and clean the script on every render outcome.