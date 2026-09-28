---
name: HLS player callback lifecycle
description: Why callbacks passed to HLS players need stable identities and async setup work must stop on teardown.
---

When a player setup effect depends on callback props, callers should pass stable callbacks (or the player should keep callback refs) so ordinary parent state updates do not destroy and recreate the HLS instance. Async media-capability checks may finish after teardown; they must not update a destroyed HLS controller.

**Why:** An unstable playback callback caused repeated HLS remounts, and a late quality-cap result reached the destroyed level controller and threw at runtime.

**How to apply:** Memoize HLS event handlers at call sites when appropriate, and mark quality-cap work disposed on both effect cleanup and the HLS `DESTROYING` event.