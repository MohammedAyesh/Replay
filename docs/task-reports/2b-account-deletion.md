# Task 2b — Account deletion safety and interface

Completed 2026-09-26.

## Changes

- Self-service deletion now rejects administrator accounts and field owners before calling Clerk. Active footage checks include `awaiting_payment` for both self-service and admin deletion.
- Added per-user self-delete throttling (three attempts per hour), machine-readable error reasons, and a last-active-admin guard for admin deletion. Admin deletion attempts are serialized within the API process to protect the guard against concurrent requests handled by that process.
- The deletion transaction removes user-scoped `settings_rules`. After commit, account cleanup makes a best-effort, path-validated Bunny Storage deletion for the saved avatar.
- Removed the reserved deleted-player placeholder from both admin user listings.
- Updated the OpenAPI contract and regenerated the React API client and Zod types.
- Added a bilingual, RTL-aware account deletion confirmation dialog in Account settings. It requires `DELETE` or `حذف`, maps server reasons to English or Arabic destructive toasts, clears cached data on success, signs out, and shows a success toast on the landing page.
- Added the public `/delete-account` page with localized deletion and retention details, links to Account and sign-in, and support-contact behavior. The page is public, uses the legal-document layout width, and does not change the privacy policy copy.
- Added frontend unit tests for confirmation parsing and every deletion error reason, plus API tests for blockers, rate limiting, retained data cleanup, avatar cleanup, admin safeguards, and placeholder visibility.

## Files

- API: `artifacts/api-server/src/lib/accountDeletion.ts`, `src/lib/bunny.ts`, `src/routes/account.ts`, `src/routes/admin.ts`, and `src/routes/accountDeletion.test.ts`.
- Frontend: `artifacts/soccerwatch/src/App.tsx`, `src/components/layout.tsx`, `src/i18n/legal-strings.ts`, `src/pages/account.tsx`, `src/pages/login.tsx`, `src/pages/delete-account.tsx`, and `src/lib/account-deletion.ts` with its test.
- Contract and generated outputs: `lib/api-spec/openapi.yaml`, `lib/api-client-react/src/generated/api.ts`, `lib/api-client-react/src/generated/api.schemas.ts`, and generated Zod types under `lib/api-zod/src/generated/types/`.

## Verification

- OpenAPI code generation and library typecheck: passed (`pnpm --filter @workspace/api-spec run codegen`, including `pnpm -w run typecheck:libs`).
- API server typecheck: passed.
- SoccerWatch typecheck: passed.
- Full API server suite: **732 tests passed across 55 files**.
- Full SoccerWatch suite: **200 tests passed across 26 files**.
- `git diff --check`: passed.
- Visually checked `/delete-account` at a 402×874 mobile viewport in Arabic. Restarted API and SoccerWatch workflows; both came up successfully.
- No pre-existing test failures were identified.

## Scope confirmations

- No database schema change or database push.
- No publish/release, GitHub push, or deployment.