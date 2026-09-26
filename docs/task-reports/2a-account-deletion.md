# TASK 2a — Backend self-service account deletion

**Date:** 2026-09-26  
**Status:** Implemented and verified

## Delivered

- Added authenticated `DELETE /api/account` for real accounts; guest and unauthenticated sessions cannot use self-service deletion.
- Routed `DELETE /api/admin/users/:id` through the same deletion service.
- Blocks deletion when the account has queued, running, scheduled, or recording owner-footage requests, and rechecks inside the database transaction.
- Deletes the Clerk identity before changing local data. A Clerk failure returns an error without local database changes. If the local transaction fails after Clerk deletion, the local account is disabled and the failure is logged.
- In one transaction, removes the account and user-generated clips, clears saved clips, follows, likes, and ad-account associations, and decrements denormalized like counts for surviving legacy and user clips.
- Retains footage requests, cancellation requests, payment records, VAR marks, and stat-unlock history by reassigning their user references to a disabled `Deleted player` placeholder. Amounts, statuses, footage links, references, and review state are preserved.
- Removes Bunny export and poster assets after the database transaction; external cleanup failures are logged without undoing the local deletion.
- Added the endpoint contracts to OpenAPI and regenerated the client and Zod API types.

## Unique-constraint handling

- The placeholder is found or created inside the transaction. Creation uses conflict-safe insertion, then verifies that any conflicting row is the expected disabled system account.
- `stat_unlocks.reference` remains unchanged and unique; `user_id` is not unique, so multiple historical unlock rows can reference the placeholder.
- Cancellation-request uniqueness is on `footage_request_id`; deletion only changes `requested_by`, so that unique key is unaffected.

## Changed files

- `artifacts/api-server/src/lib/accountDeletion.ts` (new shared deletion service)
- `artifacts/api-server/src/lib/bunny.ts`
- `artifacts/api-server/src/lib/clerkUserBridge.ts`
- `artifacts/api-server/src/routes/account.ts`
- `artifacts/api-server/src/routes/admin.ts`
- `artifacts/api-server/src/routes/accountDeletion.test.ts` (new integration tests)
- `lib/api-spec/openapi.yaml`
- `lib/api-client-react/src/generated/api.schemas.ts`
- `lib/api-client-react/src/generated/api.ts`
- `lib/api-zod/src/generated/api.ts`
- `lib/api-zod/src/generated/types/index.ts`
- `lib/api-zod/src/generated/types/accountDeletionResponse.ts` (generated)

## Verification

- `pnpm --filter @workspace/api-spec run codegen` — passed.
- `pnpm run typecheck:libs` — passed.
- `pnpm --filter @workspace/api-server run typecheck` — passed.
- `pnpm --filter @workspace/api-server exec vitest run src/routes/accountDeletion.test.ts` — 1 file and all 6 tests passed.
- `pnpm --filter @workspace/api-server run test` — 55 files and all 724 tests passed.
- `git diff --check` — passed.
- Restarted `artifacts/api-server: API Server`; build completed and the service started. `GET /api/healthz` through the shared proxy returned `200 {"status":"ok"}`.

## Scope and release confirmations

- No database schema changes, migrations, or database push.
- No publish or GitHub push.
- No VPS, live-capture, archive, or payment workflow changes. VAR and payment records are only reassigned to the disabled placeholder as part of preserving history during account deletion.