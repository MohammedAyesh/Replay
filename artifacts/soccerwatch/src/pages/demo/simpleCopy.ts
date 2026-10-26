/**
 * Words for the short /demo (2026-10-26: "make it simpler, and make the value
 * clear, it's too long"). Arabic first, in the Ammani register; the long page
 * lives on at /demo/full with its own copy (copy.ts).
 */
import type { DemoLocale, Persona } from "./copy";

type PersonaText = Record<Persona, string>;

export type SimpleCopy = {
  kicker: PersonaText;
  title: PersonaText;
  lead: PersonaText;
  valuesTitle: string;
  values: Record<Persona, Array<{ title: string; body: string; stat?: "returnRate" }>>;
  clipsTitle: PersonaText;
  clipsNote: PersonaText;
  phoneCaption: PersonaText;
  statsTitle: string;
  statsNote: (date: string) => string;
  stats: {
    score: string;
    possession: string;
    shots: string;
    players: string;
    furthest: string;
    fastest: string;
    km: string;
    kmh: string;
  };
  ads: { slider: string; fee: string; headline: string; reach: string };
  moneyTitle: string;
  inputs: Record<Persona, { a: string; b: string }>;
  assumption: PersonaText;
  perMonth: string;
  perYear: (value: string) => string;
  alsoTitle: string;
  also: Array<{ title: string; body: string }>;
  setup: string;
  full: string;
  fullBody: string;
  howTitle: string;
  parts: Record<Persona, Array<{ title: string; detail: (n: string, unit: string) => string }>>;
};

const ar: SimpleCopy = {
  kicker: { pitch: "لأصحاب الملاعب", academy: "للأكاديميات" },
  title: {
    pitch: "خلّي لاعبينك\nيسوّقوا لملعبك.",
    academy: "خلّي لاعبينك\nيسوّقوا لأكاديميتك.",
  },
  lead: {
    pitch: "كاميرا وحدة بتصوّر كل مباراة. اللاعبين بنشروا مقاطعهم وعليها شعار ملعبك، وأصحابهم بيجوا يحجزوا عندك.",
    academy: "كل حصة مصوّرة. اللاعبين بنشروا مقاطعهم وعليها شعار الأكاديمية، والأهل بتابعوا مباشر من البيت.",
  },
  valuesTitle: "شو بتستفيد",
  values: {
    pitch: [
      { title: "إعلان ببلاش كل ليلة", body: "كل مقطع بنزّله لاعب عليه شعارك وبطاقة بتقول وين يحجزوا." },
      { title: "اللاعبين بيرجعوا", body: "من الزباين اللي بدفعوا بجوردان جالاكسي بيرجعوا يحجزوا.", stat: "returnRate" },
      { title: "ما في إشي تشغّله", body: "بتصوّر وبتقصّ وبتبعت المقاطع لحالها. موظفينك ما بعملوا إشي." },
    ],
    academy: [
      { title: "الأهل بشوفوا كل حصة", body: "مباشر من البيت، وكل مقطع عليه شعار الأكاديمية." },
      { title: "تطوّر بشوفوه", body: "كل لاعب بتوصله مسافته وسرعته وتمريراته، مباراة بعد مباراة." },
      { title: "ما في إشي تشغّله", body: "بتصوّر وبتقصّ وبتبعت المقاطع لحالها. المدربين ما بعملوا إشي." },
    ],
  },
  clipsTitle: { pitch: "مقاطع حقيقية من جوردان جالاكسي", academy: "مقاطع حقيقية، بشعار أكاديمية" },
  clipsNote: {
    pitch: "هيك بتطلع: الشعار بالزاوية وبطاقة الحجز بالآخر. الأسماء مخفية.",
    academy: "هون بشعار أكاديمية JUFA اللي بتتدرب بجوردان جالاكسي: إطار الأكاديمية وبطاقة بالآخر. الأسماء مخفية.",
  },
  phoneCaption: { pitch: "هيك بشوفها أصحابهم على الستوري.", academy: "هيك بشوفها الأهل والعيلة على الستوري." },
  statsTitle: "أرقام حقيقية من مباراة وحدة",
  statsNote: (date) => `مباراة ${date}. الكاميرا قاستها لحالها، والأسماء مخفية.`,
  stats: {
    score: "النتيجة",
    possession: "الاستحواذ",
    shots: "تسديدات",
    players: "لاعب انقاسوا",
    furthest: "أبعد مسافة للاعب",
    fastest: "أعلى سرعة",
    km: "كم",
    kmh: "كم/س",
  },
  ads: {
    slider: "إعلانات ببلاش بالشهر",
    fee: "الاشتراك الشهري (دينار)",
    headline: "إعلان ببلاش بالشهر",
    reach: "كل مقطع بنشره لاعب أو أهله إعلان لأكاديميتك، بشوفه أصحابهم وعيلتهم.",
  },
  moneyTitle: "قديش بتزيد دخلك",
  inputs: {
    pitch: { a: "حجوزات بالأسبوع", b: "سعر الحجز (دينار)" },
    academy: { a: "إعلانات ببلاش بالشهر", b: "الاشتراك الشهري (دينار)" },
  },
  assumption: {
    pitch: "على فرض إنه 4 من كل 10 حجوزات بدفعوا 3 دنانير زيادة عشان تتصوّر، وحجز زيادة بالأسبوع من المقاطع اللي بتنتشر.",
    academy: "على فرض إنه كل 50 مقطع بنتشر بجيب لاعب جديد واحد.",
  },
  perMonth: "دينار زيادة بالشهر",
  perYear: (value) => `يعني حوالي ${value} دينار بالسنة`,
  alsoTitle: "وكمان",
  also: [
    { title: "بث مباشر", body: "أصحابهم وأهلهم بتابعوا من البيت." },
    { title: "أرقام كل لاعب", body: "مسافة، سرعة، تمريرات، من الكاميرا." },
    { title: "أي ساعة فاتت", body: "بتطلبها وبتوصلك عالواتساب." },
  ],
  setup: "زيارة وحدة للتركيب: منركّب كاميرا وحدة، بتشتغل على الإنترنت اللي عندك، والتصوير ببلّش لحاله.",
  full: "شوف الديمو كامل",
  fullBody: "جرّب الكاميرا بإيدك: تنقّل بالملعب كامل، شوف البث المباشر، وشوف أرقام كل لاعب من مباراة حقيقية.",
  howTitle: "من وين بتجي الزيادة",
  parts: {
    pitch: [
      { title: "اللاعبين بدفعوا زيادة عشان المباراة تتصوّر", detail: (n, unit) => `${n} مباراة مصوّرة بالشهر × ${unit} دنانير زيادة` },
      { title: "المقاطع اللي بتنتشر بتجيب حجوزات جديدة", detail: (n, unit) => `${n} حجوزات زيادة بالشهر × ${unit} دينار` },
    ],
    academy: [
      { title: "المقاطع اللي بتنتشر بتجيب لاعبين جداد", detail: (n, unit) => `${n} لاعب جديد بالشهر × ${unit} دينار` },
    ],
  },
};

