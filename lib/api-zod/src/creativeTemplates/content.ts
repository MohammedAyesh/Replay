import type { CreativeData, CreativeFormat } from "../creativeScene";
import type { Locale } from "./kit";

/**
 * What each template says, separate from how a style draws it. A template
 * picks one of six layouts (its archetype) and fills that layout's slots with
 * fixed labels in the right language and {{bindings}} for the facts. Each
 * style then draws every archetype by hand (styles/*.ts).
 */

export type Arch = "score" | "fixture" | "hero" | "list" | "promo" | "video";
export type TemplateCategory = "matchday" | "live" | "results" | "players" | "recruitment" | "academy-life" | "community";

export type Content = {
  key: string;
  arch: Arch;
  /** Short fixed label: FULL TIME, MATCHDAY, PLAYER OF THE MATCH. */
  kicker: string;
  /** Big words (hero / promo), or a list's title. */
  headline?: string;
  /** One sentence or a secondary line. */
  sub?: string;
  /** A shirt number: the hero of every player template. */
  number?: string;
  /** The player's name: optional and often empty (names off, children). */
  name?: string;
  /** Small metadata lines (date, squad, competition). */
  meta: string[];
  /** Info pills (day, time, place, ages). */
  pills: string[];
  /** Contact line (phone / Instagram). */
  cta?: string;
  /** A sticker or tag (FREE, 0 CONCEDED). */
  badge?: string;
  /** One big stat with its label. */
  stat?: { value: string; label: string };
  score?: { ownName: string; oppName: string; own: string; opp: string };
  vs?: { ownName: string; oppName: string; label: string };
  rowsHead?: [string, string, string];
  /** [lead (number / position), main, trail (points / price / role)]. */
  rows?: Array<[string, string, string]>;
  options?: [string, string];
  /**
   * A line-up: each row is a player. With player photos (data.photos, only
   * for an academy that shows names) a style draws photo tiles; without, its
   * numbers-only rows.
   */
  playerRows?: boolean;
  /** A player post that shows the player's own cut-out photo (player.photo) when there is one. */
  playerPhoto?: boolean;
  /** Whether the main picture slot is used. */
  media: boolean;
  video?: { variant: "goal" | "talk" | "training" | "duo"; durationMs: number; captions?: string[] };
  /** A video's line under the crest on its end card (the Instagram autopilot's booking number). */
  endLine?: string;
  academy: string;
};

type Def = {
  key: string;
  category: TemplateCategory;
  title: { en: string; ar: string };
  formats: CreativeFormat[];
  content: (ar: boolean) => Omit<Content, "key" | "academy">;
  sample: (ar: boolean) => CreativeData;
};

const STILL: CreativeFormat[] = ["post", "square", "story"];
const REEL: CreativeFormat[] = ["story", "post", "square"];

const scoreline = (ar: boolean) => (ar
  ? "{{match.ownName}} {{match.ownScore}}–{{match.opponentScore}} {{match.opponent}}"
  : "{{match.ownName}} {{match.ownScore}}–{{match.opponentScore}} {{match.opponent}}");
const squadDate = "{{match.squad}} · {{match.date}}";

// ── Sample data (believable, Amman) ─────────────────────────────────────────

const ACADEMY = { en: "Amman Stars Academy", ar: "أكاديمية نجوم عمّان" };
const academy = (ar: boolean) => ({ name: ar ? ACADEMY.ar : ACADEMY.en, nameAr: ACADEMY.ar, phone: "079 543 3320", instagram: "@ammanstars" });
const match = (ar: boolean) => ({
  ownName: ar ? "نجوم عمّان" : "Amman Stars",
  opponent: ar ? "أسود الصويفية" : "Sweifieh Lions",
  ownScore: 3,
  opponentScore: 1,
  date: ar ? "السبت 7 تشرين الثاني" : "SAT 7 NOV",
  time: ar ? "5:00 المسا" : "5:00 PM",
  place: ar ? "ملعب جالاكسي، خلدا" : "Galaxy Pitch, Khalda",
  squad: ar ? "تحت 12" : "U12",
  competition: ar ? "دوري أكاديميات عمّان" : "Amman Academies League",
  stage: ar ? "نص النهائي" : "Semi-final",
  scorers: ar ? "#9 ×2، #7" : "#9 ×2, #7",
});
const player = (ar: boolean, number = 10) => ({
  name: ar ? "عمر خ." : "Omar K.",
  number,
  squad: ar ? "تحت 12" : "U12",
  position: ar ? "وسط" : "Midfield",
});
const photo = (key: string) => ({ type: "artwork" as const, key: `sample/${key}` });

// ── The catalogue ───────────────────────────────────────────────────────────

