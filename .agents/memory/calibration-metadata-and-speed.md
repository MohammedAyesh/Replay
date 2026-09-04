---
name: Calibration metadata and guarded speed metrics
description: Bundle-owned pitch calibration metadata and the safety rules for player speed metrics.
---

The pitch model is frozen inside the tracking bundle that uses it. New models must carry a stable calibration identifier, fit timestamp, and source aspect ratio; aliases may be accepted at ingest but storage and responses use one canonical shape. A model with missing metadata or incompatible framing is invalid for distance and speed rather than silently falling back.

**Why:** Calibration values are only meaningful for the crop and framing they were fitted against, and a fast-looking number is worse than an explicit unavailable result when tracking quality is uncertain.

**How to apply:** Keep aspect-ratio validation at both bundle ingest and deliberate admin attach/replace. Compute average speed as calibrated distance divided by confirmed presence. Compute top speed only from direct near-pitch samples using rolling one-second windows with speed, acceleration, gap, and far-third exclusions; expose it only through an admin-gated surface and label it unvalidated.