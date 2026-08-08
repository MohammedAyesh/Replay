import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown } from "lucide-react";

type NewsPost = {
  id: number;
  tag: string;
  date: string;
  readTime: string;
  title: string;
  excerpt: string;
  body: string[];
  facts: string[];
  image: string | null;
};

const newsPosts: NewsPost[] = [
  {
    id: 1,
    tag: "FEATURE",
    date: "28 JUL",
    readTime: "3 MIN READ",
    title: "Every match you play, recorded and ready",
    excerpt:
      "Cameras run all evening at partner pitches. Your game is waiting for you before you reach the car park.",
    body: [
      "Replay records continuously at every partner pitch. There is nothing to set up, nothing to press, and nobody to ask — you play, and the footage is there.",
      "Open the app, pick your pitch and pick the date. Every recorded hour is listed and ready to watch from any phone.",
    ],
    facts: ["No setup", "Full match", "Watch anywhere"],
    image: null,
  },
  {
    id: 2,
    tag: "CLIPS",
    date: "24 JUL",
    readTime: "2 MIN READ",
    title: "Cut your own highlights in seconds",
    excerpt:
      "Found the goal? Trim it, frame it, and send it to the group chat before anyone has stopped arguing about it.",
    body: [
      "Scrub to the moment, drag the handles, and save. Your clip lives in My Clips and downloads as a normal video file.",
      "Pan and zoom while you cut, so the ball stays in frame instead of lost somewhere in a wide shot of the pitch.",
    ],
    facts: ["Trim and save", "Pan and zoom", "Share instantly"],
    image: null,
  },
  {
    id: 3,
    tag: "ACADEMIES",
    date: "21 JUL",
    readTime: "2 MIN READ",
    title: "Parents can watch from anywhere",
    excerpt:
      "Training sessions and academy matches stream live, and stay available afterwards for the ones you miss.",
    body: [
      "Partner academies stream their sessions straight to the app. Family who cannot make it to the pitch can watch from home, or from another country.",
      "Every session is kept afterwards, so a missed evening is only a tap away.",
    ],
    facts: ["Live streams", "Kept afterwards", "Any device"],
    image: null,
  },
  {
    id: 4,
    tag: "FIELDS",
    date: "18 JUL",
    readTime: "2 MIN READ",
    title: "More pitches joining across Amman",
    excerpt:
      "New fields are coming online each month, each with cameras covering the full pitch.",
    body: [
      "Every new partner pitch arrives already wired — cameras mounted, angle covering the whole surface, recording from the first booking.",
      "If you play somewhere that is not listed yet, tell the field owner. Getting set up takes one visit.",
    ],
    facts: ["Growing weekly", "Full pitch view", "Amman and beyond"],
    image: null,
  },
];

export default function Home() {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-28 pt-4">
        <div className="mb-4 flex items-center gap-3 px-1">
          <h1 className="text-sm font-semibold text-foreground">News &amp; updates</h1>
          <div className="h-px flex-1 bg-border" />
        </div>

        <div className="flex flex-col gap-3">
          {newsPosts.map((post, index) => (
            <NewsCard
              key={post.id}
              post={post}
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
  index,
  isExpanded,
  onToggle,
}: {
  post: NewsPost;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
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
            alt={post.title}
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
          {post.tag}
        </span>
      </div>

      <button type="button" onClick={onToggle} className="w-full text-start">
        <div className="px-4 pb-[15px] pt-3.5">
          <p className="text-[11px] font-bold uppercase tracking-[0.07em] text-muted-foreground/40">
            {post.date} · {post.readTime}
          </p>
          <h2 className="mt-1.5 font-display text-[18.5px] font-bold leading-[1.22] tracking-[-0.02em] text-foreground">
            {post.title}
          </h2>
          <p className="mt-2 text-[13.5px] leading-[1.55] text-muted-foreground/[0.66]">
            {post.excerpt}
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
                  {post.body.map((paragraph) => (
                    <p key={paragraph} className="text-[13.5px] leading-[1.68] text-muted-foreground/[0.78]">
                      {paragraph}
                    </p>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {post.facts.map((fact) => (
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
