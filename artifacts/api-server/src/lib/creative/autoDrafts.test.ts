import { describe, expect, it } from "vitest";
import type { Scene, TemplateMeta } from "@workspace/api-zod";
import {
  callupCustom,
  draftTitle,
  groupOf,
  inFeed,
  isFinished,
  isoWeekKey,
  materializeDraft,
  originKey,
  parseOriginKey,
  planAutoDrafts,
  positionLabel,
  preferredStyle,
  shouldSync,
  styleFor,
  type WeekFacts,
} from "./autoDrafts";
import { confirmedGoalMoments, type SessionFacts } from "./sessionData";

const NOW = new Date("2026-11-02T09:00:00Z"); // Monday, noon in Amman

function match(id: number, startsAt: string, over: Partial<SessionFacts["session"]> = {}, rest: Partial<SessionFacts> = {}): SessionFacts {
  return {
    session: { id, type: "match", startsAt: new Date(startsAt), endsAt: null, location: "Galaxy", opponent: "Al-Wehdat", ownScore: null, opponentScore: null, squad: "U-12", ...over },
    academy: { name: "Galaxy Academy", nameAr: "أكاديمية جالكسي", phone: null, instagram: null },
    showNames: false,
    players: [],
    team: null,
    recording: null,
    goals: [],
    clips: [],
    ...rest,
  };
}

const players: SessionFacts["players"] = [
  { playerId: 1, name: "Ahmad Saleh", number: 9, stats: { goals: 2, minutes: 40, touches: 50 } },
  { playerId: 2, name: "Zaid Omar", number: 7, stats: { goals: 1, minutes: 40, touches: 30 } },
  { playerId: 3, name: "Yousef Ali", number: 4, stats: { goals: 0, minutes: 40, touches: 20 } },
];

// Monday morning's filmed training, nothing stood out in it.
const training: SessionFacts = {
  ...match(20, "2026-11-02T05:00:00Z", { type: "training", opponent: null }),
  recording: { id: 950, durationSeconds: 3600, videoStartSeconds: 0 },
};
const week: WeekFacts = { isoWeek: "2026-W45", training };

const sessions = [
  // Saturday's 3–0 win with two confirmed goals on the footage.
  match(10, "2026-10-31T15:00:00Z", { ownScore: 3, opponentScore: 0 }, {
    players,
    recording: { id: 900, durationSeconds: 3600, videoStartSeconds: 60 },
    goals: confirmedGoalMoments(900, [
      { atTenths: 3000, userId: 1, verdict: "goal" },
      { atTenths: 9000, userId: 2, verdict: "goal" },
    ], 60),
  }),
  // A 1–2 loss: no clean sheet, and goals we cannot tell were ours are left out.
  match(11, "2026-10-28T15:00:00Z", { ownScore: 1, opponentScore: 2, opponent: "Shabab" }, {
    goals: confirmedGoalMoments(901, [{ atTenths: 3000, userId: 1, verdict: "goal" }], 0),
  }),
  // Older than 14 days: nothing.
  match(12, "2026-10-10T15:00:00Z", { ownScore: 2, opponentScore: 0 }),
  // Played, no score entered yet: nothing until it is.
  match(13, "2026-11-01T15:00:00Z"),
  // Saturday's fixture.
  match(14, "2026-11-07T14:00:00Z", { opponent: "Ramtha" }),
  // Kicking off now: neither finished nor upcoming.
  match(15, "2026-11-02T08:30:00Z"),
];

describe("auto drafts: origin keys", () => {
  it("round-trips every key", () => {
    expect(parseOriginKey(originKey.fulltime(12))).toEqual({ kind: "fulltime", sessionId: 12 });
    expect(parseOriginKey(originKey.matchday(3))).toEqual({ kind: "matchday", sessionId: 3 });
    expect(parseOriginKey(originKey.goal("900-6050"))).toEqual({ kind: "goal", momentId: "900-6050" });
    expect(parseOriginKey(originKey.weekly("2026-W45"))).toEqual({ kind: "weekly", week: "2026-W45" });
    expect(parseOriginKey("fulltime:session:x")).toBeNull();
    expect(parseOriginKey(null)).toBeNull();
  });
});

