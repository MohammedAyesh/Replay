---
name: SoccerWatch build environment
description: Required environment values for validating the SoccerWatch frontend build outside its workflow.
---

The SoccerWatch Vite build intentionally requires both `PORT` and `BASE_PATH`; the workflow supplies them, while direct shell builds must provide them explicitly.

**Why:** Running the package build without those values fails while loading the Vite config, before compilation starts.

**How to apply:** Use the artifact workflow for normal validation or provide the project port and `/soccerwatch` base path for a direct production build.