const en: SimpleCopy = {
  kicker: { pitch: "For pitch owners", academy: "For academies" },
  title: {
    pitch: "Let your players\nmarket your pitch.",
    academy: "Let your players\nmarket your academy.",
  },
  lead: {
    pitch: "One camera films every match. Players share their clips with your logo on them, and their friends book with you.",
    academy: "Every session filmed. Players share clips with your badge on them, and parents watch live from home.",
  },
  valuesTitle: "What you get",
  values: {
    pitch: [
      { title: "Free ads every night", body: "Every clip a player posts carries your logo and a card that says where to book." },
      { title: "Players come back", body: "of paying customers at Jordan Galaxy book again.", stat: "returnRate" },
      { title: "Nothing to run", body: "It films, cuts and sends the clips on its own. Your staff do nothing." },
    ],
    academy: [
      { title: "Parents see every session", body: "Live from home, and every clip carries your badge." },
      { title: "Progress they can see", body: "Each player gets his distance, speed and passes, game after game." },
      { title: "Nothing to run", body: "It films, cuts and sends the clips on its own. Your coaches do nothing." },
    ],
  },
  clipsTitle: { pitch: "Real clips from Jordan Galaxy", academy: "Real clips, with an academy's badge" },
  clipsNote: {
    pitch: "This is how they go out: the crest in the corner, a booking card at the end. Names hidden.",
    academy: "Shown with the badge of JUFA, an academy that trains at Jordan Galaxy: the academy frame, and a card at the end. Names hidden.",
  },
  phoneCaption: { pitch: "This is how their friends see it on a story.", academy: "This is how parents and family see it on a story." },
  statsTitle: "Real numbers from one match",
  statsNote: (date) => `${date}. Measured by the camera on its own; names hidden.`,
  stats: {
    score: "Score",
    possession: "Possession",
    shots: "Shots",
    players: "players measured",
    furthest: "Furthest run",
    fastest: "Top speed",
    km: "km",
    kmh: "km/h",
  },
  ads: {
    slider: "Free ads a month",
    fee: "Monthly fee (JOD)",
    headline: "free ads a month",
    reach: "Every clip a player or parent shares is an ad for your academy, seen by their friends and family.",
  },
  moneyTitle: "What it adds",
  inputs: {
    pitch: { a: "Bookings a week", b: "Booking price (JOD)" },
    academy: { a: "Free ads a month", b: "Monthly fee (JOD)" },
  },
  assumption: {
    pitch: "Assumes 4 in 10 bookings pay 3 JOD more to be filmed, and one extra booking a week from shared clips.",
    academy: "Assumes one new player for every 50 clips shared.",
  },
  perMonth: "JOD more a month",
  perYear: (value) => `About ${value} JOD a year`,
  alsoTitle: "Also included",
  also: [
    { title: "Live", body: "Friends and family watch from home." },
    { title: "Player stats", body: "Distance, speed and passes, from the camera." },
    { title: "Any past hour", body: "Ask for it and get it on WhatsApp." },
  ],
  setup: "One visit to set up: we mount one camera, it uses the internet you already have, and recording starts on its own.",
  full: "See the full demo",
  fullBody: "Try the camera yourself: look around the whole pitch, watch live, and see every player's numbers from a real match.",
  howTitle: "Where the extra comes from",
  parts: {
    pitch: [
      { title: "Players pay more to have the match filmed", detail: (n, unit) => `${n} filmed matches a month × ${unit} JOD more` },
      { title: "Shared clips bring new bookings", detail: (n, unit) => `${n} extra bookings a month × ${unit} JOD` },
    ],
    academy: [
      { title: "Shared clips bring in new players", detail: (n, unit) => `${n} new players a month × ${unit} JOD` },
    ],
  },
};

export const simpleCopy: Record<DemoLocale, SimpleCopy> = { ar, en };
