import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "@/i18n";

type LocalizedText = { en: string; ar: string };
type LocalizedList = { en: string[]; ar: string[] };

type NewsPost = {
  id: number;
  tag: LocalizedText;
  date: LocalizedText;
  readTime: LocalizedText;
  title: LocalizedText;
  excerpt: LocalizedText;
  body: LocalizedList;
  facts: LocalizedList;
  image: string | null;
};

const newsPosts: NewsPost[] = [
  {
    id: 1,
    tag: { en: "FEATURE", ar: "ميزة" },
    date: { en: "28 JUL", ar: "٢٨ تموز" },
    readTime: { en: "3 MIN READ", ar: "قراءة ٣ دقائق" },
    title: { en: "Every match you play, recorded and ready", ar: "كل مباراة تلعبها، مسجّلة وجاهزة" },
    excerpt: {
      en: "Cameras run all evening at partner pitches. Your game is waiting for you before you reach the car park.",
      ar: "الكاميرات تعمل طوال المساء في الملاعب الشريكة. مباراتك بانتظارك قبل أن تصل إلى السيارة.",
    },
    body: {
      en: [
        "Replay records continuously at every partner pitch. There is nothing to set up, nothing to press, and nobody to ask — you play, and the footage is there.",
        "Open the app, pick your pitch and pick the date. Every recorded hour is listed and ready to watch from any phone.",
      ],
      ar: [
        "ريبلاي يسجّل باستمرار في كل ملعب شريك. لا شيء تجهّزه، ولا زر تضغطه، ولا أحد تسأله — أنت تلعب، والتسجيل موجود.",
        "افتح التطبيق، اختر الملعب ثم التاريخ. كل ساعة مسجّلة معروضة وجاهزة للمشاهدة من أي هاتف.",
      ],
    },
    facts: {
      en: ["No setup", "Full match", "Watch anywhere"],
      ar: ["بلا إعداد", "المباراة كاملة", "شاهد أينما كنت"],
    },
    image: null,
  },
  {
    id: 2,
    tag: { en: "CLIPS", ar: "مقاطع" },
    date: { en: "24 JUL", ar: "٢٤ تموز" },
    readTime: { en: "2 MIN READ", ar: "قراءة دقيقتين" },
    title: { en: "Cut your own highlights in seconds", ar: "اقتطع لقطاتك المميزة في ثوانٍ" },
    excerpt: {
      en: "Found the goal? Trim it, frame it, and send it to the group chat before anyone has stopped arguing about it.",
      ar: "وجدت الهدف؟ اقتطعه، أطّره، وأرسله إلى مجموعة الأصدقاء قبل أن ينتهي الجدال حوله.",
    },
    body: {
      en: [
        "Scrub to the moment, drag the handles, and save. Your clip lives in My Clips and downloads as a normal video file.",
        "Pan and zoom while you cut, so the ball stays in frame instead of lost somewhere in a wide shot of the pitch.",
      ],
      ar: [
        "مرّر إلى اللحظة، اسحب المقابض، ثم احفظ. مقطعك يظهر في مقاطعي ويُحمَّل كملف فيديو عادي.",
        "حرّك الصورة وقرّبها أثناء الاقتطاع، لتبقى الكرة في الإطار بدل أن تضيع في لقطة واسعة للملعب.",
      ],
    },
    facts: {
      en: ["Trim and save", "Pan and zoom", "Share instantly"],
      ar: ["اقتطع واحفظ", "تحريك وتقريب", "شارك فوراً"],
    },
    image: null,
  },
  {
    id: 3,
    tag: { en: "ACADEMIES", ar: "أكاديميات" },
    date: { en: "21 JUL", ar: "٢١ تموز" },
    readTime: { en: "2 MIN READ", ar: "قراءة دقيقتين" },
    title: { en: "Parents can watch from anywhere", ar: "الأهل يشاهدون من أي مكان" },
    excerpt: {
      en: "Training sessions and academy matches stream live, and stay available afterwards for the ones you miss.",
      ar: "التدريبات ومباريات الأكاديميات تُبَث مباشرة، وتبقى متاحة لاحقاً لمن فاتته.",
    },
    body: {
      en: [
        "Partner academies stream their sessions straight to the app. Family who cannot make it to the pitch can watch from home, or from another country.",
        "Every session is kept afterwards, so a missed evening is only a tap away.",
      ],
      ar: [
        "الأكاديميات الشريكة تبثّ حصصها مباشرة إلى التطبيق. من لا يستطيع الحضور إلى الملعب يشاهد من البيت، أو من بلد آخر.",
        "كل حصة تُحفظ بعد انتهائها، فالمساء الذي فاتك يبعد نقرة واحدة.",
      ],
    },
    facts: {
      en: ["Live streams", "Kept afterwards", "Any device"],
      ar: ["بث مباشر", "محفوظ لاحقاً", "أي جهاز"],
    },
    image: null,
  },
  {
    id: 4,
    tag: { en: "FIELDS", ar: "ملاعب" },
    date: { en: "18 JUL", ar: "١٨ تموز" },
    readTime: { en: "2 MIN READ", ar: "قراءة دقيقتين" },
    title: { en: "More pitches joining across Amman", ar: "ملاعب جديدة تنضم في عمّان" },
    excerpt: {
      en: "New fields are coming online each month, each with cameras covering the full pitch.",
      ar: "ملاعب جديدة تدخل الخدمة كل شهر، وكل واحد منها مغطّى بكاميرات ترى الملعب بالكامل.",
    },
    body: {
      en: [
        "Every new partner pitch arrives already wired — cameras mounted, angle covering the whole surface, recording from the first booking.",
        "If you play somewhere that is not listed yet, tell the field owner. Getting set up takes one visit.",
      ],
      ar: [
        "كل ملعب شريك جديد يصل مجهّزاً — الكاميرات مركّبة، والزاوية تغطي كامل المساحة، والتسجيل يبدأ من أول حجز.",
        "إذا كنت تلعب في مكان غير مدرج بعد، أخبر صاحب الملعب. التجهيز يحتاج زيارة واحدة.",
      ],
    },
    facts: {
      en: ["Growing weekly", "Full pitch view", "Amman and beyond"],
      ar: ["ينمو أسبوعياً", "الملعب بالكامل", "عمّان وما بعدها"],
    },
    image: null,
  },
];

