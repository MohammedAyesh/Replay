Use FREE MODE for this task.

Restyle the player page (/players/:id, artifacts/soccerwatch/src/pages/profile.tsx) to match the attached reference file `player-page-reference.html` and the attached screenshot. This is a UI-only change. Do not change any API calls, queries, mutations, handlers, routes, feature flags or the shared components FriendButton, SafetyMenu and StatsBetaNote (use them as they are). Do not touch the app header bar or the bottom navigation. Keep the brand tokens (void, surface, raised, line, text, muted, floodlight, violet, turf) and fonts (Cairo for Arabic headings, Tajawal for Arabic body, Rajdhani for numbers). Arabic is RTL; English is the same layout mirrored, using start/end, never left/right. Every tap target is at least 44px. The loading, not-found and blocked screens keep their current logic (restyle only if needed to match the tokens).

The reference shows two states side by side: someone else's page with data, and your own page with no data.

TOP BAR (unchanged behaviour): sticky; round back button, the player's name in muted text, and the SafetyMenu "⋯" button only when a signed-in user views someone else's page.

1. PLAYER CARD (one card, 24px radius, turf border at 35%, dark turf-to-surface gradient, faint pitch lines behind at ~18% opacity, no dot)
- Row: avatar 84px with a turf-to-violet gradient ring (photo if avatarUrl, otherwise initials; no camera badge), then the name (Cairo 22px, one line with ellipsis), then a line with a Floodlight pill for the position and the age ("25 سنة").
- Position label: use the same translated label the account page uses. If none exists, map goalkeeper/defender/midfielder/forward to حارس/مدافع/وسط/مهاجم (Goalkeeper/Defender/Midfielder/Forward in English) and fall back to the raw value. Hide the pill if there is no position; hide the age if there is no age.
- A 2-column grid of six numbers (Rajdhani 26px, short label beside each), separated by thin lines:
  - top speed = stats.measured.totals.topSpeedKmh, 1 decimal (label "سرعة" / "km/h")
  - distance = stats.totals.totalDistanceMetres / 1000, 2 decimals (label "كم" / "km")
  - goals = stats.measured.totals.goals
  - passes = stats.measured.totals.passesCompleted
  - touches = stats.measured.totals.touches
  - dribbles = stats.measured.totals.dribbles, else stats.totals.dribbles.total
- Bottom row inside the card, divided by a thin line: clips, followers, following, each with its Violet icon and number.

2. BUTTONS under the card
- Someone else's page: two equal buttons in one row. FriendButton as it is (Floodlight), and Follow/Unfollow using the existing handleFollow: violet tint (violet at 16% fill, violet border at 50%), bell-plus icon for Follow, keep the current Unfollow icon/label when following.
- Your own page: replace the buttons with one dashed-border line: "هاي صفحتك. هيك بيشوفها الناس" / "This is your page. It's what others see."
- Under that: StatsBetaNote.