const DEFS: Def[] = [
  {
    key: "fulltime", category: "results", title: { en: "Full time", ar: "نهاية المباراة" }, formats: STILL,
    content: (ar) => ({
      arch: "score",
      kicker: ar ? "نهاية المباراة" : "Full time",
      score: { ownName: "{{match.ownName}}", oppName: "{{match.opponent}}", own: "{{match.ownScore}}", opp: "{{match.opponentScore}}" },
      sub: "{{match.scorers}}",
      meta: ["{{match.competition}}", squadDate],
      pills: [],
      media: true,
    }),
    sample: (ar) => ({ academy: academy(ar), match: match(ar), media: photo("team") }),
  },
  {
    key: "matchday", category: "matchday", title: { en: "Matchday", ar: "يوم الماتش" }, formats: STILL,
    content: (ar) => ({
      arch: "fixture",
      kicker: ar ? "يوم الماتش" : "Matchday",
      vs: { ownName: "{{match.ownName}}", oppName: "{{match.opponent}}", label: ar ? "ضد" : "vs" },
      meta: ["{{match.competition}}", "{{match.squad}}"],
      pills: ["{{match.date}}", "{{match.time}}", "{{match.place}}"],
      media: true,
    }),
    sample: (ar) => ({ academy: academy(ar), match: match(ar), media: photo("action") }),
  },
  {
    key: "potm", category: "players", title: { en: "Player of the match", ar: "نجم الماتش" }, formats: STILL,
    content: (ar) => ({
      arch: "hero",
      kicker: ar ? "نجم الماتش" : "Player of the match",
      number: "{{player.number}}",
      name: "{{player.name}}",
      headline: ar ? "نجم الماتش" : "Player of the match",
      meta: [scoreline(ar), "{{player.squad}} · {{match.date}}"],
      pills: [],
      media: true,
      playerPhoto: true,
    }),
    sample: (ar) => ({ academy: academy(ar), match: match(ar), player: player(ar), media: photo("player") }),
  },
  {
    key: "goal", category: "players", title: { en: "Goal clip", ar: "كليب الجول" }, formats: REEL,
    content: (ar) => ({
      arch: "video",
      kicker: ar ? "جووول" : "Goal",
      number: "{{player.number}}",
      name: "{{player.name}}",
      score: { ownName: "{{match.ownName}}", oppName: "{{match.opponent}}", own: "{{match.ownScore}}", opp: "{{match.opponentScore}}" },
      meta: [squadDate],
      pills: [],
      media: true,
      video: { variant: "goal", durationMs: 15000 },
    }),
    sample: (ar) => ({ academy: academy(ar), match: match(ar), player: player(ar, 9), media: photo("goal-clip") }),
  },
  {
    key: "lineup", category: "matchday", title: { en: "Line-up", ar: "التشكيلة" }, formats: ["post", "story", "square"],
    content: (ar) => ({
      arch: "list",
      kicker: ar ? "تشكيلة اليوم" : "Starting line-up",
      headline: ar ? "ضد {{match.opponent}}" : "vs {{match.opponent}}",
      rowsHead: ["#", ar ? "اللاعب" : "Player", ar ? "المركز" : "Pos"],
      rows: [1, 2, 3, 4, 5, 6, 7].map((i) => [`{{custom.n${i}}}`, `{{custom.p${i}}}`, `{{custom.pos${i}}}`] as [string, string, string]),
      playerRows: true,
      meta: ["{{match.date}} · {{match.time}}", "{{match.place}}"],
      pills: [],
      media: false,
    }),
    sample: (ar) => ({
      academy: academy(ar), match: match(ar),
      custom: Object.fromEntries(([
        [1, ar ? "يزن" : "Yazan", ar ? "حارس" : "GK"], [4, ar ? "كريم" : "Karim", ar ? "دفاع" : "DF"], [5, ar ? "سند" : "Sanad", ar ? "دفاع" : "DF"],
        [8, ar ? "زيد" : "Zaid", ar ? "وسط" : "MF"], [10, ar ? "عمر" : "Omar", ar ? "وسط" : "MF"], [7, ar ? "هاشم" : "Hashem", ar ? "جناح" : "WG"],
        [9, ar ? "ليث" : "Laith", ar ? "هجوم" : "FW"],
      ] as const).flatMap(([n, p, pos], i) => [[`n${i + 1}`, String(n)], [`p${i + 1}`, p], [`pos${i + 1}`, pos]])),
    }),
  },
  {
    key: "potmonth", category: "players", title: { en: "Player of the month", ar: "لاعب الشهر" }, formats: STILL,
    content: (ar) => ({
      arch: "hero",
      kicker: ar ? "لاعب الشهر" : "Player of the month",
      headline: "{{custom.month}}",
      number: "{{player.number}}",
      name: "{{player.name}}",
      stat: { value: "{{stats.goals}}", label: ar ? "أهداف" : "Goals" },
      meta: ["{{player.squad}} · {{player.position}}", ar ? "{{stats.matches}} مباريات · {{stats.assists}} أسيست" : "{{stats.matches}} matches · {{stats.assists}} assists"],
      pills: [],
      media: true,
      playerPhoto: true,
    }),
    sample: (ar) => ({
      academy: academy(ar), player: player(ar, 7), stats: { goals: 6, matches: 4, assists: 3 },
      custom: { month: ar ? "تشرين الأول" : "October" }, media: photo("player"),
    }),
  },
  {
    key: "standings", category: "results", title: { en: "League table", ar: "جدول الترتيب" }, formats: STILL,
    content: (ar) => ({
      arch: "list",
      kicker: ar ? "جدول الترتيب" : "League table",
      headline: "{{match.competition}}",
      rowsHead: ["#", ar ? "الفريق" : "Team", ar ? "نقاط" : "Pts"],
      rows: [1, 2, 3, 4, 5, 6].map((i) => [String(i), `{{custom.team${i}}}`, `{{custom.pts${i}}}`] as [string, string, string]),
      meta: ["{{match.squad}} · {{custom.round}}"],
      pills: [],
      media: false,
    }),
    sample: (ar) => ({
      academy: academy(ar), match: match(ar),
      custom: {
        round: ar ? "بعد الجولة 6" : "After round 6",
        team1: ar ? "نجوم عمّان" : "Amman Stars", pts1: "16",
        team2: ar ? "أسود الصويفية" : "Sweifieh Lions", pts2: "13",
        team3: ar ? "نسور عبدون" : "Abdoun Eagles", pts3: "11",
        team4: ar ? "شباب دابوق" : "Dabouq Youth", pts4: "9",
        team5: ar ? "فرسان الجبيهة" : "Jubeiha Knights", pts5: "6",
        team6: ar ? "صقور مرج الحمام" : "Marj Falcons", pts6: "4",
      },
    }),
  },
  {
    key: "nextround", category: "results", title: { en: "Through to the next round", ar: "تأهّلنا" }, formats: STILL,
    content: (ar) => ({
      arch: "fixture",
      kicker: ar ? "تأهّلنا!" : "We're through",
      headline: "{{match.stage}}",
      vs: { ownName: "{{match.ownName}}", oppName: "{{match.opponent}}", label: ar ? "ضد" : "vs" },
      meta: ["{{match.competition}}", "{{match.squad}}"],
      pills: ["{{match.date}}", "{{match.time}}", "{{match.place}}"],
      media: true,
    }),
    sample: (ar) => ({ academy: academy(ar), match: { ...match(ar), opponent: ar ? "نسور عبدون" : "Abdoun Eagles", date: ar ? "الجمعة 13 تشرين الثاني" : "FRI 13 NOV" }, media: photo("team") }),
  },
  {
    key: "champions", category: "results", title: { en: "Champions", ar: "أبطال" }, formats: STILL,
    content: (ar) => ({
      arch: "hero",
      kicker: "{{match.competition}}",
      headline: ar ? "أبطال" : "Champions",
      sub: ar ? "الكاس إلنا. شكراً لكل لاعب وأهل وكابتن." : "The cup is ours. Thank you players, parents and coaches.",
      meta: ["{{match.squad}} · {{custom.season}}"],
      pills: [],
      media: true,
    }),
    sample: (ar) => ({ academy: academy(ar), match: match(ar), custom: { season: "2025/26" }, media: photo("trophy") }),
  },
  {
    key: "freetrial", category: "recruitment", title: { en: "Free trial", ar: "تمرين تجريبي ببلاش" }, formats: STILL,
    content: (ar) => ({
      arch: "promo",
      kicker: ar ? "تمرين تجريبي ببلاش" : "Free trial session",
      headline: "{{custom.headline}}",
      sub: "{{custom.ages}}",
      badge: ar ? "ببلاش" : "Free",
      pills: ["{{custom.days}}", "{{custom.time}}", "{{custom.place}}"],
      cta: ar ? "احجز: {{academy.phone}}" : "Book: {{academy.phone}}",
      meta: [],
      media: true,
    }),
    sample: (ar) => ({
      academy: academy(ar), media: photo("training"),
      custom: {
        headline: ar ? "تعال جرّب معنا" : "Come play with us",
        ages: ar ? "للأعمار من 5 لـ 14 سنة" : "Boys & girls aged 5–14",
        days: ar ? "السبت والثلاثا" : "Sat & Tue", time: ar ? "4:30 العصر" : "4:30 PM", place: ar ? "ملعب جالاكسي، خلدا" : "Galaxy Pitch, Khalda",
      },
    }),
  },
  {
    key: "cleansheet", category: "results", title: { en: "Clean sheet", ar: "شباك نظيفة" }, formats: STILL,
    content: (ar) => ({
      arch: "hero",
      kicker: ar ? "شباك نظيفة" : "Clean sheet",
      headline: ar ? "شباك نظيفة" : "Clean sheet",
      number: "{{player.number}}",
      name: "{{player.name}}",
      stat: { value: "0", label: ar ? "أهداف علينا" : "Goals conceded" },
      meta: [scoreline(ar), squadDate],
      pills: [],
      media: true,
      playerPhoto: true,
    }),
    sample: (ar) => ({ academy: academy(ar), match: { ...match(ar), ownScore: 2, opponentScore: 0 }, player: { ...player(ar, 1), position: ar ? "حارس" : "Goalkeeper" }, media: photo("keeper") }),
  },
  {
    key: "birthday", category: "community", title: { en: "Happy birthday", ar: "عيد ميلاد سعيد" }, formats: STILL,
    content: (ar) => ({
      arch: "hero",
      kicker: ar ? "كل سنة وإنت سالم" : "Birthday",
      headline: ar ? "عيد ميلاد سعيد" : "Happy birthday",
      number: "{{player.number}}",
      name: "{{player.name}}",
      sub: ar ? "من كل عيلة {{academy.name}}" : "From all of us at {{academy.name}}",
      meta: ["{{player.squad}}"],
      pills: [],
      media: true,
      playerPhoto: true,
    }),
    sample: (ar) => ({ academy: academy(ar), player: player(ar, 11), media: photo("player") }),
  },
  {
    key: "pricing", category: "recruitment", title: { en: "Membership prices", ar: "الاشتراكات" }, formats: STILL,
    content: (ar) => ({
      arch: "list",
      kicker: ar ? "الاشتراكات" : "Membership",
      headline: "{{custom.headline}}",
      rowsHead: [ar ? "الباقة" : "Plan", "", ar ? "بالشهر" : "Monthly"],
      rows: [1, 2, 3, 4].map((i) => [`{{custom.plan${i}}}`, `{{custom.detail${i}}}`, `{{custom.price${i}}}`] as [string, string, string]),
      cta: ar ? "للتسجيل: {{academy.phone}}" : "Register: {{academy.phone}}",
      meta: ["{{custom.note}}"],
      pills: [],
      media: false,
    }),
    sample: (ar) => ({
      academy: academy(ar),
      custom: {
        headline: ar ? "موسم 2026/27" : "Season 2026/27",
        plan1: ar ? "أساسي" : "Starter", detail1: ar ? "تمرينين بالأسبوع" : "2 sessions a week", price1: ar ? "35 دينار" : "35 JOD",
        plan2: ar ? "أكاديمي" : "Academy", detail2: ar ? "3 تمارين + ماتش" : "3 sessions + a match", price2: ar ? "50 دينار" : "50 JOD",
        plan3: ar ? "حراس المرمى" : "Goalkeepers", detail3: ar ? "تدريب خاص للحراس" : "Specialist keeper coaching", price3: ar ? "45 دينار" : "45 JOD",
        plan4: ar ? "إخوة" : "Siblings", detail4: ar ? "للأخ التاني" : "For the second child", price4: ar ? "خصم 15%" : "15% off",
        note: ar ? "الأسعار بتشمل الطقم والتأمين" : "Kit and insurance included",
      },
    }),
  },
  {
    key: "newgroup", category: "recruitment", title: { en: "New age group", ar: "مجموعة جديدة" }, formats: STILL,
    content: (ar) => ({
      arch: "promo",
      kicker: ar ? "مجموعة جديدة" : "New group",
      headline: "{{custom.ages}}",
      sub: "{{custom.headline}}",
      badge: ar ? "جديد" : "New",
      pills: ["{{custom.days}}", "{{custom.time}}", "{{custom.starts}}"],
      cta: ar ? "سجّل: {{academy.phone}}" : "Sign up: {{academy.phone}}",
      meta: [],
      media: true,
    }),
    sample: (ar) => ({
      academy: academy(ar), media: photo("kids"),
      custom: {
        ages: ar ? "بنات تحت 10" : "Girls U10",
        headline: ar ? "فريق البنات الأول عنا. المقاعد محدودة." : "Our first girls' squad. Places are limited.",
        days: ar ? "الأحد والأربعا" : "Sun & Wed", time: ar ? "5:00 المسا" : "5:00 PM", starts: ar ? "بتبلّش 15 تشرين الثاني" : "Starts 15 Nov",
      },
    }),
  },
  {
    key: "talk", category: "academy-life", title: { en: "Coach talk", ar: "كلمة الكابتن" }, formats: REEL,
    content: (ar) => ({
      arch: "video",
      kicker: ar ? "كلمة الكابتن" : "Coach's corner",
      headline: "{{custom.speaker}}",
      sub: "{{custom.role}}",
      meta: [],
      pills: [],
      media: true,
      video: { variant: "talk", durationMs: 15000, captions: ["{{custom.quote1}}", "{{custom.quote2}}", "{{custom.quote3}}"] },
    }),
    sample: (ar) => ({
      academy: academy(ar), media: photo("coach-talk"),
      custom: {
        speaker: ar ? "كابتن رامي حدّاد" : "Coach Rami Haddad",
        role: ar ? "مدرّب فريق تحت 12" : "U12 head coach",
        quote1: ar ? "أهم إشي إنهم يستمتعوا بالكورة" : "The most important thing is that they enjoy it",
        quote2: ar ? "هالأسبوع اشتغلنا على التمرير القصير" : "This week we worked on short passing",
        quote3: ar ? "وشفتوا النتيجة يوم السبت" : "And you saw the result on Saturday",
      },
    }),
  },
  {
    key: "training", category: "academy-life", title: { en: "Training clip", ar: "كليب التمرين" }, formats: REEL,
    content: (ar) => ({
      arch: "video",
      kicker: ar ? "من التمرين" : "Training",
      headline: "{{custom.headline}}",
      meta: [squadDate],
      pills: [],
      media: true,
      video: { variant: "training", durationMs: 15000 },
    }),
    sample: (ar) => ({ academy: academy(ar), match: match(ar), media: photo("training-clip"), custom: { headline: ar ? "تمارين التسديد" : "Finishing drills" } }),
  },
  {
    key: "welcome", category: "academy-life", title: { en: "Welcome", ar: "أهلاً فيك" }, formats: STILL,
    content: (ar) => ({
      arch: "hero",
      kicker: ar ? "أهلا وسهلا" : "Welcome",
      headline: ar ? "أهلاً فيك بالعيلة" : "Welcome to the family",
      number: "{{player.number}}",
      name: "{{player.name}}",
      meta: ["{{player.squad}} · {{player.position}}"],
      pills: [],
      media: true,
      playerPhoto: true,
    }),
    sample: (ar) => ({ academy: academy(ar), player: player(ar, 14), media: photo("player") }),
  },
  {
    key: "getwell", category: "community", title: { en: "Get well soon", ar: "سلامتك" }, formats: STILL,
    content: (ar) => ({
      arch: "hero",
      kicker: ar ? "ألف سلامة" : "Get well soon",
      headline: ar ? "سلامتك يا بطل" : "Get well soon",
      number: "{{player.number}}",
      name: "{{player.name}}",
      sub: ar ? "مستنيينك ترجع عالملعب أقوى." : "We'll be waiting for you back on the pitch.",
      meta: ["{{player.squad}}"],
      pills: [],
      media: true,
    }),
    sample: (ar) => ({ academy: academy(ar), player: player(ar, 5), media: photo("player") }),
  },
  {
    key: "staff", category: "academy-life", title: { en: "Meet the coach", ar: "تعرّفوا على الكابتن" }, formats: STILL,
    content: (ar) => ({
      arch: "hero",
      kicker: ar ? "تعرّفوا على الكابتن" : "Meet the coach",
      headline: "{{custom.name}}",
      sub: "{{custom.role}}",
      stat: { value: "{{custom.years}}", label: ar ? "سنين خبرة" : "Years coaching" },
      meta: ["{{custom.license}}"],
      pills: [],
      media: true,
    }),
    sample: (ar) => ({
      academy: academy(ar), media: photo("coach"),
      custom: {
        name: ar ? "كابتن رامي حدّاد" : "Rami Haddad",
        role: ar ? "مدرّب فريق تحت 12" : "U12 head coach",
        years: "9",
        license: ar ? "رخصة تدريب آسيوية C" : "AFC C Licence",
      },
    }),
  },
  {
    key: "alumni", category: "community", title: { en: "One of ours", ar: "من خرّيجينا" }, formats: STILL,
    content: (ar) => ({
      arch: "hero",
      kicker: ar ? "من خرّيجينا" : "One of ours",
      headline: "{{custom.club}}",
      number: "{{player.number}}",
      name: "{{player.name}}",
      sub: "{{custom.years}}",
      meta: [ar ? "بلّش معنا وهو صغير" : "Started with us as a kid"],
      pills: [],
      media: true,
    }),
    sample: (ar) => ({
      academy: academy(ar), player: { ...player(ar, 8), name: ar ? "مالك ن." : "Malek N." }, media: photo("player"),
      custom: { club: ar ? "صار مع منتخب الناشئين" : "Now with the national U17s", years: ar ? "معنا من 2017 لـ 2023" : "With us 2017–2023" },
    }),
  },
  {
    key: "tournament", category: "matchday", title: { en: "Tournament", ar: "بطولة" }, formats: STILL,
    content: (ar) => ({
      arch: "promo",
      kicker: ar ? "بطولة" : "Tournament",
      headline: "{{match.competition}}",
      sub: "{{custom.headline}}",
      badge: "{{custom.ages}}",
      pills: ["{{match.date}}", "{{match.place}}", "{{custom.teams}}"],
      cta: ar ? "للتسجيل: {{academy.phone}}" : "Enter your team: {{academy.phone}}",
      meta: [],
      media: true,
    }),
    sample: (ar) => ({
      academy: academy(ar), media: photo("tournament"),
      match: { ...match(ar), competition: ar ? "كاس الشتاء" : "Winter Cup", date: ar ? "12–14 كانون الأول" : "12–14 DEC" },
      custom: { headline: ar ? "3 أيام كورة، ميداليات لكل لاعب" : "Three days of football. A medal for every player.", ages: ar ? "تحت 8 لـ تحت 14" : "U8–U14", teams: ar ? "16 فريق" : "16 teams" },
    }),
  },
  {
    key: "poll", category: "community", title: { en: "Poll story", ar: "تصويت" }, formats: ["story", "post", "square"],
    content: (ar) => ({
      arch: "promo",
      kicker: ar ? "إنتو بتقرروا" : "You decide",
      headline: "{{custom.question}}",
      options: ["{{custom.optionA}}", "{{custom.optionB}}"],
      pills: [],
      meta: [ar ? "صوّتوا بالستوري" : "Vote in our story"],
      media: true,
    }),
    sample: (ar) => ({
      academy: academy(ar), more: [photo("goal-a"), photo("goal-b")],
      custom: { question: ar ? "أحلى جول هالشهر؟" : "Goal of the month?", optionA: "#9", optionB: "#7" },
    }),
  },
  {
    key: "map", category: "academy-life", title: { en: "Find us", ar: "وين تلاقونا" }, formats: STILL,
    content: (ar) => ({
      arch: "promo",
      kicker: ar ? "وين تلاقونا" : "Find us",
      headline: "{{custom.place}}",
      sub: "{{custom.address}}",
      pills: ["{{custom.hours}}"],
      cta: ar ? "اتصلوا: {{academy.phone}}" : "Call {{academy.phone}} · {{academy.instagram}}",
      meta: [],
      media: true,
    }),
    sample: (ar) => ({
      academy: academy(ar), media: photo("pitch"),
      custom: {
        place: ar ? "ملعب جالاكسي" : "Galaxy Pitch",
        address: ar ? "خلدا، ورا دوار الواحة، عمّان" : "Khalda, behind Al-Waha circle, Amman",
        hours: ar ? "كل يوم من 4 لـ 10 المسا" : "Daily 4–10 PM",
      },
    }),
  },
  {
    key: "manifesto", category: "academy-life", title: { en: "Our values", ar: "قيمنا" }, formats: STILL,
    content: (ar) => ({
      arch: "promo",
      kicker: "{{academy.name}}",
      headline: "{{custom.headline}}",
      sub: "{{custom.body}}",
      pills: [],
      meta: [],
      media: true,
    }),
    sample: (ar) => ({
      academy: academy(ar), media: photo("team"),
      custom: {
        headline: ar ? "ما بنعلّم كورة بس.\nبنربّي أبطال." : "We don't just teach football.\nWe raise good people.",
        body: ar ? "احترام، شغل جماعي، ومتعة بكل تمرين." : "Respect, teamwork and fun in every session.",
      },
    }),
  },
  // ── In-game: posted while the match is on (from the live stream) ──────────
  {
    key: "kickoff", category: "live", title: { en: "Kick-off", ar: "بلّش الماتش" }, formats: ["story", "post", "square"],
    content: (ar) => ({
      arch: "fixture",
      kicker: ar ? "بلّش الماتش" : "Kick-off",
      vs: { ownName: "{{match.ownName}}", oppName: "{{match.opponent}}", label: ar ? "ضد" : "vs" },
      meta: ["{{match.competition}}", "{{match.squad}}"],
      pills: [ar ? "لايف هلأ" : "Live now", "{{match.place}}"],
      cta: ar ? "تابعوا لايف على ريبلاي" : "Watch live on Replay",
      media: true,
    }),
    sample: (ar) => ({ academy: academy(ar), match: match(ar), media: photo("pitch") }),
  },
  {
    key: "goalflash", category: "live", title: { en: "Goal flash", ar: "جول!" }, formats: ["story", "post", "square"],
    content: (ar) => ({
      arch: "score",
      kicker: ar ? "جووول!" : "Goal!",
      score: { ownName: "{{match.ownName}}", oppName: "{{match.opponent}}", own: "{{match.ownScore}}", opp: "{{match.opponentScore}}" },
      sub: ar ? "#{{player.number}} · الدقيقة {{custom.minute}}" : "#{{player.number}} · {{custom.minute}}'",
      meta: ["{{match.squad}} · {{match.competition}}"],
      pills: [],
      badge: ar ? "لايف" : "Live",
      media: true,
      playerPhoto: true,
    }),
    sample: (ar) => ({ academy: academy(ar), match: { ...match(ar), ownScore: 2, opponentScore: 1 }, player: player(ar, 9), custom: { minute: "34" }, media: photo("goal-a") }),
  },
  {
    key: "halftime", category: "live", title: { en: "Half time", ar: "بين الشوطين" }, formats: ["story", "post", "square"],
    content: (ar) => ({
      arch: "score",
      kicker: ar ? "بين الشوطين" : "Half time",
      score: { ownName: "{{match.ownName}}", oppName: "{{match.opponent}}", own: "{{match.ownScore}}", opp: "{{match.opponentScore}}" },
      sub: "{{match.scorers}}",
      meta: ["{{match.squad}} · {{match.competition}}"],
      pills: [],
      media: true,
    }),
    sample: (ar) => ({ academy: academy(ar), match: { ...match(ar), ownScore: 1, opponentScore: 0, scorers: ar ? "#9" : "#9" }, media: photo("action") }),
  },
  {
    key: "livescore", category: "live", title: { en: "Live score", ar: "النتيجة هلأ" }, formats: ["story", "post", "square"],
    content: (ar) => ({
      arch: "score",
      kicker: ar ? "لايف · الدقيقة {{custom.minute}}" : "Live · {{custom.minute}}'",
      score: { ownName: "{{match.ownName}}", oppName: "{{match.opponent}}", own: "{{match.ownScore}}", opp: "{{match.opponentScore}}" },
      sub: ar ? "تابعوا لايف على ريبلاي" : "Watch live on Replay",
      meta: ["{{match.squad}} · {{match.place}}"],
      pills: [],
      badge: ar ? "لايف" : "Live",
      media: true,
    }),
    sample: (ar) => ({ academy: academy(ar), match: { ...match(ar), ownScore: 2, opponentScore: 2 }, custom: { minute: "62" }, media: photo("action") }),
  },
  // ── Pre-game extras ──────────────────────────────────────────────────────
  {
    key: "countdown", category: "matchday", title: { en: "Countdown", ar: "العد التنازلي" }, formats: ["story", "post", "square"],
    content: (ar) => ({
      arch: "promo",
      kicker: ar ? "ضد {{match.opponent}}" : "vs {{match.opponent}}",
      headline: ar ? "باقي {{custom.days}} أيام" : "{{custom.days}} days to go",
      sub: "{{match.competition}}",
      pills: ["{{match.date}}", "{{match.time}}", "{{match.place}}"],
      meta: [],
      media: true,
    }),
    sample: (ar) => ({ academy: academy(ar), match: match(ar), custom: { days: "2" }, media: photo("pitch") }),
  },
  {
    key: "callup", category: "matchday", title: { en: "Squad call-up", ar: "قائمة الماتش" }, formats: ["post", "story", "square"],
    content: (ar) => ({
      arch: "list",
      kicker: ar ? "قائمة الماتش" : "Squad call-up",
      headline: ar ? "ضد {{match.opponent}}" : "vs {{match.opponent}}",
      rowsHead: ["#", ar ? "اللاعب" : "Player", ar ? "المركز" : "Pos"],
      rows: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => [`{{custom.n${i}}}`, `{{custom.p${i}}}`, `{{custom.pos${i}}}`] as [string, string, string]),
      playerRows: true,
      meta: ["{{match.date}} · {{match.time}}", "{{match.place}}"],
      pills: [],
      media: false,
    }),
    sample: (ar) => ({
      academy: academy(ar), match: match(ar),
      // Numbers only by default: names appear only when the academy allows them.
      custom: Object.fromEntries(([[1, "GK"], [2, "DF"], [4, "DF"], [5, "DF"], [6, "MF"], [8, "MF"], [10, "MF"], [7, "FW"], [9, "FW"]] as const)
        .flatMap(([n, pos], i) => [[`n${i + 1}`, String(n)], [`p${i + 1}`, ""], [`pos${i + 1}`, ar ? ({ GK: "حارس", DF: "دفاع", MF: "وسط", FW: "هجوم" } as Record<string, string>)[pos] : pos]])),
    }),
  },
  // ── Post-game extras ─────────────────────────────────────────────────────
  {
    key: "matchstats", category: "results", title: { en: "Match stats", ar: "أرقام الماتش" }, formats: ["post", "story", "square"],
    content: (ar) => ({
      arch: "list",
      kicker: ar ? "أرقام الماتش" : "Match stats",
      headline: scoreline(ar),
      rowsHead: ["{{match.ownName}}", "", "{{match.opponent}}"],
      rows: [
        ["{{stats.possession}}%", ar ? "الاستحواذ" : "Possession", "{{stats.opponentPossession}}%"],
        ["{{stats.shots}}", ar ? "تسديدات" : "Shots", ""],
        ["{{stats.passes}}", ar ? "تمريرات" : "Passes", ""],
        ["{{stats.passAccuracy}}%", ar ? "دقة التمرير" : "Pass accuracy", ""],
        ["{{stats.dribbles}}", ar ? "مراوغات ناجحة" : "Dribbles won", ""],
      ],
      meta: [squadDate],
      pills: [],
      media: false,
    }),
    sample: (ar) => ({ academy: academy(ar), match: match(ar), stats: { possession: 58, opponentPossession: 42, shots: 14, passes: 312, passAccuracy: 81, dribbles: 9 } }),
  },
  // ── Every child appears: posts that don't depend on talent ──────────────
  // Each is about one child; drafts go to whoever has waited longest
  // (lib/featured/rules.ts rotationOrder). "Most improved" compares a child
  // with his own earlier matches only, never with other children.
  {
    key: "meetplayer", category: "players", title: { en: "Meet the player", ar: "تعرّفوا على اللاعب" }, formats: STILL,
    content: (ar) => ({
      arch: "hero",
      kicker: ar ? "تعرّفوا على اللاعب" : "Meet the player",
      headline: ar ? "تعرّفوا على بطلنا" : "Meet the player",
      number: "{{player.number}}",
      name: "{{player.name}}",
      sub: "{{custom.fact}}",
      meta: ["{{player.squad}} · {{player.position}}"],
      pills: [],
      media: true,
      playerPhoto: true,
    }),
    sample: (ar) => ({
      academy: academy(ar), player: player(ar, 8), media: photo("player"),
      custom: { fact: ar ? "بحب المراوغة وبحلم يلعب للنشامى." : "Loves to dribble. Dreams of playing for Jordan." },
    }),
  },
  {
    key: "improved", category: "players", title: { en: "Most improved", ar: "الأكثر تطوّراً" }, formats: STILL,
    content: (ar) => ({
      arch: "hero",
      kicker: ar ? "تطوّر حلو" : "On the rise",
      headline: ar ? "الأكثر تطوّراً" : "Most improved",
      number: "{{player.number}}",
      name: "{{player.name}}",
      stat: { value: "{{stats.value}}", label: "{{stats.label}}" },
      sub: "{{custom.since}}",
      meta: ["{{player.squad}} · {{match.date}}"],
      pills: [],
      media: true,
      playerPhoto: true,
    }),
    sample: (ar) => ({
      academy: academy(ar), match: match(ar), player: player(ar, 6), media: photo("player"),
      stats: { value: 4, label: ar ? "مراوغات ناجحة" : "Dribbles won" },
      custom: { since: ar ? "أكثر من معدّله بآخر مبارياته (1)" : "Up from his usual 1 in his last matches" },
    }),
  },
  {
    key: "streak", category: "academy-life", title: { en: "Attendance streak", ar: "ما بغيب" }, formats: STILL,
    content: (ar) => ({
      arch: "hero",
      kicker: ar ? "ما بغيب أبداً" : "Never misses a session",
      headline: ar ? "التزام بطل" : "Always there",
      number: "{{player.number}}",
      name: "{{player.name}}",
      stat: { value: "{{custom.streak}}", label: ar ? "تمرين ورا بعض" : "sessions in a row" },
      meta: ["{{player.squad}}"],
      pills: [],
      media: true,
      playerPhoto: true,
    }),
    sample: (ar) => ({ academy: academy(ar), player: player(ar, 4), media: photo("player"), custom: { streak: "20" } }),
  },
  {
    key: "firstgoal", category: "players", title: { en: "First goal", ar: "أول جول" }, formats: STILL,
    content: (ar) => ({
      arch: "hero",
      kicker: ar ? "أول جول إله!" : "First goal!",
      headline: ar ? "أول جول إله" : "His first goal",
      number: "{{player.number}}",
      name: "{{player.name}}",
      meta: [scoreline(ar), squadDate],
      pills: [],
      media: true,
      playerPhoto: true,
    }),
    sample: (ar) => ({ academy: academy(ar), match: match(ar), player: player(ar, 15), media: photo("player") }),
  },
  {
    key: "weekmoment", category: "players", title: { en: "Moment of the week", ar: "لقطة الأسبوع" }, formats: REEL,
    content: (ar) => ({
      arch: "video",
      kicker: ar ? "لقطة الأسبوع" : "Moment of the week",
      headline: "{{custom.headline}}",
      meta: [squadDate],
      pills: [],
      media: true,
      video: { variant: "training", durationMs: 15000 },
    }),
    sample: (ar) => ({ academy: academy(ar), match: match(ar), media: photo("goal-clip"), custom: { headline: ar ? "أحلى لقطة من هالأسبوع" : "The best of this week" } }),
  },
  {
    // The panoramic camera on top, a parent's or coach's phone clip of the same moment below,
    // kept in step by the phone clip's offset into the recording (phone media sorted by match time).
    key: "goalduo", category: "players", title: { en: "Goal from two angles", ar: "الجول من زاويتين" }, formats: ["story"],
    content: (ar) => ({
      arch: "video",
      kicker: ar ? "من زاويتين" : "Two angles",
      headline: "{{custom.headline}}",
      number: "{{player.number}}",
      name: "{{player.name}}",
      score: { ownName: "{{match.ownName}}", oppName: "{{match.opponent}}", own: "{{match.ownScore}}", opp: "{{match.opponentScore}}" },
      meta: [squadDate],
      pills: [],
      media: true,
      video: { variant: "duo", durationMs: 15000 },
    }),
    sample: (ar) => ({
      academy: academy(ar), match: match(ar), player: player(ar, 9), media: photo("goal-clip"), more: [photo("training-clip")],
      custom: { headline: ar ? "الجول من الكاميرا ومن التلفون" : "From the camera and from the stands" },
    }),
  },
];

