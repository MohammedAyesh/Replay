# TASK 4c — Friends polish

Applied the three browser-review fixes to SoccerWatch:

- Restored the original five bottom-navigation items and removed the unused Friends nav icon/copy. The invitation badge remains on My matches.
- Moved “Invite friends from Replay” directly below the match-card heading, ahead of the WhatsApp/Share row and the manual “Add a player without the app” control.
- Changed `/friends` for guests and signed-out visitors to show a short localized “Sign in to add friends” card with a Sign in link to `/sign-in?redirect_url=%2Ffriends`. Friend queries remain disabled for those visitors.

## Verification

- SoccerWatch typecheck passed.
- SoccerWatch tests passed: 29 files, 215 tests.
- Checked the signed-out `/friends` preview: the sign-in card rendered, with the five-item bottom navigation.

No database schema changes, database pushes, GitHub pushes, or publishing were performed.