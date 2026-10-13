---
name: Follow-ball smoothing
description: Constraints for camera-path filtering and speed limits.
---

Keep follow-ball smoothing time-symmetric. A causal dead zone introduced visible lag around direction changes, and averaging independent forward and backward speed limits can exceed the configured per-step cap.

**Why:** The camera must follow ball motion without a directional delay while respecting a hard pan-speed ceiling.

**How to apply:** When changing the filter, test mirrored step motion, adjacent-frame speed limits, and stationary detector wiggle suppression together.
