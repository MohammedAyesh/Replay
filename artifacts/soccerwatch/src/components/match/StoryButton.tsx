import { useRef, useState } from "react";
import { Loader2, Smartphone, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLocale } from "@/i18n";
import { apiBase } from "@/lib/match-api";
import { canRenderStory, renderStory, shareStory } from "@/lib/story-render";

type StoryContext = {
  playerName: string;
  shirtNumber: number | null;
  avatarUrl: string | null;
  clipTitle: string;
  match: {
    code: string;
    title: string | null;
    fieldName: string;
    startLocal: string;
    startMs: number;
    score: { a: number; b: number } | null;
    teamColor: string | null;
  } | null;
};

/**
 * Turns an exported clip into a branded 9:16 story video on the phone and opens
 * the share sheet (Instagram, WhatsApp status, TikTok). Uses the clip's
 * download, so it counts like a download.
 */
export function StoryButton({ clipId, className }: { clipId: number; className?: string }) {
  const { locale } = useLocale();
  const { toast } = useToast();
  const ar = locale === "ar";
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  if (!canRenderStory()) return null;

  const run = async () => {
    const abort = new AbortController();
    abortRef.current = abort;
    setProgress(0);
    try {
      const [ctxRes, fileRes] = await Promise.all([
        fetch(`${apiBase}/user-clips/${clipId}/story-context`, { credentials: "include" }),
        fetch(`${apiBase}/user-clips/${clipId}/download`, { credentials: "include", signal: abort.signal }),
      ]);
      if (fileRes.status === 402) throw new Error(ar ? "وصلت حد التنزيلات" : "You've reached your download limit");
      if (!ctxRes.ok || !fileRes.ok) throw new Error(ar ? "ما قدرنا نجهّز المقطع" : "Couldn't load the clip");
      const context = (await ctxRes.json()) as StoryContext;
      const blob = await fileRes.blob();
      const dateLabel = context.match
        ? new Intl.DateTimeFormat(ar ? "ar-JO" : "en-GB", { timeZone: "Asia/Amman", weekday: "short", day: "numeric", month: "short" }).format(new Date(context.match.startMs))
        : new Intl.DateTimeFormat(ar ? "ar-JO" : "en-GB", { day: "numeric", month: "short" }).format(new Date());
      const result = await renderStory({
        videoBlob: blob,
        playerName: context.playerName,
        shirtNumber: context.shirtNumber,
        avatarUrl: context.avatarUrl,
        teamColor: context.match?.teamColor ?? null,
        fieldName: context.match?.fieldName ?? context.clipTitle,
        dateLabel,
        title: context.match?.title ?? null,
        matchCode: context.match?.code ?? null,
        score: context.match?.score ?? null,
        locale: ar ? "ar" : "en",
        onProgress: setProgress,
        signal: abort.signal,
      });
      const how = await shareStory(result, `replay-story-${clipId}.mp4`);
      toast({ title: how === "shared" ? (ar ? "جاهز للمشاركة" : "Ready to share") : (ar ? "انحفظت الستوري" : "Story saved") });
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") {
        toast({ title: error instanceof Error ? error.message : (ar ? "صار خطأ" : "Something went wrong"), variant: "destructive" });
      }
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  };

  if (progress !== null) {
    return (
      <button
        type="button"
        onClick={() => abortRef.current?.abort()}
        className={className ?? "flex min-h-10 shrink-0 items-center gap-2 rounded-full bg-violet px-4 text-sm font-bold text-text pointer-events-auto"}
        aria-label={ar ? "إيقاف" : "Stop"}
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {Math.round(progress * 100)}%
        <X className="h-3.5 w-3.5 opacity-70" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void run()}
      className={className ?? "flex min-h-10 shrink-0 items-center gap-2 rounded-full border border-violet/70 bg-void/60 px-4 text-sm font-bold text-violet pointer-events-auto"}
    >
      <Smartphone className="h-4 w-4" />
      {ar ? "ستوري ٩:١٦" : "Story 9:16"}
    </button>
  );
}
