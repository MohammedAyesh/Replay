import { useLocale } from "./context";
import { arCount } from "./ar-count";
import type { ReportMetric } from "@/lib/match-report";

/**
 * Copy for the compact and sheet match-report layouts (Admin → Settings →
 * Match report layout). Numbers arrive formatted and are wrapped LTR by the
 * page. Arabic is Ammani, like the rest of the report.
 */

const ordinalEn = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
};

type TopMetric = ReportMetric;

const en = {
  km: "km",
  kmh: "km/h",
  played: (n: number) => `${n} played`,
  scoreNotIn: "score not in",
  watchMatch: "Watch the match",
  yourMoments: "your moments",
  goalsToCheck: (n: number) => (n === 1 ? "1 likely goal to check" : `${n} likely goals to check`),
  chancesToCheck: (n: number) => (n === 1 ? "Was it a goal? 1 chance to check" : `Was it a goal? ${n} chances to check`),
  onCamera: (on: number, total: number) => `on camera ${on} of ${total}′`,

  personalBest: "Personal best",
  twoBests: "2 personal bests",
  pb: "PB",
  watchIt: "Watch it",
  headlineTwoBests: "Your fastest and furthest game yet.",
  headlineTopToo: "Top of the pitch too.",
  headlineBest: { topSpeed: "The fastest you've ever run.", distance: "The furthest you've ever run." } as Record<"topSpeed" | "distance", string>,
  headlineOnPitch: (metric: "topSpeed" | "distance", shared: boolean): string =>
    metric === "topSpeed" ? (shared ? "Joint fastest on the pitch." : "Fastest on the pitch.") : (shared ? "Joint most ground on the pitch." : "Most ground on the pitch."),
  headlineTop: (metric: TopMetric, shared: boolean): string => {
    const joint = shared ? "Joint " : "";
    switch (metric) {
      case "topSpeed": return `${joint}${shared ? "fastest" : "Fastest"} on the pitch.`;
      case "distanceRate": case "distance": return `${joint}${shared ? "most" : "Most"} ground covered on the pitch.`;
      case "dribblesWon": return `${joint}${shared ? "most" : "Most"} dribbles won on the pitch.`;
      case "passes": return `${joint}${shared ? "most" : "Most"} passes completed on the pitch.`;
      case "touchRate": case "touches": return shared ? "Joint most on the ball." : "On the ball more than anyone.";
      default: return shared ? "Joint top scorer." : "Top scorer.";
    }
  },
  headlineRank: (metric: TopMetric, rank: number, shared: boolean): string => {
    const place = `${shared ? "Joint " : ""}${ordinalEn(rank)}`;
    switch (metric) {
      case "topSpeed": return `${place} fastest on the pitch.`;
      case "distanceRate": return `${place} for ground covered.`;
      default: return `${place} for time on the ball.`;
    }
  },
  headlineTotal: "covered in this match.",

  distance: "distance",
  topSpeed: "top speed",
  passes: "passes",
  dribbles: "dribbles won",
  touchesPer10: "touches /10′",
  rank: (rank: number, shared: boolean, of: number) => (shared ? (rank === 1 ? "Joint 1st" : `Joint ${ordinalEn(rank)}`) : `${ordinalEn(rank)} of ${of}`),
  notRanked: "not ranked",
  topIs: (value: string) => `top: ${value}`,
  offTop: (gap: number) => (gap === 1 ? "1 off the top" : `${gap} off the top`),
  vsLast: (n: number) => (n === 1 ? "vs your last match:" : `vs your last ${n}:`),
  further: "further",
  less: "less ground",
  faster: "faster",
  slower: "slower",
  moreTouches: "more touches",
  fewerTouches: "fewer touches",
  sameTouches: "same touches",
  sameGround: "same ground",
  sameSpeed: "same speed",

  board: "Pitch board",
  boardMetric: { topSpeed: "Speed", distanceRate: "km", touchRate: "Touches", passes: "Passes", dribblesWon: "Dribbles" } as Partial<Record<ReportMetric, string>>,
  boardUnit: { topSpeed: "km/h", distanceRate: "km per 10 min", touchRate: "touches per 10 min", passes: "passes completed", dribblesWon: "dribbles won" } as Partial<Record<ReportMetric, string>>,
  boardTie: (n: number) => `Top ${n} are too close to call, so they share 1st.`,
  notFoundYet: (n: number) => (n === 1 ? "1 not found yet" : `${n} not found yet`),
  you: "You",

  more: "More stats",
  splits: "Ten minutes at a time",
  headToHead: "Head to head",
  everyone: "Everyone on the pitch",
  sides: "The two sides",
  sidesBeta: "Beta",

  reelTitle: "Your reel",
  makeReel: "Make a reel of this match",
  reelClips: (n: number) => (n === 1 ? "1 clip of yours from this match" : `${n} clips of yours from this match`),
  reelNeedClips: "Cut 2 clips from this match to make a reel",
  cutClips: "Cut clips",

  sheetTitle: "Your match sheet",
  colStat: "Stat",
  colYou: "You",
  colPitch: "On the pitch",
  colForm: (n: number) => (n === 1 ? "vs last" : `vs last ${n}`),
  rowDistance: "Distance",
  rowSpeed: "Top speed",
  rowPasses: "Passes",
  rowDribbles: "Dribbles won",
  rowTouches: "Touches",
  rowSecondHalf: "2nd half",
  completed: (pct: number) => `${pct}% completed`,
  possession: "Possession",
  sprint: "Sprint",
  dribble: "Dribble",
  goal: "Goal",
};

