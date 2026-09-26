# TASK 4b — Friends app UI

Implemented the Friends experience in the existing SoccerWatch app in English and Arabic, using the Replay dark semantic colors and RTL-aware layout.

## Delivered

- Added `/friends` with Friends, Requests, and Suggestions tabs; friend search; request accept/decline/cancel; remove-friend menu; empty and error states; and a shareable friend link with confirmed reset.
- Added public `/f/:code` friend-link pages with player identity, own-link and already-friends states, signed-in acceptance, and sign-up return handling. Pending links are stored in session storage for up to one hour and accepted once after sign-up.
- Added reusable friend actions to player profiles and post-match rosters. Roster actions are hidden for guests, the current player, and existing friends.
- Added the Replay friends invite sheet to match pages. It searches friends, disables roster members, limits selection to 30, invites through the existing endpoint, and offers the existing match WhatsApp invite text after successful invitations. Manual player invitations remain available.
- Added Friends navigation and the account invitations badge, a Friends entry on Matches and in account settings, and inviter details/status in existing invitation cards and RSVP.
- Suggestions now include the count of recent shared matches. No database schema changes were made.

## Verification

- SoccerWatch typecheck passed.
- SoccerWatch tests passed: 29 files, 215 tests.
- API server typecheck passed.
- API server tests passed: 57 files, 744 tests.