import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Download, ImagePlus, LayoutTemplate, Loader2, Megaphone, Play, Plus, Trash2, Video, X } from "lucide-react";
import { useStudioCopy } from "@/i18n/studio-strings";
import { starredFirst, useFavorites } from "@/lib/favorites-api";
import { StarButton } from "@/components/creative-hub/star-button";
import {
  addClipToAds,
  addImageToAds,
  clipVideoUrl,
  downloadBlob,
  downloadClip,
  photoToDataUrl,
  pngToJpegDataUrl,
  renderPost,
  useStudioClips,
  useStudioData,
  type StudioClip,
  type StudioData,
  type StudioScorer,
} from "@/lib/academy-studio-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Locale = "en" | "ar";
type Template = "match" | "player" | "training" | "registration" | "announcement";
type Format = "post" | "square" | "story";
const TEMPLATES: Template[] = ["match", "player", "training", "registration", "announcement"];
const FORMATS: Format[] = ["post", "square", "story"];
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

function Chip({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: ReactNode; testId?: string }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId}
      className={cn("min-h-9 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors", active ? "border-turf bg-turf text-void" : "border-line text-muted-text hover:text-text")}>
      {children}
    </button>
  );
}

function Field({ id, label, hint, children }: { id?: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-semibold text-muted-text">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-text">{hint}</p> : null}
    </div>
  );
}

const numOrNull = (v: string): number | null => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// ── Clips ───────────────────────────────────────────────────────────────────

