/**
 * Words for the public demo (/demo), Arabic first.
 *
 * The Arabic is written in the Jordanian register players and pitch owners
 * actually use, not translated MSA. Every factual claim here is true of the
 * running system; anything that depends on a deal (Replay's own price, a
 * trial) is left for the call rather than promised on the page.
 */

export type Persona = "pitch" | "academy";
export type DemoLocale = "ar" | "en";

type PersonaText = Record<Persona, string>;

export interface DemoCopy {
  brand: string;
  switchLanguage: string;
  getCamera: string;
  personaQuestion: string;
  personas: PersonaText;
  hero: {
    kicker: PersonaText;
    title: PersonaText;
    body: PersonaText;
    scroll: string;
  };
  proof: {
    returnRate: string;
    recordings: string;
    clips: string;
    analysed: string;
    note: string;
  };
  sections: {
    clips: { kicker: string; title: PersonaText; body: string; bodyBranded: string; loss: string; mute: string; unmute: string; play: string; pause: string; loading: string };
    social: {
      kicker: string;
      title: PersonaText;
      body: PersonaText;
      nameLabel: PersonaText;
      defaultName: PersonaText;
      tryTitle: PersonaText;
      namePlaceholder: PersonaText;
      duringClip: string;
      endOfClip: string;
      points: Record<Persona, string[]>;
      endBook: PersonaText;
      endFilmed: string;
      platforms: string;
      sample: string;
      lookLabel: string;
      looks: { galaxy: string; custom: string };
      colorLabel: string;
      colorHint: string;
      previewKicker: string;
      previewDescription: PersonaText;
      aspectLabel: string;
      showcases: Record<"cornerCrest" | "broadcastBar" | "academyFrame" | "signOff" | "player" | "match" | "academy", string>;
    };
    players: {
      kicker: string;
      title: PersonaText;
      body: string;
      pick: string;
      vsAverage: string;
      average: string;
      rank: (rank: number, total: number) => string;
      trendTitle: string;
      trendNote: string;
      trendMetric: string;
      thisGame: string;
      gameLabel: (n: number) => string;
      passes: string;
      leaderboard: string;
      previous: string;
      next: string;
      of: (index: number, total: number) => string;
      best: string;
    };
    tryIt: {
      kicker: string;
      title: string;
      body: (date: string) => string;
      bodyNoDate: string;
      start: string;
      loading: string;
      failed: string;
      retry: string;
      tabs: { look: string; moments: string; clip: string; var: string };
      whole: string;
      zoomIn: string;
      zoomOut: string;
      dragHint: string;
      fullscreen: string;
      exitFullscreen: string;
      goal: string;
      shot: string;
      momentsNote: string;
      momentsLoading: string;
      momentsNone: string;
      clip: {
        vertical: string;
        horizontal: string;
        markStart: string;
        markEnd: string;
        play: string;
        again: string;
        length: (seconds: string) => string;
        needStart: string;
        needEnd: string;
        done: string;
      };
      varTab: {
        back: string;
        slow: string;
        normal: string;
        goal: string;
        noGoal: string;
        decision: (verdict: string) => string;
        note: string;
      };
    };
    live: {
      kicker: string;
      title: PersonaText;
      liveBadge: string;
      camera: string;
      following: string;
      offTitle: string;
      offBody: string;
      delay: string;
      checking: string;
      body: PersonaText;
      demoNote: string;
      realLive: string;
      backToDemo: string;
      family: string;
      familyAlt: string;
      teamA: string;
      teamB: string;
    };
    report: {
      kicker: string;
      title: PersonaText;
      body: (date: string) => string;
      loading: string;
      teamA: string;
      teamB: string;
      possession: string;
      passes: string;
      shots: string;
      goals: string;
      dribbles: string;
      player: string;
      minutes: string;
      distance: string;
      topSpeed: string;
      touches: string;
      heatmap: (label: string) => string;
      tapRow: string;
      find: string;
      km: string;
      kmh: string;
    };
    tools: {
      kicker: string;
      title: PersonaText;
      items: Record<Persona, Array<{ title: string; body: string }>>;
    };
    numbers: {
      kicker: string;
      title: PersonaText;
      pitch: { bookings: string; extra: string; share: string; price: string; extraBookings: string };
      fromFilmed: string;
      fromBookings: string;
      fromFees: string;
      fromNewPlayers: string;
      academy: { players: string; extra: string; newPlayers: string; fee: string };
      result: string;
      perYear: (value: string) => string;
      formulaPitch: string;
      formulaAcademy: string;
      note: string;
    };
    setup: {
      kicker: string;
      title: string;
      steps: string[];
      faqTitle: string;
      faq: Record<Persona, Array<{ q: string; a: string }>>;
    };
    contact: {
      title: PersonaText;
      body: string;
      bodyWhatsapp: string;
      whatsapp: string;
      whatsappMessage: PersonaText;
      name: string;
      place: PersonaText;
      phone: string;
      send: string;
      sending: string;
      sent: string;
      error: string;
      noChannel: string;
    };
  };
  footer: string;
  jod: string;
  sectionNav: string;
  tabs: { demo: string; story: string };
  bridge: { body: string; action: string };
  story: {
    title: string;
    subtitle: string;
    chapters: Record<Persona, Array<{ time: string; body: string; visual: "panorama" | "phone" | "clip" | "chat" | "booking" | "progress" }>>;
    closing: PersonaText;
    exampleNote: string;
    visualFallback: string;
    flywheel: { title: string; steps: Record<Persona, string[]>; returnLabel: string; clipsLabel: string; atLabel: string };
    revenueTitle: string;
    revenueCards: Record<Persona, Array<{ title: string; body: string; driver: string; driverIndex: 0 | 1 }>>;
    calculatorExampleNote: string;
    nav: { timeline: string; flywheel: string; revenue: string; calculator: string };
    endScreensTitle: string;
    loading: string;
  };
}