describe("auto drafts: Amman calendar", () => {
  it("counts ISO weeks on Amman's calendar day", () => {
    expect(isoWeekKey(new Date("2026-11-01T20:00:00Z"))).toBe("2026-W44"); // Sunday 23:00 in Amman
    expect(isoWeekKey(new Date("2026-11-01T22:30:00Z"))).toBe("2026-W45"); // already Monday 01:30 in Amman
    expect(isoWeekKey(new Date("2026-12-31T22:30:00Z"))).toBe("2026-W53"); // Friday 1 Jan 2027 in Amman
  });

  it("treats a match with no end time as over 100 minutes after kick-off", () => {
    const s = { startsAt: new Date("2026-11-02T08:00:00Z"), endsAt: null };
    expect(isFinished(s, new Date("2026-11-02T09:39:00Z"))).toBe(false);
    expect(isFinished(s, new Date("2026-11-02T09:40:00Z"))).toBe(true);
  });
});

describe("auto drafts: planning", () => {
  const plans = planAutoDrafts({ now: NOW, sessions, week, existing: new Set() });
  const keys = plans.map((p) => p.originKey);

  it("plans the drafts recent and coming matches call for", () => {
    expect(keys.sort()).toEqual([
      "cleansheet:session:10",
      "fulltime:session:10",
      "fulltime:session:11",
      "goal:moment:900-3000",
      "goal:moment:900-9000",
      "matchday:session:14",
      "potm:session:10",
      "weekly:2026-W45",
    ]);
  });

  it("is idempotent: what exists (skipped included) is never planned again", () => {
    expect(planAutoDrafts({ now: NOW, sessions, week, existing: new Set(keys) })).toEqual([]);
    const skipped = new Set(["fulltime:session:10"]);
    const again = planAutoDrafts({ now: NOW, sessions, week, existing: skipped }).map((p) => p.originKey);
    expect(again).not.toContain("fulltime:session:10");
    expect(again).toHaveLength(keys.length - 1);
  });

  it("never plans the same key twice in one run", () => {
    const twice = planAutoDrafts({ now: NOW, sessions: [...sessions, ...sessions], week, existing: new Set() });
    expect(twice.map((p) => p.originKey).sort()).toEqual(keys.sort());
  });

  it("fills each draft's data, by shirt number when names are off", () => {
    const potm = plans.find((p) => p.kind === "potm")!;
    expect(potm.data.player).toMatchObject({ name: null, number: 9 });
    expect(potm.data.stats).toMatchObject({ goals: 2, potmGoals: 2 });
    expect(potm.title).toBe("نجم المباراة · ضد Al-Wehdat 3–0 · #9");
    expect(JSON.stringify(plans)).not.toContain("Saleh");
    const goal = plans.find((p) => p.originKey === "goal:moment:900-9000")!;
    expect(goal.data.media).toEqual({ type: "recording", recordingId: 900, fromMs: 954_000, toMs: 964_000 });
    const matchday = plans.find((p) => p.kind === "matchday")!;
    expect(matchday.data.match).toMatchObject({ opponent: "Ramtha", date: "السبت 7 تشرين الثاني", time: "17:00" });
    expect(matchday.data.match?.ownScore).toBeUndefined();
    const weekly = plans.find((p) => p.kind === "weekly")!;
    expect(weekly).toMatchObject({ templateKey: "training", sessionId: 20, title: "من تمرين الأسبوع · U-12" });
    expect(weekly.data.custom).toEqual({ headline: "من تمرين الأسبوع" });
    expect(weekly.data.media).toEqual({ type: "recording", recordingId: 950, fromMs: 300_000, toMs: 315_000 });
  });

  it("never credits the wrong player on a goal or a clean sheet", () => {
    // Two academy players scored: a goal clip names nobody.
    const goal = plans.find((p) => p.originKey === "goal:moment:900-3000")!;
    expect(goal.data.player).toBeUndefined();
    expect(plans.find((p) => p.kind === "cleansheet")!.data.player).toBeUndefined();
    // One player scored them all: the clip names him, by shirt number.
    const solo = match(30, "2026-10-31T15:00:00Z", { ownScore: 2, opponentScore: 0 }, {
      players: [players[0], { ...players[1], stats: { goals: 0, minutes: 40 } }],
      recording: { id: 960, durationSeconds: 3600, videoStartSeconds: 0 },
      goals: confirmedGoalMoments(960, [{ atTenths: 1000, userId: 1, verdict: "goal" }], 0),
    });
    const soloGoal = planAutoDrafts({ now: NOW, sessions: [solo], week: null, existing: new Set() }).find((p) => p.kind === "goal")!;
    expect(soloGoal.data.player).toEqual({ name: null, number: 9, squad: "U-12" });
    expect(soloGoal.title).toBe("هدف · ضد Al-Wehdat 2–0 · #9");
    const named = planAutoDrafts({ now: NOW, sessions: [{ ...solo, showNames: true }], week: null, existing: new Set() }).find((p) => p.kind === "goal")!;
    expect(named.data.player?.name).toBe("Ahmad");
  });

  it("makes no weekly draft without a filmed training", () => {
    const none = planAutoDrafts({ now: NOW, sessions: [], week: { isoWeek: "2026-W45", training: { ...training, recording: null } }, existing: new Set() });
    expect(none).toEqual([]);
  });

  it("titles drafts in their language", () => {
    expect(draftTitle("fulltime", sessions[0], "en")).toBe("Full time · vs Al-Wehdat 3–0");
    expect(draftTitle("matchday", sessions[4], "ar")).toBe("يوم المباراة · ضد Ramtha");
  });
});

