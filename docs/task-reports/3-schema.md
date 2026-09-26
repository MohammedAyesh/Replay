# TASK 3-schema — Report, Block, and Friends schema

## Schema changes

- Added `content_reports` and `user_blocks` for Report & Block.
- Added `friendships` for Friends.
- Added nullable `users.friend_code` with a named unique constraint.
- Added nullable typed `user_clips.hidden_reason`.
- Exported both new schema modules from `lib/db/src/schema/index.ts`.
- No routes, UI, or application behavior were added.

## Files changed

- `lib/db/src/schema/safety.ts` — new reports and blocks tables and inferred types.
- `lib/db/src/schema/friends.ts` — new friendships table and inferred type.
- `lib/db/src/schema/users.ts` — nullable `friendCode` and named unique constraint.
- `lib/db/src/schema/userClips.ts` — nullable `hiddenReason`.
- `lib/db/src/schema/index.ts` — exports `safety` and `friends`.

## Verification

- `pnpm run typecheck` — passed across all packages.
- `pnpm --filter @workspace/api-server run test` — **not fully passing against the current database**: 31 of 55 files passed; 24 failed because the test database does not yet have `users.friend_code`. The run reported 389 passed and 343 skipped tests. Existing test inserts use the expanded Drizzle `usersTable` and therefore reference the new column even though application features do not use it yet.
- No database push was run. After the owner applies the manual schema change, rerun the full API suite; this task has not verified that post-push run.

## Owner: apply the schema manually

Run this exact command in an **interactive Shell tab**:

```sh
pnpm --filter db run push
```

The wrapper is deprecated and will say the push is not recorded in `lib/db/migrations/`. It prints the target database host and then asks:

> Type yes to push schema changes to the database above, or anything else to abort:

Confirm that the displayed host is the intended database, then type exactly `yes`. Any other input aborts without making changes. Do not use `push-force`.

## Expected Drizzle changes

The requested schema delta is additive. Expect Drizzle to create:

- **Three tables:** `content_reports`, `user_blocks`, and `friendships`.
- **Two nullable columns:** `users.friend_code` and `user_clips.hidden_reason`.
- **Named unique constraints:** `content_reports_reporter_target_unique`, `friendships_pair_unique`, and `users_friend_code_unique`.
- **Five ordinary indexes:** `content_reports_status_created_at_idx`, `content_reports_target_type_id_idx`, `user_blocks_blocked_id_idx`, `friendships_user_low_id_idx`, and `friendships_user_high_id_idx`.
- Primary keys and user foreign keys with the requested delete behavior.

No drop or rename is expected from these declared changes alone. I did not run Drizzle against the live database, so its complete diff is unverified. The documented push wrapper is deprecated and may encounter live-schema drift, including legacy columns that are not represented in current code. If Drizzle proposes **any drop or rename**, abort instead of accepting it; preserve the unrelated legacy object and review the diff before trying again.

## Scope confirmations

- No database push or schema mutation was performed.
- No publish/deployment or GitHub push was performed.