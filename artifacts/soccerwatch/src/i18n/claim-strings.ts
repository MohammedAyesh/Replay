import { useLocale } from "./context";

/**
 * Copy for the "find yourself" claim flow.
 *
 * Kept out of strings.ts on purpose. That file is one 1100-line literal that
 * every page imports, and the claim flow is the largest single block of new
 * copy in the app; adding it there would make every merge in the flow a merge
 * in the whole app's copy. The pattern is the one match-strings.ts already
 * uses: two objects, one hook, the English object as the type.
 *
 * The claim chain (the fallback flow) is still 100% hardcoded English. Strings
 * migrated out of it belong here too, so there is one place to check an Arabic
 * screen against.
 */
const en = {
  /* Rows that offer the flow, on the field page and the match room. */
  entry: {
    claim: "Find yourself in this match",
    claimDesc: "Pick yourself out of the footage and get your own distance, energy and clips.",
    claimMeta: (minutes: number) => `About ${minutes} minutes`,
    continue: "Carry on finding yourself",
    continueDesc: (percent: number) => `${percent}% of your match is accounted for so far.`,
    result: "Your match",
    resultDesc: "Distance, energy and where you played.",
    shared: (name: string) => `Shared with ${name} — you both kept it`,
    /** The recording list does not carry the other claimant's name. */
    sharedNoName: "Shared with another player — you both kept it",
    sharedDesc: "You were both on the same stretches of footage. Nothing was taken away from either of you.",
    replaced: "This match was tracked again",
    replacedDesc: "The footage was reprocessed, so what you picked no longer lines up. Opening it starts a fresh pass.",
    replacedAction: "Start again",
    notReady: "Not ready to claim yet",
    notReadyDesc: "This recording is still being processed. It usually takes a few hours after full time.",
    expired: "The video has gone, your match hasn't",
    expiredDesc: "Footage is kept for 14 days. Your stats and clips stay.",
    open: "Open",
  },

  /* Screen 2 — the intro. */
  intro: {
    eyebrow: "Find yourself",
    title: "Four steps to your match",
    lead: "The cameras tracked everyone on the pitch. They don't know which one is you — so you tell them, once, and the rest of the match follows.",
    step1Title: "What you wore",
    step1Body: "Pick your kit. It cuts the pitch down to your side.",
    step2Title: "Which one is you",
    step2Body: "Pick yourself out of a row of photos.",
    step3Title: "Check it's all you",
    step3Body: "Strike out anything that isn't.",
    step4Title: "Join the pieces",
    step4Body: "A few side-by-sides where the camera lost you.",
    timeCost: (minutes: number) => `About ${minutes} minutes for a whole game.`,
    savedAsYouGo: "Saved as you go — you can stop any time and pick it back up.",
    start: "Start",
    resume: "Carry on",
    resumeDesc: (percent: number) => `You're ${percent}% of the way through.`,
    seeResult: "See your match",
    startOver: "Start again from the beginning",
    startOverConfirm: "Start again? What you've picked so far will be cleared.",
    notInMatch: "I wasn't in this match",
  },

  /* Screen 3 — kit. */
  kit: {
    eyebrow: "Step 1 of 4",
    title: "What were you wearing?",
    lead: "Tap the kit you played in.",
    unclaimed: (n: number) => `${n} still unclaimed`,
    found: (n: number) => `${n} already found`,
    players: (n: number) => (n === 1 ? "1 player" : `${n} players`),
    none: "No kits to show",
    noneDesc: "The tracking for this match didn't separate the teams. You can still find yourself in the video.",
    notSure: "I'm not sure — show me everyone",
    findInVideo: "Find me in the video instead",
  },

  /* Screen 4 — the gallery. */
  gallery: {
    eyebrow: "Step 2 of 4",
    title: "Which one is you?",
    lead: "Each row is one person, seen six times through the match.",
    onCamera: (text: string) => `${text} on camera`,
    seenBetween: (from: string, to: string) => `Seen between ${from} and ${to}`,
    thisIsMe: "This is me",
    takenBy: (name: string) => `Taken by ${name}`,
    takenByYou: "This is you",
    changeKit: "Wrong kit — go back",
    findInVideo: "I can't see myself — find me in the video",
    notInMatch: "I'm not in this match",
    none: "No one left to pick",
    noneDesc: "Everyone in this kit has been claimed. If one of them is you, find yourself in the video instead.",
    loading: "Loading the players…",
    failed: "That didn't load",
    failedDesc: "The tracking for this stretch didn't come through. Try again, or find yourself in the video.",
    retry: "Try again",
    moreShots: "More shots of this player",
  },

  /* Screen 6 — the name dialog, first tap only. */
  name: {
    title: "What should we call you here?",
    lead: "This is the name other players see on this match. You can change it later in your account.",
    placeholder: "Your name",
    save: "That's me",
    cancel: "Not yet — go back",
    empty: "Put a name in, or go back.",
    tooLong: "That name is too long.",
  },

  /* Screens 17b and 17c — energy. */
  energy: {
    title: "Energy",
    askTitle: "How much do you weigh?",
    askLead: "Energy is worked out from how far you ran, how fast, and your weight. Without your weight there's no honest number to show.",
    weightLabel: "Weight",
    weightUnit: "kg",
    heightLabel: "Height (optional)",
    heightUnit: "cm",
    privacy: "Kept to you. Never on your profile, never in a shared clip.",
    saveAndSee: "Work it out",
    skip: "Skip this",
    skipForever: "Don't ask again",
    skipped: "Energy is off",
    skippedDesc: "You skipped the weight question. Everything else on this screen still works.",
    turnOn: "Turn energy on",
    value: (kcal: number) => `${kcal} kcal`,
    lead: "What this game cost you.",
    why: "Worked out from your own distance, your own speeds and your own weight — not an average player's.",
    breakdown: "Where it went",
    walking: "Walking",
    jogging: "Jogging",
    running: "Running",
    sprinting: "Sprinting",
    onThePitch: "Being on the pitch",
    onThePitchWhy: "Turning, jostling, jumping, getting back up.",
    total: "Total",
    zoneRow: (km: string, kcal: number) => `${km} km · ${kcal} kcal`,
    invalidWeight: "Put in a weight between 30 and 200 kg.",
    invalidHeight: "Put in a height between 100 and 230 cm.",
  },

  /* Shared across the flow. */
  common: {
    back: "Back",
    next: "Next",
    undo: "Undo",
    cantTell: "Can't tell",
    saving: "Saving…",
    saved: "Saved as you go",
    saveFailed: "That didn't save",
    saveFailedDesc: "Your last tap didn't reach us. Nothing before it is lost.",
    tryAgain: "Try again",
    leaveForNow: "Leave it here for now",
    signedOut: "You've been signed out",
    signedOutDesc: "Sign back in and your claim will be where you left it.",
    signIn: "Sign in",
    unavailable: "Unavailable",
    coverage: (percent: number) => `${percent}% accounted for`,
    ofMatch: "of the match",
  },
};

