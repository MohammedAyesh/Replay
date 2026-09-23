---
name: Replay visual tokens
description: Replay Signal System color semantics and the boundary between UI tokens and video legibility scrims.
---

Replay's visual language uses Floodlight for the one primary action on a screen, Violet for secondary save/commit actions, Turf for ready and active states, Muted for pending progress, and Surface + Line for errors and neutral destructive controls. Live red is reserved for live/recording badges, dots, and timers; it is not a button color.

**Why:** Red buttons and mixed status palettes made actions read as alerts instead of controls, while video controls need translucent black/white scrims for legibility over footage.

**How to apply:** Use Replay CSS variables or their semantic utility classes for app surfaces and controls. Keep translucent black/white only inside media overlays and checkerboard/asset previews when changing them would reduce contrast or transparency visibility.