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
  clipsTitle: string;
  clipsNote: string;
  moneyTitle: string;
  inputs: Record<Persona, { a: string; b: string }>;
  assumption: PersonaText;
  perMonth: string;
  perYear: (value: string) => string;
  alsoTitle: string;
  also: Array<{ title: string; body: string }>;
  setup: string;
  full: string;
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
  clipsTitle: "مقاطع حقيقية من جوردان جالاكسي",
  clipsNote: "هيك بتطلع: الشعار بالزاوية وبطاقة الحجز بالآخر. الأسماء مخفية.",
  moneyTitle: "قديش بتزيد دخلك",
  inputs: {
    pitch: { a: "حجوزات بالأسبوع", b: "سعر الحجز (دينار)" },
    academy: { a: "عدد اللاعبين", b: "الاشتراك الشهري (دينار)" },
  },
  assumption: {
    pitch: "على فرض إنه 4 من كل 10 حجوزات بدفعوا 3 دنانير زيادة عشان تتصوّر، وحجز زيادة بالأسبوع من المقاطع اللي بتنتشر.",
    academy: "على فرض إنه كل لاعب بدفع 3 دنانير زيادة بالشهر للحصص المصوّرة، ولاعبين جداد بالشهر من المقاطع اللي بتنتشر.",
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
  clipsTitle: "Real clips from Jordan Galaxy",
  clipsNote: "This is how they go out: the crest in the corner, a booking card at the end. Names hidden.",
  moneyTitle: "What it adds",
  inputs: {
    pitch: { a: "Bookings a week", b: "Booking price (JOD)" },
    academy: { a: "Players", b: "Monthly fee (JOD)" },
  },
  assumption: {
    pitch: "Assumes 4 in 10 bookings pay 3 JOD more to be filmed, and one extra booking a week from shared clips.",
    academy: "Assumes each player pays 3 JOD a month more for filmed sessions, and 2 new players a month from shared clips.",
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
};

export const simpleCopy: Record<DemoLocale, SimpleCopy> = { ar, en };
