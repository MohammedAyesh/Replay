---
name: Creative render source versions
description: How to keep completed Creative Hub renders from bypassing newer camera-source requirements.
---

A Creative Hub render is publishable only when its stored output path identifies the current render/source version. Keep the output path, publication gate, and Instagram autopilot's stale-render query in sync when the source policy changes.

**Why:** Rendered files do not record which source produced them. A completed pre-change render can otherwise be reused by manual or automated publishing without reading the required camera original.

**How to apply:** For future Creative Hub render-source changes, version the output path and require old completed outputs to be rerendered before publication.
