import { describe, expect, it } from "vitest";
import {
  buildSessionData,
  lineupRows,
  clipMoment,
  confirmedGoalMoments,
  pickPlayerOfMatch,
  playerLabel,
  rankedMoments,
  scorerLine,
  teamStatsSummary,
  type SessionFacts,
  type SessionPlayerFacts,
} from "./sessionData";

const player = (playerId: number, name: string, number: number | null, stats: SessionPlayerFacts["stats"]): SessionPlayerFacts => ({ playerId, name, number, stats });

function facts(over: Partial<SessionFacts> = {}, session: Partial<SessionFacts["session"]> = {}): SessionFacts {
  return {
    session: {
      id: 41, type: "match", startsAt: new Date("2026-10-31T15:00:00Z"), endsAt: null, location: "Galaxy pitch 2",
      opponent: "Al-Wehdat", ownScore: 3, opponentScore: 0, squad: "U-12 Blue", ...session,
    },
    academy: { name: "Galaxy Academy", nameAr: "أكاديمية جالكسي", phone: "079 123 4567", instagram: "galaxy.academy" },
    showNames: false,
    players: [
      player(1, "Ahmad Saleh Haddad", 9, { goals: 2, minutes: 40, passesCompleted: 10, dribblesWon: 3, touches: 50, distanceKm: 3.4, topSpeedKmh: 21.4 }),
      player(2, "Zaid Omar", 7, { goals: 1, minutes: 38, passesCompleted: 6, dribblesWon: 1, touches: 41, distanceKm: 3.1 }),
      player(3, "Yousef Ali", 4, { goals: 0, minutes: 40, passesCompleted: 12, dribblesWon: 0, touches: 39, distanceKm: 3.9 }),
    ],
    team: null,
    recording: { id: 900, durationSeconds: 3600, videoStartSeconds: 120 },
    goals: [],
    clips: [],
    ...over,
  };
}

describe("creative session data: names", () => {
  it("labels a player by shirt number unless the academy allows names, then by first name only", () => {
    expect(playerLabel({ name: "Ahmad Saleh", number: 9 }, false)).toBe("#9");
    expect(playerLabel({ name: "Ahmad Saleh", number: 9 }, true)).toBe("Ahmad");
    expect(playerLabel({ name: "  ", number: 9 }, true)).toBe("#9");
    expect(playerLabel({ name: "Ahmad Saleh", number: null }, false)).toBeNull();
  });

  it("lists scorers most goals first, in the locale's separator", () => {
    const players = facts().players;
    expect(scorerLine(players, false, "en")).toBe("#9 ×2, #7");
    expect(scorerLine(players, true, "ar")).toBe("Ahmad ×2، Zaid");
  });

  it("never puts a name in the data when names are off, and only first names when on", () => {
    const hidden = buildSessionData(facts(), "en");
    const text = JSON.stringify(hidden);
    for (const part of ["Ahmad", "Saleh", "Haddad", "Zaid", "Omar", "Yousef"]) expect(text).not.toContain(part);
    expect(hidden.match?.scorers).toBe("#9 ×2, #7");
    expect(hidden.player).toMatchObject({ name: null, number: 9, squad: "U-12 Blue" });

    const shown = buildSessionData(facts({ showNames: true }), "en");
    expect(shown.player?.name).toBe("Ahmad");
    expect(JSON.stringify(shown)).not.toContain("Saleh");
    expect(JSON.stringify(shown)).not.toContain("Haddad");
  });
});

describe("creative session data: match facts", () => {
  it("dates and times the match in Amman, whatever the server's zone", () => {
    // 21:30 UTC on Saturday is 00:30 on Sunday in Amman (UTC+3).
    const data = buildSessionData(facts({}, { startsAt: new Date("2026-10-31T21:30:00Z") }), "en");
    expect(data.match?.date).toBe("SUN 1 NOV");
    expect(data.match?.time).toBe("00:30");
    const ar = buildSessionData(facts({}, { startsAt: new Date("2026-10-31T21:30:00Z") }), "ar");
    expect(ar.match?.date).toBe("الأحد 1 تشرين الثاني");
  });

  it("fills names, score, place and squad, in the asked language", () => {
    const en = buildSessionData(facts(), "en");
    expect(en.match).toMatchObject({ ownName: "Galaxy Academy", opponent: "Al-Wehdat", ownScore: 3, opponentScore: 0, place: "Galaxy pitch 2", squad: "U-12 Blue" });
    expect(en.academy).toMatchObject({ name: "Galaxy Academy", nameAr: "أكاديمية جالكسي", phone: "079 123 4567", instagram: "galaxy.academy" });
    expect(buildSessionData(facts(), "ar").match?.ownName).toBe("أكاديمية جالكسي");
  });

  it("leaves the score out of a fixture", () => {
    const data = buildSessionData(facts({ players: [], recording: null }, { ownScore: null, opponentScore: null }), "en");
    expect(data.match?.ownScore).toBeUndefined();
    expect(data.match?.scorers).toBeUndefined();
    expect(data.media).toBeUndefined();
  });

  it("summarises team stats the analysis measured", () => {
    expect(teamStatsSummary({
      touches: [300, 250], passesTried: [80, 60], passesCompleted: [60, 40], possessionPercent: [58.4, 41.6],
      completionPercent: 75, dribbles: [10, 8], dribblesWon: [6, 3], shots: [9, 4], goals: [3, 0],
    })).toEqual({ possession: "58%", opponentPossession: "42%", shots: 9, opponentShots: 4, passes: 60, opponentPasses: 40, touches: 300, opponentTouches: 250, dribbles: 6, opponentDribbles: 3, passAccuracy: "75%" });
    expect(teamStatsSummary(null)).toEqual({});
  });
});