const ar: DemoCopy = {
  brand: "ريبلاي",
  switchLanguage: "English",
  getCamera: "بدي كاميرا",
  personaQuestion: "شو عندك؟",
  personas: { pitch: "عندي ملعب", academy: "عندي أكاديمية" },
  hero: {
    kicker: { pitch: "ريبلاي لأصحاب الملاعب", academy: "ريبلاي للأكاديميات" },
    title: {
      pitch: "خلّي لاعبينك\nيسوّقوا لملعبك.",
      academy: "خلّي لاعبينك\nيسوّقوا لأكاديميتك.",
    },
    body: {
      pitch: "كاميرا وحدة بتصوّر كل مباراة. كل لاعب بتوصله مقاطعه جاهزة وعليها شعار ملعبك، بنشرها لأصحابه، وهمّ بيجوا يلعبوا عندك.",
      academy: "كل حصة مصوّرة. كل لاعب بتوصله مقاطعه وعليها شعار الأكاديمية، الأهل بتابعوا مباشر من البيت، واللاعب بشوف أرقامه بتتحسن من مباراة لمباراة.",
    },
    scroll: "انزل تشوف",
  },
  proof: {
    returnRate: "بملعب جوردان جالاكسي، من الزباين اللي بدفعوا بيرجعوا يحجزوا",
    recordings: "تسجيل محفوظ",
    clips: "مقطع قصّه اللاعبين",
    analysed: "مباراة حللها الذكاء الاصطناعي",
    note: "اللي بدّه فيديو لمبارياته، بضل يرجع.",
  },
  sections: {
    clips: {
      kicker: "من اللاعبين",
      title: { pitch: "كل مقطع إعلان لملعبك", academy: "كل مقطع إعلان لأكاديميتك" },
      body: "مقاطع حقيقية قصّها لاعبين في جوردان جالاكسي، وبتوصل لكل لاعب أوتوماتيك. أخفينا الأسماء.",
      bodyBranded: "مقاطع حقيقية قصّها لاعبين في جوردان جالاكسي: الشعار بالزاوية وبطاقة الحجز بالآخر، وبتوصل لكل لاعب أوتوماتيك. أخفينا الأسماء.",
      loss: "بدون كاميرا، كل مباراة على ملعبك الليلة بتخلص وما بيضل منها إشي.",
      mute: "اكتم الصوت",
      unmute: "شغّل الصوت",
      play: "شغّل",
      pause: "وقّف",
      loading: "عم بحمّل",
    },
    social: {
      kicker: "سوشال ميديا",
      title: { pitch: "كل مقطع إعلان لملعبك", academy: "كل مقطع إعلان لأكاديميتك" },
      body: {
        pitch: "بعد الصافرة، كل لاعب بتوصله مقاطعه جاهزة وعليها هوية ملعبك. هاي نفس الهوية اللي بتطلع على المقاطع؛ جرّب اسم ملعبك ولونك.",
        academy: "كل لاعب بتوصله مقاطعه بهوية أكاديميتك. هاي نفس الإطارات والبطاقات اللي بتطلع على المقاطع؛ جرّب اسم أكاديميتك ولونك.",
      },
      nameLabel: { pitch: "اكتب اسم ملعبك وشوفه على المقاطع", academy: "اكتب اسم أكاديميتك وشوفه على المقاطع" },
      defaultName: { pitch: "ملعبك", academy: "أكاديميتك" },
      tryTitle: { pitch: "جرّبها باسم ملعبك", academy: "جرّبها باسم أكاديميتك" },
      namePlaceholder: { pitch: "اسم ملعبك", academy: "اسم أكاديميتك" },
      duringClip: "خلال المقطع",
      endOfClip: "بآخر المقطع",
      points: {
        pitch: ["أوتوماتيك: ما حدا بحتاج يمنتج إشي", "شعارك على كل مقطع", "بطاقة بالآخر فيها وين يحجزوا"],
        academy: ["أوتوماتيك لكل لاعب", "شعار الأكاديمية على كل مقطع", "بطاقة بالآخر فيها كيف يسجّلوا"],
      },
      endBook: { pitch: "احجز مباراتك الجاية", academy: "سجّل ابنك معنا" },
      endFilmed: "مصوّرة بـ ريبلاي",
      platforms: "إنستغرام · تيك توك · واتساب · سناب",
      sample: "البطاقات فيها أرقام للتوضيح؛ الصورة والهوية زي ما بتطلع بالضبط.",
      lookLabel: "شكل الهوية",
      looks: { galaxy: "هوية جوردان جالاكسي", custom: "هوية مخصّصة" },
      colorLabel: "لون الهوية",
      colorHint: "اكتب لون HEX من 6 خانات، مثل #D4FF4F.",
      previewKicker: "كيف بتطلع المقاطع",
      previewDescription: {
        pitch: "الشعار والبطاقات زي ما بتطلع على مقاطع ملعبك.",
        academy: "الإطار والبطاقات زي ما بتطلع على مقاطع الأكاديمية.",
      },
      aspectLabel: "نسبة العرض",
      showcases: {
        cornerCrest: "شارة زاوية المقطع",
        broadcastBar: "شريط البث",
        academyFrame: "إطار الأكاديمية",
        signOff: "بطاقة الختام",
        player: "مقطع لاعب",
        match: "مقطع مباراة",
        academy: "مقطع أكاديمية",
      },
    },
    players: {
      kicker: "أرقام كل لاعب",
      title: { pitch: "كل لاعب إله بطاقته", academy: "كل لاعب بشوف تطوره" },
      body: "اختار لاعب. الأرقام من نفس المباراة الحقيقية، والأسماء مخفية.",
      pick: "اختار لاعب",
      vsAverage: "مقارنة بمعدل المباراة",
      average: "المعدل",
      rank: (r, n) => `المركز ${r} من ${n}`,
      trendTitle: "آخر 5 مباريات",
      trendNote: "المباراة الأخيرة حقيقية؛ اللي قبلها مثال عشان توضح الفكرة.",
      trendMetric: "المسافة (كم)",
      thisGame: "هاي المباراة",
      gameLabel: (n) => `م${n}`,
      passes: "تمريرات وصلت",
      leaderboard: "كل اللاعبين",
      previous: "اللاعب اللي قبل",
      next: "اللاعب اللي بعد",
      of: (i, n) => `${i} من ${n}`,
      best: "الأعلى بالمباراة",
    },
    tryIt: {
      kicker: "جرّبها بإيدك",
      title: "الملعب كامل، من كاميرا وحدة",
      body: (date) => `اسحب عشان تتنقل، وقرّب على أي لاعب. هاي مباراة حقيقية بتاريخ ${date}.`,
      bodyNoDate: "اسحب عشان تتنقل، وقرّب على أي لاعب. هاي مباراة حقيقية.",
      start: "شغّل المباراة",
      loading: "عم نحمّل الفيديو…",
      failed: "الفيديو مش متاح هلأ.",
      retry: "جرّب كمان مرة",
      tabs: { look: "تنقّل", moments: "لحظات", clip: "اعمل مقطع", var: "VAR" },
      whole: "الملعب كامل",
      zoomIn: "قرّب",
      zoomOut: "بعّد",
      dragHint: "اسحب بإصبعك، وقرّب بإصبعين",
      fullscreen: "شاشة كاملة",
      exitFullscreen: "اطلع من الشاشة الكاملة",
      goal: "هدف",
      shot: "تسديدة",
      momentsNote: "الذكاء الاصطناعي لقى هاي اللحظات لحاله، بدون ما حدا يعلّم عليها.",
      momentsLoading: "عم نقرأ المباراة…",
      momentsNone: "ما لقينا أهداف أو تسديدات بهاي المباراة.",
      clip: {
        vertical: "طولي للستوري",
        horizontal: "عرضي",
        markStart: "من هون",
        markEnd: "لهون",
        play: "شوف مقطعك",
        again: "من جديد",
        length: (s) => `طول المقطع ${s}`,
        needStart: "شغّل الفيديو ووقّف عند بداية اللقطة، وبعدين اكبس «من هون».",
        needEnd: "خلّيه يكمّل، واكبس «لهون» لما تخلص اللقطة.",
        done: "هيك بطلع المقطع اللي بنشره اللاعب. بالتطبيق بنحفظه، وبقدر يحمل اسم ملعبك.",
      },
      varTab: {
        back: "−10 ثواني",
        slow: "بطيء",
        normal: "عادي",
        goal: "هدف",
        noGoal: "مش هدف",
        decision: (v) => `القرار: ${v}`,
        note: "بالمباراة المحجوزة، بترجعوا اللقطة على الجوال وهي لسا طازة، حوالي نص دقيقة ورا اللعب.",
      },
    },
    live: {
      kicker: "بث مباشر",
      title: { pitch: "الأصحاب بتابعوا من البيت", academy: "الأهل بتابعوا مباشر من البيت" },
      liveBadge: "مباشر",
      camera: "كاميرا 1 · جوردان جالاكسي",
      following: "الكاميرا بتلحق الطابة",
      offTitle: "البث مطفي هلأ",
      offBody: "بشتغل وقت المباريات. لما يكون في لعب، بتشوفه هون مباشرة.",
      delay: "البث بتأخر حوالي 20–30 ثانية عن الملعب.",
      checking: "عم نشيّك على الكاميرا…",
      body: {
        pitch: "الكاميرا بتلحق الطابة لحالها، والنتيجة والوقت على الشاشة مثل أي بث حقيقي. الأصحاب والأهل بتابعوا من جوالاتهم.",
        academy: "الأهل اللي ما قدروا ييجوا بتابعوا الحصة أو المباراة مباشر من البيت أو الشغل، والكاميرا بتلحق الطابة لحالها.",
      },
      demoNote: "عرض تجريبي من مباراة مسجّلة، بنفس شكل البث المباشر.",
      realLive: "كاميرا 1 شغّالة هلأ. شوف البث الحقيقي",
      backToDemo: "رجوع للعرض التجريبي",
      family: "الأهل بتابعوا مباراة ابنهم من الصالون.",
      familyAlt: "رسمة لعيلة قاعدة على الكنباية بتتابع مباراة مباشرة على التلفزيون",
      teamA: "أ",
      teamB: "ب",
    },
    report: {
      kicker: "بعد الصافرة",
      title: { pitch: "كل لاعب بتوصله أرقامه", academy: "كل لاعب بتوصله أرقامه" },
      body: (date) => `من مباراة حقيقية بتاريخ ${date}. الكاميرا قاستها، والأسماء مخفية.`,
      loading: "عم نحسب التقرير من المباراة… أول مرة بتاخد شوي.",
      teamA: "فريق أ",
      teamB: "فريق ب",
      possession: "الاستحواذ",
      passes: "تمريرات وصلت",
      shots: "تسديدات",
      goals: "أهداف",
      dribbles: "مراوغات ناجحة",
      player: "اللاعب",
      minutes: "دقائق",
      distance: "المسافة",
      topSpeed: "أعلى سرعة",
      touches: "لمسات",
      heatmap: (label) => `وين لعب ${label}`,
      tapRow: "اكبس على لاعب تشوف وين لعب",
      find: "اللاعب بلاقي حاله بالمباراة بكم كبسة، وأرقامه بتمشي معه.",
      km: "كم",
      kmh: "كم/س",
    },
    tools: {
      kicker: "إنت شو بتعمل",
      title: { pitch: "كله من جوالك", academy: "كله من جوال المدرب" },
      items: {
        pitch: [
          { title: "احجز مباراة تتصوّر", body: "اختار الوقت، والفيديو بجهز بعد الصافرة بحوالي 20 دقيقة." },
          { title: "اسحب أي ساعة فاتت", body: "من كاميرا الملعب مباشرة، وابعت الرابط على واتساب." },
          { title: "اسم ملعبك على المقاطع", body: "المقطع اللي بنشره اللاعب بقدر يحمل اسم ملعبك وشعاره." },
        ],
        academy: [
          { title: "راجع الحصة من فوق", body: "الملعب كامل بلقطة وحدة، عشان تشوف التمركز مش بس الأهداف." },
          { title: "مقاطع لكل لاعب", body: "كل لاعب بقص لقطاته وبجمعها بملف إله يوصل للأهل والكشّافين." },
          { title: "مقدّمة أكاديميتك", body: "كل مقطع بنزل بمقدّمة وشعار الأكاديمية." },
        ],
      },
    },
    numbers: {
      kicker: "أرقامك إنت",
      title: { pitch: "احسبها على ملعبك", academy: "احسبها على أكاديميتك" },
      pitch: {
        bookings: "حجوزات بالأسبوع",
        extra: "الزيادة اللي بتاخدها عن المباراة المصوّرة (دينار)",
        share: "كم حجز من كل 100 بختار «مصوّر»",
        price: "سعر الحجز عندك (دينار)",
        extraBookings: "حجوزات زيادة بالأسبوع من السوشال ميديا واللاعبين اللي بيرجعوا",
      },
      fromFilmed: "من المباريات المصوّرة",
      fromBookings: "من الحجوزات الزيادة",
      fromFees: "من زيادة الاشتراك",
      fromNewPlayers: "من اللاعبين الجداد",
      academy: {
        players: "عدد اللاعبين",
        extra: "زيادة شهرية لكل لاعب مقابل التصوير والتقرير (دينار)",
        newPlayers: "لاعبين جداد بالشهر من المقاطع اللي بتنتشر وكلام الأهل",
        fee: "الاشتراك الشهري (دينار)",
      },
      result: "دخل إضافي بالشهر",
      perYear: (v) => `يعني حوالي ${v} دينار بالسنة`,
      formulaPitch: "(حجوزات بالأسبوع × 4.3 × النسبة × الزيادة) + (حجوزات زيادة × 4.3 × سعر الحجز)",
      formulaAcademy: "(اللاعبين × الزيادة) + (اللاعبين الجداد × الاشتراك)",
      note: "هاي أرقامك إنت. سعر ريبلاي بنحكي فيه بالمكالمة، لأنه بعتمد على الملعب.",
    },
    setup: {
      kicker: "التركيب",
      title: "زيارة وحدة. ما في إشي تتعلمه.",
      steps: [
        "بنركّب كاميرا وحدة على عمود عالي بتشوف الملعب كامل.",
        "بدها كهربا والإنترنت اللي عندك.",
        "أول ما تشبك، التصوير بيبلش لحاله.",
      ],
      faqTitle: "أسئلة بتيجي على بالك",
      faq: {
        pitch: [
          { q: "إذا فصل الإنترنت؟", a: "الكاميرا بتسجّل على كرت ذاكرة جواتها، فالمباراة ما بتروح. بس البث المباشر بوقف لحد ما يرجع الخط." },
          { q: "مين بشوف الفيديو؟", a: "الفيديو بنتشارك برابط. إحصائيات كل لاعب ما بشوفها غير اللي لعبوا بنفس المباراة، ووقت المباراة المحجوزة البث المباشر ما بطلع للعامة." },
          { q: "الموظفين لازم يعملوا إشي؟", a: "لا. التصوير أوتوماتيكي. وإذا بدك، بتحجز مباراة مصوّرة من جوالك بدقيقة." },
          { q: "قديش الفيديو بضل محفوظ؟", a: "التسجيل الكامل بضل 14 يوم، والمقاطع اللي بقصّها اللاعبين بتضل على طول." },
          { q: "قديش بتكلّف؟", a: "بتعتمد على الملعب. بنحكيها بالمكالمة، ومنمرّ نفرجيك إياها على ملعبك." },
        ],
        academy: [
          { q: "لاعبينا صغار. مين بشوف الفيديو؟", a: "بنظبطها معكم من الأول: مين بوصله الرابط، وشو بضل جوا الأكاديمية بس." },
          { q: "المدرب بقدر يرجع لحصة الأسبوع الماضي؟", a: "آه. التسجيل الكامل بضل 14 يوم، والمقاطع اللي بتنقص بتضل على طول." },
          { q: "إذا فصل الإنترنت؟", a: "الكاميرا بتسجّل على كرت ذاكرة جواتها، فالحصة ما بتروح." },
          { q: "قديش بتكلّف؟", a: "بتعتمد على عدد اللاعبين والملاعب. بنحكيها بالمكالمة." },
        ],
      },
    },
    contact: {
      title: { pitch: "شوفها على ملعبك", academy: "شوفها بأكاديميتك" },
      body: "اترك رقمك ومنرجعلك، أو احكينا مباشرة على واتساب.",
      bodyWhatsapp: "احكينا على واتساب ومنرتّب نمرّ عليك.",
      whatsapp: "احكينا على واتساب",
      whatsappMessage: {
        pitch: "مرحبا، شفت ديمو ريبلاي وبدي أعرف أكثر عن الكاميرا لملعبي.",
        academy: "مرحبا، شفت ديمو ريبلاي وبدي أعرف أكثر عنه لأكاديميتي.",
      },
      name: "الاسم",
      place: { pitch: "اسم الملعب", academy: "اسم الأكاديمية" },
      phone: "رقم الجوال",
      send: "رجّعولي",
      sending: "عم نبعت…",
      sent: "وصلنا. رح نتواصل معك قريب.",
      error: "ما زبطت. جرّب كمان مرة أو احكينا على واتساب.",
      noChannel: "احكي مع الشخص اللي بعتلك هالرابط، وهو برتّبلك زيارة.",
    },
  },
  footer: "ريبلاي · عمّان",
  jod: "دينار",
  sectionNav: "أقسام الصفحة",
  tabs: { demo: "شوف المنتج", story: "كيف بتكسب منها" },
  bridge: { body: "شفت كيف بتشتغل. هلأ شوف كيف بتجيبلك حجوزات.", action: "شوف كيف بتكسب منها" },
  story: {
    title: "مباراة وحدة. شوف لوين بتوصل.",
    subtitle: "هاي قصة مباراة عادية على ملعبك، من الصافرة لحد الحجز الجاي.",
    chapters: {
      pitch: [
        { time: "الخميس، 10 بالليل", body: "فريقين بيلعبوا على ملعبك. الكاميرا بتصوّر لحالها، وما حدا من موظفينك بعمل إشي.", visual: "panorama" },
        { time: "بعد الصافرة بـ20 دقيقة", body: "كل لاعب بتوصله مقاطعه على جواله، جاهزة وعليها شعار ملعبك.", visual: "phone" },
        { time: "نفس الليلة", body: "واحد منهم بنزّل هدفه ستوري. أصحابه بشوفوه، وبآخره بطاقة: احجز مباراتك الجاية · [اسم ملعبك].", visual: "clip" },
        { time: "تاني يوم", body: "أصحابه بسألوه عن الملعب، وهو بيبعتلهم اللوكيشن.", visual: "chat" },
        { time: "الأسبوع الجاي", body: "فريق جديد بحجز عندك وبطلب المباراة مصوّرة، لأنه بدهم مقاطعهم كمان. وفريق الخميس؟ راجع.", visual: "booking" },
      ],
      academy: [
        { time: "السبت، الحصة", body: "الكاميرا بتصوّر الحصة كاملة، والمدرب ما بحتاج يمسك جوال.", visual: "panorama" },
        { time: "أبو سامي بالشغل", body: "بتابع ابنه مباشر من جواله.", visual: "phone" },
        { time: "بعد الحصة", body: "سامي بتوصله مقاطعه وعليها شعار الأكاديمية، وأمه بتبعتها على قروب العيلة.", visual: "clip" },
        { time: "قروب العيلة", body: "عمته بتسأله وين بيتدرب سامي، لأنها بتعرف ولد بعمره.", visual: "chat" },
        { time: "الشهر الجاي", body: "لاعب جديد بسجّل، وأهل سامي بيجددوا الاشتراك لأنهم شايفين أرقامه بتتحسن.", visual: "progress" },
      ],
    },
    closing: { pitch: "وهيك بتلف. كل مباراة بتجيب اللي بعدها.", academy: "كل حصة بتسوّق للي بعدها." },
    exampleNote: "القصة مثال لمباراة عادية. الأرقام تحت حقيقية من جوردان جالاكسي.",
    visualFallback: "مشهد توضيحي",
    flywheel: {
      title: "كل مباراة بتوصل للي بعدها",
      steps: {
        pitch: ["بلعبوا", "بتوصلهم المقاطع", "بنشروها", "أصحابهم بشوفوا ملعبك", "بحجزوا"],
        academy: ["بتتمرّنوا", "بتوصلهم المقاطع", "الأهل بنشروها", "العيلة بتشوف الأكاديمية", "بسجّلوا أو بجددوا"],
      },
      returnLabel: "من الزباين اللي بدفعوا بيرجعوا يحجزوا",
      clipsLabel: "مقطع قصّوه اللاعبين",
      atLabel: "بجوردان جالاكسي",
    },
    revenueTitle: "من وين بتجي المصاري",
    revenueCards: {
      pitch: [
        { title: "المباراة المصوّرة بسعر أعلى", body: "ضيف فرق السعر للمباراة المصوّرة على حجوزاتك.", driver: "من المباريات المصوّرة", driverIndex: 0 },
        { title: "حجوزات جديدة من السوشال", body: "كل مقطع بيننشر مثال لإعلان مجاني بيوصل لأصحاب اللاعبين.", driver: "من الحجوزات الزيادة", driverIndex: 1 },
        { title: "زباين بيرجعوا", body: "نسبة العودة الحقيقية من جوردان جالاكسي، أو عدّل الحجوزات حسب أرقام ملعبك.", driver: "من الحجوزات الزيادة", driverIndex: 1 },
      ],
      academy: [
        { title: "اشتراك أعلى مقابل التصوير والتقارير", body: "احسب الزيادة الشهرية اللي بتناسب اللاعبين المسجّلين عندك.", driver: "من زيادة الاشتراك", driverIndex: 0 },
        { title: "تسجيلات جديدة من المقاطع", body: "مقاطع اللاعبين بتوصل لأهل جداد وبتعرّفهم على الأكاديمية.", driver: "من اللاعبين الجداد", driverIndex: 1 },
        { title: "تجديد الاشتراكات", body: "الأهل بشوفوا تطوّر أولادهم وبيقرروا إذا يكملوا معهم.", driver: "من زيادة الاشتراك", driverIndex: 0 },
      ],
    },
    calculatorExampleNote: "مدخلات الحاسبة أمثلة للتوضيح. عدّلها حسب أرقامك الفعلية.",
    nav: { timeline: "القصة", flywheel: "الدورة", revenue: "المصاري", calculator: "احسبها" },
    endScreensTitle: "البطاقة اللي بتطلع بآخر كل مقطع",
    loading: "عم بحمّل",
  },
};

