---
name: Cartographer and generic JSX
description: A SoccerWatch Vite preview quirk where Cartographer metadata injection breaks explicit generic arguments on JSX components.
---

When Replit Cartographer instruments JSX in the SoccerWatch Vite preview, it inserts `data-replit-metadata` and `data-component-name` after a component identifier. Explicit type arguments written directly in JSX, such as `<PillToggle<"rate" | "total">`, can then become invalid before Babel parses them, even though TypeScript accepts the original source.

**Why:** A typed generic component compiled under `tsc` but caused a Vite 500 in the preview because instrumentation split the JSX tag from its type arguments.

**How to apply:** Prefer inferred prop types or move generic specialization outside JSX. If inference widens a callback parameter, guard the value to the intended union. Restart the Vite workflow and confirm the transformed page loads.