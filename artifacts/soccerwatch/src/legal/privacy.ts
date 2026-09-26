import type { LegalDoc } from "./types";

export const privacy: { en: LegalDoc; ar: LegalDoc } = {
  en: {
    title: "Privacy Policy",
    lastUpdated: "2026-09-26",
    draftNotice: "Draft — pending legal review",
    sections: [
      {
        heading: "Who we are",
        paragraphs: [
          "{{COMPANY}} operates Replay, which records amateur football matches with fixed cameras at partner pitches in Jordan.",
          "Questions: {{SUPPORT_EMAIL}}.",
        ],
      },
      {
        heading: "What we collect",
        paragraphs: [],
        bullets: [
          "Account details: name, email, phone, age, gender, playing position, profile photo and shirt number.",
          "Video of matches recorded at partner pitches. It shows everyone on the pitch, including people who do not have a Replay account.",
          "Stats we calculate from that video, such as positions, distance, speed, touches and passes.",
          "What you create or do in Replay: clips, likes, follows, match pages, votes and VAR flags.",
          "Bookings and payments: the amount, the CliQ reference and whether cash was collected. We never receive card numbers.",
          "Ads: which of our own ads you see and click. Ads are chosen only by the pitch you are watching. We do not track you across other apps or websites.",
          "Technical data: device, browser, logs, and the cookies needed to keep you signed in.",
        ],
      },
      {
        heading: "Why we use it",
        paragraphs: [
          "We use it to run Replay, make and share clips and stats, handle bookings and payments, keep Replay safe, and improve it. We do not sell personal data.",
        ],
      },
      {
        heading: "Who processes data for us",
        paragraphs: [],
        bullets: [
          "Clerk: sign-in (USA).",
          "Replit: app hosting and database (USA).",
          "Bunny.net: video storage and delivery (Germany, EU).",
          "Contabo: video processing server (Germany).",
          "Cloud GPU providers that analyse match video. They may be outside Jordan, including in Asia.",
        ],
      },
      {
        heading: "How long we keep it",
        paragraphs: [],
        bullets: [
          "Full match recordings: about 14 days.",
          "Clips you save: until you delete them or your account.",
          "Account data: until you delete your account.",
          "Payment records: as long as the law requires.",
        ],
      },
      {
        heading: "Your choices",
        paragraphs: [],
        bullets: [
          "See and correct your details in Account.",
          "Delete your clips at any time.",
          "Delete your account in Account → Delete account, or see /delete-account.",
          "Ask for a clip you appear in to be removed: {{SUPPORT_EMAIL}}.",
          "Withdraw your consent to social media use at any time.",
        ],
      },
      {
        heading: "Players under 18",
        paragraphs: [
          "Use Replay only with a parent's or guardian's permission.",
        ],
      },
      {
        heading: "Changes to this policy",
        paragraphs: [
          "When we change it, we update the date at the top and tell you in the app about important changes.",
        ],
      },
    ],
  },
  ar: {
    title: "سياسة الخصوصية",
    lastUpdated: "2026-09-26",
    draftNotice: "مسودة — قيد المراجعة القانونية",
    sections: [
      {
        heading: "من نحن",
        paragraphs: [
          "تدير {{COMPANY}} خدمة Replay، التي تسجّل مباريات كرة القدم للهواة بكاميرات ثابتة في الملاعب الشريكة في الأردن.",
          "للاستفسارات: {{SUPPORT_EMAIL}}.",
        ],
      },
      {
        heading: "ما البيانات التي نجمعها",
        paragraphs: [],
        bullets: [
          "بيانات الحساب: الاسم، والبريد الإلكتروني، ورقم الهاتف، والعمر، والجنس، ومركز اللعب، وصورة الملف الشخصي، ورقم القميص.",
          "فيديو المباريات المسجلة في الملاعب الشريكة. يظهر فيه كل من في الملعب، بمن فيهم من ليس لديهم حساب في Replay.",
          "إحصاءات نحسبها من الفيديو، مثل المراكز والمسافة والسرعة واللمسات والتمريرات.",
          "ما تنشئه أو تفعله في Replay: المقاطع، والإعجابات، والمتابعات، وصفحات المباريات، والتصويتات، وإشارات VAR.",
          "الحجوزات والمدفوعات: المبلغ، ومرجع CliQ، وما إذا جُمع المبلغ نقدًا. لا نتلقى أرقام البطاقات أبدًا.",
          "الإعلانات: إعلاناتنا التي تشاهدها وتنقر عليها. نختار الإعلانات بحسب الملعب الذي تشاهده فقط. لا نتتبعك عبر التطبيقات أو المواقع الأخرى.",
          "البيانات التقنية: الجهاز، والمتصفح، والسجلات، وملفات تعريف الارتباط اللازمة لإبقائك مسجلًا للدخول.",
        ],
      },
      {
        heading: "لماذا نستخدم البيانات",
        paragraphs: [
          "نستخدمها لتشغيل Replay، وإنشاء المقاطع والإحصاءات ومشاركتها، وإدارة الحجوزات والمدفوعات، والحفاظ على أمان Replay، وتحسينه. لا نبيع البيانات الشخصية.",
        ],
      },
      {
        heading: "من يعالج البيانات نيابة عنا",
        paragraphs: [],
        bullets: [
          "Clerk: تسجيل الدخول (الولايات المتحدة).",
          "Replit: استضافة التطبيق وقاعدة البيانات (الولايات المتحدة).",
          "Bunny.net: تخزين الفيديو وتوصيله (ألمانيا، الاتحاد الأوروبي).",
          "Contabo: خادم معالجة الفيديو (ألمانيا).",
          "مزودو وحدات معالجة الرسومات السحابية الذين يحللون فيديو المباريات. قد يكونون خارج الأردن، بما في ذلك في آسيا.",
        ],
      },
      {
        heading: "مدة الاحتفاظ بالبيانات",
        paragraphs: [],
        bullets: [
          "التسجيلات الكاملة للمباريات: نحو 14 يومًا.",
          "المقاطع التي تحفظها: حتى تحذفها أو تحذف حسابك.",
          "بيانات الحساب: حتى تحذف حسابك.",
          "سجلات الدفع: للمدة التي يفرضها القانون.",
        ],
      },
      {
        heading: "خياراتك",
        paragraphs: [],
        bullets: [
          "يمكنك الاطلاع على بياناتك وتصحيحها في الحساب.",
          "يمكنك حذف مقاطعك في أي وقت.",
          "يمكنك حذف حسابك من الحساب، ثم اختيار «حذف الحساب»، أو من خلال /delete-account.",
          "لطلب إزالة مقطع تظهر فيه: {{SUPPORT_EMAIL}}.",
          "يمكنك سحب موافقتك على استخدام المقاطع في وسائل التواصل الاجتماعي في أي وقت.",
        ],
      },
      {
        heading: "اللاعبون دون 18 عامًا",
        paragraphs: [
          "استخدم Replay فقط بإذن من أحد الوالدين أو الوصي.",
        ],
      },
      {
        heading: "التغييرات على هذه السياسة",
        paragraphs: [
          "عندما نغيّر هذه السياسة، نحدّث التاريخ في أعلاها ونبلغك بالتغييرات المهمة داخل التطبيق.",
        ],
      },
    ],
  },
};