import { useParams } from "wouter";
import { Loader2, Lock } from "lucide-react";
import { useFeaturedCopy } from "@/i18n/featured-strings";
import { useLocale } from "@/i18n/context";
import { apiUrl } from "@/lib/academy-studio-api";
import { useKidClip } from "@/lib/academy-featured-api";

/**
 * /kc/:token — a child's private clip from a match, for his own family, no
 * account needed. The link is the only way in; it isn't listed anywhere.
 */
export default function KidClipPage() {
  const { token = "" } = useParams<{ token: string }>();
  const copy = useFeaturedCopy();
  const { setLocale } = useLocale();
  const clip = useKidClip(token);
  const t = copy.page;
  const dir = copy.locale === "ar" ? "rtl" : "ltr";
  const academy = clip.data?.academy ? (copy.locale === "ar" ? clip.data.academy.nameAr || clip.data.academy.name : clip.data.academy.name) : "";
  const date = clip.data?.match ? new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Amman" }).format(new Date(clip.data.match.startsAt)) : "";
  const note = clip.data ? copy.clips.note(clip.data.note) : "";

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col gap-4 bg-void px-4 py-6 text-text" dir={dir} data-testid="kid-clip-page">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold tracking-[0.28em] text-floodlight">REPLAY</span>
        <div className="flex gap-1">
          {(["ar", "en"] as const).map((l) => (
            <button key={l} type="button" onClick={() => setLocale(l)} className={`rounded-full px-3 py-1 text-xs font-semibold ${copy.locale === l ? "bg-floodlight text-void" : "bg-raised text-muted-text"}`}>
              {l === "ar" ? "العربية" : "English"}
            </button>
          ))}
        </div>
      </div>
      {clip.isLoading ? <div className="grid h-64 place-items-center"><Loader2 className="h-6 w-6 animate-spin text-muted-text" /></div>
        : clip.isError || !clip.data ? <p className="rounded-2xl border border-line bg-surface p-6 text-center text-sm text-muted-text" data-testid="kid-clip-missing">{t.notFound}</p>
        : (
          <>
            <header className="space-y-1">
              <p className="text-sm text-muted-text">{t.from(academy)}{date ? ` · ${date}` : ""}</p>
              <h1 className="font-display text-3xl font-bold" dir="auto">{t.title(clip.data.firstName)}</h1>
              <p className="text-sm text-text">{copy.clips.moment(clip.data.momentKind)}{note ? ` — ${note}` : ""}</p>
            </header>
            {clip.data.ready
              ? <video src={apiUrl(`/kc/${token}/video`)} controls playsInline autoPlay muted className="aspect-video w-full rounded-2xl bg-black" data-testid="kid-clip-video" />
              : <div className="grid aspect-video place-items-center rounded-2xl border border-line bg-surface p-6 text-center text-sm text-muted-text"><span className="flex flex-col items-center gap-3"><Loader2 className="h-6 w-6 animate-spin" />{t.preparing}</span></div>}
            <p className="flex items-center gap-2 text-xs text-muted-text"><Lock className="h-3.5 w-3.5" aria-hidden />{t.privacy}</p>
          </>
        )}
    </main>
  );
}