export default function Home() {
  const { locale } = useTranslation();
  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-28 pt-4">
        <div className="mb-4 flex items-center gap-3 px-1">
          <h1 className="text-sm font-semibold text-foreground">
            {locale === "ar" ? "الأخبار والتحديثات" : "News & updates"}
          </h1>
          <div className="h-px flex-1 bg-border" />
        </div>

        <div className="flex flex-col gap-3">
          {newsPosts.map((post, index) => (
            <NewsCard
              key={post.id}
              post={post}
              locale={locale}
              index={index}
              isExpanded={expandedId === post.id}
              onToggle={() => setExpandedId(expandedId === post.id ? null : post.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}


function NewsCard({
  post,
  locale,
  index,
  isExpanded,
  onToggle,
}: {
  post: NewsPost;
  locale: "en" | "ar";
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const text = post[locale];

  return (
    <motion.article
      initial={{ opacity: 0, y: 18 }}
      animate={{
        opacity: 1,
        y: 0,
        transition: { delay: index * 0.06, duration: 0.35, ease: "easeOut" as const },
      }}
      className="overflow-hidden rounded-[22px] border border-border bg-card"
    >
      <div className="relative aspect-video overflow-hidden">
        {post.image ? (
          <img
            src={post.image}
            alt={text.title}
            className="absolute inset-0 h-full w-full object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div className="absolute inset-0 field-pattern bg-gradient-to-br from-card via-muted to-card" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/10 to-transparent" />
        <span className="absolute start-3 top-3 rounded-[7px] border border-[rgba(255,255,255,0.12)] bg-[rgba(7,8,10,0.72)] px-[9px] py-1 text-[9.5px] font-extrabold uppercase tracking-[0.12em] text-primary">
          {text.tag}
        </span>
      </div>

      <button type="button" onClick={onToggle} className="w-full text-start">
        <div className="px-4 pb-[15px] pt-3.5">
          <p
            className="text-[11px] font-bold uppercase tracking-[0.07em] text-muted-foreground/40"
            style={{
              unicodeBidi: "isolate",
              direction: locale === "ar" ? "rtl" : "ltr",
            }}
          >
            {text.date} · {text.readTime}
          </p>
          <h2 className="mt-1.5 font-display text-[18.5px] font-bold leading-[1.22] tracking-[-0.02em] text-foreground">
            {text.title}
          </h2>
          <p className="mt-2 text-[13.5px] leading-[1.55] text-muted-foreground/[0.66]">
            {text.excerpt}
          </p>
          <div className="mt-3 flex items-center gap-1.5 text-xs font-extrabold text-primary">
            <span>{isExpanded ? "Show less" : "Read full story"}</span>
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform duration-300 ${
                isExpanded ? "rotate-180" : ""
              }`}
            />
          </div>
        </div>

        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.32, ease: "easeInOut" }}
              className="overflow-hidden"
            >
              <div className="border-t border-border px-4 pb-4 pt-3">
                <div className="flex flex-col gap-3">
                  {text.body.map((paragraph) => (
                    <p key={paragraph} className="text-[13.5px] leading-[1.68] text-muted-foreground/[0.78]">
                      {paragraph}
                    </p>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {text.facts.map((fact) => (
                    <span
                      key={fact}
                      className="rounded-[9px] border border-border bg-muted/50 px-[11px] py-[7px] text-[11.5px] font-bold text-muted-foreground"
                    >
                      {fact}
                    </span>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </button>
    </motion.article>
  );
}