3. "الماتشات" (Matches): the match record (useReplayProfile)
- Heading "الماتشات" / "Matches", subtitle "سجلّه ونتايجه على ريبلاي" / "His record and results on Replay" (own page: "سجلّك ونتايجك على ريبلاي" / "Your record and results on Replay").
- Three equal boxes: played, wins (Turf number), man of the match (Floodlight crown + number). Reuse the existing played / wins / motmShort strings.
- Timeline of the recent matches (data.recent, up to 6, same as today), like the ماتشاتي page timeline: date column at the start side (day number big, month name under it, from startLocal, Western digits), then a vertical line with a ring per match (Floodlight ring if he was man of the match, otherwise Turf), then a card linking to /m/{code} with: field name (Rajdhani), crown if motm, and at the end the score (dir="ltr", "5–3") plus ربحنا/خسرنا (existing won/lost copy, Turf for won, muted for lost). If there is no score show "بدون نتيجة" / "No score" in dim text. Weekday under the field name.
- This section is now ALWAYS shown (today it is hidden when matchesPlayed is 0). With no matches: the boxes show 0 and the timeline shows one dashed note: "لسا ما في ماتشات. لما تنضم لماتش على ريبلاي بيظهر هون." / "No matches yet. When you join a match on Replay it shows up here." (someone else's page: "لسا ما في ماتشات على ريبلاي." / "No matches on Replay yet.").

4. HEAT MAP + TOTALS (two tiles side by side), then the MINUTES BAR
- Heat map tile ("خريطة الحركة", existing heatmap string): draw a small pitch (pitch lines on a dark turf background) and the 12×8 cells as soft glowing circles (Floodlight centre fading to Turf), size and opacity from cell.weight. Keep the role="img" aria-label.
  - Combined map (aggregatePitchHeatmaps) when it exists.
  - If shouldShowPerMatchHeatmaps is true: empty pitch plus a small line "كل ماتش إله خريطته تحت" / "Each match has its own map below", and the maps go inside the match rows (section 5).
  - No data: empty pitch lines.
- Totals tile: confirmed matches, minutes played, km run (1 decimal), label on the start side and number on the end side. Reuse the existing matchesClaimed / totalMinutes / totalDistance strings.
- Minutes bar card: title "دقايق الماتشات المأكّدة" / "Minutes in confirmed matches"; one 8px bar split Turf (human-vouched minutes) and Violet (inferred minutes) in proportion; under it the two values with coloured dots and the existing humanVouched / inferred labels. With 0 and 0 the bar is an empty grey track.

5. "أرقامه بكل ماتش" (match by match), from stats.matches
- Heading "أرقامه بكل ماتش" / "His numbers, match by match" (own page: "أرقامك بكل ماتش" / "Your numbers, match by match"), subtitle = existing statsSubtitle.
- If excludedClaimCount > 0: a small violet pill at the end of the heading with the existing awaitingReview(n) text, and keep the existing awaitingReviewDesc line under the heading.
- Each claimed match is an expandable card (first one open): summary shows match.title (Rajdhani, dir ltr), the date, and the minutes at the end ("52.3 د") with a chevron. Inside, a 3-column grid of small dark cells: distance, top speed, goals, shots, passes ("12 من 17" using passesOf), touches, dribbles (from the match report, or the claim's dribbles when the report has none), human-vouched minutes, inferred minutes. Under the grid: the existing off-pitch line when offPitchSeconds > 0, and the per-match heat map when per-match maps are on.
- After them, OtherMeasuredMatches in the same card style, with the existing otherMatches label.
- No confirmed matches:
  - your own page with the claim flag on: a centred card with a Turf target icon, the existing noConfirmedTitle, noConfirmedDesc and a Floodlight pill button with viewClaimFlow linking to /claim/demo (the reference wording is illustrative; keep the existing strings);
  - otherwise: a quiet card with the existing noConfirmedOther text.

ZEROS RULE (important): never hide a number because there is no data. If the player has not played, has no confirmed matches, or a figure was not measured, show it as 0 in the same place: top speed 0.0, km 0.00 in the card and 0.0 in the totals, every count 0, the match-row cells 0. This replaces today's behaviour of leaving unmeasured tiles out and showing "Unavailable" for distance. Exceptions: while the stats are loading, show "–" in the card and totals (no flash of zeros); if the stats request fails, show "–" and the existing statsLoadFailed message in section 5.

Remove the old blocks this replaces: the centred avatar/name/position/age block, the old 3-stat row, the "own profile" text line, the old MatchRecord card, and the old player-stats-section layout (total grid, unavailable grid, trust grid, aggregate heatmap card). Their data now lives in the sections above. Delete any CSS that becomes unused.

Add every new string to the i18n files in both English and Arabic (Ammani wording as written above). Numbers use Rajdhani and dir="ltr".

When done, check and report:
- someone else's page with data, and your own page with no data, look like the two phones in the reference, in Arabic and English;
- Follow/Unfollow, the friend button, the ⋯ menu, the back button, timeline links to /m/{code} and the /claim/demo link all still work;
- a brand-new account shows zeros everywhere, not empty gaps;
- a player with camera-coordinate matches shows the maps inside the match rows;
- nothing changed in the header bar or the bottom navigation.