describe("creative session data: player of the match", () => {
  it("is the leader on goals, then passes and dribbles", () => {
    expect(pickPlayerOfMatch(facts().players)?.playerId).toBe(1);
  });
  it("is nobody with fewer than three measured players", () => {
    expect(pickPlayerOfMatch(facts().players.slice(0, 2))).toBeNull();
  });
  it("is nobody when the top two are level", () => {
    const same = { goals: 1, minutes: 30, passesCompleted: 5, dribblesWon: 1, touches: 20, distanceKm: 2 };
    expect(pickPlayerOfMatch([player(1, "A", 1, same), player(2, "B", 2, same), player(3, "C", 3, { goals: 0, minutes: 30 })])).toBeNull();
  });
  it("leaves out players with a few minutes on camera", () => {
    const ps = [player(1, "A", 1, { goals: 3, minutes: 4 }), player(2, "B", 2, { goals: 1, minutes: 30 }), player(3, "C", 3, { goals: 0, minutes: 30 }), player(4, "D", 4, { goals: 0, minutes: 30, touches: 5 })];
    expect(pickPlayerOfMatch(ps)?.playerId).toBe(2);
  });
});

describe("creative session data: moments", () => {
  it("turns confirmed goal votes into recording windows, one per goal", () => {
    const votes = [
      { atTenths: 6000, userId: 1, verdict: "goal" as const },
      { atTenths: 6050, userId: 2, verdict: "goal" as const },
      { atTenths: 6050, userId: 3, verdict: "goal" as const }, // the same goal, 0.5 s later, more votes
      { atTenths: 9000, userId: 1, verdict: "not_goal" as const },
      { atTenths: 12000, userId: 1, verdict: "goal" as const },
    ];
    const moments = confirmedGoalMoments(900, votes, 120);
    expect(moments.map((m) => m.id)).toEqual(["900-6050", "900-12000"]);
    // 605 s of tracking + 120 s into the video.
    expect(moments[0]).toMatchObject({ recordingId: 900, atMs: 725_000, fromMs: 719_000, toMs: 729_000, weight: 2 });
  });

  it("shows goals only when they can only be ours, then members' clips", () => {
    const goal = confirmedGoalMoments(900, [{ atTenths: 6000, userId: 1, verdict: "goal" }], 120);
    const clip = clipMoment({ id: 5, recordingId: 900, startTime: 100, endTime: 140, score: 3 })!;
    expect(clip).toMatchObject({ fromMs: 100_000, toMs: 115_000 });
    expect(rankedMoments(facts({ goals: goal, clips: [clip] })).map((m) => m.id)).toEqual(["900-6000", "clip-5"]);
    expect(rankedMoments(facts({ goals: goal, clips: [clip] }, { opponentScore: 1 })).map((m) => m.id)).toEqual(["clip-5"]);

    const data = buildSessionData(facts({ goals: goal, clips: [clip] }), "en");
    expect(data.media).toEqual({ type: "recording", recordingId: 900, fromMs: 714_000, toMs: 724_000 });
    expect(data.more).toEqual([{ type: "recording", recordingId: 900, fromMs: 100_000, toMs: 115_000 }]);
  });

  it("falls back to a still of the footage when nothing stands out", () => {
    const data = buildSessionData(facts(), "en");
    expect(data.media).toEqual({ type: "frame", recordingId: 900, atMs: 420_000 });
  });
});

describe("creative session data: line-ups and player photos", () => {
  const squad = [
    { playerId: 11, name: "Omar Khaled", number: 7, position: "Forward" },
    { playerId: 12, name: "Yazan Ali", number: 1, position: "Goalkeeper" },
    { playerId: 13, name: "Karim Saleh", number: 4, position: "DF" },
  ];
  const pictures = new Map([[11, { cutout: true }], [12, { cutout: false }]]);

  it("fills rows goalkeeper first, then by shirt; with names allowed first names and each row's photo", () => {
    const rows = lineupRows(squad, true, "en", pictures);
    expect(rows.custom).toMatchObject({ n1: "1", p1: "Yazan", pos1: "GK", n2: "4", p2: "Karim", pos2: "DF", n3: "7", p3: "Omar", pos3: "FW" });
    expect(rows.photos).toEqual([{ type: "player", playerId: 12, cutout: false }, null, { type: "player", playerId: 11, cutout: true }]);
    expect(lineupRows(squad, true, "ar").custom.pos1).toBe("حارس");
  });

  it("withholds names and photos when the academy doesn't show names", () => {
    const rows = lineupRows(squad, false, "en", pictures);
    expect(rows.custom).toMatchObject({ n1: "1", p1: "", n3: "7", p3: "" });
    expect(rows.photos).toBeUndefined();
    expect(JSON.stringify(rows)).not.toMatch(/Omar|Yazan|Karim/);
  });

  it("puts the squad and photos in the session data only as the names rule allows", () => {
    const withPics = facts({ squad, pictures, showNames: true, players: [...facts().players.map((p, i) => ({ ...p, playerId: 11 + i }))] });
    const on = buildSessionData(withPics, "en");
    expect(on.custom?.p1).toBe("Yazan");
    expect(on.photos?.[0]).toEqual({ type: "player", playerId: 12, cutout: false });
    // Player of the match (most goals: playerId 11) carries his own cut-out.
    expect(on.player?.photo).toEqual({ type: "player", playerId: 11, cutout: true });
    const off = buildSessionData({ ...withPics, showNames: false }, "en");
    expect(off.photos).toBeUndefined();
    expect(off.player?.photo).toBeUndefined();
    expect(off.custom?.p1).toBe("");
    expect(off.custom?.n1).toBe("1");
  });
});
