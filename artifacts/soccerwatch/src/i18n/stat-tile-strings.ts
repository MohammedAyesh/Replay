import { useLocale } from "./context";
import type { TileMetric } from "@/lib/stat-tile";
import { arCount } from "./ar-count";

/**
 * Copy for the Home stat tiles (components/home/StatTile.tsx). Numbers come
 * in already formatted; the page wraps them LTR so an Arabic sentence never
 * reorders "24.3" or "41:12". Dates and days come in already written in the
 * reader's language.
 */

const enWord = (n: number) => ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][n] ?? String(n);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ordinalEn = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

const en = {
  units: { distanceKm: "km", topSpeedKmh: "km/h", touches: "touches", passesCompleted: "passes", dribblesWon: "dribbles", goals: "goals", shots: "shots" } as Record<TileMetric, string>,
  metric: { distanceKm: "Distance", topSpeedKmh: "Top speed", touches: "Touches", passesCompleted: "Passes completed", dribblesWon: "Dribbles won", goals: "Goals", shots: "Shots on target" } as Record<TileMetric, string>,
  metricShort: { distanceKm: "Distance", topSpeedKmh: "Top speed", touches: "Touches", passesCompleted: "Passes", dribblesWon: "Dribbles", goals: "Goals", shots: "Shots" } as Record<TileMetric, string>,
  small: { distanceKm: "distance", topSpeedKmh: "top speed", touches: "touches", passesCompleted: "passes", dribblesWon: "dribbles won", goals: "goals", shots: "shots" } as Record<TileMetric, string>,
  ordinal: ordinalEn,
  you: "You",
  matchReport: "Match report",
  matchAt: (day: string, time: string) => `${day} ${time}`,

  lastMatchEyebrow: "Your last match",
  lastMatchHead: {
    distanceKm: "You ran further than anyone on the pitch.",
    topSpeedKmh: "Nobody on the pitch was faster than you.",
    touches: "Nobody saw more of the ball than you.",
    passesCompleted: "You completed more passes than anyone.",
    dribblesWon: "You beat more players than anyone.",
    goals: "You scored more than anyone on the pitch.",
    shots: "Nobody had more shots than you.",
  } as Record<TileMetric, string>,
  lastMatchMeta: (field: string, when: string, players: number) => `${field} · ${when}${players ? ` · ${players} players` : ""}`,
  pitchAverage: "Pitch average",
  numberOne: (metric: string) => `#1 ${metric}`,

  newBest: "New personal best",
  bestSpeedBody: (at: string | null, day: string, time: string) => at ? `Your fastest run yet, ${at} into ${day}'s ${time} match.` : `Your fastest run yet, in ${day}'s ${time} match.`,
  fasterAtField: (n: number, field: string) => n === 0 ? `Nobody at ${field} has gone faster.` : n === 1 ? `Only one player at ${field} has gone faster.` : `Only ${enWord(n)} players at ${field} have gone faster.`,
  bestBody: { distanceKm: "in one match", touches: "touches in one match", passesCompleted: "passes completed in one match", dribblesWon: "dribbles won in one match", goals: "goals in one match", topSpeedKmh: "", shots: "shots in one match" } as Record<TileMetric, string>,
  bestOn: (day: string, time: string) => `on ${day} at ${time}.`,
  /** The word beside a big number: "17 passes", "1 goal", "4.8 km". */
  bigUnit: (metric: TileMetric, n: number): string => {
    if (metric === "distanceKm") return "km";
    if (metric === "topSpeedKmh") return "km/h";
    const one = n === 1;
    return ({ touches: one ? "touch" : "touches", passesCompleted: one ? "pass" : "passes", dribblesWon: one ? "dribble" : "dribbles", goals: one ? "goal" : "goals", shots: one ? "shot" : "shots" } as Record<string, string>)[metric];
  },
  /** The small line under "17 passes", before "on Tuesday at 20:00." */
  bestRest: { distanceKm: "covered in one match", touches: "in one match", passesCompleted: "completed in one match", dribblesWon: "won in one match", goals: "scored in one match", topSpeedKmh: "", shots: "on target in one match" } as Record<TileMetric, string>,
  oldBest: (value: string, date: string) => `Your old best: ${value}, ${date}`,
  watchRun: "Watch the run",
  yourSprint: "Your sprint",
  clipNote: "the full match, from the start of your run",

  rivalAhead: (name: string, gap: string) => `${name} is ${gap} ahead of you this month.`,
  rivalLead: (field: string) => `You lead ${field} this month.`,
  rivalAheadBody: "An average match from you puts you past them.",
  rivalLeadBody: (name: string, gap: string) => `${name} is ${gap} behind. An average match from you keeps you clear.`,
  distanceThisMonth: "Distance, this month",
  allPlayers: (n: number) => `All ${n}`,
  bookNext: "Book your next match",

  formEyebrow: "Your form",
  formHead: (metric: "distanceKm" | "topSpeedKmh" | "touches", n: number) => {
    const runs = `${cap(enWord(n))} matches running`;
    return metric === "distanceKm" ? `${runs}, you've covered more ground.` : metric === "topSpeedKmh" ? `${runs}, you've got faster.` : `${runs}, you've seen more of the ball.`;
  },
  formBody: (latest: string, day: string, diff: string) => `${latest} on ${day}, ${diff} over your average.`,
  keepGoing: (when: string) => ` Keep it going ${when}.`,
  allMatches: "See all your matches",

  notFoundTeaser: {
    topSpeedKmh: (v: string, day: string) => `Someone hit ${v} km/h on ${day}. Was it you?`,
    distanceKm: (v: string, day: string) => `Someone ran ${v} km on ${day}. Was it you?`,
    dribblesWon: (v: string, day: string) => `Someone beat ${v} players on ${day}. Was it you?`,
    shots: (v: string, day: string) => `Someone had ${v} shots on target on ${day}. Was it you?`,
  } as Partial<Record<TileMetric, (v: string, day: string) => string>>,
  notFoundPlain: (day: string) => `Your numbers from ${day} are ready.`,
  notFoundBody: "Your numbers are ready. Pick yourself from a few photos and confirm a few moments — about 3 minutes.",
  found: (found: number, total: number) => total ? `${found} of ${total} found` : `${found} found`,
  findYourself: "Find yourself",
  yourDistance: "Your distance",
  yourTopSpeed: "Your top speed",
  yourPlace: "Your place on the pitch",

  passingEyebrow: "Passing",
  passingHead: (c: number, t: number) => `${c} of your ${t} passes completed.`,
  passingBest: (pct: string) => `That's ${pct}, your best rate yet.`,
  passingRate: (pct: string) => `That's ${pct}.`,
  pitchAveraged: (pct: string) => ` The pitch averaged ${pct}.`,
  completed: "completed",
  lost: "lost",
  watchPasses: "Watch your passes",

  touchesEyebrow: "Touches",
  touchesHead: (n: number, every: number | null) => every ? `${n} touches. On the ball every ${every} seconds.` : `${n} touches.`,
  busiest: (from: number, to: number, count: number) => `Your busiest 5 minutes: ${from}′–${to}′, ${count === 1 ? "one touch" : `${count} touches`}`,
  everyTouch: "Every touch",

  sinceEyebrow: (date: string, n: number) => `Since ${date} · ${n} matches`,
  milestoneName: (km: number) => km === 21.1 ? "half marathon" : km === 42.2 ? "marathon" : `${km} km`,
  totalHead: (total: string, field: string | null) => field ? `${total} km run at ${field}.` : `${total} km run with Replay.`,
  passedHead: (name: string, field: string | null) => `You've now run a ${name}${field ? ` at ${field}` : ""}.`,
  passedBody: (total: string, n: number) => `${total} km in ${n} matches.`,
  toGoBody: (name: string, km: string, k: number, day: string) => `A ${name} is ${km} km. ${k === 1 ? `One more match like ${day}'s` : `${cap(enWord(k))} more matches like ${day}'s`} and you're past it.`,
  toGoBodyKm: (km: string, k: number, day: string) => `${k === 1 ? `One more match like ${day}'s` : `${cap(enWord(k))} more matches like ${day}'s`} takes you past ${km} km.`,
  eachBlock: "Each block is one match",

  distanceEyebrow: "Distance",
  strongerHead: "You finished stronger than you started.",
  strongerBody: (m: string) => `${m} m in the last ten minutes, more than any other spell.`,
  strongestHead: (from: number, to: number) => `Your strongest ten minutes: ${from}′–${to}′.`,
  strongestBody: (m: string) => `${m} m in that spell.`,

  ranksHead: "Where you finished on the pitch",
  players: (n: number) => `${n} players`,
  fullTable: "Full table",
  ofN: (v: string, of: number) => `${v} of ${of}`,

  styleEyebrow: (n: number) => `How you play · last ${n} matches`,
  styleHead: { passer: "More passer than dribbler.", dribbler: "More dribbler than passer.", shooter: "Always looking for goal.", allRounder: "A bit of everything." },
  styleBody: (touches: number, share: string) => `Of your ${touches} touches, ${share} were passes.`,
  passes: "Passes",
  dribbles: "Dribbles",
  shotsOnTarget: "Shots on target",
  otherTouches: "Other touches",

  challengeEyebrow: (when: string, time: string, field: string) => `${when} · ${time} · ${field}`,
  challengeHead: {
    passesCompleted: (n: string, when: string) => `Complete ${n} passes ${when}.`,
    dribblesWon: (n: string, when: string) => `Win ${n} dribbles ${when}.`,
    touches: (n: string, when: string) => `Get ${n} touches ${when}.`,
    distanceKm: (n: string, when: string) => `Run ${n} km ${when}.`,
  },
  challengeBody: (avg: string, target: string) => `You average ${avg}. ${target} beats your best, and you'll find out about 20 minutes after the whistle.`,
  average: "average",
  best: "best",
  target: "target",
  openMatch: "Open the match",

  dribblesEyebrow: "Dribbles",
  won: "won",
  dribblesBody: (tries: number, won: number) => `You took your man on ${tries === 1 ? "once" : `${enWord(tries)} times`} and beat him ${won === 1 ? "once" : enWord(won)}.`,
  onlyMore: (name: string) => ` Only ${name} won more.`,
  rankBadge: (rank: number, metric: string) => `#${rank} ${metric}`,

  matchesEyebrow: "Matches played",
  matchesBody: (makes: string | null) => `in three weeks.${makes ? ` ${makes}` : ""}`,
  makes: (when: string, n: number) => `${cap(when)} makes ${enWord(n)}.`,
  weekdays: ["M", "T", "W", "T", "F", "S", "S"],

  shotsEyebrow: "Shots on target",
  shotsBody: "Tap a time to watch it. The camera doesn't catch every shot.",
  watchThem: "Watch them",

  trendEyebrow: "Passing · last 3 matches",
  trendBody: "You're completing more of your passes every match.",

  teamEyebrow: "Your team",
  teamHead: (share: number) => share >= 0.45 ? "Half your team's passes went through you." : share >= 0.3 ? "A third of your team's passes went through you." : share >= 0.23 ? "A quarter of your team's passes went through you." : `${Math.round(share * 100)}% of your team's passes went through you.`,
  teamBody: (mine: number, total: number, next: number | null) => `${mine} of your team's ${total} completed passes.${next !== null ? ` Next most: ${next}.` : ""}`,

  duelEyebrow: "Dribbles won",
  duelHead: (name: string, diff: number, theyWon: boolean) => theyWon ? `${name} beat you by ${enWord(diff)}.` : `You beat ${name} by ${enWord(diff)}.`,
  duelLine: (won: number, tries: number, pct: number) => `${won} of ${tries} · ${pct}%`,
  duelNote: "They tried more often. You lost the ball less.",
  vs: "vs",

  weekEyebrow: "This week",
  weekHead: (n: number, km: string) => `${n} matches, ${km} km.`,
  touchesLabel: "touches",
  passesCompleted: "passes completed",
  dribblesWon: "dribbles won",
  shotsLabel: "shots on target",
  of: "of",

  friendsHead: (names: string[]) => `${names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`} have their numbers. Where are yours?`,
  friendsBody: "You played in this match too. Find yourself and see how you stack up against them.",
  claimStats: "Find yourself",
  cols: { km: "KM", top: "TOP KM/H", shots: "SHOTS", dribbles: "DRIBBLES" },

  nobodyHead: "Nobody has found themselves in this match yet.",
  nobodyBody: "Who ran the furthest? Who was fastest? Be the first to find yourself and set the numbers everyone else has to beat.",
  claimMatch: "Find yourself",
  topSpeed: "Top speed",
  distanceRan: "Distance run",
  shotsOnGoal: "Shots on goal",
  successfulDribbles: "Successful dribbles",
};

type TileStrings = typeof en;

const ar: TileStrings = {
  units: { distanceKm: "كم", topSpeedKmh: "كم/س", touches: "لمسة", passesCompleted: "تمريرة", dribblesWon: "مراوغة", goals: "هدف", shots: "تسديدة" },
  metric: { distanceKm: "المسافة", topSpeedKmh: "أعلى سرعة", touches: "اللمسات", passesCompleted: "التمريرات الصحيحة", dribblesWon: "المراوغات الناجحة", goals: "الأهداف", shots: "التسديدات على المرمى" },
  metricShort: { distanceKm: "المسافة", topSpeedKmh: "السرعة", touches: "اللمسات", passesCompleted: "التمريرات", dribblesWon: "المراوغات", goals: "الأهداف", shots: "التسديدات" },
  small: { distanceKm: "المسافة", topSpeedKmh: "أعلى سرعة", touches: "لمسات", passesCompleted: "تمريرات", dribblesWon: "مراوغات ناجحة", goals: "أهداف", shots: "تسديدات" },
  ordinal: (n: number) => (["", "الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع", "الثامن", "التاسع", "العاشر"][n] ?? `#${n}`),
  you: "إنت",
  matchReport: "تقرير الماتش",
  matchAt: (day: string, time: string) => `${day} ${time}`,

  lastMatchEyebrow: "آخر ماتش إلك",
  lastMatchHead: {
    distanceKm: "ركضت أكثر من أي حدا بالملعب.",
    topSpeedKmh: "ما في حدا بالملعب كان أسرع منك.",
    touches: "ما في حدا لمس الكرة أكثر منك.",
    passesCompleted: "مرّرت تمريرات صحيحة أكثر من الكل.",
    dribblesWon: "راوغت لاعبين أكثر من الكل.",
    goals: "سجّلت أكثر من أي حدا بالملعب.",
    shots: "ما في حدا سدّد أكثر منك.",
  },
  lastMatchMeta: (field: string, when: string, players: number) => `${field} · ${when}${players ? ` · ${arCount(players, "لاعب واحد", "لاعبين", "لاعبين", "لاعب")}` : ""}`,
  pitchAverage: "معدّل الملعب",
  numberOne: (metric: string) => `#1 ${metric}`,

  newBest: "رقم شخصي جديد",
  bestSpeedBody: (at: string | null, day: string, time: string) => at ? `أسرع ركضة إلك لهلأ، بالدقيقة ${at} من ماتش ${day} الساعة ${time}.` : `أسرع ركضة إلك لهلأ، بماتش ${day} الساعة ${time}.`,
  fasterAtField: (n: number, field: string) => n === 0 ? `ما في حدا بـ${field} ركض أسرع.` : n === 1 ? `لاعب واحد بس بـ${field} ركض أسرع.` : `بس ${arCount(n, "", "لاعبين اثنين", "لاعبين", "لاعب")} بـ${field} ركضوا أسرع.`,
  bestBody: { distanceKm: "بماتش واحد", touches: "لمسة بماتش واحد", passesCompleted: "تمريرة صحيحة بماتش واحد", dribblesWon: "مراوغة ناجحة بماتش واحد", goals: "أهداف بماتش واحد", topSpeedKmh: "", shots: "تسديدة بماتش واحد" },
  bestOn: (day: string, time: string) => `يوم ${day} الساعة ${time}.`,
  // Arabic counting: 1 and 11+ take the singular, 2 the dual, 3–10 the plural.
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
    const [one, two, few] = forms[metric];
    return n === 2 ? two : n >= 3 && n <= 10 && Number.isInteger(n) ? few : one;
  },
  bestRest: { distanceKm: "بماتش واحد", touches: "بماتش واحد", passesCompleted: "صحيحة بماتش واحد", dribblesWon: "ناجحة بماتش واحد", goals: "بماتش واحد", topSpeedKmh: "", shots: "على المرمى بماتش واحد" },
  oldBest: (value: string, date: string) => `رقمك القديم: ${value}، ${date}`,
  watchRun: "شوف الركضة",
  yourSprint: "ركضتك",
  clipNote: "الماتش كامل، من بداية ركضتك",

  rivalAhead: (name: string, gap: string) => `${name} سابقك بـ${gap} هالشهر.`,
  rivalLead: (field: string) => `إنت الأول بـ${field} هالشهر.`,
  rivalAheadBody: "ماتش عادي منك بيطلّعك قدّامه.",
  rivalLeadBody: (name: string, gap: string) => `${name} وراك بـ${gap}. ماتش عادي منك بيخلّيك قدّام.`,
  distanceThisMonth: "المسافة، هالشهر",
  allPlayers: (n: number) => `الكل ${n}`,
  bookNext: "احجز ماتشك الجاي",

  formEyebrow: "فورمتك",
  formHead: (metric: "distanceKm" | "topSpeedKmh" | "touches", n: number) => {
    const runs = `${arCount(n, "ماتش", "ماتشين", "ماتشات", "ماتش")} ورا بعض`;
    return metric === "distanceKm" ? `${runs} وإنت عم تركض أكثر.` : metric === "topSpeedKmh" ? `${runs} وإنت عم تصير أسرع.` : `${runs} وإنت عم تلمس الكرة أكثر.`;
  },
  formBody: (latest: string, day: string, diff: string) => `${latest} يوم ${day}، ${diff} فوق معدّلك.`,
  keepGoing: (when: string) => ` كمّل هيك ${when}.`,
  allMatches: "شوف كل ماتشاتك",

  notFoundTeaser: {
    topSpeedKmh: (v: string, day: string) => `في حدا وصل ${v} كم/س يوم ${day}. كنت إنت؟`,
    distanceKm: (v: string, day: string) => `في حدا ركض ${v} كم يوم ${day}. كنت إنت؟`,
    dribblesWon: (v: string, day: string) => `في حدا راوغ ${v} لاعبين يوم ${day}. كنت إنت؟`,
    shots: (v: string, day: string) => `في حدا سدّد ${v} على المرمى يوم ${day}. كنت إنت؟`,
  },
  notFoundPlain: (day: string) => `أرقامك من يوم ${day} جاهزة.`,
  notFoundBody: "أرقامك جاهزة. اختار حالك من كم صورة وأكّد كم لحظة، تقريبًا 3 دقايق.",
  found: (found: number, total: number) => total ? `${found} من ${total} لاقوا حالهم` : `${found} لاقوا حالهم`,
  findYourself: "لاقي حالك",
  yourDistance: "مسافتك",
  yourTopSpeed: "أعلى سرعة إلك",
  yourPlace: "ترتيبك بالملعب",

  passingEyebrow: "التمرير",
  passingHead: (c: number, t: number) => `تمريراتك الصحيحة: ${c} من ${t}.`,
  passingBest: (pct: string) => `يعني ${pct}، أحسن نسبة إلك لهلأ.`,
  passingRate: (pct: string) => `يعني ${pct}.`,
  pitchAveraged: (pct: string) => ` معدّل الملعب كان ${pct}.`,
  completed: "صحيحة",
  lost: "ضايعة",
  watchPasses: "شوف تمريراتك",

  touchesEyebrow: "اللمسات",
  touchesHead: (n: number, every: number | null) => every ? `${arCount(n, "لمسة وحدة", "لمستين", "لمسات", "لمسة")}. الكرة كانت معك كل ${arCount(every, "ثانية", "ثانيتين", "ثواني", "ثانية")}.` : `${arCount(n, "لمسة وحدة", "لمستين", "لمسات", "لمسة")}.`,
  busiest: (from: number, to: number, count: number) => `أكثر 5 دقايق كنت فيها عالكرة: من الدقيقة ${from} لـ ${to}، ${arCount(count, "لمسة وحدة", "لمستين", "لمسات", "لمسة")}`,
  everyTouch: "كل لمسة",

  sinceEyebrow: (date: string, n: number) => `من ${date} · ${arCount(n, "ماتش واحد", "ماتشين", "ماتشات", "ماتش")}`,
  milestoneName: (km: number) => km === 21.1 ? "نص ماراثون" : km === 42.2 ? "ماراثون" : `${km} كم`,
  totalHead: (total: string, field: string | null) => field ? `ركضت ${total} كم بـ${field}.` : `ركضت ${total} كم مع Replay.`,
  passedHead: (name: string, field: string | null) => `هيك صرت راكض ${name}${field ? ` بـ${field}` : ""}.`,
  passedBody: (total: string, n: number) => `${total} كم بـ${arCount(n, "ماتش واحد", "ماتشين", "ماتشات", "ماتش")}.`,
  toGoBody: (name: string, km: string, k: number, day: string) => `الـ${name} ${km} كم. ${k === 1 ? `ماتش كمان متل ماتش ${day}` : `${arCount(k, "", "ماتشين", "ماتشات", "ماتش")} كمان متل ماتش ${day}`} وبتكون عدّيته.`,
  toGoBodyKm: (km: string, k: number, day: string) => `${k === 1 ? `ماتش كمان متل ماتش ${day}` : `${arCount(k, "", "ماتشين", "ماتشات", "ماتش")} كمان متل ماتش ${day}`} وبتعدّي ${km} كم.`,
  eachBlock: "كل مربّع ماتش",

  distanceEyebrow: "المسافة",
  strongerHead: "خلّصت أقوى ما بلّشت.",
  strongerBody: (m: string) => `${m} م بآخر 10 دقايق، أكثر من أي فترة ثانية.`,
  strongestHead: (from: number, to: number) => `أقوى 10 دقايق إلك: من الدقيقة ${from} لـ ${to}.`,
  strongestBody: (m: string) => `${m} م بهالفترة.`,

  ranksHead: "ترتيبك بالملعب",
  players: (n: number) => arCount(n, "لاعب واحد", "لاعبين", "لاعبين", "لاعب"),
  fullTable: "الجدول كامل",
  ofN: (v: string, of: number) => `${v} من ${of}`,

  styleEyebrow: (n: number) => `أسلوب لعبك · آخر ${arCount(n, "ماتش", "ماتشين", "ماتشات", "ماتش")}`,
  styleHead: { passer: "ممرّر أكثر من مراوغ.", dribbler: "مراوغ أكثر من ممرّر.", shooter: "دايمًا عينك عالمرمى.", allRounder: "شوي من كل إشي." },
  styleBody: (touches: number, share: string) => `من أصل ${arCount(touches, "لمسة وحدة", "لمستين", "لمسات", "لمسة")} إلك، ${share} كانت تمريرات.`,
  passes: "تمريرات",
  dribbles: "مراوغات",
  shotsOnTarget: "على المرمى",
  otherTouches: "لمسات ثانية",

  challengeEyebrow: (when: string, time: string, field: string) => `${when} · ${time} · ${field}`,
  challengeHead: {
    passesCompleted: (n: string, when: string) => `مرّر ${n} تمريرة صحيحة ${when}.`,
    dribblesWon: (n: string, when: string) => `راوغ ${n} مرات ${when}.`,
    touches: (n: string, when: string) => `المس الكرة ${n} مرة ${when}.`,
    distanceKm: (n: string, when: string) => `اركض ${n} كم ${when}.`,
  },
  challengeBody: (avg: string, target: string) => `معدّلك ${avg}. الـ${target} بتكسر رقمك، وبتعرف النتيجة بعد الصافرة بحوالي 20 دقيقة.`,
  average: "معدّل",
  best: "أحسن",
  target: "الهدف",
  openMatch: "افتح الماتش",

  dribblesEyebrow: "المراوغات",
  won: "نجحت",
  dribblesBody: (tries: number, won: number) => `حاولت تراوغ ${arCount(tries, "مرة وحدة", "مرتين", "مرات", "مرة")} ونجحت ${arCount(won, "مرة وحدة", "مرتين", "مرات", "مرة")}.`,
  onlyMore: (name: string) => ` بس ${name} نجح أكثر.`,
  rankBadge: (rank: number, metric: string) => `#${rank} ${metric}`,

  matchesEyebrow: "ماتشات لعبتها",
  matchesBody: (makes: string | null) => `بـ3 أسابيع.${makes ? ` ${makes}` : ""}`,
  makes: (when: string, n: number) => `${when} بتصير ${n}.`,
  weekdays: ["ن", "ث", "ر", "خ", "ج", "س", "ح"],

  shotsEyebrow: "التسديدات على المرمى",
  shotsBody: "اضغط على الوقت لتشوفها. الكاميرا ما بتلقط كل تسديدة.",
  watchThem: "شوفهم",

  trendEyebrow: "التمرير · آخر 3 ماتشات",
  trendBody: "تمريراتك عم توصل لزملائك أكثر كل ماتش.",

  teamEyebrow: "فريقك",
  teamHead: (share: number) => share >= 0.45 ? "نص تمريرات فريقك مرّت عن طريقك." : share >= 0.3 ? "ثلث تمريرات فريقك مرّت عن طريقك." : share >= 0.23 ? "ربع تمريرات فريقك مرّت عن طريقك." : `${Math.round(share * 100)}% من تمريرات فريقك مرّت عن طريقك.`,
  teamBody: (mine: number, total: number, next: number | null) => `${mine} من ${total} تمريرة صحيحة لفريقك.${next !== null ? ` اللي بعدك: ${next}.` : ""}`,

  duelEyebrow: "المراوغات الناجحة",
  duelHead: (name: string, diff: number, theyWon: boolean) => theyWon ? `${name} غلبك بـ${diff}.` : `غلبت ${name} بـ${diff}.`,
  duelLine: (won: number, tries: number, pct: number) => `${won} من ${tries} · ${pct}%`,
  duelNote: "هو حاول أكثر. إنت خسرت الكرة أقل.",
  vs: "ضد",

  weekEyebrow: "هالأسبوع",
  weekHead: (n: number, km: string) => `${arCount(n, "ماتش واحد", "ماتشين", "ماتشات", "ماتش")}، ${km} كم.`,
  touchesLabel: "لمسات",
  passesCompleted: "تمريرات صحيحة",
  dribblesWon: "مراوغات ناجحة",
  shotsLabel: "تسديدات على المرمى",
  of: "من",

  friendsHead: (names: string[]) => `${names.length === 2 ? `${names[0]} و${names[1]}` : `${names.slice(0, -1).join("، ")} و${names.at(-1)}`} عندهم أرقامهم. وين أرقامك؟`,
  friendsBody: "إنت كمان لعبت بهالماتش. لاقي حالك وشوف وين إنت منهم.",
  claimStats: "لاقي حالك",
  cols: { km: "كم", top: "أعلى سرعة", shots: "تسديدات", dribbles: "مراوغات" },

  nobodyHead: "لسا ما حدا لاقى حاله بهالماتش.",
  nobodyBody: "مين ركض أكثر؟ مين كان أسرع؟ كون أول واحد يلاقي حاله، وحط الأرقام اللي لازم الكل يكسرها.",
  claimMatch: "لاقي حالك",
  topSpeed: "أعلى سرعة",
  distanceRan: "المسافة",
  shotsOnGoal: "تسديدات على المرمى",
  successfulDribbles: "مراوغات ناجحة",
};

export function useTileCopy(): TileStrings & { locale: "en" | "ar" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale };
}

export type { TileStrings };
/** For tests: the two copies side by side. */
export const tileCopies = { en, ar };
