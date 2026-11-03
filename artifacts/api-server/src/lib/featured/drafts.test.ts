import { describe, expect, it } from "vitest";
import { inFeed, groupOf, originKey, parseOriginKey, planAutoDrafts, materializeDraft } from "../creative/autoDrafts";
import { confirmedGoalMoments, type SessionFacts } from "../creative/sessionData";
import type { FeaturedFacts } from "./drafts";
import { attendanceStreak } from "./draftFacts";

const NOW = new Date("2026-11-02T09:00:00Z"); // Monday, noon in Amman
const DAY = 86_400_000;

function match(id: number, startsAt: string, rest: Partial<SessionFacts> = {}, over: Partial<SessionFacts["session"]> = {}): SessionFacts {
  return {
    session: { id, type: "match", startsAt: new Date(startsAt), endsAt: null, location: "Galaxy", opponent: "Al-Wehdat", ownScore: 3, opponentScore: 0, squad: "U-12", ...over },
    academy: { name: "JUFA", nameAr: "جوفا", phone: null, instagram: null },
    showNames: true,
    players: [],
    team: null,
    recording: { id: 900 + id, durationSeconds: 3600, videoStartSeconds: 0 },
    goals: [],
    clips: [],
    ...rest,
  };
}

// #9 scores every week; #7 and #4 rarely do. #11 has no consent.
const players: SessionFacts["players"] = [
  { playerId: 1, name: "Ahmad Saleh", number: 9, stats: { goals: 2, minutes: 40, touches: 60, dribblesWon: 1 } },
  { playerId: 2, name: "Zaid Omar", number: 7, stats: { goals: 0, minutes: 40, touches: 30, dribblesWon: 4 } },
  { playerId: 3, name: "Yousef Ali", number: 4, stats: { goals: 1, minutes: 40, touches: 20, dribblesWon: 0 } },
  { playerId: 4, name: "Karim Nasser", number: 11, stats: { goals: 3, minutes: 40, touches: 80, dribblesWon: 5 } },
];

function featured(over: Partial<FeaturedFacts> = {}): FeaturedFacts {
  return {
    consent: new Set([1, 2, 3]),
    lastSolo: new Map<number, Date | null>([[1, new Date(NOW.getTime() - 3 * DAY)], [2, new Date(NOW.getTime() - 40 * DAY)], [3, new Date(NOW.getTime() - 20 * DAY)]]),
    showNames: true,
    roster: [
      { playerId: 1, name: "Ahmad Saleh", number: 9, position: "FW", squad: "U-12", picture: { cutout: true } },
      { playerId: 2, name: "Zaid Omar", number: 7, position: "MF", squad: "U-12", picture: null },
      { playerId: 3, name: "Yousef Ali", number: 4, position: "DF", squad: "U-12", picture: { cutout: false } },
      { playerId: 4, name: "Karim Nasser", number: 11, position: "FW", squad: "U-12", picture: { cutout: true } },
    ],
    history: [
      // Zaid's own earlier matches: 1 dribble won each time. Yousef had never scored.
      { playerId: 2, sessionId: 5, startsAt: new Date("2026-10-10T15:00:00Z"), stats: { dribblesWon: 1, touches: 28, goals: 0 } },
      { playerId: 2, sessionId: 6, startsAt: new Date("2026-10-17T15:00:00Z"), stats: { dribblesWon: 1, touches: 31, goals: 0 } },
      { playerId: 3, sessionId: 6, startsAt: new Date("2026-10-17T15:00:00Z"), stats: { goals: 0, touches: 25 } },
      { playerId: 1, sessionId: 6, startsAt: new Date("2026-10-17T15:00:00Z"), stats: { goals: 3, touches: 70 } },
    ],
    streaks: new Map([[1, 3], [2, 12], [3, 9], [4, 30]]),
    ...over,
  };
}

const saturday = match(10, "2026-10-31T15:00:00Z", {
  players,
  goals: confirmedGoalMoments(910, [{ atTenths: 3000, userId: 1, verdict: "goal" }], 0),
  squad: players.map((p) => ({ playerId: p.playerId, name: p.name, number: p.number, position: null })),
});