describe("auto drafts: building rows", () => {
  const stillScene = (key: string): Scene => ({ v: 1, format: "post", background: "#0B0F1A", layers: [], template: { key, style: "street" }, locale: "ar" });
  const catalogue = {
    templates: [
      { key: "fulltime", category: "results", title: { en: "Full time", ar: "نهاية المباراة" }, kind: "image", formats: ["post"], fields: [] },
      { key: "goal", category: "results", title: { en: "Goal", ar: "هدف" }, kind: "video", formats: ["story"], fields: [] },
    ] as TemplateMeta[],
    build: (key: string): Scene => (key === "goal" ? { ...stillScene(key), format: "story", durationMs: 12_000 } : stillScene(key)),
  };
  const plans = planAutoDrafts({ now: NOW, sessions, week, existing: new Set() });

  it("makes an auto draft row with its origin key, a still using the moment's frame", () => {
    const row = materializeDraft(plans.find((p) => p.originKey === "fulltime:session:10")!, 5, "street", catalogue)!;
    expect(row).toMatchObject({ academyId: 5, origin: "auto", status: "draft", originKey: "fulltime:session:10", templateKey: "fulltime", style: "street", kind: "image", format: "post", sourceSessionId: 10 });
    expect(row.title).toBe("نهاية المباراة · ضد Al-Wehdat 3–0");
    // The best moment is the first goal (both have one vote): tracking 300 s + 60 s into the video.
    expect((row.data as { media: unknown }).media).toEqual({ type: "frame", recordingId: 900, atMs: 360_000 });
  });

  it("gives a video its moment's window", () => {
    const row = materializeDraft(plans.find((p) => p.originKey === "goal:moment:900-3000")!, 5, "street", catalogue)!;
    expect(row).toMatchObject({ kind: "video", format: "story" });
    expect((row.data as { media: unknown }).media).toEqual({ type: "recording", recordingId: 900, fromMs: 354_000, toMs: 364_000 });
  });

  it("waits for templates the catalogue does not have yet, and for broken ones", () => {
    expect(materializeDraft(plans.find((p) => p.kind === "potm")!, 5, "street", catalogue)).toBeNull();
    const broken = { ...catalogue, build: () => { throw new Error("no"); } };
    expect(materializeDraft(plans.find((p) => p.kind === "fulltime")!, 5, "street", broken)).toBeNull();
  });
});