const en: DemoCopy = {
  brand: "REPLAY",
  switchLanguage: "عربي",
  getCamera: "Get a camera",
  personaQuestion: "Which are you?",
  personas: { pitch: "I own a pitch", academy: "I run an academy" },
  hero: {
    kicker: { pitch: "Replay for pitch owners", academy: "Replay for academies" },
    title: {
      pitch: "Let your players\nmarket your pitch.",
      academy: "Let your players\nmarket your academy.",
    },
    body: {
      pitch: "One camera films every match. Every player gets his clips with your logo already on them, shares them with his friends, and they come to play at your pitch.",
      academy: "Every session is filmed. Every player gets clips with your academy's badge on them, parents watch live from home, and players see their numbers improve game after game.",
    },
    scroll: "Scroll to see it",
  },
  proof: {
    returnRate: "of paying customers at Jordan Galaxy come back to book again",
    recordings: "recordings on file",
    clips: "clips cut by players",
    analysed: "matches analysed by AI",
    note: "Players who want their videos keep coming back.",
  },
  sections: {
    clips: {
      kicker: "Made by players",
      title: { pitch: "Every clip is an ad for your pitch", academy: "Every clip is an ad for your academy" },
      body: "Real clips players cut at Jordan Galaxy, sent to every player automatically. Names hidden.",
      bodyBranded: "Real clips players cut at Jordan Galaxy: the crest in the corner and a booking card at the end, sent to every player automatically. Names hidden.",
      loss: "Without a camera, every match on your pitch tonight ends and nothing of it is left.",
      mute: "Mute",
      unmute: "Unmute",
      play: "Play",
      pause: "Pause",
      loading: "Loading",
    },
    social: {
      kicker: "Social media",
      title: { pitch: "Every clip is an ad for your pitch", academy: "Every clip is an ad for your academy" },
      body: {
        pitch: "After the whistle each player gets clips carrying your pitch's identity. This is exactly how they look; try your pitch's name and colour.",
        academy: "Every player gets clips carrying your academy's identity. These are the frames and cards clips go out with; try your academy's name and colour.",
      },
      nameLabel: { pitch: "Type your pitch's name and see it on the clips", academy: "Type your academy's name and see it on the clips" },
      defaultName: { pitch: "Your pitch", academy: "Your academy" },
      tryTitle: { pitch: "Try it with your pitch's name", academy: "Try it with your academy's name" },
      namePlaceholder: { pitch: "Your pitch's name", academy: "Your academy's name" },
      duringClip: "During the clip",
      endOfClip: "At the end",
      points: {
        pitch: ["Automatic: nobody edits anything", "Your logo on every clip", "An end card that says where to book"],
        academy: ["Automatic for every player", "Your academy's badge on every clip", "An end card that says how to join"],
      },
      endBook: { pitch: "Book your next match", academy: "Join the academy" },
      endFilmed: "Filmed by Replay",
      platforms: "Instagram · TikTok · WhatsApp · Snapchat",
      sample: "The cards show sample numbers; the look is exactly what goes out.",
      lookLabel: "Brand look",
      looks: { galaxy: "Jordan Galaxy preset", custom: "Custom brand" },
      colorLabel: "Brand colour",
      colorHint: "Enter a 6-digit hex colour, for example #D4FF4F.",
      previewKicker: "How clips look",
      previewDescription: {
        pitch: "The crest and cards exactly as they appear on your pitch's clips.",
        academy: "The frame and cards exactly as they appear on your academy's clips.",
      },
      aspectLabel: "Preview aspect ratio",
      showcases: {
        cornerCrest: "Corner crest",
        broadcastBar: "Broadcast bar",
        academyFrame: "Academy frame",
        signOff: "Sign-off card",
        player: "Player clip",
        match: "Match clip",
        academy: "Academy clip",
      },
    },
    players: {
      kicker: "Player stats",
      title: { pitch: "Every player gets his own card", academy: "Every player sees his progress" },
      body: "Pick a player. Numbers from the same real match; names hidden.",
      pick: "Pick a player",
      vsAverage: "vs the match average",
      average: "average",
      rank: (r, n) => `${r} of ${n}`,
      trendTitle: "Last 5 games",
      trendNote: "The latest game is real; earlier games are an example of how progress shows.",
      trendMetric: "Distance (km)",
      thisGame: "This game",
      gameLabel: (n) => `G${n}`,
      passes: "Passes completed",
      leaderboard: "All players",
      previous: "Previous player",
      next: "Next player",
      of: (i, n) => `${i} of ${n}`,
      best: "Best in the match",
    },
    tryIt: {
      kicker: "Try it",
      title: "The whole pitch, from one camera",
      body: (date) => `Drag to look around, zoom in on anyone. This is a real match from ${date}.`,
      bodyNoDate: "Drag to look around, zoom in on anyone. This is a real match.",
      start: "Play the match",
      loading: "Loading the video…",
      failed: "This video isn't available right now.",
      retry: "Try again",
      tabs: { look: "Look around", moments: "Moments", clip: "Make a clip", var: "VAR" },
      whole: "Whole pitch",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      dragHint: "Drag with one finger, pinch with two",
      fullscreen: "Full screen",
      exitFullscreen: "Exit full screen",
      goal: "Goal",
      shot: "Shot",
      momentsNote: "The AI found these moments on its own. Nobody tagged them.",
      momentsLoading: "Reading the match…",
      momentsNone: "No goals or shots were found in this match.",
      clip: {
        vertical: "Vertical, for stories",
        horizontal: "Wide",
        markStart: "Start here",
        markEnd: "End here",
        play: "Play my clip",
        again: "Start over",
        length: (s) => `Clip length ${s}`,
        needStart: "Play the video, pause where the move starts, then tap “Start here”.",
        needEnd: "Let it run, and tap “End here” when the move is over.",
        done: "That's the clip a player shares. In the app it's saved, and it can carry your pitch's name.",
      },
      varTab: {
        back: "−10 s",
        slow: "Slow",
        normal: "Normal",
        goal: "Goal",
        noGoal: "No goal",
        decision: (v) => `Decision: ${v}`,
        note: "During a booked match you rewind the play on a phone while it's still fresh, about half a minute behind.",
      },
    },
    live: {
      kicker: "Live",
      title: { pitch: "Friends watch from home", academy: "Parents watch live from home" },
      liveBadge: "LIVE",
      camera: "Camera 1 · Jordan Galaxy",
      following: "Following the ball",
      offTitle: "Live is off right now",
      offBody: "It runs during matches. When there's a game on, you'll see it here as it happens.",
      delay: "Live runs about 20–30 seconds behind the pitch.",
      checking: "Checking the camera…",
      body: {
        pitch: "The camera follows the ball by itself, with the score and clock on screen like a real broadcast. Friends and family watch on their phones.",
        academy: "Parents who can't make it watch the session or match live from home or work, and the camera follows the ball by itself.",
      },
      demoNote: "Demo replayed from a recorded match, exactly as live looks.",
      realLive: "Camera 1 is live right now. Watch it",
      backToDemo: "Back to the demo",
      family: "Parents follow their son's match from the living room.",
      familyAlt: "Illustration of a family on a sofa watching a live match on TV",
      teamA: "A",
      teamB: "B",
    },
    report: {
      kicker: "After the whistle",
      title: { pitch: "Every player gets his numbers", academy: "Every player gets his numbers" },
      body: (date) => `From a real match on ${date}, measured by the camera. Names hidden.`,
      loading: "Working out the report from the match… the first time takes a moment.",
      teamA: "Team A",
      teamB: "Team B",
      possession: "Possession",
      passes: "Passes completed",
      shots: "Shots",
      goals: "Goals",
      dribbles: "Dribbles won",
      player: "Player",
      minutes: "Min",
      distance: "Distance",
      topSpeed: "Top speed",
      touches: "Touches",
      heatmap: (label) => `Where ${label} played`,
      tapRow: "Tap a player to see where they played",
      find: "A player finds himself in the match in a few taps, and his numbers follow him.",
      km: "km",
      kmh: "km/h",
    },
    tools: {
      kicker: "Your side",
      title: { pitch: "All from your phone", academy: "All from the coach's phone" },
      items: {
        pitch: [
          { title: "Book a match to be filmed", body: "Pick the time. The video is ready about 20 minutes after the whistle." },
          { title: "Pull any past hour", body: "Straight from the pitch camera, then send the link on WhatsApp." },
          { title: "Your pitch's name on clips", body: "The clips players share can carry your pitch's name and logo." },
        ],
        academy: [
          { title: "Review the session from above", body: "The whole pitch in one shot, so you see positioning, not just goals." },
          { title: "Clips for every player", body: "Each player cuts their moments into a profile that reaches parents and scouts." },
          { title: "Your academy's intro", body: "Every clip goes out with your academy's intro and badge." },
        ],
      },
    },
    numbers: {
      kicker: "Your numbers",
      title: { pitch: "Work it out for your pitch", academy: "Work it out for your academy" },
      pitch: {
        bookings: "Bookings a week",
        extra: "Extra you charge for a filmed match (JOD)",
        share: "Bookings out of 100 that pick “filmed”",
        price: "Your booking price (JOD)",
        extraBookings: "Extra bookings a week from social media and returning players",
      },
      fromFilmed: "from filmed matches",
      fromBookings: "from extra bookings",
      fromFees: "from the higher fee",
      fromNewPlayers: "from new players",
      academy: {
        players: "Players enrolled",
        extra: "Extra per player a month for filming and reports (JOD)",
        newPlayers: "New players a month from shared clips and parents talking",
        fee: "Monthly fee (JOD)",
      },
      result: "Extra income a month",
      perYear: (v) => `About ${v} JOD a year`,
      formulaPitch: "(bookings a week × 4.3 × share × extra) + (extra bookings × 4.3 × booking price)",
      formulaAcademy: "(players × extra) + (new players × monthly fee)",
      note: "These are your numbers. Replay's own price we go through on the call, because it depends on the pitch.",
    },
    setup: {
      kicker: "Setup",
      title: "One visit. Nothing to learn.",
      steps: [
        "We mount one camera high on a pole that sees the whole pitch.",
        "It needs power and the internet you already have.",
        "Once it's online, recording starts on its own.",
      ],
      faqTitle: "Questions owners ask",
      faq: {
        pitch: [
          { q: "What if the internet drops?", a: "The camera records to its own memory card, so the match isn't lost. Only live stops until the line is back." },
          { q: "Who can see the footage?", a: "Videos are shared by link. Each player's stats are only visible to people in that match, and during a booked match the live picture stays off public screens." },
          { q: "Do my staff have to do anything?", a: "No. Recording is automatic. If you want, you book a filmed match from your phone in a minute." },
          { q: "How long is footage kept?", a: "The full recording is kept for 14 days. Clips players cut are kept for good." },
          { q: "What does it cost?", a: "It depends on the pitch. We go through it on the call and come by to show it on your own pitch." },
        ],
        academy: [
          { q: "Our players are young. Who sees the footage?", a: "We set it up with you from day one: who gets links, and what stays inside the academy." },
          { q: "Can a coach go back to last week's session?", a: "Yes. The full recording is kept for 14 days, and clips you cut are kept for good." },
          { q: "What if the internet drops?", a: "The camera records to its own memory card, so the session isn't lost." },
          { q: "What does it cost?", a: "It depends on players and pitches. We go through it on the call." },
        ],
      },
    },
    contact: {
      title: { pitch: "See it on your own pitch", academy: "See it at your academy" },
      body: "Leave your number and we'll call you back, or message us on WhatsApp.",
      bodyWhatsapp: "Message us on WhatsApp and we'll arrange to come by.",
      whatsapp: "Message us on WhatsApp",
      whatsappMessage: {
        pitch: "Hi, I saw the Replay demo and I'd like to know more about a camera for my pitch.",
        academy: "Hi, I saw the Replay demo and I'd like to know more about it for my academy.",
      },
      name: "Name",
      place: { pitch: "Pitch name", academy: "Academy name" },
      phone: "Mobile number",
      send: "Call me back",
      sending: "Sending…",
      sent: "Got it. We'll be in touch soon.",
      error: "That didn't go through. Try again, or message us on WhatsApp.",
      noChannel: "Talk to whoever sent you this link and they'll set up a visit.",
    },
  },
  footer: "Replay · Amman",
  jod: "JOD",
  sectionNav: "Page sections",
  tabs: { demo: "See the product", story: "How it earns you more" },
  bridge: { body: "You've seen how it works. Now see how it brings you bookings.", action: "See how it earns you more" },
  story: {
    title: "One match. Watch where it goes.",
    subtitle: "An ordinary match at your pitch, from kick-off to the next booking.",
    chapters: {
      pitch: [
        { time: "Thursday, 10 pm", body: "Two teams play at your pitch. The camera films on its own; your staff don't lift a finger.", visual: "panorama" },
        { time: "20 minutes after the whistle", body: "Every player has his clips on his phone, ready, with your logo on them.", visual: "phone" },
        { time: "Same night", body: "One of them posts his goal to his story. His friends watch, and it ends on a card: Book your next match · [your pitch].", visual: "clip" },
        { time: "Next day", body: "His friends ask about the pitch, and he sends them the location.", visual: "chat" },
        { time: "Next week", body: "A new team books with you and asks for it filmed, because they want their clips too. And Thursday's team? They're back.", visual: "booking" },
      ],
      academy: [
        { time: "Saturday, the session", body: "The camera films the whole session; the coach never holds a phone.", visual: "panorama" },
        { time: "Sami's dad is at work", body: "He watches his son live on his phone.", visual: "phone" },
        { time: "After the session", body: "Sami gets his clips with the academy's badge, and his mum shares them in the family group.", visual: "clip" },
        { time: "The family group", body: "His aunt asks where Sami trains; she knows a boy his age.", visual: "chat" },
        { time: "Next month", body: "A new player signs up, and Sami's parents renew because they can see his numbers improving.", visual: "progress" },
      ],
    },
    closing: { pitch: "And round it goes. Every match brings the next one.", academy: "Every session markets the next one." },
    exampleNote: "This story is an example of an ordinary match. The numbers below are real, from Jordan Galaxy.",
    visualFallback: "Illustrative scene",
    flywheel: {
      title: "Each match leads to the next",
      steps: {
        pitch: ["Play", "Get their clips", "Share", "Friends see your pitch", "Book"],
        academy: ["Train", "Get their clips", "Parents share", "Families see the academy", "Enrol or renew"],
      },
      returnLabel: "of paying customers come back to book again",
      clipsLabel: "clips cut by players",
      atLabel: "at Jordan Galaxy",
    },
    revenueTitle: "Where the money comes from",
    revenueCards: {
      pitch: [
        { title: "Filmed matches at a higher price", body: "Add the filmed-match price difference to your bookings.", driver: "from filmed matches", driverIndex: 0 },
        { title: "New bookings from social media", body: "Every shared clip is an example of a free ad reaching players' friends.", driver: "from extra bookings", driverIndex: 1 },
        { title: "Customers who come back", body: "Use Jordan Galaxy's real return rate, or adjust extra bookings to your pitch.", driver: "from extra bookings", driverIndex: 1 },
      ],
      academy: [
        { title: "A higher monthly fee for filming and reports", body: "Set the monthly increase that fits your enrolled players.", driver: "from the higher fee", driverIndex: 0 },
        { title: "New enrolments from shared clips", body: "Players' clips introduce new families to your academy.", driver: "from new players", driverIndex: 1 },
        { title: "Renewals because parents see progress", body: "Parents can see their child's progress and decide to stay.", driver: "from the higher fee", driverIndex: 0 },
      ],
    },
    calculatorExampleNote: "The calculator inputs are examples. Adjust them to match your real numbers.",
    nav: { timeline: "The story", flywheel: "The loop", revenue: "Revenue", calculator: "Calculator" },
    endScreensTitle: "The card at the end of every clip",
    loading: "Loading",
  },
};

export const demoCopy: Record<DemoLocale, DemoCopy> = { ar, en };
