# TASK 3c — Report & Block, App UI

## Implemented

- Added typed React Query safety API hooks for reporting, blocking, unblock/list, and admin report review. Block/unblock refresh the feed, match room and clips, affected player/replay profiles, and the viewer's block list.
- Added English and Arabic safety copy, clip/user-specific report reasons, the report sheet, and the report/block menu with guest handling and confirmation.
- Added report controls to other players' match clips and signed-in player profiles. Blocking from a profile returns to the previous page, or `/matches` when there is no history entry.
- Added blocked-profile states with an unblock action when the viewer blocked the player, plus `/account/blocked` with avatars, dates, empty/loading/error states, and unblock actions.
- Added hidden-clip notices to My Clips for removal requests, reports, and admin-hidden clips; moved the Private badge label into English/Arabic strings.
- Added the English admin Reports tab with open/history queues, open-count badge, poster and match links, moderation actions, confirmations, toasts, and refreshes.
- Added helper tests for report reason availability, error messages in both locales, and hidden-notice selection.

## Files changed

- `artifacts/soccerwatch/src/lib/safety-api.ts` (new)
- `artifacts/soccerwatch/src/i18n/safety-strings.ts` (new)
- `artifacts/soccerwatch/src/lib/safety-helpers.test.ts` (new)
- `artifacts/soccerwatch/src/components/safety/ReportSheet.tsx` (new)
- `artifacts/soccerwatch/src/components/safety/SafetyMenu.tsx` (new)
- `artifacts/soccerwatch/src/components/admin/ReportsTab.tsx` (new)
- `artifacts/soccerwatch/src/pages/blocked-players.tsx` (new)
- `artifacts/soccerwatch/src/App.tsx`
- `artifacts/soccerwatch/src/i18n/strings.ts`
- `artifacts/soccerwatch/src/pages/account.tsx`
- `artifacts/soccerwatch/src/pages/admin.tsx`
- `artifacts/soccerwatch/src/pages/match.tsx`
- `artifacts/soccerwatch/src/pages/my-clips.tsx`
- `artifacts/soccerwatch/src/pages/profile.tsx`

## Verification

- The owner-applied 3-schema is present. Full API suite, run before UI implementation and again after it: **56 test files passed; 736 tests passed**.
- `pnpm --filter @workspace/soccerwatch run test` — **27 test files passed; 211 tests passed**.
- `pnpm run typecheck` — passed, including workspace libraries, API server, and SoccerWatch.
- `git diff --check` — passed.
- The SoccerWatch web workflow restarted cleanly. The preview session was a guest, so `/account/blocked` correctly redirected to `/account`; the authenticated-only blocked list and admin Reports screen could not be visually inspected in that session.
- No requested work remains incomplete.
- No publish, GitHub push, or database push was performed.