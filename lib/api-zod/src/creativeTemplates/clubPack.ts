import type { CreativeData, CreativeFormat, MediaSource, Scene } from "../creativeScene";
import { Ctx as Canvas, crest, ellipse, image, rect, type Box, type Ctx, type Locale, type Timing } from "./kit";
import { FIELD_KIT, FIELD_TIMING, countData, type PackSkin } from "./fieldPack";
import { playerTiles, type TileLook } from "./players";
import type { Content } from "./content";

/**
 * Academies' template pack (Mohammed, 2026-11-04: "make new branding for academies the same way
 * you did for fields"). The field pack's look, with an academy's words: the crest, the main colour
 * (@primary, @on-primary on it) on the dark @ink, the academy's name, phone and registration line
 * through {{bindings}}. Video templates run the same sequence: an opening card, a wipe in the
 * main colour, the clip with its tag, then the end card over the softened clip.
 *
 * Children: a player is his shirt number. The disc on a player card holds the number, and the
 * name line is "#10" unless the academy shows names (the editor's starting data decides, see
 * templates/data.ts). Nothing here names an academy.
 *
 * Unlike the field pack these are in every academy's Creative hub, under "Academy pack".
 */

export const CLUB_STYLE = "club" as const;

export type ClubTemplateKey =
  | "club-goal"
  | "club-fulltime"
  | "club-matchday"
  | "club-lineup"
  | "club-potm"
  | "club-award"
  | "club-top5"
  | "club-week"
  | "club-milestone"
  | "club-trial"
  | "club-scorers"
  | "club-versus"
  | "club-versus-story"
  | "club-nominee-slide"
  | "club-nominees-cover";

type ClubDef = {
  key: ClubTemplateKey;
  title: { en: string; ar: string };
  formats: CreativeFormat[];
  build: (c: Ctx) => number | undefined;
  sample: (ar: boolean) => CreativeData;
};

const { PAPER, C, when, text, withSkin, backdrop, pill, header, bookingBand, footage, onClip, endCard, wipe, layouts } = FIELD_KIT;

// ── The Souqar look, in each academy's own colours ──────────────────────────
//
// Mohammed, 2026-11-05: "I want it to be souqar style". The brand deck of Sports iN Souqar
// (pack-souqar.ts): every match under floodlights. A night-stadium plate tinted in the academy's
// main colour behind a dark scrim, floodlight sparkles at the top, heavy white Montserrat capitals
// with a glow in the main colour, silver for the metal (rings, rules, labels, the REPLAY mark),
// clean white pills with dark words, and the accent colour only on the score.

const WHITE = "#F3F6FF";
const SILVER = "#C9CED6";

function souqarStage(c: Ctx, id: string, t: Timing) {
  const all: Box = { x: 0, y: 0, w: c.W, h: c.H };
  rect(c, `${id}-sky`, all, { ...t, gradient: { from: "@primary", to: "@ink" }, name: "bleed" });
  const plate = image(c, `${id}-plate`, { type: "artwork", key: "bg/stadium/2" }, all, { ...t, fit: "cover", name: "bleed" });
  (plate as { tint?: unknown }).tint = { color: "@primary", mode: "color" };
  rect(c, `${id}-tint`, all, { ...t, fill: "@ink", opacity: 0.5, name: "bleed" });
  rect(c, `${id}-scrim`, all, { ...t, gradient: { from: "#0000001A", to: "#000000C7" }, name: "bleed" });
  rect(c, `${id}-scrim-top`, { x: 0, y: 0, w: c.W, h: c.T + 260 }, { ...t, gradient: { from: "#00000080", to: "#00000000" }, name: "bleed" });
  const spots: Array<[number, number, number, number]> = [[0.86, 0.05, 14, 0.55], [0.93, 0.12, 6, 0.5], [0.7, 0.09, 5, 0.4], [0.08, 0.16, 8, 0.4], [0.18, 0.07, 5, 0.35]];
  spots.forEach(([fx, fy, d, o], i) => ellipse(c, `${id}-flare-${i + 1}`, { x: Math.round(c.W * fx), y: Math.round(c.T * 0.4 + c.H * fy * 0.6), w: d, h: d }, { ...t, fill: WHITE, opacity: o, mirror: false }));
}