describe("auto drafts: style, throttle and feed", () => {
  it("uses the academy's most used style, broadcast otherwise", () => {
    expect(preferredStyle([])).toBe("broadcast");
    expect(preferredStyle([{ style: "luxury", count: 2 }, { style: "street", count: 5 }, { style: null, count: 9 }])).toBe("street");
    expect(preferredStyle([{ style: "bogus", count: 9 }])).toBe("broadcast");
  });

  it("syncs at most once per ten minutes", () => {
    expect(shouldSync(undefined, 1000)).toBe(true);
    expect(shouldSync(0, 9 * 60_000)).toBe(false);
    expect(shouldSync(0, 10 * 60_000)).toBe(true);
  });

  it("keeps a matchday draft until kick-off and the week's schedule during its week", () => {
    const created = new Date("2026-11-01T09:00:00Z");
    expect(inFeed({ kind: "matchday", sessionId: 1 }, created, { startsAt: new Date("2026-11-07T14:00:00Z") }, NOW)).toBe(true);
    expect(inFeed({ kind: "matchday", sessionId: 1 }, created, { startsAt: new Date("2026-11-02T08:00:00Z") }, NOW)).toBe(false);
    expect(inFeed({ kind: "weekly", week: "2026-W45" }, created, null, NOW)).toBe(true);
    expect(inFeed({ kind: "weekly", week: "2026-W44" }, created, null, NOW)).toBe(false);
    expect(inFeed({ kind: "fulltime", sessionId: 1 }, new Date("2026-10-01T09:00:00Z"), null, NOW)).toBe(false);
    expect(inFeed({ kind: "fulltime", sessionId: 1 }, created, null, NOW)).toBe(true);
  });
});

