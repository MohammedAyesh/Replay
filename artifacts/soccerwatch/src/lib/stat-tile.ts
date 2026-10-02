/**
 * The stat tile Home shows under "Your next match" (GET /me/matches
 * `statTile`). The server picks the most impressive tile for the player's
 * situation; this mirrors its shape (api-server/src/lib/homeStatTile.ts).
 */

export type TileMetric = "distanceKm" | "topSpeedKmh" | "touches" | "passesCompleted" | "dribblesWon" | "goals" | "shots";

type MatchBit = { code: string; startLocal: string; fieldName: string; players: number; watch: string | null };

export type StatTile =
  | { kind: "lastMatch"; match: MatchBit; metric: TileMetric; value: number; pitchAverage: number; claimed: number; secondary: Partial<Record<TileMetric, number>> }
  | { kind: "personalBest"; match: MatchBit; metric: TileMetric; value: number; previousBest: number; previousBestLocal: string; at: number | null; fasterAtField: number | null }
  | { kind: "rival"; fieldName: string; month: string; board: Array<{ rank: number; name: string; distanceKm: number; me: boolean }>; total: number; myRank: number; other: { name: string; distanceKm: number }; mine: number; perMatch: number; upcoming: { code: string; startLocal: string } | null }
  | { kind: "form"; metric: "distanceKm" | "topSpeedKmh" | "touches"; values: Array<{ startLocal: string; value: number }>; streak: number; latest: number; average: number; upcoming: { code: string; startLocal: string } | null }
  | { kind: "notFound"; match: MatchBit; findRecordingId: number; found: number; teaser: { metric: TileMetric; value: number } | null }
  | { kind: "passing"; match: MatchBit; completed: number; tried: number; rate: number; bestRate: boolean; pitchRate: number | null }
  | { kind: "touches"; match: MatchBit; total: number; firstIndex: number; blocks: number[]; busiest: { index: number; count: number }; everySeconds: number | null }
  | { kind: "distanceTotal"; fieldName: string | null; sinceLocal: string; latestLocal: string; matches: number; totalKm: number; perMatch: number[]; milestone: number; passed: boolean; matchesToGo: number }
  | { kind: "distanceSpells"; match: MatchBit; spells: number[]; strongest: number; finishedStrongest: boolean }
  | { kind: "ranks"; match: MatchBit; claimed: number; ranks: Array<{ metric: TileMetric; rank: number; value: number; of: number | null }> }
  | { kind: "style"; matches: number; touches: number; passes: number; dribbles: number; shots: number; other: number; lean: "passer" | "dribbler" | "shooter" | "allRounder" }
  | { kind: "challenge"; upcoming: { code: string; startLocal: string; fieldName: string }; metric: "passesCompleted" | "distanceKm" | "touches" | "dribblesWon"; target: number; average: number; best: number; scaleMax: number }
  | { kind: "dribbles"; match: MatchBit; won: number; lost: number; rank: number | null; leaderName: string | null }
  | { kind: "matchesPlayed"; dates: string[]; weekStarts: string[]; total: number; upcomingDate: string | null }
  | { kind: "shots"; match: MatchBit; shots: number; times: number[] }
  | { kind: "passingTrend"; rates: Array<{ startLocal: string; rate: number }> }
  | { kind: "teamShare"; match: MatchBit; mine: number; teamTotal: number; teammates: number[] }
  | { kind: "dribbleDuel"; match: MatchBit; me: { won: number; tries: number }; other: { name: string; won: number; tries: number } }
  | { kind: "week"; matches: number; distanceKm: number; touches: number; passesCompleted: number; passesTried: number; dribblesWon: number; dribbles: number; shots: number }
  | { kind: "friends"; match: MatchBit; findRecordingId: number; found: number; peers: Array<{ name: string; distanceKm: number | null; topSpeedKmh: number | null; shots: number | null; dribblesWon: number | null }> }
  | { kind: "unclaimed"; match: MatchBit; findRecordingId: number };

export type StatTileKind = StatTile["kind"];
