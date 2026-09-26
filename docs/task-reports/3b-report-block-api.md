# TASK 3b — Report & Block API

## Implemented

- Added the shared block lookup helpers. `blockedUserIdsFor` returns both directions of a block and treats a missing `user_blocks` relation as an empty set, with one warning per process.
- Added authenticated report submission and block management routes:
  - Reports validate clip/user targets, reject self-reports and duplicates, enforce a 20-report rolling 24-hour per-user limit, and auto-hide clips for nudity reports or three open reports from distinct reporters.
  - Blocks reject self/guest targets, remove follows in both directions and the friendship pair in one transaction, and support listing and unblocking.
- Added admin open/history report queues and transactional resolution actions: dismiss, hide, unhide, remove from clip, and disable user. Disabling an administrator is rejected.
- Added block-aware filtering to the public feed, match clip list, profile/replay-profile, follow, like, and clip share-link routes. Match rosters remain unchanged.
- Added hidden-reason serialization to user clip responses and the OpenAPI `UserClip` schema. Admin clip hiding now sets `hiddenReason` to `admin`; unhiding clears it.
- Added integration coverage in `artifacts/api-server/src/routes/safety.test.ts` for report limits, auto-hide, block cleanup and filtering, moderation actions, and hidden-reason behavior.

## Verification

- `pnpm --filter @workspace/api-spec run codegen` — passed.
- `pnpm run typecheck` — passed.
- `pnpm --filter @workspace/api-server run typecheck` — passed after the test updates.
- `pnpm --filter @workspace/soccerwatch run test` — passed: 26 files, 200 tests.
- `pnpm --filter @workspace/api-server run test` — **blocked by the pending TASK 3-schema database push**. The shared test database reports `column "friend_code" of relation "users" does not exist`; 25 of 56 files failed during fixture setup, while 31 files passed (389 tests passed, 347 skipped). The new safety integration suite also stops during fixture setup at the same missing column, before it can exercise the safety tables.
- No database push or other database mutation was performed. The `content_reports`, `user_blocks`, and `friendships` tables were not verified by this test run; rerun the API suite after the owner applies the schema push.