import { useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { ChevronRight, X, Volume2, VolumeX, Share2, Download, Users } from "lucide-react";
import { useTranslation } from "@/i18n";
import { getWeeklyHighlight, type WeeklyHighlight } from "@workspace/api-client-react";

type Highlight = WeeklyHighlight;
const base = import.meta.env.BASE_URL.replace(/\/$/, "");
const ordinal = (n: number, locale: string) => locale === "ar" ? String(n) : `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;

export default function WeeklyHighlightPage() {
  const { id } = useParams<{ id: string }>();
  const { t, locale } = useTranslation();
  const s = t.weeklyHighlights;
  const [, setLocation] = useLocation();
  const [data, setData] = useState<Highlight | null>(null);
  const [error, setError] = useState(false);
  const [index, setIndex] = useState(0);
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let active = true;
    if (!id || !/^\d+$/.test(id)) { setError(true); return () => { active = false; }; }
    getWeeklyHighlight(Number(id))
      .then((value) => { if (active) setData(value); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [id]);
  useEffect(() => { videoRef.current?.load(); void videoRef.current?.play().catch(() => {}); }, [index, data]);
  useEffect(() => { setProgress(0); }, [index]);
  const clip = data?.clips[index];
  const next = () => setIndex((i) => Math.min(i + 1, (data?.clips.length ?? 1) - 1));
  const prev = () => setIndex((i) => Math.max(0, i - 1));
  const tap = (event: React.MouseEvent) => {
    const nextOnLeft = locale === "ar";
    const isLeft = event.clientX < window.innerWidth * 0.4;
    if (isLeft === nextOnLeft) next(); else prev();
  };
  const publicClipUrl = async () => {
    try {
      const r = await fetch(`${base}/api/user-clips/${clip?.clipId}/share-link`, { credentials: "include" });
      if (r.ok) return (await r.json()).shareUrl as string;
    } catch { /* fallback below */ }
    return `${window.location.origin}${base}/week/${id}`;
  };
  const share = async () => {
    if (!clip) return;
    try {
      const response = await fetch(`${base}${clip.videoUrl}`, { credentials: "include" });
      const blob = await response.blob();
      const file = new File([blob], `replay-${clip.clipId}.mp4`, { type: "video/mp4" });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: data?.title }); return; }
    } catch { /* use WhatsApp link */ }
    window.open(`https://wa.me/?text=${encodeURIComponent(await publicClipUrl())}`, "_blank", "noopener,noreferrer");
  };
  const shareTeam = async () => window.open(`https://wa.me/?text=${encodeURIComponent(await publicClipUrl())}`, "_blank", "noopener,noreferrer");
  const close = () => {
    const ref = document.referrer;
    setLocation(ref.startsWith(window.location.origin) ? new URL(ref).pathname : "/home");
  };
  const event = clip ? s[clip.eventType] : "";
  const minute = clip?.minute == null ? "" : ordinal(clip.minute, locale);
  const title = clip && clip.minute != null ? s[`${clip.eventType}Title`](minute) : data?.title;

  if (error) return <main className="fixed inset-0 z-[100] grid place-items-center bg-void p-6 text-center text-text" dir={locale === "ar" ? "rtl" : "ltr"}><div><p>{s.error}</p><button onClick={close} className="mt-4 rounded-xl border border-line px-4 py-2">{s.close}</button></div></main>;
  if (data && !data.clips.length) return <main className="fixed inset-0 z-[100] grid place-items-center bg-void p-6 text-center text-text" dir={locale === "ar" ? "rtl" : "ltr"}><div><p>{s.empty}</p><button onClick={close} className="mt-4 rounded-xl border border-line px-4 py-2">{s.close}</button></div></main>;
  if (!data || !clip) return <main className="fixed inset-0 z-[100] grid place-items-center bg-void text-muted-text">{s.loading}</main>;
  return <main className="fixed inset-0 z-[100] overflow-hidden bg-void text-white" dir={locale === "ar" ? "rtl" : "ltr"}>
    <video ref={videoRef} key={clip.clipId} src={`${base}${clip.videoUrl}`} autoPlay playsInline muted={muted} onTimeUpdate={() => { const v = videoRef.current; setProgress(v?.duration ? (v.currentTime / v.duration) * 100 : 0); }} onEnded={next} onClick={tap} className="absolute inset-0 h-full w-full object-cover" />
    <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-void/70 via-transparent to-void/95" />
    <div className="absolute inset-x-3 top-0 z-10 flex gap-1.5 pt-safe" style={{ paddingTop: "max(env(safe-area-inset-top), 8px)" }}>{data.clips.map((item, i) => <span key={item.clipId} className="h-1 flex-1 overflow-hidden rounded-full bg-white/40"><span className="block h-full bg-white" style={{ width: i < index ? "100%" : i === index ? `${progress}%` : "0%" }} /></span>)}</div>
    <header dir="ltr" className="absolute inset-x-4 top-safe z-10 flex items-center justify-between pt-8">
      <button onClick={close} aria-label={s.close} className="rounded-full bg-void/60 p-2"><X /></button>
      <div className="text-center text-sm font-semibold">{data.userId == null ? s.goalWeek : s.yourWeek}<div className="text-xs text-white/70">{s.clipOf(index + 1, data.clips.length)}</div></div>
      <strong className="font-display tracking-[.16em]">REPLAY</strong>
    </header>
    {clip.youX != null && clip.youY != null && <div className="pointer-events-none absolute z-10" style={{ left: `${clip.youX * 100}%`, top: `${clip.youY * 100}%`, transform: "translate(-50%,-50%)" }}><span className="block size-14 rounded-full border-[3px] border-floodlight" /><b className="absolute left-1/2 top-full mt-1 -translate-x-1/2 rounded bg-floodlight px-1.5 text-[10px] text-void">YOU</b></div>}
    <button onClick={(e) => { e.stopPropagation(); next(); }} aria-label={s.nextClip} className="absolute right-3 top-1/2 z-20 -translate-y-1/2 rounded-full bg-void/70 p-3"><ChevronRight /></button>
    <button onClick={() => { setMuted((v) => !v); if (videoRef.current) videoRef.current.muted = !muted; }} aria-label={muted ? s.unmute : s.mute} className="absolute end-4 top-20 z-10 rounded-full bg-void/60 p-2">{muted ? <VolumeX /> : <Volume2 />}</button>
    <button onClick={(e) => { e.stopPropagation(); locale === "ar" ? next() : prev(); }} className="absolute inset-y-24 left-0 z-0 w-[40%]" aria-label={locale === "ar" ? s.nextClip : s.close} />
    <button onClick={(e) => { e.stopPropagation(); locale === "ar" ? prev() : next(); }} className="absolute inset-y-24 right-0 z-0 w-[60%]" aria-label={locale === "ar" ? s.close : s.nextClip} />
    <section className="absolute inset-x-0 bottom-0 z-10 space-y-3 bg-gradient-to-t from-void via-void/90 to-transparent px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-24">
      <div className="inline-flex rounded-full bg-floodlight px-3 py-1 text-xs font-black text-void">{event}{clip.minute != null ? ` · ${clip.minute}'` : ""}</div>
      <p className="text-xs text-white/70">{clip.matchDate ?? data.weekStart} · {data.fieldName}</p>
      <h1 className="font-display text-2xl font-black">{title}</h1>
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => void share()} className="col-span-2 flex min-h-12 items-center justify-center gap-2 rounded-xl bg-floodlight font-bold text-void"><Share2 className="size-4" />{s.shareStatus}</button>
        <a href={`${base}/api/user-clips/${clip.clipId}/download`} className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-line bg-surface/80 text-sm"><Download className="size-4" />{s.saveVideo}</a>
        <button onClick={() => void shareTeam()} className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-line bg-surface/80 text-sm"><Users className="size-4" />{s.sendTeam}</button>
      </div>
      <a href={`${base}/home?record=1`} className="block text-sm font-semibold text-floodlight">{s.bookNext}</a>
      {clip.matchCode && clip.availableUntil && <a href={`${base}/m/${clip.matchCode}`} className="block text-xs text-muted-text">{s.fullMatchUntil(new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(clip.availableUntil)))}</a>}
    </section>
  </main>;
}