export const CLUB_SKIN: PackSkin = {
  pill: WHITE, onPill: "@ink", hi: WHITE, onHi: "@ink", accent: WHITE, metal: SILVER,
  family: { display: "Montserrat", body: "Inter", arabic: "Cairo" },
  glow: "@primary",
  backdrop: souqarStage,
};
const MAIN = SILVER;

const STORY: CreativeFormat[] = ["story"];
const STORY_POST: CreativeFormat[] = ["story", "post"];
const POST_STORY: CreativeFormat[] = ["post", "story"];

// ── Layouts of its own ──────────────────────────────────────────────────────

/**
 * Full time: the result on the opening card (the academy on the left of the score, which reads
 * left to right in Arabic too), then a moment of the match, then the end card.
 */
function fullTime(c: Ctx) {
  const intro = 3200;
  const D = 15000;
  const endAt = D - FIELD_TIMING.end;
  footage(c, "video", { startMs: intro, blurFrom: endAt });
  onClip(c, "clip", { startMs: intro + 300, endMs: endAt }, { tag: C("kicker"), headline: C("headline"), meta: C("meta") });
  const t = { startMs: 0, endMs: intro };
  backdrop(c, "open-bg", t);
  const s = c.pick(190, 160, 220);
  const top = Math.round(c.T + Math.max(0, (c.B - c.T - c.pick(900, 800, 1060)) / 2));
  crest(c, "open-crest", { x: (c.W - s) / 2, y: top, w: s, h: s }, { startMs: 80, endMs: intro, enter: "pop", mirror: false });
  pill(c, "open-kicker", C("kicker"), top + s + c.pick(44, 36, 60), { startMs: 300, endMs: intro, enter: "slide-up" });
  const ry = top + s + c.pick(170, 150, 210);
  const nameH = c.pick(80, 72, 92);
  text(c, "open-own", C("ownName"), { x: c.M, y: ry, w: c.CW * 0.42, h: nameH }, {
    startMs: 450, endMs: intro, enter: "fade", size: c.pick(44, 40, 52), weight: 900, color: PAPER, align: "center", fit: true, mirror: false,
  });
  text(c, "open-opp", C("opponent"), { x: c.M + c.CW * 0.58, y: ry, w: c.CW * 0.42, h: nameH }, {
    startMs: 450, endMs: intro, enter: "fade", size: c.pick(44, 40, 52), weight: 900, color: PAPER, align: "center", fit: true, mirror: false,
  });
  c.only(when("score"), () => text(c, "open-score", C("score"), { x: c.M, y: ry + nameH + 10, w: c.CW, h: c.pick(250, 220, 300) }, {
    startMs: 600, endMs: intro, enter: "pop", size: c.pick(250, 220, 300), weight: 900, font: "display", color: "@accent", align: "center", num: true, fit: true, mirror: false,
    shadow: { color: "#000000B3", blur: 30, x: 0, y: 6 },
  }));
  c.only(when("meta"), () => text(c, "open-meta", C("meta"), { x: c.M + 40, y: ry + nameH + c.pick(290, 256, 340), w: c.CW - 80, h: 70 }, {
    startMs: 1200, endMs: intro, enter: "fade", size: c.pick(32, 30, 36), weight: 600, color: PAPER, align: "center", bg: { color: "#FFFFFF1F", padding: 18, radius: 999 },
  }));
  wipe(c, "wipe", intro);
  endCard(c, "end", endAt, D);
  return D;
}