function ClipCard({ academyId, clip, onPlay, starred, onStar, onMakePost }: {
  academyId: number; clip: StudioClip; onPlay: () => void; starred: boolean; onStar: () => void;
  /** Creative hub only: open Templates starting from this clip. */
  onMakePost?: () => void;
}) {
  const all = useStudioCopy();
  const copy = all.studio;
  const [busy, setBusy] = useState<"download" | "ad" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (what: "download" | "ad") => {
    setBusy(what);
    setMessage(null);
    try {
      if (what === "download") await downloadClip(academyId, clip);
      else { await addClipToAds(academyId, clip.id); setMessage({ ok: true, text: copy.addedToAds }); }
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const date = new Intl.DateTimeFormat(all.locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { dateStyle: "medium", timeZone: "Asia/Amman" }).format(new Date(clip.createdAt));
  const who = clip.creator.isYou ? copy.you : `${clip.creator.name ?? ""}${clip.creator.role === "coach" ? ` (${copy.coach})` : ""}`;
  const ready = clip.status === "ready";
  return (
    <article className="flex gap-3 rounded-2xl border border-line bg-surface p-3" data-testid={`studio-clip-${clip.id}`}>
      <button type="button" onClick={onPlay} disabled={!ready}
        className={cn("relative shrink-0 overflow-hidden rounded-xl bg-raised", clip.aspectRatio === "9:16" ? "h-28 w-16" : "h-16 w-28 self-center")}
        aria-label={copy.play}>
        {clip.thumbnailUrl ? <img src={clip.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Video className="m-auto h-5 w-5 text-muted-text" />}
        {ready ? <span className="absolute inset-0 grid place-items-center bg-black/30"><Play className="h-5 w-5 text-white" /></span> : null}
      </button>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-text" dir="auto">{clip.title}</h3>
          <StarButton size="sm" on={starred} onToggle={onStar} className={starred ? "" : "bg-raised text-muted-text hover:bg-raised hover:text-text"} testId={`star-clip-${clip.id}`} />
        </div>
        <p className="text-xs text-muted-text">
          <bdi>{date}</bdi> · {copy.by(who)} · <span className="font-mono">{clip.aspectRatio}</span> · <bdi>{clip.durationSeconds}s</bdi>
        </p>
        <span className={cn("inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold",
          ready ? "bg-turf/15 text-turf" : clip.status === "failed" || clip.status === "expired" ? "bg-red-500/10 text-red-400" : "bg-raised text-muted-text")}>
          {copy.status[clip.status]}
        </span>
        <div className="flex flex-wrap gap-2 pt-1">
          {onMakePost ? (
            <Button type="button" size="sm" className="rounded-xl bg-turf font-semibold text-void hover:bg-turf/90" disabled={!ready} onClick={onMakePost}
              data-testid={`studio-clip-make-post-${clip.id}`}>
              <LayoutTemplate className="h-4 w-4" /><span className="ms-1.5">{copy.makePost}</span>
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" className="rounded-xl" disabled={!!busy || clip.status === "expired" || clip.status === "live"} onClick={() => void run("download")}>
            {busy === "download" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            <span className="ms-1.5">{busy === "download" ? copy.preparing : copy.download}</span>
          </Button>
          <Button type="button" variant="outline" size="sm" className="rounded-xl" disabled={!!busy || clip.status === "expired"} onClick={() => void run("ad")}>
            {busy === "ad" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Megaphone className="h-4 w-4" />}
            <span className="ms-1.5">{busy === "ad" ? copy.adding : copy.useInAd}</span>
          </Button>
        </div>
        {message ? <p className={cn("text-xs", message.ok ? "text-turf" : "text-red-400")} role={message.ok ? "status" : "alert"}>{message.text}</p> : null}
      </div>
    </article>
  );
}

/**
 * The academy's clips (was Studio → Clips; now Creative hub → Clips). Starred clips first.
 * In the Creative hub each ready clip has "Make a post": Templates opens starting from it.
 */
export function StudioClipsPanel({ academyId, onMakePost }: { academyId: number; onMakePost?: (clipId: number) => void }) {
  const copy = useStudioCopy().studio;
  const query = useStudioClips(academyId);
  const fav = useFavorites(academyId);
  const [playing, setPlaying] = useState<StudioClip | null>(null);
  if (query.isLoading) return <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-2xl bg-raised" />)}</div>;
  if (query.isError) return <p className="text-sm text-red-400" role="alert">{(query.error as Error).message}</p>;
  const clips = starredFirst(query.data?.clips ?? [], (c) => c.id, fav.data.clip);
  return (
    <div className="space-y-3">
      {clips.length === 0 ? <p className="rounded-2xl border border-dashed border-line bg-surface p-6 text-center text-sm text-muted-text">{copy.clipsEmpty}</p> : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {clips.map((clip) => <ClipCard key={clip.id} academyId={academyId} clip={clip} onPlay={() => setPlaying(clip)} starred={fav.isStarred("clip", clip.id)} onStar={() => fav.toggle("clip", clip.id)}
          onMakePost={onMakePost ? () => onMakePost(clip.id) : undefined} />)}
      </div>
      <Dialog open={!!playing} onOpenChange={(open) => { if (!open) setPlaying(null); }}>
        <DialogContent className="max-w-lg border-line bg-surface p-3">
          <DialogHeader className="px-1">
            <DialogTitle className="truncate text-sm" dir="auto">{playing?.title}</DialogTitle>
            <DialogDescription className="sr-only">{copy.play}</DialogDescription>
          </DialogHeader>
          {playing ? (
            <video key={playing.id} src={clipVideoUrl(academyId, playing.id)} controls autoPlay playsInline
              className={cn("mx-auto block rounded-xl bg-black", playing.aspectRatio === "9:16" ? "max-h-[70dvh]" : "w-full")} />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Posts & stories ─────────────────────────────────────────────────────────

type MatchForm = { sessionId: number | null; opponent: string; ownScore: string; opponentScore: string; squad: string; dateLabel: string | null; scorers: Array<{ number: string; name: string; goals: string }> };
type PlayerForm = { playerId: number | null; number: string; firstName: string; squad: string; ageGroup: string; line: string; photoData: string | null };
type RegistrationForm = { kind: "registration" | "trial"; headline: string; ageGroups: string; startDate: string; priceJod: string };

function matchFormFrom(m: StudioData["matches"][number] | undefined): MatchForm {
  return {
    sessionId: m?.sessionId ?? null,
    opponent: m?.opponent ?? "",
    ownScore: m?.ownScore?.toString() ?? "",
    opponentScore: m?.opponentScore?.toString() ?? "",
    squad: m?.squad ?? "",
    dateLabel: null,
    scorers: (m?.scorers ?? []).map((s: StudioScorer) => ({ number: s.number?.toString() ?? "", name: s.name ?? "", goals: String(s.goals) })),
  };
}

function playerFormFrom(p: StudioData["players"][number] | undefined, keepPhoto: string | null = null): PlayerForm {
  return {
    playerId: p?.id ?? null,
    number: p?.number?.toString() ?? "",
    firstName: p?.firstName ?? "",
    squad: p?.squad ?? "",
    ageGroup: p?.ageGroup ?? "",
    line: "",
    photoData: keepPhoto,
  };
}

function PhotoPicker({ label, hint, value, onChange }: { label: string; hint?: string; value: string | null; onChange: (v: string | null) => void }) {
  const copy = useStudioCopy().studio;
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Field label={label} hint={error ?? hint}>
      <div className="flex items-center gap-3">
        {value ? <img src={value} alt="" className="h-14 w-14 rounded-xl object-cover" /> : null}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setError(null);
            try {
              const dataUrl = await photoToDataUrl(file);
              if (dataUrl.length * 0.75 > MAX_PHOTO_BYTES) { setError(copy.tooBig); return; }
              onChange(dataUrl);
            } catch (err) {
              setError((err as Error).message);
            }
          }} />
        <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={() => input.current?.click()}>
          <ImagePlus className="h-4 w-4" /><span className="ms-1.5">{copy.choosePhoto}</span>
        </Button>
        {value ? <Button type="button" variant="ghost" size="sm" className="rounded-xl text-muted-text" onClick={() => onChange(null)}><Trash2 className="h-4 w-4" /><span className="ms-1.5">{copy.removePhoto}</span></Button> : null}
      </div>
    </Field>
  );
}

function PostsTab({ academyId, data }: { academyId: number; data: StudioData }) {
  const fav = useFavorites(academyId);
  const all = useStudioCopy();
  const copy = all.studio;
  const [template, setTemplate] = useState<Template>("match");
  const [format, setFormat] = useState<Format>("post");
  const [locale, setLocale] = useState<Locale>(all.locale);
  const [background, setBackground] = useState<string | null>(null);
  const scoredMatches = useMemo(() => data.matches.filter((m) => m.ownScore !== null && m.opponentScore !== null), [data.matches]);
  const [match, setMatch] = useState<MatchForm>(() => matchFormFrom(scoredMatches[0]));
  const [player, setPlayer] = useState<PlayerForm>(() => playerFormFrom(data.players[0]));
  const [skipRows, setSkipRows] = useState<Set<number>>(new Set());
  const ageGroups = useMemo(() => [...new Set(data.squads.map((s) => s.ageGroup).filter(Boolean))].join(", "), [data.squads]);
  const [registration, setRegistration] = useState<RegistrationForm>({ kind: "registration", headline: "", ageGroups, startDate: "", priceJod: "" });
  const [announcement, setAnnouncement] = useState({ title: "", body: "" });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [action, setAction] = useState<"download" | "ad" | null>(null);
  const [actionMessage, setActionMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const names = data.brand.showPlayerNames;

  const selectedMatch = data.matches.find((m) => m.sessionId === match.sessionId);
  const weekRows = data.week.rows[locale];
  const registrationHeadline = registration.headline || (registration.kind === "trial" ? copy.defaults.trialHeadline : copy.defaults.registrationHeadline);

  /** The render request for the current form, or null while something required is missing. */
  const payload = useMemo((): Record<string, unknown> | null => {
    const common = { format, locale, backgroundData: background };
    switch (template) {
      case "match": {
        const own = numOrNull(match.ownScore);
        const opp = numOrNull(match.opponentScore);
        if (!match.opponent.trim() || own === null || opp === null) return null;
        return {
          ...common, template, opponent: match.opponent, ownScore: own, opponentScore: opp, squad: match.squad || null,
          dateLabel: match.dateLabel ?? selectedMatch?.dateLabel[locale] ?? null,
          scorers: match.scorers
            .map((s) => ({ number: numOrNull(s.number), name: names ? s.name || null : null, goals: numOrNull(s.goals) ?? 1 }))
            .filter((s) => (s.number !== null || s.name) && s.goals > 0),
        };
      }
      case "player": {
        const number = numOrNull(player.number);
        if (number === null && !(names && player.firstName.trim())) return null;
        return {
          ...common, template, number, firstName: names ? player.firstName || null : null, squad: player.squad || null,
          ageGroup: player.ageGroup || null, line: player.line || null, photoData: player.photoData,
        };
      }
      case "training":
        return { ...common, template, rangeLabel: data.week.rangeLabel[locale], rows: weekRows.filter((_, i) => !skipRows.has(i)).slice(0, 14) };
      case "registration":
        return {
          ...common, template, kind: registration.kind, headline: registrationHeadline, ageGroups: registration.ageGroups || null,
          startDate: registration.startDate || null, priceJod: numOrNull(registration.priceJod),
        };
      default:
        return announcement.title.trim() ? { ...common, template, title: announcement.title, body: announcement.body || null } : null;
    }
  }, [template, format, locale, background, match, player, registration, registrationHeadline, announcement, names, selectedMatch, data.week, weekRows, skipRows]);

  const payloadKey = payload ? JSON.stringify(payload) : null;
  useEffect(() => {
    if (!payloadKey) { setPreviewError(null); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setRendering(true);
      try {
        const blob = await renderPost(academyId, { ...JSON.parse(payloadKey), preview: true }, controller.signal);
        setPreviewUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
        setPreviewError(null);
      } catch (error) {
        if ((error as Error).name !== "AbortError") setPreviewError((error as Error).message);
      } finally {
        if (!controller.signal.aborted) setRendering(false);
      }
    }, 600);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [academyId, payloadKey]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const runAction = async (what: "download" | "ad") => {
    if (!payload) return;
    setAction(what);
    setActionMessage(null);
    try {
      const blob = await renderPost(academyId, payload);
      const name = `${template}-${format}-${locale}`;
      if (what === "download") {
        await downloadBlob(blob, `${name}.png`);
      } else {
        const dataUrl = await pngToJpegDataUrl(blob);
        if (!dataUrl) { setActionMessage({ ok: false, text: copy.adImageTooBig }); return; }
        await addImageToAds(academyId, dataUrl, `${copy.templates[template]} (${copy.formats[format]})`);
        setActionMessage({ ok: true, text: copy.addedToAds });
      }
    } catch (error) {
      setActionMessage({ ok: false, text: (error as Error).message });
    } finally {
      setAction(null);
    }
  };

  const textDir = locale === "ar" ? "rtl" : "ltr";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
      <div className="space-y-5">
        <section className="space-y-2">
          <h3 className="text-sm font-bold text-text">{copy.pickTemplate}</h3>
          <div className="flex flex-wrap gap-2">
            {starredFirst(TEMPLATES, (t) => `studio:${t}`, fav.data.template).map((t) => (
              <span key={t} className="inline-flex items-center gap-1">
                <Chip active={template === t} onClick={() => setTemplate(t)} testId={`studio-template-${t}`}>{copy.templates[t]}</Chip>
                <StarButton size="sm" on={fav.isStarred("template", `studio:${t}`)} onToggle={() => fav.toggle("template", `studio:${t}`)}
                  className={fav.isStarred("template", `studio:${t}`) ? "" : "bg-raised text-muted-text hover:bg-raised hover:text-text"} testId={`star-studio-${t}`} />
              </span>
            ))}
          </div>
        </section>

        <section className="space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
          <h3 className="text-sm font-bold text-text">{copy.fill}</h3>
          <div className="flex flex-wrap gap-6">
            <Field label={copy.format}>
              <div className="flex flex-wrap gap-2">{FORMATS.map((f) => <Chip key={f} active={format === f} onClick={() => setFormat(f)}>{copy.formats[f]}</Chip>)}</div>
            </Field>
            <Field label={copy.language}>
              <div className="flex gap-2">
                <Chip active={locale === "en"} onClick={() => setLocale("en")}>English</Chip>
                <Chip active={locale === "ar"} onClick={() => setLocale("ar")}>عربي</Chip>
              </div>
            </Field>
          </div>

          {template === "match" ? (
            <div className="space-y-4">
              {scoredMatches.length ? (
                <Field id="studio-match" label={copy.match}>
                  <select id="studio-match" value={match.sessionId ?? ""} className="min-h-10 w-full rounded-lg border border-input bg-raised px-3 text-sm text-text"
                    onChange={(e) => setMatch(matchFormFrom(scoredMatches.find((m) => m.sessionId === Number(e.target.value))))}>
                    {scoredMatches.map((m) => (
                      <option key={m.sessionId} value={m.sessionId}>{m.dateLabel[all.locale]} · {m.opponent ?? "?"} · {m.ownScore}–{m.opponentScore}{m.squad ? ` · ${m.squad}` : ""}</option>
                    ))}
                  </select>
                </Field>
              ) : <p className="text-xs text-muted-text">{copy.noMatches}</p>}
              <div className="grid gap-3 sm:grid-cols-3">
                <Field id="studio-opponent" label={copy.opponent}><Input id="studio-opponent" dir="auto" maxLength={40} value={match.opponent} onChange={(e) => setMatch({ ...match, opponent: e.target.value })} /></Field>
                <Field id="studio-own" label={copy.ownScore}><Input id="studio-own" dir="ltr" inputMode="numeric" value={match.ownScore} onChange={(e) => setMatch({ ...match, ownScore: e.target.value })} /></Field>
                <Field id="studio-opp" label={copy.opponentScore}><Input id="studio-opp" dir="ltr" inputMode="numeric" value={match.opponentScore} onChange={(e) => setMatch({ ...match, opponentScore: e.target.value })} /></Field>
                <Field id="studio-squad" label={copy.squad}><Input id="studio-squad" dir="auto" maxLength={40} value={match.squad} onChange={(e) => setMatch({ ...match, squad: e.target.value })} /></Field>
                <Field id="studio-date" label={copy.date}>
                  <Input id="studio-date" dir="auto" maxLength={40} value={match.dateLabel ?? selectedMatch?.dateLabel[locale] ?? ""} onChange={(e) => setMatch({ ...match, dateLabel: e.target.value })} />
                </Field>
              </div>
              <Field label={copy.scorers} hint={names ? undefined : copy.namesOff}>
                <div className="space-y-2">
                  {match.scorers.map((s, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input aria-label={copy.shirt} dir="ltr" inputMode="numeric" placeholder="#" className="w-20" value={s.number}
                        onChange={(e) => setMatch({ ...match, scorers: match.scorers.map((x, j) => (j === i ? { ...x, number: e.target.value } : x)) })} />
                      {names ? <Input aria-label={copy.firstName} dir="auto" maxLength={30} placeholder={copy.firstName} className="min-w-0 flex-1" value={s.name}
                        onChange={(e) => setMatch({ ...match, scorers: match.scorers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /> : null}
                      <Input aria-label={copy.goals} dir="ltr" inputMode="numeric" className="w-16" value={s.goals}
                        onChange={(e) => setMatch({ ...match, scorers: match.scorers.map((x, j) => (j === i ? { ...x, goals: e.target.value } : x)) })} />
                      <Button type="button" variant="ghost" size="icon" aria-label={copy.removePhoto} onClick={() => setMatch({ ...match, scorers: match.scorers.filter((_, j) => j !== i) })}><X className="h-4 w-4" /></Button>
                    </div>
                  ))}
                  {match.scorers.length < 12 ? (
                    <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={() => setMatch({ ...match, scorers: [...match.scorers, { number: "", name: "", goals: "1" }] })}>
                      <Plus className="h-4 w-4" /><span className="ms-1.5">{copy.addScorer}</span>
                    </Button>
                  ) : null}
                </div>
              </Field>
            </div>
          ) : null}

          {template === "player" ? (
            <div className="space-y-4">
              {data.players.length ? (
                <Field id="studio-player" label={copy.player}>
                  <select id="studio-player" value={player.playerId ?? ""} className="min-h-10 w-full rounded-lg border border-input bg-raised px-3 text-sm text-text"
                    onChange={(e) => setPlayer(playerFormFrom(data.players.find((p) => p.id === Number(e.target.value)), player.photoData))}>
                    {data.players.map((p) => <option key={p.id} value={p.id}>{p.number !== null ? `#${p.number}` : "—"}{p.firstName ? ` ${p.firstName}` : ""}{p.squad ? ` · ${p.squad}` : ""}</option>)}
                  </select>
                </Field>
              ) : null}
              {!names ? <p className="text-xs text-muted-text">{copy.namesOff}</p> : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="studio-number" label={copy.shirt}><Input id="studio-number" dir="ltr" inputMode="numeric" value={player.number} onChange={(e) => setPlayer({ ...player, number: e.target.value })} /></Field>
                {names ? <Field id="studio-first" label={copy.firstName}><Input id="studio-first" dir="auto" maxLength={30} value={player.firstName} onChange={(e) => setPlayer({ ...player, firstName: e.target.value })} /></Field> : null}
                <Field id="studio-psquad" label={copy.squad}><Input id="studio-psquad" dir="auto" maxLength={40} value={player.squad} onChange={(e) => setPlayer({ ...player, squad: e.target.value })} /></Field>
                <Field id="studio-age" label={copy.ageGroup}><Input id="studio-age" dir="auto" maxLength={20} value={player.ageGroup} onChange={(e) => setPlayer({ ...player, ageGroup: e.target.value })} /></Field>
              </div>
              <Field id="studio-line" label={copy.extraLine}><Input id="studio-line" dir={textDir} maxLength={80} value={player.line} onChange={(e) => setPlayer({ ...player, line: e.target.value })} /></Field>
              <PhotoPicker label={copy.playerPhoto} value={player.photoData} onChange={(v) => setPlayer({ ...player, photoData: v })} />
            </div>
          ) : null}

          {template === "training" ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-text">{copy.weekRange}: <bdi>{data.week.rangeLabel[locale]}</bdi></p>
              {weekRows.length === 0 ? <p className="text-xs text-muted-text">{copy.noSessions}</p> : null}
              {weekRows.map((row, i) => (
                <label key={i} className="flex items-center gap-3 rounded-xl border border-line bg-raised/50 px-3 py-2 text-sm text-text" dir={textDir}>
                  <input type="checkbox" checked={!skipRows.has(i)} onChange={(e) => {
                    const next = new Set(skipRows);
                    if (e.target.checked) next.delete(i); else next.add(i);
                    setSkipRows(next);
                  }} />
                  <span className="font-semibold">{row.day}</span>
                  <bdi className="font-mono">{row.time}</bdi>
                  <span className="min-w-0 truncate text-muted-text">{[row.squad, row.place].filter(Boolean).join(" · ")}</span>
                </label>
              ))}
            </div>
          ) : null}

          {template === "registration" ? (
            <div className="space-y-4">
              <Field label={copy.kind}>
                <div className="flex gap-2">
                  <Chip active={registration.kind === "registration"} onClick={() => setRegistration({ ...registration, kind: "registration" })}>{copy.registrationKind}</Chip>
                  <Chip active={registration.kind === "trial"} onClick={() => setRegistration({ ...registration, kind: "trial" })}>{copy.trialKind}</Chip>
                </div>
              </Field>
              <Field id="studio-headline" label={copy.headline}>
                <Input id="studio-headline" dir={textDir} maxLength={80} placeholder={registrationHeadline} value={registration.headline} onChange={(e) => setRegistration({ ...registration, headline: e.target.value })} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field id="studio-ages" label={copy.ageGroups}><Input id="studio-ages" dir="auto" maxLength={40} value={registration.ageGroups} onChange={(e) => setRegistration({ ...registration, ageGroups: e.target.value })} /></Field>
                <Field id="studio-start" label={copy.startDate}><Input id="studio-start" dir="auto" maxLength={40} placeholder={locale === "ar" ? "الأحد 15 تشرين الثاني" : "SUN 15 NOV"} value={registration.startDate} onChange={(e) => setRegistration({ ...registration, startDate: e.target.value })} /></Field>
                <Field id="studio-price" label={copy.price}><Input id="studio-price" dir="ltr" inputMode="decimal" value={registration.priceJod} onChange={(e) => setRegistration({ ...registration, priceJod: e.target.value })} /></Field>
              </div>
              <p className="text-xs text-muted-text">{data.brand.contact[locale] ? copy.contactFrom(data.brand.contact[locale]!) : copy.noContact}</p>
            </div>
          ) : null}

          {template === "announcement" ? (
            <div className="space-y-4">
              <Field id="studio-title" label={copy.titleField}><Input id="studio-title" dir={textDir} maxLength={80} value={announcement.title} onChange={(e) => setAnnouncement({ ...announcement, title: e.target.value })} /></Field>
              <Field id="studio-body" label={copy.body}><Textarea id="studio-body" dir={textDir} rows={4} maxLength={400} value={announcement.body} onChange={(e) => setAnnouncement({ ...announcement, body: e.target.value })} /></Field>
            </div>
          ) : null}

          <PhotoPicker label={copy.background} hint={copy.backgroundHint} value={background} onChange={setBackground} />
        </section>
      </div>

      <section className="space-y-3 lg:sticky lg:top-24 lg:self-start">
        <h3 className="text-sm font-bold text-text">{copy.previewTitle}</h3>
        <div className={cn("relative mx-auto overflow-hidden rounded-xl border border-line bg-raised",
          format === "story" ? "aspect-[9/16] max-w-[260px]" : format === "square" ? "aspect-square max-w-[340px]" : "aspect-[4/5] max-w-[320px]")}>
          {previewUrl ? <img src={previewUrl} alt={copy.templates[template]} className="h-full w-full object-contain" data-testid="studio-preview" /> : null}
          {rendering ? <span className="absolute end-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[11px] text-white"><Loader2 className="h-3 w-3 animate-spin" />{copy.rendering}</span> : null}
        </div>
        {previewError ? <p className="text-xs text-red-400" role="alert">{previewError}</p> : null}
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" className="rounded-xl bg-floodlight font-bold text-void" disabled={!payload || !!action} onClick={() => void runAction("download")} data-testid="button-studio-download">
            {action === "download" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}<span className="ms-1.5">{copy.downloadPng}</span>
          </Button>
          <Button type="button" variant="outline" className="rounded-xl" disabled={!payload || !!action} onClick={() => void runAction("ad")}>
            {action === "ad" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Megaphone className="h-4 w-4" />}<span className="ms-1.5">{action === "ad" ? copy.adding : copy.useInAd}</span>
          </Button>
        </div>
        {actionMessage ? (
          <p className={cn("flex items-center justify-center gap-1 text-xs", actionMessage.ok ? "text-turf" : "text-red-400")} role={actionMessage.ok ? "status" : "alert"}>
            {actionMessage.ok ? <Check className="h-3.5 w-3.5" /> : null}{actionMessage.text}
          </p>
        ) : null}
      </section>
    </div>
  );
}

/** Branded posts and stories from five quick forms (was Studio → Posts; now Creative hub → Quick posts). */
export function StudioQuickPosts({ academyId }: { academyId: number }) {
  const data = useStudioData(academyId);
  return data.isLoading ? <div className="h-64 animate-pulse rounded-2xl bg-raised" />
    : data.isError || !data.data ? <p className="text-sm text-red-400" role="alert">{(data.error as Error | null)?.message}</p>
      : <PostsTab academyId={academyId} data={data.data} />;
}

/** The old Studio section (both tabs). The consoles now open these inside the Creative hub. */
export function AcademyStudioSection({ academyId }: { academyId: number }) {
  const all = useStudioCopy();
  const copy = all.studio;
  const [tab, setTab] = useState<"clips" | "posts">("clips");
  const data = useStudioData(academyId);
  return (
    <section className="space-y-6 pb-16" dir={all.locale === "ar" ? "rtl" : "ltr"} data-testid="academy-studio">
      <div>
        <h2 className="font-display text-2xl font-bold text-text">{copy.title}</h2>
        <p className="mt-1 text-sm text-muted-text">{copy.intro}</p>
      </div>
      <div className="flex gap-2 border-b border-line" role="tablist">
        {(["clips", "posts"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} data-testid={`studio-tab-${t}`}
            className={cn("-mb-px min-h-11 border-b-2 px-3 text-sm font-semibold", tab === t ? "border-turf text-turf" : "border-transparent text-muted-text hover:text-text")}>
            {t === "clips" ? copy.tabClips : copy.tabPosts}
          </button>
        ))}
      </div>
      {tab === "clips" ? <StudioClipsPanel academyId={academyId} />
        : data.isLoading ? <div className="h-64 animate-pulse rounded-2xl bg-raised" />
          : data.isError || !data.data ? <p className="text-sm text-red-400" role="alert">{(data.error as Error | null)?.message}</p>
            : <PostsTab academyId={academyId} data={data.data} />}
    </section>
  );
}
