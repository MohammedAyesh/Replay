---
name: FFmpeg crop w/h expression evaluation
description: FFmpeg crop filter evaluates w/h expressions with t=NaN at init — not per-frame. if(lt(t,...)) zoom expressions never animate.
---

## Rule
Do NOT use `if(lt(t,...))` expressions in FFmpeg `crop` (or `crop@dyn`) for animated zoom.
The `w` and `h` parameters of FFmpeg's crop filter are evaluated **once during filter
initialization**, and `t` is `NaN` at that moment. Every `if(lt(t,...))` condition is
false, so the expression always resolves to the final else-branch value.

**Why:** Empirically verified on FFmpeg 7.1.1:
- `crop='if(lt(t,0.4),200,100)':100:0:0` on 200×100 source → ALL frames 100×100
- `crop='if(lt(t,9999),200,100)':100:0:0` → still ALL frames 100×100 (NaN < anything = false)

`x` and `y` ARE re-evaluated per-frame (they work correctly for pan animation).

**How to apply:** For dynamic zoom (changing crop width/height during encoding):
- Do NOT rely on `if(t,...)` or other `t`-dependent expressions in `w`/`h`
- `sendcmd` w/h changes are silently ignored in FFmpeg 7.1.1 (not stream-terminating — the
  memory note "silently terminates video" appears to reflect a different configuration or
  FFmpeg version; current behaviour is silent no-op for w/h changes)
- A correct approach requires either: (a) scale-then-fixed-crop with per-frame scale
  expressions, (b) per-segment rendering + concat, or (c) the `zoompan` filter (for
  still-to-video use cases)

## Impact discovered
`buildDimExpr` in `ffmpegExport.ts` generates `if(lt(t,...))` chains for crop `w`/`h`.
These chains never animate. Clip exports always use the **last zoomKf sample's
wpx/hpx** as the static crop size. For clips where the last keyframe has `w=0.5`
(zoom=1, full width), the crop is permanently 1920×1080 and zoom animation is absent.
`sendcmd` x/y are auto-clamped by FFmpeg to the valid range for the static crop width,
so no geometry errors or black bars occur — the output just lacks zoom.

This is a **pre-existing issue** that existed before Task #114. Task #114 correctly
fixed the black-space geometry violation bug; zoom animation being absent is separate.