describe("every child appears: drafts", () => {
  const plans = planAutoDrafts({ now: NOW, sessions: [saturday], week: { isoWeek: "2026-W45", training: null }, existing: new Set(), locale: "en", featured: featured(), weekSessions: [saturday] });
  const byKind = (k: string) => plans.filter((p) => p.kind === k);

  it("player of the match goes to whoever waited longest, not the top scorer, and never to a child without consent", () => {
    const potm = byKind("potm")[0];
    // Zaid (40 days) over Yousef (20) and Ahmad (3); Karim scored three but has no consent.
    expect((potm.data.player as { playerId: number }).playerId).toBe(2);
    expect(potm.data.player?.name).toBe("Zaid");
    expect(potm.title).toContain("Zaid");
  });

  it("leaves a child without consent out of the scorer line, the line-up rows and the goal clip", () => {
    const full = byKind("fulltime")[0];
    expect(full.data.match?.scorers ?? "").not.toContain("11");
    expect(full.data.player).toBeUndefined();
    expect(Object.values(full.data.custom ?? {})).not.toContain("11");
    for (const g of byKind("goal")) expect(g.data.player?.number ?? null).not.toBe(11);
  });

  it("most improved compares a child only with his own earlier matches", () => {
    const imp = byKind("improved");
    expect(imp).toHaveLength(1);
    expect((imp[0].data.player as { playerId: number }).playerId).toBe(2);
    expect(imp[0].data.stats).toEqual({ value: 4, label: "Dribbles won" });
    expect(imp[0].data.custom?.since).toBe("4 dribbles won, his best yet");
    expect(imp[0].originKey).toBe("improved:session:10");
  });

  it("a child's first goal ever gets its own post, once", () => {
    const first = byKind("firstgoal");
    // Yousef: first goal. Ahmad scored before. Karim: no consent.
    expect(first.map((f) => (f.data.player as { playerId: number }).playerId)).toEqual([3]);
    expect(first[0].originKey).toBe("firstgoal:player:3");
    const again = planAutoDrafts({ now: NOW, sessions: [saturday], week: null, existing: new Set(["firstgoal:player:3"]), locale: "en", featured: featured() });
    expect(again.some((p) => p.kind === "firstgoal")).toBe(false);
  });

  it("the week brings meet the player, an attendance streak and the moment of the week", () => {
    // Meet: Zaid waited longest.
    expect((byKind("meet")[0].data.player as { playerId: number }).playerId).toBe(2);
    // Streak ≥ 8 among consented children: Zaid (12) and Yousef (9) — Zaid waited longer. Karim's 30 doesn't count without consent.
    const streak = byKind("streak")[0];
    expect((streak.data.player as { playerId: number }).playerId).toBe(2);
    expect(streak.data.custom?.streak).toBe("12");
    const moment = byKind("weekmoment")[0];
    expect(moment.data.media).toMatchObject({ type: "recording", recordingId: 910 });
    expect(moment.originKey).toBe("weekmoment:2026-W45");
  });

  it("every new draft builds a real scene from its template", () => {
    for (const plan of plans) expect(materializeDraft(plan, 1, "jufa"), plan.kind).not.toBeNull();
  });

  it("without the feature facts, drafts are made as before", () => {
    const old = planAutoDrafts({ now: NOW, sessions: [saturday], week: { isoWeek: "2026-W45", training: null }, existing: new Set(), locale: "en" });
    expect(old.some((p) => ["improved", "firstgoal", "meet", "streak", "weekmoment"].includes(p.kind))).toBe(false);
  });

  it("parses, groups and expires the new origin keys", () => {
    expect(parseOriginKey(originKey.improved(10))).toEqual({ kind: "improved", sessionId: 10 });
    expect(parseOriginKey(originKey.firstgoal(3))).toEqual({ kind: "firstgoal", playerId: 3 });
    expect(parseOriginKey(originKey.meet("2026-W45"))).toEqual({ kind: "meet", week: "2026-W45" });
    expect(parseOriginKey(originKey.streak("2026-W45"))).toEqual({ kind: "streak", week: "2026-W45" });
    expect(parseOriginKey(originKey.weekmoment("2026-W45"))).toEqual({ kind: "weekmoment", week: "2026-W45" });
    expect(groupOf("meet")).toBe("week");
    expect(groupOf("improved")).toBe("after");
    expect(inFeed(parseOriginKey("meet:2026-W45"), NOW, null, NOW)).toBe(true);
    expect(inFeed(parseOriginKey("meet:2026-W44"), NOW, null, NOW)).toBe(false);
  });
});

describe("attendance streak", () => {
  it("counts present and late back to the last absence; excused neither breaks nor adds", () => {
    expect(attendanceStreak(["present", "late", "excused", "present", "absent", "present"])).toBe(3);
    expect(attendanceStreak(["absent", "present"])).toBe(0);
    expect(attendanceStreak([])).toBe(0);
  });
});
