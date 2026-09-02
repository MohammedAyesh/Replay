---
name: Calibrated player metrics
description: Rules for deriving player distance and heatmaps from tracking bundles
---

Use only a bundle-supplied pitch calibration for metre-based distance. Map each detection using the box's bottom centre, interpolate within the calibration grid, and smooth the mapped position track before summing. If calibration is absent or invalid, return distance as unavailable rather than estimating from pixel height or image movement.

**Why:** Pixel-scale estimates drift over a full match and produce confidently wrong distances; the bottom centre is the closest available ground-contact proxy.

**How to apply:** Keep minutes and heatmaps available from confirmed tracking intervals; gate distance on a valid pitch model and describe it as an approximate camera-tracking result.