type LayoutStrings = typeof en;

const ar: LayoutStrings = {
  km: "كم",
  kmh: "كم/س",
  played: (n: number) => `${arCount(n, "لاعب واحد", "لاعبين", "لاعبين", "لاعب")} لعبوا`,
  scoreNotIn: "النتيجة لسا ما انحطت",
  watchMatch: "شوف الماتش",
  yourMoments: "لحظاتك",
  goalsToCheck: (n: number) => (n === 1 ? "في هدف محتمل لازم تأكده" : `في ${arCount(n, "هدف", "هدفين", "أهداف", "هدف")} محتملة لازم تأكدها`),
  chancesToCheck: (n: number) => `كان جول؟ ${arCount(n, "فرصة وحدة", "فرصتين", "فرص", "فرصة")} لازم تتأكد منها`,
  onCamera: (on: number, total: number) => `عالكاميرا ${on} من ${total} دقيقة`,

  personalBest: "أحسن رقم إلك",
  twoBests: "رقمين قياسيين إلك",
  pb: "أحسن رقم",
  watchIt: "شوفها",
  headlineTwoBests: "أسرع وأطول ماتش إلك لحد هلأ.",
  headlineTopToo: "وإنت فوق بالملعب كمان.",
  headlineBest: { topSpeed: "أسرع ما ركضت لحد هلأ.", distance: "أكثر مسافة ركضتها لحد هلأ." },
  headlineOnPitch: (metric: "topSpeed" | "distance", shared: boolean) =>
    metric === "topSpeed" ? (shared ? "ومن أسرع اللاعبين بالملعب." : "وأسرع واحد بالملعب.") : (shared ? "ومن أكثر اللي ركضوا بالملعب." : "وأكثر واحد ركض بالملعب."),
  headlineTop: (metric: TopMetric, shared: boolean) => {
    switch (metric) {
      case "topSpeed": return shared ? "من أسرع اللاعبين بالملعب." : "أسرع واحد بالملعب.";
      case "distanceRate": case "distance": return shared ? "من أكثر اللي ركضوا بالملعب." : "أكثر واحد ركض بالملعب.";
      case "dribblesWon": return shared ? "من أكثر اللي راوغوا بالملعب." : "أكثر واحد راوغ بالملعب.";
      case "passes": return shared ? "من أكثر اللي مرروا صح." : "أكثر واحد مرر صح بالملعب.";
      case "touchRate": case "touches": return shared ? "من أكثر اللي لمسوا الطابة." : "أكثر واحد لمس الطابة.";
      default: return shared ? "من هدافين الماتش." : "هداف الماتش.";
    }
  },
  headlineRank: (metric: TopMetric, rank: number, shared: boolean) => {
    const place = `المركز ${rank}${shared ? " مشترك" : ""}`;
    switch (metric) {
      case "topSpeed": return `${place} بالسرعة بالملعب.`;
      case "distanceRate": return `${place} بالمسافة بالملعب.`;
      default: return `${place} باللمسات بالملعب.`;
    }
  },
  headlineTotal: "ركضتهم بهالماتش.",

  distance: "المسافة",
  topSpeed: "أعلى سرعة",
  passes: "تمريرات",
  dribbles: "مراوغات نجحت",
  touchesPer10: "لمسات كل 10 د",
  rank: (rank: number, shared: boolean, of: number) => (shared ? (rank === 1 ? "الأول مشترك" : `المركز ${rank} مشترك`) : `المركز ${rank} من ${of}`),
  notRanked: "بدون ترتيب",
  topIs: (value: string) => `الأعلى: ${value}`,
  offTop: (gap: number) => (gap === 1 ? "ناقصك وحدة للأول" : `ناقصك ${gap} للأول`),
  vsLast: (n: number) => (n === 1 ? "مقارنة بآخر ماتش:" : `مقارنة بآخر ${arCount(n, "ماتش", "ماتشين", "ماتشات", "ماتش")}:`),
  further: "ركضت أكثر",
  less: "ركضت أقل",
  faster: "أسرع",
  slower: "أبطأ",
  moreTouches: "لمسات أكثر",
  fewerTouches: "لمسات أقل",
  sameTouches: "نفس اللمسات",
  sameGround: "نفس المسافة",
  sameSpeed: "نفس السرعة",

  board: "لوحة الملعب",
  boardMetric: { topSpeed: "السرعة", distanceRate: "كم", touchRate: "لمسات", passes: "تمريرات", dribblesWon: "مراوغات" },
  boardUnit: { topSpeed: "كم/س", distanceRate: "كم كل 10 دقايق", touchRate: "لمسات كل 10 دقايق", passes: "تمريرات صحيحة", dribblesWon: "مراوغات نجحت" },
  boardTie: (n: number) => `أول ${n} قراب كثير من بعض، فكلهم بالمركز الأول.`,
  notFoundYet: (n: number) => `${arCount(n, "واحد", "اثنين", "لاعبين", "لاعب")} لسا ما لقوا حالهم`,
  you: "إنت",

  more: "أرقام أكثر",
  splits: "كل 10 دقايق لحال",
  headToHead: "وجهاً لوجه",
  everyone: "كل اللي بالملعب",
  sides: "الفريقين",
  sidesBeta: "تجريبي",

  reelTitle: "الريل تبعك",
  makeReel: "اعمل ريل من هالماتش",
  reelClips: (n: number) => `${arCount(n, "مقطع واحد", "مقطعين", "مقاطع", "مقطع")} إلك من هالماتش`,
  reelNeedClips: "قص مقطعين من هالماتش عشان تعمل ريل",
  cutClips: "قص مقاطع",

  sheetTitle: "ورقة ماتشك",
  colStat: "الرقم",
  colYou: "إنت",
  colPitch: "بالملعب",
  colForm: (n: number) => (n === 1 ? "مقارنة بآخر ماتش" : `مقارنة بآخر ${n}`),
  rowDistance: "المسافة",
  rowSpeed: "أعلى سرعة",
  rowPasses: "تمريرات",
  rowDribbles: "مراوغات نجحت",
  rowTouches: "لمسات",
  rowSecondHalf: "الشوط الثاني",
  completed: (pct: number) => `${pct}% صحيحة`,
  possession: "الاستحواذ",
  sprint: "ركضة",
  dribble: "مراوغة",
  goal: "هدف",
};

export function useReportLayoutCopy(): LayoutStrings & { locale: "en" | "ar" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale };
}

export type { LayoutStrings };
