import { useLocale } from "./context";
import type { StrainZone, TileMetric } from "@/lib/stat-tile";

/**
 * Copy for the Home stat tiles (components/home/StatTile.tsx), written for the
 * Whoop-style cards: a short title, one sentence under the visual and three
 * labels along the bottom. Numbers come in already formatted and the page
 * wraps them LTR, so an Arabic sentence never reorders "24.3" or "9′48".
 * The Arabic is the app's Levantine voice: "ماتش", "هالشهر", "شوف".
 */

const enWord = (n: number) => ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][n] ?? String(n);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ordinalEn = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

/** Arabic counted nouns: 1 and 11+ singular, 2 dual, 3–10 plural. */
const arCount = (n: number, [one, two, few]: [string, string, string]) => (n === 2 ? two : n >= 3 && n <= 10 && Number.isInteger(n) ? few : one);
/** "ماتش واحد", "ماتشين", "5 ماتشات", "12 ماتش": Arabic drops the number for one and two. */
const arN = (n: number, forms: [string, string, string], oneWord = "واحد") => (n === 1 ? `${forms[0]} ${oneWord}` : n === 2 ? forms[1] : `${n} ${arCount(n, forms)}`);
const MATCH: [string, string, string] = ["ماتش", "ماتشين", "ماتشات"];
/** A name or place set apart from the sentence's direction, so "Laith" or "Jordan Galaxy" never reorders the Arabic around it. */
const iso = (text: string) => `\u2068${text}\u2069`;
/** Names joined the Arabic way, with the "و" kept apart from Latin names. */
const arList = (names: string[]) => (names.length <= 1 ? iso(names[0] ?? "") : `${names.slice(0, -1).map(iso).join("، ")} و ${iso(names.at(-1)!)}`);