/** Templates that read the academy's crest name line. */
export const DEFINITIONS = DEFS;

// ── Instagram autopilot (field console) ─────────────────────────────────────
//
// Kept out of the catalogue (DEFINITIONS): a field's autopilot makes these on its own, from a
// booking's clip or a weekly award, in the field's brand. Each award is its own template.

const AWARD_TITLES: Record<string, { en: string; ar: string }> = {
  goal: { en: "Goal of the week", ar: "جول الأسبوع" },
  dribble: { en: "Dribble of the week", ar: "مراوغة الأسبوع" },
  shot: { en: "Shot of the week", ar: "تسديدة الأسبوع" },
  save: { en: "Save of the week", ar: "تصدّي الأسبوع" },
  fastest: { en: "Fastest player of the week", ar: "أسرع لاعب بالأسبوع" },
};

export const AUTOPILOT_AWARD_KEYS = ["goal", "dribble", "shot", "save", "fastest"] as const;
export const awardTemplateKey = (category: string) => `ig-award-${category}`;
export const AUTOPILOT_TEMPLATE_KEYS = ["ig-booking-clip", "ig-award-nominees", ...AUTOPILOT_AWARD_KEYS.map(awardTemplateKey)];
export function awardTitle(category: string, ar: boolean): string {
  const t = AWARD_TITLES[category];
  return t ? (ar ? t.ar : t.en) : category;
}