/** Matchday (a still): the opponent big, then the day, the kick-off and the place, then the band. */
function matchday(c: Ctx) {
  backdrop(c, "bg");
  header(c, "head", {});
  const top = c.T + c.pick(150, 140, 220);
  pill(c, "kicker", C("kicker"), top, { align: "start", w: c.CW * 0.5 });
  text(c, "vs", C("vsLine"), { x: c.M, y: top + c.pick(100, 92, 116), w: c.CW, h: c.pick(60, 54, 70) }, { size: c.pick(44, 40, 50), weight: 800, color: MAIN });
  text(c, "title", C("opponent"), { x: c.M, y: top + c.pick(160, 148, 190), w: c.CW, h: c.pick(150, 130, 180) }, { size: c.pick(120, 104, 140), weight: 900, font: "condensed", color: PAPER, fit: true });
  const rowsTop = top + c.pick(350, 320, 420);
  const rowH = c.pick(120, 100, 150);
  for (let i = 1; i <= 3; i++) {
    c.only(when(`d${i}`), () => {
      const y = rowsTop + (i - 1) * (rowH + 18);
      rect(c, `row-${i}`, { x: c.M, y, w: c.CW, h: rowH }, { fill: "#FFFFFF14", radius: 28 });
      text(c, `row-${i}-l`, C(`l${i}`), { x: c.M + 34, y: y + rowH * 0.28, w: c.CW * 0.34, h: rowH * 0.44 }, { size: rowH * 0.26, weight: 700, color: MAIN, fit: true });
      text(c, `row-${i}-d`, C(`d${i}`), { x: c.M + c.CW * 0.36, y: y + rowH * 0.2, w: c.CW * 0.6, h: rowH * 0.6 }, { size: rowH * 0.36, weight: 900, color: PAPER, align: "end", fit: true });
    });
  }
  c.only(when("note"), () => text(c, "note", C("note"), { x: c.M, y: rowsTop + 3 * (rowH + 18) + 6, w: c.CW, h: 60 }, { size: c.pick(32, 30, 36), weight: 600, color: PAPER, opacity: 0.85 }));
  bookingBand(c, "band", {});
  return undefined;
}

/** The pack's player tile: a soft panel, the photo (a cut-out or a card), the number, a bar in the main colour. */
const CLUB_TILE: TileLook = {
  backdrop: (c, id, b) => { rect(c, id, b, { fill: "#FFFFFF14", stroke: { color: SILVER, width: 2 }, radius: 26 }); },
  bar: (c, id, b) => { rect(c, id, b, { fill: WHITE, radius: 18 }); },
  num: { font: "display", color: WHITE, weight: 900, shadow: { color: "@primary", blur: 30, x: 0, y: 0 } },
  name: { font: "display", color: "@ink", weight: 900 },
  pos: { font: "body", color: "@ink", weight: 700 },
  shadow: "#000000",
  cardRadius: 20,
  gap: 16,
  text: (c, id, value, b, o) => text(c, id, value, b, o),
};

/**
 * Line-up / call-up (a still): a tile per player. With photos (an academy that shows names, each
 * child whose family agreed: data.photos) the player stands in his tile; without, his shirt number
 * fills it. Names only when the academy shows them; otherwise the bar carries the position.
 */
function lineup(c: Ctx, n: number) {
  backdrop(c, "bg");
  header(c, "head", {});
  const top = c.T + c.pick(130, 120, 190);
  pill(c, "kicker", C("kicker"), top, { align: "start", w: c.CW * 0.56 });
  // The match's own opponent (a session's facts), so a real line-up never says the sample's.
  text(c, "title", c.ar ? "ضد {{match.opponent}}" : "vs {{match.opponent}}", { x: c.M, y: top + c.pick(92, 84, 110), w: c.CW, h: c.pick(110, 96, 130) }, { size: c.pick(92, 80, 108), weight: 900, font: "condensed", color: PAPER, fit: true });
  c.only([{ path: "match.date" }], () => text(c, "when", "{{match.date}} · {{match.time}}", { x: c.M, y: top + c.pick(204, 184, 246), w: c.CW, h: c.pick(52, 46, 58) }, { size: c.pick(32, 30, 36), weight: 700, color: MAIN }));
  const gridTop = top + c.pick(272, 246, 326);
  const band = c.pick(104, 96, 112);
  const k = { rows: Array.from({ length: n }, (_, i) => [`{{custom.n${i + 1}}}`, `{{custom.p${i + 1}}}`, `{{custom.pos${i + 1}}}`] as [string, string, string]) } as Content;
  // A story is tall: three across gives each child a bigger tile.
  playerTiles(c, k, { x: c.M, y: gridTop, w: c.CW, h: c.B - band - 30 - gridTop }, c.format === "story" ? { ...CLUB_TILE, cols: 3 } : CLUB_TILE);
  bookingBand(c, "band", {});
  return undefined;
}

// ── Catalogue ───────────────────────────────────────────────────────────────

const art = (key: string): MediaSource => ({ type: "artwork", key: `sample/${key}` });
const sampleCommon = () => ({ academy: { name: "Your academy", nameAr: "أكاديميتكم", phone: "07 9000 0000" } });
const endBits = (ar: boolean) => ({
  endLine: ar ? "سجّل ابنك، وكل تمرين بيتصوّر" : "Join us: every session is filmed",
  endBig: "07 9000 0000",
  endSmall: ar ? "أول تمرين مجاني" : "First session free",
  bookLine: ar ? "سجّل هلأ · أول تمرين مجاني" : "Join now · first session free",
  field: ar ? "أكاديميتكم" : "Your academy",
});