describe("auto drafts: countdown, call-up, match stats and the pack style", () => {
  // Monday noon in Amman: Wednesday's fixture is 2 days away, Tuesday's is tomorrow.
  const wed = match(30, "2026-11-04T15:00:00Z", { opponent: "Faisaly" });
  const tue = match(31, "2026-11-03T15:00:00Z", { opponent: "Jazeera" }, { showNames: true });
  const analysed = match(32, "2026-11-01T10:00:00Z", { ownScore: 2, opponentScore: 1 }, {
    team: { touches: [300, 250], possessionPercent: [58, 42], shots: [14, 6], passesCompleted: [312, 200], dribblesWon: [9, 4], completionPercent: 81 } as unknown as SessionFacts["team"],
  });
  const squad = [
    { name: "Zaid Omar", number: 7, position: "forward" },
    { name: "Omar Khaled", number: 1, position: "Goalkeeper" },
    { name: "Ahmad Saleh", number: 4, position: "defender" },
  ];

  it("plans a countdown 2 days before, a call-up the day before (only with a squad), match stats after analysis", () => {
    const plans = planAutoDrafts({ now: NOW, sessions: [wed, tue, analysed], week: null, existing: new Set(), callups: new Map([[31, squad]]) });
    const keys = plans.map((p) => p.originKey).sort();
    expect(keys).toEqual([
      "callup:session:31", "countdown:session:30", "fulltime:session:32",
      "matchday:session:30", "matchday:session:31", "matchstats:session:32",
    ]);
    const countdown = plans.find((p) => p.kind === "countdown")!;
    expect(countdown).toMatchObject({ templateKey: "countdown", sessionId: 30, moment: null });
    expect(countdown.data.custom).toEqual({ days: "2" });
    expect(countdown.data.match).toMatchObject({ opponent: "Faisaly" });
    expect(countdown.data.match?.ownScore).toBeUndefined();

    const callup = plans.find((p) => p.kind === "callup")!;
    // Goalkeeper first, then shirt order; names shown because this academy allows them.
    expect(callup.data.custom).toEqual({ n1: "1", p1: "Omar", pos1: "حارس", n2: "4", p2: "Ahmad", pos2: "دفاع", n3: "7", p3: "Zaid", pos3: "هجوم" });
    expect(callup.title).toBe("قائمة الماتش · ضد Jazeera");

    const stats = plans.find((p) => p.kind === "matchstats")!;
    expect(stats.data.stats).toMatchObject({ possession: "58%", opponentPossession: "42%", shots: 14, passes: 312, passAccuracy: "81%", dribbles: 9 });
    expect(stats.data.media).toBeUndefined();

    // No squad picked: no call-up. A day further out: no countdown yet.
    const none = planAutoDrafts({ now: NOW, sessions: [tue], week: null, existing: new Set() }).map((p) => p.kind);
    expect(none).toEqual(["matchday"]);
    const early = planAutoDrafts({ now: new Date(NOW.getTime() - 86_400_000), sessions: [wed], week: null, existing: new Set() }).map((p) => p.kind);
    expect(early).toEqual(["matchday"]);
    // Stable keys: running again plans nothing.
    expect(planAutoDrafts({ now: NOW, sessions: [wed, tue, analysed], week: null, existing: new Set(keys), callups: new Map([[31, squad]]) })).toEqual([]);
  });

  it("hides names in the call-up when the academy hides them, and keeps 9 rows at most", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `Player ${i}`, number: 20 - i, position: "MF" }));
    const rows = callupCustom(many, false, "en");
    expect(Object.keys(rows)).toHaveLength(27);
    expect(rows.n1).toBe("9");
    expect(rows.p1).toBe("");
    expect(rows.pos1).toBe("MF");
    expect(positionLabel("Sweeper keeper", "en")).toBe("Sweeper keep");
    expect(positionLabel("cb", "ar")).toBe("دفاع");
  });

  it("parses the new origin keys, groups them and keeps fixture drafts until kick-off", () => {
    for (const kind of ["countdown", "callup", "matchstats"] as const) {
      expect(parseOriginKey(originKey[kind](5))).toEqual({ kind, sessionId: 5 });
    }
    expect([groupOf("countdown"), groupOf("callup"), groupOf("matchstats")]).toEqual(["upcoming", "upcoming", "after"]);
    expect(inFeed({ kind: "callup", sessionId: 1 }, NOW, { startsAt: new Date("2026-11-03T15:00:00Z") }, NOW)).toBe(true);
    expect(inFeed({ kind: "countdown", sessionId: 1 }, NOW, { startsAt: new Date("2026-11-01T15:00:00Z") }, NOW)).toBe(false);
  });

  it("builds the new templates into valid drafts", () => {
    const plans = planAutoDrafts({ now: NOW, sessions: [wed, tue, analysed], week: null, existing: new Set(), callups: new Map([[31, squad]]) });
    for (const kind of ["countdown", "callup", "matchstats"] as const) {
      const row = materializeDraft(plans.find((p) => p.kind === kind)!, 1, "broadcast");
      expect(row, kind).not.toBeNull();
      expect(row).toMatchObject({ templateKey: kind, origin: "auto", style: "broadcast" });
    }
  });

  it("defaults drafts to the academy's own pack, and never to a pack from usage counts", async () => {
    expect(await styleFor({ id: 1, creativePack: "iris" })).toBe("iris");
    expect(preferredStyle([{ style: "juventus", count: 9 }, { style: "street", count: 1 }])).toBe("street");
  });
});
