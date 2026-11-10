import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, Clapperboard, Film, Loader2, Search, X } from "lucide-react";
import {
  PLAYER_REEL_MUSIC_TEMPLATE,
  REEL_MAX_CLIPS,
  REEL_MAX_INTRO_STATS,
  REEL_MAX_OUTRO_STATS,
  REEL_MAX_PHOTOS,
  buildPlayerReelScene,
  recommendationSceneMusic,
  type MediaSource,
  type ReelFormat,
} from "@workspace/api-zod";
import { useReelCopy } from "@/i18n/creative-reel-strings";
import { useMatchesCopy } from "@/i18n/matches-strings";
import { METRICS, type MetricKey } from "@/lib/academy-match-metrics";
import { useAcademyPlayerStats } from "@/lib/academy-matches-api";
import { useCreateCreativeProject } from "@/lib/creative-hub-api";
import { browserUrl, useLibraryPlayerMedia, useLibraryPlayers, type LibraryPlayerMedia } from "@/lib/creative-hub-library-api";
import { creativeMediaUrl } from "@/lib/creative-hub-media";
import { useTemplateMusicRecommendations } from "@/lib/creative-hub-music-api";
import { fetchFraming, type FramingSource } from "@/lib/creative-framing";
import {
  INTRO_PREFER,
  OUTRO_PREFER,
  defaultStats,
  metaLine,
  reelClipOf,
  reelInput,
  reelStat,
  reelStatValues,
  type ReelPick,
  type StatScope,
} from "@/lib/player-reel";
import { cn } from "@/lib/utils";
import type { HubNav } from "./types";

/** Creative hub → Player reel: one player's highlight reel (intro card, his clips, his numbers), opened in the Editor. */
export function CreativePlayerReel({ academyId, nav, initialPlayerId }: { academyId: number; nav: HubNav; initialPlayerId?: number | null }) {
  const copy = useReelCopy();
  const [playerId, setPlayerId] = useState<number | null>(initialPlayerId ?? null);
  return (
    <div className="space-y-4" data-testid="creative-player-reel">
      <header>
        <h2 className="font-display text-xl font-bold text-text">{copy.title}</h2>
        <p className="mt-1 text-sm text-muted-text">{copy.intro}</p>
      </header>
      {playerId === null
        ? <PlayerPicker academyId={academyId} onPick={setPlayerId} />
        : <ReelBuilder key={playerId} academyId={academyId} playerId={playerId} nav={nav} onChange={() => setPlayerId(null)} />}
    </div>
  );
}