const CLUB_DEFS: ClubDef[] = [
  {
    key: "club-goal", title: { en: "Goal!", ar: "جول!" }, formats: STORY,
    build: layouts.bookingClip,
    sample: (ar) => ({ ...sampleCommon(), media: art("goal-clip"), custom: {
      ...endBits(ar), kicker: ar ? "تحت 12" : "U12", title: ar ? "جووول!" : "Goal!", headline: ar ? "جووول!" : "Goal!", meta: ar ? "ضد الوحدات · السبت" : "vs Wehdat · Saturday",
    } }),
  },
  {
    key: "club-fulltime", title: { en: "Full time", ar: "نهاية الماتش" }, formats: STORY,
    build: fullTime,
    sample: (ar) => ({ ...sampleCommon(), media: art("goal-clip"), custom: {
      ...endBits(ar), kicker: ar ? "نهاية الماتش" : "Full time", ownName: ar ? "أكاديميتكم" : "Us", opponent: ar ? "الوحدات" : "Wehdat", score: "3–1",
      headline: ar ? "فوز حلو!" : "Great win!", meta: ar ? "تحت 12 · دوري الأكاديميات" : "U12 · Academy league",
    } }),
  },
  {
    key: "club-matchday", title: { en: "Matchday", ar: "يوم الماتش" }, formats: STORY_POST,
    build: matchday,
    sample: (ar) => ({ ...sampleCommon(), custom: {
      ...endBits(ar), kicker: ar ? "يوم الماتش" : "Matchday", vsLine: ar ? "تحت 12 ضد" : "U12 vs", opponent: ar ? "الوحدات" : "Wehdat",
      l1: ar ? "اليوم" : "Day", d1: ar ? "السبت 8 تشرين الثاني" : "Sat 8 Nov", l2: ar ? "البداية" : "Kick-off", d2: ar ? "5:00 م" : "5:00 PM", l3: ar ? "المكان" : "Where", d3: ar ? "ملعبنا · ملعب 1" : "Home · Pitch 1",
      note: ar ? "تعالوا شجّعونا" : "Come and cheer us on",
    } }),
  },
  {
    key: "club-lineup", title: { en: "Line-up", ar: "التشكيلة" }, formats: POST_STORY,
    build: (c) => lineup(c, 7),
    sample: (ar) => ({ ...sampleCommon(), match: { opponent: ar ? "الوحدات" : "Wehdat", date: ar ? "السبت 8 تشرين الثاني" : "Sat 8 Nov", time: ar ? "5:00 م" : "5:00 PM" }, custom: {
      ...endBits(ar), kicker: ar ? "تشكيلة اليوم" : "Starting line-up",
      ...Object.fromEntries(([[1, "GK"], [4, "DF"], [5, "DF"], [8, "MF"], [10, "MF"], [7, "FW"], [9, "FW"]] as const).flatMap(([num, pos], i) => [
        [`n${i + 1}`, String(num)], [`p${i + 1}`, ""], [`pos${i + 1}`, ar ? ({ GK: "حارس", DF: "دفاع", MF: "وسط", FW: "هجوم" } as Record<string, string>)[pos] : pos],
      ])),
    } }),
  },
  {
    key: "club-potm", title: { en: "Player of the match", ar: "نجم الماتش" }, formats: STORY,
    build: layouts.playerCard,
    sample: (ar) => ({ ...sampleCommon(), media: art("goal-clip"), custom: {
      ...endBits(ar), kicker: ar ? "نجم الماتش" : "Player of the match", title: "#10", initials: "10",
      ...countData("stat", 8.4, 1), statLabel: ar ? "تقييم ريبلاي" : "Replay rating", meta: ar ? "تحت 12 · ضد الوحدات" : "U12 · vs Wehdat",
      s1v: "2", s1l: ar ? "أهداف" : "Goals", s2v: "1", s2l: ar ? "أسيست" : "Assists", s3v: "3.8", s3l: ar ? "كم ركض" : "km run", s4v: "21.5", s4l: ar ? "كم/س" : "km/h",
    } }),
  },
  {
    key: "club-award", title: { en: "Goal of the week", ar: "جول الأسبوع" }, formats: STORY,
    build: layouts.award,
    sample: (ar) => ({ ...sampleCommon(), media: art("goal-clip"), custom: {
      ...endBits(ar), kicker: ar ? "فايز هالأسبوع" : "This week's winner", title: ar ? "جول الأسبوع" : "Goal of the week", meta: ar ? "تحت 10 · تمرين الخميس" : "U10 · Thursday training",
    } }),
  },
  {
    key: "club-top5", title: { en: "Top 5 of the week", ar: "أحلى 5 بالأسبوع" }, formats: STORY,
    build: layouts.top5,
    sample: (ar) => ({ ...sampleCommon(), media: art("goal-clip"), more: [art("goal-clip"), art("goal-clip"), art("goal-clip"), art("goal-clip")], custom: {
      ...endBits(ar), kicker: ar ? "هالأسبوع بالأكاديمية" : "This week at the academy", title: ar ? "أحلى 5 لقطات" : "Top 5 moments",
      l5: ar ? "تمريرة حلوة" : "Perfect pass", m5: ar ? "تحت 8" : "U8", l4: ar ? "مراوغة" : "Skill move", m4: ar ? "تحت 10" : "U10",
      l3: ar ? "تصدّي" : "Big save", m3: ar ? "تحت 12" : "U12", l2: ar ? "تسديدة قوية" : "Rocket shot", m2: ar ? "تحت 14" : "U14",
      l1: ar ? "جول الأسبوع" : "Goal of the week", m1: ar ? "تحت 12" : "U12",
    } }),
  },
  {
    key: "club-week", title: { en: "The week in numbers", ar: "الأسبوع بالأرقام" }, formats: STORY,
    build: (c) => layouts.thanks(c, false),
    sample: (ar) => ({ ...sampleCommon(), media: art("goal-clip"), custom: {
      ...endBits(ar), title: ar ? "أسبوعنا" : "Our week", sub: ar ? "شكراً للاعبين والأهالي" : "Thank you, players and parents",
      ...countData("matches", 18), matchesLabel: ar ? "تمرين وماتش متصوّر" : "sessions and games filmed",
      ...countData("goals", 64), goalsLabel: ar ? "جول" : "goals",
      ...countData("km", 412), kmLabel: ar ? "كم ركضوا لاعبينا" : "km our players ran",
    } }),
  },
  {
    key: "club-milestone", title: { en: "Milestone", ar: "إنجاز" }, formats: STORY,
    build: (c) => layouts.thanks(c, true),
    sample: (ar) => ({ ...sampleCommon(), media: art("goal-clip"), custom: {
      ...endBits(ar), title: ar ? "شكراً إلكم" : "Thank you", sub: ar ? "وصلنا لرقم كبير" : "We reached a big one",
      ...countData("big", 200), bigLabel: ar ? "لاعب بالأكاديمية" : "players at the academy", bigSub: ar ? "وكل واحد إله فيديوهاته" : "and every one has his videos",
    } }),
  },
  {
    key: "club-trial", title: { en: "Free trial sessions", ar: "تمارين تجريبية" }, formats: STORY_POST,
    build: layouts.openSlots,
    sample: (ar) => ({ ...sampleCommon(), custom: {
      ...endBits(ar), kicker: ar ? "هالأسبوع" : "This week", title: ar ? "جرّب معنا مجاناً" : "Try a session free", sub: ar ? "كل تمرين متصوّر، وبتشوفوا الفيديو بالبيت" : "Every session is filmed, watch it at home",
      free: ar ? "مجاني" : "Free", t1: ar ? "السبت 4:00 م" : "Sat 4:00 PM", p1: ar ? "تحت 8 · تحت 10" : "U8 · U10", t2: ar ? "الاثنين 5:00 م" : "Mon 5:00 PM", p2: ar ? "تحت 12" : "U12", t3: ar ? "الأربعاء 6:00 م" : "Wed 6:00 PM", p3: ar ? "تحت 14 · تحت 16" : "U14 · U16",
    } }),
  },
  {
    key: "club-scorers", title: { en: "Top scorers", ar: "الهدّافين" }, formats: STORY_POST,
    build: layouts.leaderboard,
    sample: (ar) => ({ ...sampleCommon(), custom: {
      ...endBits(ar), kicker: ar ? "تشرين الثاني" : "November", title: ar ? "هدّافين الشهر" : "Top scorers",
      r1n: "#10", r1v: "9", r2n: "#7", r2v: "7", r3n: "#9", r3v: "6", r4n: "#11", r4v: "5", r5n: "#8", r5v: "4",
      note: ar ? "بالأرقام، والأسماء بس بموافقة الأهل" : "By shirt number; names only with parents' OK",
    } }),
  },
  ...(["club-versus", "club-versus-story"] as const).map((key): ClubDef => ({
    key, title: key === "club-versus" ? { en: "Which is nicer? (Reel)", ar: "أي واحد أحلى؟ (ريل)" } : { en: "Which is nicer? (Story)", ar: "أي واحد أحلى؟ (ستوري)" },
    formats: STORY,
    build: (c) => layouts.versus(c, key === "club-versus-story"),
    sample: (ar) => ({ ...sampleCommon(), media: art("goal-clip"), more: [art("goal-clip")], custom: {
      ...endBits(ar), question: ar ? "أي جول أحلى؟" : "Which goal is nicer?", labelA: ar ? "أ" : "A", labelB: ar ? "ب" : "B",
      metaA: ar ? "تحت 10 · الثلاثاء" : "U10 · Tuesday", metaB: ar ? "تحت 12 · الجمعة" : "U12 · Friday", cta: ar ? "علّقوا: أ ولا ب؟" : "Comment: A or B?",
    } }),
  })),
  {
    key: "club-nominee-slide", title: { en: "Nominee (carousel slide)", ar: "مرشّح (شريحة)" }, formats: POST_STORY,
    build: layouts.nomineeSlide,
    sample: (ar) => ({ ...sampleCommon(), media: art("goal-clip"), custom: {
      ...endBits(ar), n: "1", label: ar ? "تحت 12 · السبت" : "U12 · Saturday", cta: ar ? "علّق 1 إذا عجبتك" : "Comment 1 if it's your pick",
    } }),
  },
  {
    key: "club-nominees-cover", title: { en: "Nominees (carousel cover)", ar: "المرشّحين (غلاف)" }, formats: POST_STORY,
    build: layouts.nomineesCover,
    sample: (ar) => ({ ...sampleCommon(), custom: {
      ...endBits(ar), kicker: ar ? "صوّتوا" : "Vote", title: ar ? "جول الأسبوع" : "Goal of the week",
      n1: ar ? "تحت 8 · السبت" : "U8 · Saturday", n2: ar ? "تحت 10 · الاثنين" : "U10 · Monday", n3: ar ? "تحت 12 · الأربعاء" : "U12 · Wednesday", n4: ar ? "تحت 14 · الجمعة" : "U14 · Friday",
      cta: ar ? "اسحبوا وعلّقوا برقم اللقطة" : "Swipe, then comment its number",
    } }),
  },
];

