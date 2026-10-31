---
name: Single-fork Vitest mocks
description: Mock leakage risks in the API server's single-fork Vitest suite.
---

Avoid adding test files with broad module-level `vi.mock` declarations to the API suite. The Vitest configuration runs tests in a single fork, and a partial mock can affect another test file's import of the same module; this surfaced as an unrelated missing-export error in the route tests.

**Why:** A branding unit test mocked the FFmpeg and branding-planning modules. Another API test then received that partial FFmpeg mock without `getOutputDims`, failing in unrelated code.

**How to apply:** Prefer dependency injection into a narrowly scoped helper or spies scoped to an existing integration test. If a module must be mocked, preserve all real exports and verify the entire suite, not just that test file.