function PlayerPicker({ academyId, onPick }: { academyId: number; onPick: (id: number) => void }) {
  const copy = useReelCopy();
  const players = useLibraryPlayers(academyId);
  const [q, setQ] = useState("");
  const list = (players.data?.players ?? []).filter((p) => {
    const s = q.trim().toLowerCase().replace(/^#/, "");
    return !s || String(p.number ?? "").startsWith(s) || (p.firstName ?? "").toLowerCase().includes(s);
  });
  if (players.isLoading) return <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">{Array.from({ length: 10 }, (_, i) => <div key={i} className="aspect-square animate-pulse rounded-2xl bg-raised" />)}</div>;
  if (!players.data?.players.length) return <p className="rounded-2xl border border-dashed border-line p-8 text-center text-sm text-muted-text">{copy.noPlayers}</p>;
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-bold text-text">{copy.pickPlayer}</h3>
      <label className="flex h-10 max-w-sm items-center gap-2 rounded-xl border border-line bg-surface px-3">
        <Search className="h-4 w-4 text-muted-text" aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={copy.search} className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none" dir="auto" />
      </label>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-6">
        {list.map((p) => (
          <button key={p.playerId} type="button" onClick={() => onPick(p.playerId)} className="group overflow-hidden rounded-2xl border border-line bg-surface text-start hover:border-turf" data-testid={`reel-player-${p.playerId}`}>
            <div className="relative aspect-square bg-raised">
              {p.photo ? <img src={browserUrl(p.photo.url) ?? undefined} alt="" className="h-full w-full object-cover" loading="lazy" />
                : <span className="grid h-full w-full place-items-center font-display text-4xl font-bold text-muted-text">{p.number ?? "?"}</span>}
              {p.number !== null && p.photo && <span className="absolute bottom-1.5 start-1.5 rounded-md bg-void/80 px-1.5 font-display text-sm font-bold text-floodlight">#{p.number}</span>}
            </div>
            <p className="truncate px-2.5 py-2 text-sm font-semibold text-text" dir="auto">{p.firstName ?? (p.number !== null ? `#${p.number}` : "—")}<span className="ms-1 text-xs font-normal text-muted-text">{p.squad ?? ""}</span></p>
          </button>
        ))}
      </div>
    </section>
  );
}

type Item = ReelPick & { thumb: string | null; kind: string };

function ReelBuilder({ academyId, playerId, nav, onChange }: { academyId: number; playerId: number; nav: HubNav; onChange: () => void }) {
  const copy = useReelCopy();
  const mc = useMatchesCopy();
  const media = useLibraryPlayerMedia(academyId, playerId);
  const statsRows = useAcademyPlayerStats(academyId);
  const music = useTemplateMusicRecommendations(academyId);
  const create = useCreateCreativeProject(academyId);

  const [photoIds, setPhotoIds] = useState<number[] | null>(null);
  const [show, setShow] = useState({ number: true, age: true, position: true, squad: true });
  const [scope, setScope] = useState<StatScope>("season");
  const [introKeys, setIntroKeys] = useState<MetricKey[] | null>(null);
  const [outroKeys, setOutroKeys] = useState<MetricKey[] | null>(null);
  const [picked, setPicked] = useState<Item[]>([]);
  const [format, setFormat] = useState<ReelFormat>("story");
  const [followHim, setFollowHim] = useState(true);
  const [footageSound, setFootageSound] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const data = media.data;
  const rows = statsRows.data ?? [];
  const myMatches = useMemo(() => rows.filter((r) => r.playerId === playerId).sort((a, b) => b.startsAt.localeCompare(a.startsAt)), [rows, playerId]);
  const season = useMemo(() => reelStatValues(rows, playerId, "season"), [rows, playerId]);
  const scoped = useMemo(() => (scope === "season" ? season : reelStatValues(rows, playerId, scope)), [rows, playerId, scope, season]);
  const units = { km: mc.stats.km ?? copy.units.km, kmh: mc.stats.kmh ?? copy.units.kmh };
  const statCopy = { ...(mc.stats as unknown as Record<MetricKey, string>), ...units };

  // Defaults once the data is in: his first photos, the numbers he has.
  useEffect(() => {
    if (data && photoIds === null) setPhotoIds(data.photos.filter((p) => !p.transparent).slice(0, REEL_MAX_PHOTOS).map((p) => p.photoId));
  }, [data, photoIds]);
  useEffect(() => {
    if (statsRows.isLoading) return;
    if (introKeys === null) setIntroKeys(defaultStats(season.values, INTRO_PREFER, 3));
    if (outroKeys === null) setOutroKeys(defaultStats(scoped.values, OUTRO_PREFER, 6));
  }, [statsRows.isLoading, introKeys, outroKeys, season.values, scoped.values]);

  const items = useMemo<{ moments: Item[]; clips: Item[] }>(() => {
    if (!data) return { moments: [], clips: [] };
    const moments = data.moments.map((m) => ({
      key: `m:${m.id}`,
      src: m.source as MediaSource,
      durationMs: m.durationMs,
      kind: m.type,
      label: [copy.kinds[m.type] ?? copy.kinds.saved, m.minute !== null ? copy.minute(m.minute) : null].filter(Boolean).join(" · "),
      thumb: browserUrl(creativeMediaUrl(academyId, m.still, "still")) ?? browserUrl(m.thumbnailUrl),
    }));
    const clips = data.clips.map((c) => ({
      key: `c:${c.clipId}`,
      src: c.source as MediaSource,
      durationMs: c.durationMs,
      kind: "clip",
      label: c.title ?? copy.kinds.clip,
      thumb: browserUrl(c.thumbnailUrl) ?? browserUrl(creativeMediaUrl(academyId, c.source, "still")),
    }));
    return { moments, clips };
  }, [academyId, copy, data]);

  if (media.isLoading) return <p className="flex items-center gap-2 text-sm text-muted-text"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{copy.loading}</p>;
  if (!data) return <p className="text-sm text-red-400" role="alert">{copy.failed}</p>;

  const who = data.player.firstName ?? (data.player.number !== null ? `#${data.player.number}` : "");
  const togglePhoto = (id: number) => setPhotoIds((ids) => {
    const cur = ids ?? [];
    return cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= REEL_MAX_PHOTOS ? cur : [...cur, id];
  });
  const toggleItem = (item: Item) => setPicked((p) => (p.some((x) => x.key === item.key) ? p.filter((x) => x.key !== item.key) : p.length >= REEL_MAX_CLIPS ? p : [...p, item]));
  const move = (i: number, d: -1 | 1) => setPicked((p) => {
    const j = i + d;
    if (j < 0 || j >= p.length) return p;
    const next = [...p];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const toggleKey = (set: (fn: (k: MetricKey[] | null) => MetricKey[] | null) => void, max: number) => (key: MetricKey) =>
    set((k) => { const cur = k ?? []; return cur.includes(key) ? cur.filter((x) => x !== key) : cur.length >= max ? cur : [...cur, key]; });
  const scopeTitle = scope === "season" ? copy.seasonTitle(season.matches) : (() => {
    const m = myMatches.find((r) => r.sessionId === scope);
    return m ? copy.matchTitle(m.opponent, new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { day: "numeric", month: "short", timeZone: "Asia/Amman" }).format(new Date(m.startsAt))) : "";
  })();

  const build = async () => {
    setError(null);
    if (!picked.length) { setError(copy.needClip); return; }
    try {
      const clips = [];
      for (let i = 0; i < picked.length; i++) {
        setProgress(copy.building(i + 1, picked.length));
        const it = picked[i];
        const req: FramingSource | null = it.src.type === "clip" ? { type: "clip", clipId: it.src.clipId }
          : it.src.type === "recording" ? { type: "recording", recordingId: it.src.recordingId, fromMs: it.src.fromMs, toMs: it.src.toMs } : null;
        const answer = req ? await fetchFraming(academyId, req, followHim ? playerId : undefined).catch(() => null) : null;
        clips.push(reelClipOf(it, answer));
      }
      setProgress(copy.creating);
      const photos: MediaSource[] = (photoIds ?? []).map((id) => data.photos.find((p) => p.photoId === id)?.source).filter((s): s is NonNullable<typeof s> => Boolean(s));
      const stat = (k: MetricKey, values: Record<MetricKey, number | null>) => reelStat(k, values[k], statCopy, copy.locale);
      const scene = buildPlayerReelScene(reelInput({
        format,
        locale: copy.locale,
        name: data.showNames ? data.player.firstName : null,
        number: show.number ? data.player.number : null,
        meta: metaLine({ age: data.player.age ?? null, position: data.player.position, squad: data.player.squad }, show, copy.ageWord),
        photos,
        introStats: (introKeys ?? []).map((k) => stat(k, season.values)).filter((s): s is NonNullable<typeof s> => Boolean(s)),
        outroTitle: scoped.matches ? scopeTitle : "",
        outroStats: (outroKeys ?? []).map((k) => stat(k, scoped.values)).filter((s): s is NonNullable<typeof s> => Boolean(s)),
        footageSound,
        music: recommendationSceneMusic(music.data?.[PLAYER_REEL_MUSIC_TEMPLATE] ?? null),
      }, clips));
      const project = await create.mutateAsync({ title: copy.projectTitle(who), scene, data: { playerReel: { playerId } } });
      nav.openInEditor(project.id);
    } catch {
      setError(copy.failed);
    } finally {
      setProgress(null);
    }
  };

  const statChips = (keys: MetricKey[] | null, values: Record<MetricKey, number | null>, onToggle: (k: MetricKey) => void, max: number) => (
    <div className="flex flex-wrap gap-1.5">
      {METRICS.filter((m) => values[m.key] !== null).map((m) => {
        const on = (keys ?? []).includes(m.key);
        const s = reelStat(m.key, values[m.key], statCopy, copy.locale);
        return (
          <button key={m.key} type="button" onClick={() => onToggle(m.key)} aria-pressed={on} disabled={!on && (keys ?? []).length >= max}
            className={cn("inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold disabled:opacity-40", on ? "bg-floodlight text-void" : "bg-raised text-muted-text hover:text-text")}>
            {on && <Check className="h-3.5 w-3.5" aria-hidden />}{s?.label}<span className="font-display tabular-nums">{s?.value}</span>
          </button>
        );
      })}
    </div>
  );

  const tile = (it: Item) => {
    const n = picked.findIndex((p) => p.key === it.key);
    return (
      <button key={it.key} type="button" onClick={() => toggleItem(it)} aria-pressed={n >= 0}
        className={cn("group relative overflow-hidden rounded-xl border text-start", n >= 0 ? "border-floodlight" : "border-line hover:border-turf")} data-testid={`reel-item-${it.key}`}>
        <div className="aspect-video bg-raised">{it.thumb && <img src={it.thumb} alt="" className="h-full w-full object-cover" loading="lazy" />}</div>
        {n >= 0 && <span className="absolute end-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-floodlight text-xs font-bold text-void">{n + 1}</span>}
        <p className="truncate px-2 py-1.5 text-xs font-semibold text-text" dir="auto">{it.label}</p>
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-raised font-display text-lg font-bold text-floodlight">{data.player.number ?? "?"}</span>
        <p className="min-w-0 flex-1 truncate font-display text-lg font-bold text-text" dir="auto">{who}<span className="ms-2 text-sm font-normal text-muted-text">{data.player.squad ?? ""}</span></p>
        <button type="button" onClick={onChange} className="rounded-xl px-3 py-2 text-sm font-semibold text-muted-text hover:bg-raised hover:text-text">{copy.change}</button>
      </div>
      {!data.showNames && <p className="rounded-xl bg-raised p-3 text-xs text-muted-text">{copy.namesOff}</p>}

      <Section title={copy.introStep}>
        {data.showNames && (
          <>
            <p className="text-sm font-semibold text-text">{copy.photos}</p>
            {data.photos.length ? (
              <div className="flex flex-wrap gap-2">
                {data.photos.map((p) => {
                  const n = (photoIds ?? []).indexOf(p.photoId);
                  return (
                    <button key={p.photoId} type="button" onClick={() => togglePhoto(p.photoId)} aria-pressed={n >= 0}
                      className={cn("relative h-28 w-24 overflow-hidden rounded-xl border-2", n >= 0 ? "border-floodlight" : "border-transparent opacity-70 hover:opacity-100")}>
                      <img src={browserUrl(p.url) ?? undefined} alt="" className="h-full w-full object-cover" loading="lazy" />
                      {n >= 0 && <span className="absolute end-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-floodlight text-[11px] font-bold text-void">{n + 1}</span>}
                    </button>
                  );
                })}
              </div>
            ) : <p className="text-xs text-muted-text">{copy.noPhotos}</p>}
          </>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-semibold text-text">{copy.show}</span>
          {([
            ["number", copy.number, data.player.number !== null],
            ["age", data.player.age != null ? copy.age : copy.noAge, data.player.age != null],
            ["position", copy.position, Boolean(data.player.position)],
            ["squad", copy.squad, Boolean(data.player.squad)],
          ] as Array<[keyof typeof show, string, boolean]>).map(([k, label, has]) => (
            <button key={k} type="button" disabled={!has} onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))} aria-pressed={show[k] && has}
              className={cn("h-8 rounded-full px-3 text-xs font-semibold disabled:opacity-40", show[k] && has ? "bg-turf text-void" : "bg-raised text-muted-text")}>{label}</button>
          ))}
        </div>
        {season.matches > 0 && (
          <>
            <p className="text-sm font-semibold text-text">{copy.introStats}</p>
            {statChips(introKeys, season.values, toggleKey(setIntroKeys, REEL_MAX_INTRO_STATS), REEL_MAX_INTRO_STATS)}
          </>
        )}
      </Section>

      <Section title={copy.clipsStep} hint={copy.clipsHint}>
        {!items.moments.length && !items.clips.length ? <p className="text-sm text-muted-text">{copy.noClips}</p> : (
          <>
            {items.moments.length > 0 && <><p className="text-xs font-bold uppercase tracking-wide text-muted-text">{copy.moments}</p><div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">{items.moments.map(tile)}</div></>}
            {items.clips.length > 0 && <><p className="text-xs font-bold uppercase tracking-wide text-muted-text">{copy.savedClips}</p><div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">{items.clips.map(tile)}</div></>}
          </>
        )}
        {picked.length > 0 && (
          <div className="rounded-xl border border-line p-2">
            <p className="mb-1 px-1 text-xs font-bold uppercase tracking-wide text-muted-text">{copy.selected}</p>
            <ol className="space-y-1">
              {picked.map((it, i) => (
                <li key={it.key} className="flex items-center gap-2 rounded-lg bg-raised p-1.5">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-floodlight text-xs font-bold text-void">{i + 1}</span>
                  <input value={it.label} onChange={(e) => setPicked((p) => p.map((x) => (x.key === it.key ? { ...x, label: e.target.value.slice(0, 60) } : x)))}
                    aria-label={copy.caption} className="min-w-0 flex-1 rounded-md bg-surface px-2 py-1 text-sm text-text" dir="auto" />
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={copy.moveUp} className="grid h-7 w-7 place-items-center rounded-md text-muted-text disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === picked.length - 1} aria-label={copy.moveDown} className="grid h-7 w-7 place-items-center rounded-md text-muted-text disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                  <button type="button" onClick={() => toggleItem(it)} aria-label={copy.remove} className="grid h-7 w-7 place-items-center rounded-md text-muted-text"><X className="h-4 w-4" /></button>
                </li>
              ))}
            </ol>
          </div>
        )}
      </Section>

      <Section title={copy.outroStep}>
        {!myMatches.length ? <p className="text-sm text-muted-text">{copy.noStats}</p> : (
          <>
            <label className="block text-sm font-semibold text-text">{copy.scope}
              <select value={String(scope)} onChange={(e) => setScope(e.target.value === "season" ? "season" : Number(e.target.value))}
                className="mt-1 block h-10 w-full max-w-sm rounded-xl border border-line bg-raised px-3 text-sm font-normal text-text">
                <option value="season">{copy.season(season.matches)}</option>
                {myMatches.map((m) => (
                  <option key={m.sessionId} value={m.sessionId}>{copy.matchTitle(m.opponent, new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Amman" }).format(new Date(m.startsAt)))}</option>
                ))}
              </select>
            </label>
            <p className="text-sm font-semibold text-text">{copy.outroStats}</p>
            {statChips(outroKeys, scoped.values, toggleKey(setOutroKeys, REEL_MAX_OUTRO_STATS), REEL_MAX_OUTRO_STATS)}
          </>
        )}
      </Section>

      <Section title={copy.formatStep}>
        <div className="flex flex-wrap gap-1.5">
          {(["story", "post", "wide"] as ReelFormat[]).map((f) => (
            <button key={f} type="button" onClick={() => setFormat(f)} aria-pressed={format === f}
              className={cn("h-9 rounded-full px-4 text-sm font-semibold", format === f ? "bg-turf text-void" : "bg-raised text-muted-text")}>{copy.formats[f]}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-semibold text-text">{copy.camera}</span>
          <button type="button" onClick={() => setFollowHim(true)} aria-pressed={followHim} className={cn("h-9 rounded-full px-4 text-sm font-semibold", followHim ? "bg-turf text-void" : "bg-raised text-muted-text")}>{copy.followHim}</button>
          <button type="button" onClick={() => setFollowHim(false)} aria-pressed={!followHim} className={cn("h-9 rounded-full px-4 text-sm font-semibold", !followHim ? "bg-turf text-void" : "bg-raised text-muted-text")}>{copy.followBall}</button>
        </div>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={footageSound} onChange={(e) => setFootageSound(e.target.checked)} className="h-4 w-4 accent-floodlight" />{copy.footageSound}
        </label>
      </Section>

      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
      <div className="sticky bottom-0 -mx-1 flex items-center gap-3 bg-void/90 px-1 py-3 backdrop-blur">
        <button type="button" onClick={() => void build()} disabled={Boolean(progress) || !picked.length}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-floodlight px-5 font-bold text-void disabled:opacity-50" data-testid="reel-build">
          {progress ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Clapperboard className="h-4 w-4" aria-hidden />}{copy.build}
        </button>
        {progress ? <span className="text-sm text-muted-text">{progress}</span> : <span className="inline-flex items-center gap-1.5 text-sm text-muted-text"><Film className="h-4 w-4" aria-hidden />{picked.length}/{REEL_MAX_CLIPS}</span>}
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl border border-line bg-surface p-4">
      <div>
        <h3 className="font-display text-base font-bold text-text">{title}</h3>
        {hint && <p className="text-xs text-muted-text">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export type { LibraryPlayerMedia };