export const CLUB_TEMPLATE_KEYS = CLUB_DEFS.map((d) => d.key);
export const isClubTemplate = (key: string): key is ClubTemplateKey => CLUB_DEFS.some((d) => d.key === key);
/** Every academy-pack template's title and formats, in order (the Creative hub's "Academy pack"). */
export const CLUB_TEMPLATE_DEFS: { key: ClubTemplateKey; title: { en: string; ar: string }; formats: CreativeFormat[] }[] =
  CLUB_DEFS.map(({ key, title, formats }) => ({ key, title, formats }));

/** An academy-pack template laid out in a format (the first of its formats when it isn't one of them). */
export function buildClubScene(key: ClubTemplateKey, format: CreativeFormat, locale: Locale): Scene {
  const def = CLUB_DEFS.find((d) => d.key === key)!;
  const f = def.formats.includes(format) ? format : def.formats[0];
  const c = new Canvas(f, locale);
  const durationMs = withSkin(CLUB_SKIN, () => def.build(c));
  return {
    v: 1,
    format: f,
    ...(durationMs !== undefined ? { durationMs } : {}),
    background: "@ink",
    layers: [...c.layers],
    template: { key, style: CLUB_STYLE },
    locale,
  } as Scene;
}

export function clubSampleData(key: string, locale: Locale): CreativeData {
  const def = CLUB_DEFS.find((d) => d.key === key);
  return def ? def.sample(locale === "ar") : {};
}