const ar: typeof en = {
  entry: {
    claim: "لاقِ حالك بهالمباراة",
    claimDesc: "اختار حالك من التصوير وخُد مسافتك وطاقتك ومقاطعك.",
    claimMeta: (minutes: number) => `حوالي ${minutes} دقائق`,
    continue: "كمّل تلاقي حالك",
    continueDesc: (percent: number) => `صار محسوب ${percent}% من مباراتك.`,
    result: "مباراتك",
    resultDesc: "المسافة والطاقة ووين لعبت.",
    shared: (name: string) => `مشتركة مع ${name} — والاثنين ضلّت إلهم`,
    sharedNoName: "مشتركة مع لاعب تاني — والاثنين ضلّت إلكم",
    sharedDesc: "كنتوا الاثنين بنفس المقاطع. ما انسحب إشي من حدا فيكم.",
    replaced: "هالمباراة انتتبّعت من جديد",
    replacedDesc: "التصوير انعالج مرة تانية، فاللي اخترته ما عاد ينطبق. لما تفتحها بتبلّش من جديد.",
    replacedAction: "ابدأ من جديد",
    notReady: "لسا ما جهزت",
    notReadyDesc: "هالتسجيل لسا عم ينعالج. عادةً بياخد كم ساعة بعد نهاية المباراة.",
    expired: "الفيديو راح، بس مباراتك لأ",
    expiredDesc: "التصوير بنضل ١٤ يوم. إحصائياتك ومقاطعك بتضل.",
    open: "افتح",
  },

  intro: {
    eyebrow: "لاقِ حالك",
    title: "أربع خطوات لمباراتك",
    lead: "الكاميرات تتبّعت كل اللي بالملعب، بس ما بتعرف مين فيهم إنت. بتقلّها مرة وحدة، وباقي المباراة بتمشي وراها.",
    step1Title: "شو كنت لابس",
    step1Body: "اختار طقمك. بيقلّص الملعب على فريقك.",
    step2Title: "مين فيهم إنت",
    step2Body: "اختار حالك من صف صور.",
    step3Title: "تأكّد إنه كله إنت",
    step3Body: "شطّب أي إشي مش إنت.",
    step4Title: "وصّل القطع",
    step4Body: "كم مقارنة بالمواقع اللي ضيّعتك فيها الكاميرا.",
    timeCost: (minutes: number) => `حوالي ${minutes} دقائق لمباراة كاملة.`,
    savedAsYouGo: "بينحفظ أول بأول — فيك توقف وقت ما بدك وتكمّل بعدين.",
    start: "ابدأ",
    resume: "كمّل",
    resumeDesc: (percent: number) => `وصلت لـ ${percent}% من الطريق.`,
    seeResult: "شوف مباراتك",
    startOver: "ابدأ من الأول",
    startOverConfirm: "تبدأ من جديد؟ اللي اخترته لهلق رح ينمسح.",
    notInMatch: "ما كنت بهالمباراة",
  },

  kit: {
    eyebrow: "الخطوة ١ من ٤",
    title: "شو كنت لابس؟",
    lead: "اضغط الطقم اللي لعبت فيه.",
    unclaimed: (n: number) => `${n} لسا ما حدا أخذهم`,
    found: (n: number) => `${n} تلاقوا`,
    players: (n: number) => (n === 1 ? "لاعب واحد" : `${n} لاعبين`),
    none: "ما في أطقم نعرضها",
    noneDesc: "التتبّع بهالمباراة ما فرّق بين الفريقين. بتقدر تلاقي حالك بالفيديو.",
    notSure: "مش متأكد — ورجيني الكل",
    findInVideo: "لاقيني بالفيديو بدل هيك",
  },

  gallery: {
    eyebrow: "الخطوة ٢ من ٤",
    title: "مين فيهم إنت؟",
    lead: "كل صف شخص واحد، مصوّر ست مرات خلال المباراة.",
    onCamera: (text: string) => `${text} على الكاميرا`,
    seenBetween: (from: string, to: string) => `انشاف بين ${from} و${to}`,
    thisIsMe: "هذا أنا",
    takenBy: (name: string) => `صار لـ${name}`,
    takenByYou: "هذا إنت",
    changeKit: "الطقم غلط — ارجع",
    findInVideo: "مش شايف حالي — لاقيني بالفيديو",
    notInMatch: "ما كنت بهالمباراة",
    none: "ما ضل حدا تختاره",
    noneDesc: "كل اللي بهالطقم صاروا لناس. إذا واحد فيهم إنت، لاقِ حالك بالفيديو.",
    loading: "عم نحمّل اللاعبين…",
    failed: "ما زبط التحميل",
    failedDesc: "بيانات التتبّع لهالمقطع ما وصلت. جرّب كمان مرة، أو لاقِ حالك بالفيديو.",
    retry: "جرّب كمان مرة",
    moreShots: "صور أكتر لهاللاعب",
  },

  name: {
    title: "شو نناديك هون؟",
    lead: "هذا الاسم اللي بيشوفه باقي اللاعبين بهالمباراة. بتقدر تغيّره بعدين من حسابك.",
    placeholder: "اسمك",
    save: "هذا أنا",
    cancel: "لسا — ارجع",
    empty: "اكتب اسم، أو ارجع.",
    tooLong: "الاسم طويل كتير.",
  },

  energy: {
    title: "الطاقة",
    askTitle: "قديش وزنك؟",
    askLead: "الطاقة بتنحسب من قديش ركضت وقديش كانت سرعتك ومن وزنك. بدون الوزن ما في رقم صادق نعرضه.",
    weightLabel: "الوزن",
    weightUnit: "كغم",
    heightLabel: "الطول (اختياري)",
    heightUnit: "سم",
    privacy: "بيضل عندك. لا بيظهر بملفك، ولا بأي مقطع بتشاركه.",
    saveAndSee: "احسبها",
    skip: "تخطَّ هذا",
    skipForever: "لا تسأل مرة تانية",
    skipped: "الطاقة مطفّية",
    skippedDesc: "تخطّيت سؤال الوزن. باقي الشاشة شغّالة عادي.",
    turnOn: "شغّل الطاقة",
    value: (kcal: number) => `${kcal} سعرة`,
    lead: "قديش كلّفتك هالمباراة.",
    why: "محسوبة من مسافتك إنت وسرعاتك إنت ووزنك إنت — مش من لاعب متوسط.",
    breakdown: "وين راحت",
    walking: "مشي",
    jogging: "هرولة",
    running: "ركض",
    sprinting: "سرعة قصوى",
    onThePitch: "وجودك بالملعب",
    onThePitchWhy: "لفّات واحتكاك ونطّ وقيام بعد الوقعة.",
    total: "المجموع",
    zoneRow: (km: string, kcal: number) => `${km} كم · ${kcal} سعرة`,
    invalidWeight: "حط وزن بين ٣٠ و٢٠٠ كغم.",
    invalidHeight: "حط طول بين ١٠٠ و٢٣٠ سم.",
  },

  common: {
    back: "رجوع",
    next: "التالي",
    undo: "تراجع",
    cantTell: "ما بعرف",
    saving: "عم نحفظ…",
    saved: "بينحفظ أول بأول",
    saveFailed: "ما انحفظ",
    saveFailedDesc: "آخر ضغطة ما وصلتنا. اللي قبلها كله محفوظ.",
    tryAgain: "جرّب كمان مرة",
    leaveForNow: "خليها هون هلق",
    signedOut: "انقطع تسجيل دخولك",
    signedOutDesc: "سجّل دخول من جديد وبترجع من نفس المكان.",
    signIn: "سجّل دخول",
    unavailable: "غير متوفّر",
    coverage: (percent: number) => `${percent}% محسوب`,
    ofMatch: "من المباراة",
  },
};

export type ClaimStrings = typeof en;

export function useClaimCopy(): ClaimStrings & { locale: "en" | "ar"; isRtl: boolean } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale, isRtl: locale === "ar" };
}

export { en as claimStringsEn, ar as claimStringsAr };