const en = {
  units: { distanceKm: "km", topSpeedKmh: "km/h", touches: "touches", passesCompleted: "passes", dribblesWon: "dribbles", goals: "goals", shots: "shots" } as Record<TileMetric, string>,
  metric: { distanceKm: "Distance", topSpeedKmh: "Top speed", touches: "Touches", passesCompleted: "Passes", dribblesWon: "Dribbles won", goals: "Goals", shots: "Shots on target" } as Record<TileMetric, string>,
  /** Lower-case metric names for the small labels along the bottom. */
  small: { distanceKm: "distance", topSpeedKmh: "top speed", touches: "touches", passesCompleted: "passes", dribblesWon: "dribbles won", goals: "goals", shots: "shots on target" } as Record<TileMetric, string>,
  /** The word beside a big number: "17 passes", "1 goal", "4.8 km". */
  bigUnit: (metric: TileMetric, n: number): string => {
    if (metric === "distanceKm") return "km";
    if (metric === "topSpeedKmh") return "km/h";
    const one = n === 1;
    return ({ touches: one ? "touch" : "touches", passesCompleted: one ? "pass" : "passes", dribblesWon: one ? "dribble" : "dribbles", goals: one ? "goal" : "goals", shots: one ? "shot" : "shots" } as Record<string, string>)[metric];
  },
  ordinal: ordinalEn,
  you: "You",
  per10Short: "/ 10 min",
  m: "m",
  min: "min",
  s: "s",
  of: (a: string, b: string) => `${a} of ${b}`,
  players: (n: number): string => (n === 1 ? "player" : "players"),
  matches: (n: number): string => (n === 1 ? "match" : "matches"),

  strain: {
    title: "Match strain",
    zone: { light: "Light", moderate: "Moderate", high: "High", allOut: "All out" } as Record<StrainZone, string>,
    zoneShort: { light: "Light", moderate: "Moderate", high: "High", allOut: "All out" } as Record<StrainZone, string>,
    harder: (prev: string) => `Harder than your last match (${prev}).`,
    easier: (prev: string) => `Easier than your last match (${prev}).`,
    same: "As hard as your last match.",
    first: "From how far and how hard you ran.",
    calories: "calories, about",
    run: "run",
    played: "played",
  },

  best: {
    title: "New personal best",
    sub: (metric: TileMetric, n: number) => (metric === "topSpeedKmh" ? "km/h, your fastest ever" : `${en.bigUnit(metric, n)}, your best ever`),
    line: (old: string, date: string) => `The white mark is your old best: ${old} on ${date}.`,
    old: "old best",
    more: "more than before",
    faster: "faster",
    times: "the old best",
    fasterAt: "faster at this pitch",
  },

  last: {
    title: { distanceKm: "Furthest on the pitch", topSpeedKmh: "Fastest on the pitch", touches: "Most on the ball", passesCompleted: "Most passes on the pitch", dribblesWon: "Most dribbles won", goals: "Top scorer on the pitch", shots: "Most shots on the pitch" } as Record<TileMetric, string>,
    sub: (claimed: number) => `Number 1 of ${claimed} who found themselves`,
    pitch: "Pitch average",
    per10: "per 10 min on camera",
    line: (field: string) => `At ${field}. Nobody who found themselves did better.`,
  },

  rival: {
    title: (month: string) => `${month}, distance`,
    ahead: (name: string, gap: string) => `${name} is ${gap} ahead. One match like yours closes it.`,
    lead: (name: string, gap: string) => `You lead. ${name} is ${gap} behind you.`,
    rank: "your rank",
    perMatch: "per match",
    players: "players this month",
  },

  form: {
    title: { distanceKm: "Your running", topSpeedKmh: "Your top speed", touches: "Your touches" } as Record<"distanceKm" | "topSpeedKmh" | "touches", string>,
    when: (n: number) => `Last ${n} matches`,
    sub: (n: number) => `Up ${enWord(n)} matches running`,
    average: "average",
    inARow: "in a row",
    best: "best",
    dashed: "The dashed line is your average.",
  },

  notFound: {
    title: "Your match is waiting",
    big: (found: number, total: number) => (total ? `${found}/${total}` : String(found)),
    sub: "found themselves",
    teaser: {
      topSpeedKmh: (v: string) => `Someone hit ${v} km/h. Was it you?`,
      distanceKm: (v: string) => `Someone ran ${v} km. Was it you?`,
      dribblesWon: (v: string) => `Someone beat ${v} players. Was it you?`,
      shots: (v: string) => `Someone had ${v} shots on target. Was it you?`,
    } as Partial<Record<TileMetric, (v: string) => string>>,
    plain: "Your numbers are ready. Find yourself to see them.",
    teaserLabel: { topSpeedKmh: "top speed on the pitch", distanceKm: "most run on the pitch", dribblesWon: "most dribbles won", shots: "most shots" } as Partial<Record<TileMetric, string>>,
    found: "found",
    toGo: "still to find themselves",
    minutes: "to find yourself",
  },

  passing: {
    title: "Passing",
    sub: (c: number, t: number) => `${c} of ${t} found a teammate`,
    best: "Your best rate yet.",
    pitch: (pct: string) => `The pitch averaged ${pct}.`,
    plain: "Tap to watch your passes.",
    pitchAvg: "pitch average",
    completed: "completed",
    lost: "lost",
  },

  touches: {
    title: "Touches",
    sub: (from: number, to: number) => `Busiest between ${from}′ and ${to}′`,
    between: "between touches",
    busiest: "in your busiest 5′",
    watched: "of the match seen",
    unit: (n: number): string => (n === 1 ? "touch" : "touches"),
  },

  total: {
    title: (field: string | null) => (field ? `Distance at ${field}` : "Distance with Replay"),
    when: (date: string) => `Since ${date}`,
    sub: (milestone: string) => `of ${milestone}`,
    milestone: (km: number) => (km === 21.1 ? "a half marathon" : km === 42.2 ? "a marathon" : `${km} km`),
    passed: (milestone: string, n: number) => `You've now run ${milestone}, in ${n} ${en.matches(n)}.`,
    toGo: (milestone: string, k: number, day: string) => `${k === 1 ? `One more match like ${day}'s` : `${cap(enWord(k))} more matches like ${day}'s`} takes you past ${milestone}.`,
    matches: "matches",
    perMatch: "per match",
    lastMatch: "last match",
  },

  spells: {
    title: "Running by 10 minutes",
    stronger: "Your strongest spell came last",
    strongest: (from: number, to: number) => `Strongest between ${from}′ and ${to}′`,
    total: "total",
    vsAvg: "on your average spell",
    played: "played",
  },

  ranks: {
    title: "Where you finished",
    line: (n: number) => `Out of ${n} ${en.players(n)} who found themselves.`,
    top3: "top-three finishes",
    claimed: "found themselves",
    best: "best finish",
  },

  style: {
    title: "How you play",
    when: (n: number) => `Last ${n} matches`,
    lean: { passer: "Passer", dribbler: "Dribbler", shooter: "Shooter", allRounder: "All-rounder" },
    line: { passer: "Most of what you do on the ball is a pass.", dribbler: "You take players on more than you pass.", shooter: "Always looking for goal.", allRounder: "A bit of everything." },
    passes: "Passes",
    dribbles: "Dribbles",
    shots: "Shots",
    other: "Other",
    matches: "matches",
    touches: "touches",
  },

  challenge: {
    title: (when: string) => `Target for ${when}`,
    sub: { passesCompleted: "passes to beat your best", dribblesWon: "dribbles to beat your best", touches: "touches to beat your best", distanceKm: "km to beat your best" },
    line: (best: string) => `The white mark is the target. Your best is ${best}.`,
    average: "your average",
    best: "your best",
    kickoff: "kick-off",
  },

  dribbles: {
    title: "Dribbles",
    won: "won",
    lost: "lost",
    line: (tries: number, won: number) => `You took your man on ${tries === 1 ? "once" : `${enWord(tries)} times`} and beat him ${won === 1 ? "once" : enWord(won)}.`,
    onlyMore: (name: string) => ` Only ${name} won more.`,
    tried: "tried",
    rate: "won",
    rank: "on the pitch",
  },

  played: {
    title: "Matches",
    when: (date: string) => `Since ${date}`,
    sub: "In three weeks",
    next: (when: string, n: number) => `${cap(when)} makes ${enWord(n)}.`,
    keep: "The dashed day is your next match.",
    none: "Book a match to keep it going.",
    perWeek: "per week",
    thisWeek: "this week",
    weekdays: ["M", "T", "W", "T", "F", "S", "S"],
  },

  shots: {
    title: "Shots",
    sub: "on target",
    line: "Tap to watch them. The camera doesn't catch every shot.",
    first: "first",
    last: "last",
    apart: "apart",
  },

  trend: {
    title: "Passing rate",
    when: (n: number) => `Last ${n} matches`,
    sub: (from: string) => `Up from ${from}`,
    first: "first match",
    points: "points better",
    matches: "matches",
  },

  team: {
    title: "Your team's passing",
    sub: "of your team's passes were yours",
    line: (next: number | null) => (next !== null ? `The next most was ${next}.` : "More than anyone else on your team."),
    yours: "yours",
    total: "team total",
    next: "next most",
  },

  duel: {
    title: "Dribble duel",
    head: (name: string, diff: number, theyWon: boolean) => (theyWon ? `${name} beat you by ${enWord(diff)}.` : `You beat ${name} by ${enWord(diff)}.`),
    note: " They tried more, you lost the ball less.",
    won: "won",
  },

  week: {
    title: "This week",
    km: "km run",
    touches: "touches",
    passes: "passes completed",
    dribbles: "dribbles won",
    line: (n: number) => `${cap(enWord(n))} ${en.matches(n)} so far. Bars show the share that came off.`,
    matches: "matches",
    shots: "shots on target",
    passing: "passing",
  },

  friends: {
    title: "Your friends have their numbers",
    line: (names: string[]) => `${names.length === 2 ? `${names[0]} and ${names[1]}` : names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`} found themselves. Where do you land?`,
    found: "found",
    players: "players",
    minutes: "to find yourself",
  },

  unclaimed: {
    title: "Your numbers are waiting",
    sub: "Find yourself in the video",
    line: "Nobody from this match has found themselves yet. Be the first.",
    players: "players",
    minutes: "to find yourself",
  },
};

type TileStrings = typeof en;

const ar: TileStrings = {
  units: { distanceKm: "كم", topSpeedKmh: "كم/س", touches: "لمسة", passesCompleted: "تمريرة", dribblesWon: "مراوغة", goals: "هدف", shots: "تسديدة" },
  metric: { distanceKm: "المسافة", topSpeedKmh: "أعلى سرعة", touches: "اللمسات", passesCompleted: "التمريرات", dribblesWon: "المراوغات الناجحة", goals: "الأهداف", shots: "التسديدات على المرمى" },
  small: { distanceKm: "المسافة", topSpeedKmh: "أعلى سرعة", touches: "اللمسات", passesCompleted: "التمريرات", dribblesWon: "مراوغات ناجحة", goals: "الأهداف", shots: "على المرمى" },
  bigUnit: (metric: TileMetric, n: number): string => {
    if (metric === "distanceKm") return "كم";
    if (metric === "topSpeedKmh") return "كم/س";
    const forms: Record<string, [string, string, string]> = {
      touches: ["لمسة", "لمستين", "لمسات"],
      passesCompleted: ["تمريرة", "تمريرتين", "تمريرات"],
      dribblesWon: ["مراوغة", "مراوغتين", "مراوغات"],
      goals: ["هدف", "هدفين", "أهداف"],
      shots: ["تسديدة", "تسديدتين", "تسديدات"],
    };
    return arCount(n, forms[metric]);
  },
  ordinal: (n: number) => (["", "الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع", "الثامن", "التاسع", "العاشر"][n] ?? `#${n}`),
  you: "إنت",
  per10Short: "/ 10 د",
  m: "م",
  min: "د",
  s: "ث",
  of: (a: string, b: string) => `${a} من ${b}`,
  players: (n: number) => arCount(n, ["لاعب", "لاعبين", "لاعبين"]),
  matches: (n: number) => arCount(n, ["ماتش", "ماتشين", "ماتشات"]),

  strain: {
    title: "جهد الماتش",
    zone: { light: "خفيف", moderate: "متوسط", high: "عالي", allOut: "أقصى جهد" },
    zoneShort: { light: "خفيف", moderate: "متوسط", high: "عالي", allOut: "أقصى" },
    harder: (prev: string) => `أصعب من ماتشك اللي قبله (${prev}).`,
    easier: (prev: string) => `أخف من ماتشك اللي قبله (${prev}).`,
    same: "نفس جهد ماتشك اللي قبله.",
    first: "محسوب من قدّيش ركضت وبأي سرعة.",
    calories: "سعرة تقريباً",
    run: "ركض",
    played: "لعب",
  },

  best: {
    title: "رقم شخصي جديد",
    sub: (metric: TileMetric, n: number) => (metric === "topSpeedKmh" ? "كم/س، أسرع ما ركضت" : `${ar.bigUnit(metric, n)}، أحسن رقم إلك`),
    line: (old: string, date: string) => `العلامة البيضا رقمك القديم: ${old} يوم ${date}.`,
    old: "رقمك القديم",
    more: "زيادة عن قبل",
    faster: "أسرع",
    times: "رقمك القديم",
    fasterAt: "أسرع منك بهالملعب",
  },

  last: {
    title: { distanceKm: "ركضت أكثر من الكل", topSpeedKmh: "أسرع واحد بالملعب", touches: "أكثر واحد لمس الكرة", passesCompleted: "أكثر تمريرات بالملعب", dribblesWon: "أكثر مراوغات ناجحة", goals: "هدّاف الملعب", shots: "أكثر تسديدات بالملعب" },
    sub: (claimed: number) => `الأول من ${claimed} لقوا حالهم`,
    pitch: "معدّل الملعب",
    per10: "كل 10 دقايق على الكاميرا",
    line: (field: string) => `في ${iso(field)}، ما حدا من اللي لقوا حالهم عمل أحسن منك.`,
  },

  rival: {
    title: (month: string) => `${month}، المسافة`,
    ahead: (name: string, gap: string) => `${iso(name)} سابقك بـ${gap}. ماتش متل ماتشك بيسكّر الفرق.`,
    lead: (name: string, gap: string) => `إنت الأول. ${iso(name)} وراك بـ${gap}.`,
    rank: "ترتيبك",
    perMatch: "بالماتش",
    players: "لاعب هالشهر",
  },

  form: {
    title: { distanceKm: "ركضك", topSpeedKmh: "سرعتك", touches: "لمساتك" },
    when: (n: number) => `آخر ${arN(n, MATCH)}`,
    sub: (n: number) => `عم يطلع ${arN(n, MATCH)} ورا بعض`,
    average: "معدّلك",
    inARow: "ورا بعض",
    best: "أحسن رقم",
    dashed: "الخط المتقطّع هو معدّلك.",
  },

  notFound: {
    title: "ماتشك ناطرك",
    big: (found: number, total: number) => (total ? `${found}/${total}` : String(found)),
    sub: "لقوا حالهم",
    teaser: {
      topSpeedKmh: (v: string) => `في حدا وصل ${v} كم/س. كنت إنت؟`,
      distanceKm: (v: string) => `في حدا ركض ${v} كم. كنت إنت؟`,
      dribblesWon: (v: string) => `في حدا راوغ ${v} لاعبين. كنت إنت؟`,
      shots: (v: string) => `في حدا سدّد ${v} على المرمى. كنت إنت؟`,
    },
    plain: "أرقامك جاهزة. لاقي حالك لتشوفها.",
    teaserLabel: { topSpeedKmh: "أعلى سرعة بالملعب", distanceKm: "أكثر ركض بالملعب", dribblesWon: "أكثر مراوغات", shots: "أكثر تسديدات" },
    found: "لقوا حالهم",
    toGo: "لسّا ما لقوا حالهم",
    minutes: "لتلاقي حالك",
  },

  passing: {
    title: "التمرير",
    sub: (c: number, t: number) => `${c} من ${t} وصلت لزميلك`,
    best: "أحسن نسبة إلك لهلّق.",
    pitch: (pct: string) => `معدّل الملعب كان ${pct}.`,
    plain: "اضغط لتشوف تمريراتك.",
    pitchAvg: "معدّل الملعب",
    completed: "صحيحة",
    lost: "ضايعة",
  },

  touches: {
    title: "اللمسات",
    sub: (from: number, to: number) => `أكثر وقت بين الدقيقة ${from} و${to}`,
    between: "بين كل لمسة",
    busiest: "بأكثر 5 دقايق",
    watched: "من الماتش",
    unit: (n: number) => arCount(n, ["لمسة", "لمستين", "لمسات"]),
  },

  total: {
    title: (field: string | null) => (field ? `مسافتك في ${iso(field)}` : `مسافتك مع ريبلاي`),
    when: (date: string) => `من ${date}`,
    sub: (milestone: string) => `من ${milestone}`,
    milestone: (km: number) => (km === 21.1 ? "نص ماراثون" : km === 42.2 ? "ماراثون" : `${km} كم`),
    passed: (milestone: string, n: number) => `هيك ركضت ${milestone} بـ${arN(n, MATCH)}.`,
    toGo: (milestone: string, k: number, day: string) => `${k === 1 ? "ماتش كمان" : k === 2 ? "ماتشين كمان" : `${k} ماتشات كمان`} متل ماتش ${day} وبتعدّي ${milestone}.`,
    matches: "ماتشات",
    perMatch: "بالماتش",
    lastMatch: "آخر ماتش",
  },

  spells: {
    title: "ركضك كل 10 دقايق",
    stronger: "أقوى فترة إلك كانت بالآخر",
    strongest: (from: number, to: number) => `أقوى فترة بين الدقيقة ${from} و${to}`,
    total: "المجموع",
    vsAvg: "فوق معدّل فتراتك",
    played: "لعب",
  },

  ranks: {
    title: "ترتيبك بالملعب",
    line: (n: number) => `من أصل ${arN(n, ["لاعب", "لاعبين", "لاعبين"])} لقوا حالهم بالماتش.`,
    top3: "مرات بأول ثلاثة",
    claimed: "لقوا حالهم",
    best: "أحسن ترتيب",
  },

  style: {
    title: "أسلوب لعبك",
    when: (n: number) => `آخر ${arN(n, MATCH)}`,
    lean: { passer: "ممرّر", dribbler: "مراوغ", shooter: "هدّاف", allRounder: "شامل" },
    line: { passer: "أغلب شغلك بالكرة تمرير.", dribbler: "بتراوغ أكثر ما بتمرّر.", shooter: "دايماً عينك عالمرمى.", allRounder: "شوي من كل إشي." },
    passes: "تمريرات",
    dribbles: "مراوغات",
    shots: "تسديدات",
    other: "غيرها",
    matches: "ماتشات",
    touches: "لمسة",
  },

  challenge: {
    title: (when: string) => `هدفك ${when}`,
    sub: { passesCompleted: "تمريرة لتكسر رقمك", dribblesWon: "مراوغة لتكسر رقمك", touches: "لمسة لتكسر رقمك", distanceKm: "كم لتكسر رقمك" },
    line: (best: string) => `العلامة البيضا هي الهدف. أحسن رقم إلك ${best}.`,
    average: "معدّلك",
    best: "أحسن رقم",
    kickoff: "البداية",
  },

  dribbles: {
    title: "المراوغات",
    won: "نجحت",
    lost: "ضاعت",
    line: (tries: number, won: number) => `حاولت تراوغ ${arN(tries, ["مرة", "مرتين", "مرات"], "وحدة")} ونجحت ${won === 1 ? "مرة وحدة" : won === 2 ? "مرتين" : won}.`,
    onlyMore: (name: string) => ` بس ${iso(name)} نجح أكثر.`,
    tried: "محاولات",
    rate: "نجحت",
    rank: "بالملعب",
  },

  played: {
    title: "ماتشاتك",
    when: (date: string) => `من ${date}`,
    sub: "بثلاث أسابيع",
    next: (when: string, n: number) => `${when} بتصير ${n}.`,
    keep: "اليوم المتقطّع هو ماتشك الجاي.",
    none: "احجز ماتش لتكمّل.",
    perWeek: "بالأسبوع",
    thisWeek: "هالأسبوع",
    weekdays: ["ن", "ث", "ر", "خ", "ج", "س", "ح"],
  },

  shots: {
    title: "التسديدات",
    sub: "على المرمى",
    line: "اضغط لتشوفهم. الكاميرا ما بتلقط كل تسديدة.",
    first: "أول وحدة",
    last: "آخر وحدة",
    apart: "بيناتهم",
  },

  trend: {
    title: "نسبة التمرير",
    when: (n: number) => `آخر ${arN(n, MATCH)}`,
    sub: (from: string) => `طالعة من ${from}`,
    first: "أول ماتش",
    points: "نقطة أحسن",
    matches: "ماتشات",
  },

  team: {
    title: "تمريرات فريقك",
    sub: "من تمريرات فريقك كانت منك",
    line: (next: number | null) => (next !== null ? `اللي بعدك عمل ${next}.` : "أكثر من أي حدا بفريقك."),
    yours: "إلك",
    total: "للفريق",
    next: "اللي بعدك",
  },

  duel: {
    title: "تحدّي المراوغة",
    head: (name: string, diff: number, theyWon: boolean) => (theyWon ? `${iso(name)} غلبك بـ${diff === 1 ? "وحدة" : diff}.` : `غلبت ${iso(name)} بـ${diff === 1 ? "وحدة" : diff}.`),
    note: " هو حاول أكثر، وإنت خسرت الكرة أقل.",
    won: "نجحت",
  },

  week: {
    title: "هالأسبوع",
    km: "كم ركض",
    touches: "لمسة",
    passes: "تمريرة صحيحة",
    dribbles: "مراوغة ناجحة",
    line: (n: number) => `${arN(n, MATCH)} لهلّق. الخط تحت كل رقم نسبة اللي زبط.`,
    matches: "ماتشات",
    shots: "على المرمى",
    passing: "تمرير",
  },

  friends: {
    title: "صحابك أخذوا أرقامهم",
    line: (names: string[]) => `${arList(names)} ${names.length === 1 ? "لقى حاله" : "لقوا حالهم"}. وين إنت منهم؟`,
    found: "لقوا حالهم",
    players: "لاعب",
    minutes: "لتلاقي حالك",
  },

  unclaimed: {
    title: "أرقامك ناطرتك",
    sub: "لاقي حالك بالفيديو",
    line: "لسّا ما حدا من هالماتش لقى حاله. كون الأول.",
    players: "لاعب",
    minutes: "لتلاقي حالك",
  },
};

export function useTileCopy(): TileStrings & { locale: "en" | "ar" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale };
}

export type { TileStrings };
/** For tests and the preview: the two copies side by side. */
export const tileCopies = { en, ar };
