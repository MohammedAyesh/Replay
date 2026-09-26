# TASK 4a — Friends API

## Implemented

- Added authenticated friends list, incoming/outgoing request, request acceptance/decline/cancellation, and removal endpoints. Guests receive 401 on private routes.
- Friend pairs are stored with the lower user ID in `user_low_id` and the higher in `user_high_id`. New requests enforce 30 outgoing requests per rolling 24 hours and a maximum of 100 pending outgoing requests. Mutual requests auto-accept.
- Added user eligibility checks for guest, disabled, and deleted-player placeholder accounts, plus block checks in both directions for requests, acceptances, and link acceptance.
- Added 8-character friend codes using the requested alphabet, collision-safe creation/reset, public profile lookup, and immediate friendship acceptance through a friend link.
- Added suggestions from shared match rosters created within the last 60 days. Suggestions require both players to be `in` or `maybe` and omit existing friendships, blocked users, guests, disabled accounts, and the deleted-player placeholder.
- Added `POST /m/:code/invite-friends`. Captains, field owners, admins, and playing roster members can invite accepted friends; blocked IDs reject the whole request, while existing roster members and non-friends are reported as skipped.
- `/api/me/matches` now returns account-bound invited rows under `invites`, with the inviter’s name and avatar, instead of listing them in `upcoming` or `live`. The original inviter can delete an account-bound invitation before the invitee responds. Joining updates the existing roster row and preserves current first-in captain behavior.
- Updated English and Arabic account-deletion copy to retain only “VAR review flags”. The deletion page shows “Open Account” only for a signed-in non-guest account and “Sign in” otherwise.
- Added route and match-invitation integration tests. No schema, migration, or OpenAPI changes were made.

## Verification

- `pnpm --filter @workspace/api-server run test` — passed: 57 files, 744 tests.
- `pnpm --filter @workspace/api-server typecheck` — passed.
- `pnpm --filter @workspace/soccerwatch typecheck` — passed.
- No database push, publish, or GitHub push was performed.