const STORY_ONLY: CreativeFormat[] = ["story"];
const meetLine = "{{match.date}} · {{match.time}}";

const AUTOPILOT_DEFS: Def[] = [
  {
    key: "ig-booking-clip", category: "results", title: { en: "Booking highlight", ar: "لقطة من الحجز" }, formats: STORY_ONLY,
    content: (ar) => ({
      arch: "video",
      kicker: "{{custom.kicker}}",
      headline: "{{custom.headline}}",
      meta: [meetLine, "{{match.place}}"],
      pills: [],
      media: true,
      video: { variant: "training", durationMs: 15000 },
      endLine: "{{custom.endLine}}",
    }),
    sample: (ar) => ({
      academy: academy(ar), match: match(ar), media: photo("goal-clip"),
      custom: { kicker: ar ? "من ملاعبنا" : "On our pitch", headline: ar ? "جووول" : "Goal!", endLine: ar ? "حجز JG-4F7K2Q" : "Booking JG-4F7K2Q" },
    }),
  },
  {
    key: "ig-award-nominees", category: "players", title: { en: "Award nominees", ar: "المرشحين للجائزة" }, formats: STORY_ONLY,
    content: (ar) => ({
      arch: "promo",
      kicker: "{{custom.award}}",
      headline: ar ? "صوّتوا هلّق" : "Vote now",
      sub: "{{custom.nominees}}",
      meta: ["{{custom.closes}}"],
      pills: ["{{custom.count}}"],
      cta: ar ? "صوّتوا على تطبيق ريبلاي" : "Vote in the Replay app",
      badge: ar ? "ترشيحات" : "Nominees",
      media: true,
    }),
    sample: (ar) => ({
      academy: academy(ar), media: photo("goal-clip"),
      custom: { award: awardTitle("goal", ar), nominees: ar ? "4 أجوال من ماتشات الأسبوع" : "4 goals from this week's games", closes: ar ? "التصويت لآخر يوم الثلاثا" : "Voting closes Tuesday", count: ar ? "4 مرشحين" : "4 nominees" },
    }),
  },
  ...AUTOPILOT_AWARD_KEYS.map((category): Def => ({
    key: awardTemplateKey(category), category: "players", title: AWARD_TITLES[category], formats: STORY_ONLY,
    content: (ar) => ({
      arch: "video",
      kicker: awardTitle(category, ar),
      headline: category === "fastest" ? "{{custom.speed}}" : ar ? "الفايز" : "The winner",
      meta: [meetLine, "{{match.place}}"],
      pills: [],
      badge: ar ? "الفايز" : "Winner",
      media: true,
      video: { variant: "training", durationMs: 15000 },
      endLine: "{{custom.endLine}}",
    }),
    sample: (ar) => ({
      academy: academy(ar), match: match(ar), media: photo("goal-clip"),
      custom: { speed: ar ? "24.9 كم/س" : "24.9 km/h", endLine: ar ? "حجز JG-4F7K2Q" : "Booking JG-4F7K2Q" },
    }),
  })),
];

export function contentFor(key: string, locale: Locale): Content | null {
  const def = DEFS.find((d) => d.key === key) ?? AUTOPILOT_DEFS.find((d) => d.key === key);
  if (!def) return null;
  return { ...def.content(locale === "ar"), key, academy: "{{academy.name}}" };
}

export function sampleFor(key: string, locale: Locale): CreativeData {
  const def = DEFS.find((d) => d.key === key) ?? AUTOPILOT_DEFS.find((d) => d.key === key);
  const ar = locale === "ar";
  return def ? def.sample(ar) : { academy: academy(ar) };
}
