import { useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Goal, Images, Loader2, Sparkles, Star, Target, Upload, Wind, X } from "lucide-react";
import { useCreativeLibraryCopy, type CreativeLibraryStrings } from "@/i18n/creative-library-strings";

export type LibraryCopy = CreativeLibraryStrings & { locale: "ar" | "en" };
import {
  LIBRARY_MOMENT_TYPES,
  useLibraryClips,
  useLibraryMatches,
  useLibraryMoments,
  useLibraryPlayers,
  useLibraryUploads,
  useUploadLibraryMedia,
  type ClipOrigin,
  type ClipSort,
  type LibraryClip,
  type LibraryMatch,
  type LibraryMoment,
  type LibraryMomentType,
  type LibraryPlayer,
  type LibraryUpload,
} from "@/lib/creative-hub-library-api";
import { resizeImage } from "@/lib/facebook-sdk";
import { cn } from "@/lib/utils";
import { formatLength, stillUrls, Thumb } from "./media";

export type LibraryView = "matches" | "clips" | "uploads";
export type LibraryAccept = "image" | "video" | "any";

/** Something in the Library a person tapped. */
export type LibraryItem =
  | { kind: "moment"; moment: LibraryMoment; match: LibraryMatch | null }
  | { kind: "clip"; clip: LibraryClip }
  | { kind: "upload"; upload: LibraryUpload };

const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

// ── Labels ──────────────────────────────────────────────────────────────────

export function playerLabel(p: LibraryPlayer | null): string | null {
  if (!p || p.number === null) return p?.firstName ?? null;
  return p.firstName ? `#${p.number} ${p.firstName}` : `#${p.number}`;
}

export function dayLabel(date: string, locale: "ar" | "en"): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(d);
}

export function matchTitle(m: LibraryMatch, copy: LibraryCopy): string {
  if (m.type === "training") return m.squad ? `${copy.training} · ${m.squad.name}` : copy.training;
  return m.opponent ? copy.vs(m.opponent) : copy.match;
}

export function momentLabel(m: LibraryMoment, copy: LibraryCopy): string {
  const parts = [m.ownGoal ? copy.ownGoal : m.title ?? copy.type[m.type]];
  if (m.minute) parts.push(copy.minute(m.minute));
  const who = playerLabel(m.player);
  if (who) parts.push(who);
  return parts.join(" · ");
}

export function clipLabel(c: LibraryClip, copy: LibraryCopy): string {
  return c.title ?? `${copy.clip} · ${dayLabel(c.date, copy.locale)}`;
}

const TYPE_ICON: Record<LibraryMomentType, typeof Goal> = { goal: Goal, chance: Target, highlight: Wind, saved: Star };

// ── Small pieces ────────────────────────────────────────────────────────────

export function Chip({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: ReactNode; testId?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} data-testid={testId}
      className={cn("flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors",
        active ? "border-floodlight bg-floodlight text-void" : "border-line text-muted-text hover:text-text")}>
      {children}
    </button>
  );
}

function Select({ value, onChange, label, children, testId }: { value: string; onChange: (v: string) => void; label: string; children: ReactNode; testId?: string }) {
  return (
    <label className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border border-line px-3 text-xs text-muted-text">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}
        className="min-h-9 bg-transparent text-xs font-semibold text-text outline-none">
        {children}
      </select>
    </label>
  );
}

function Notice({ children, onRetry, retry }: { children: ReactNode; onRetry?: () => void; retry?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted-text">
      <p>{children}</p>
      {onRetry && <button type="button" onClick={onRetry} className="mt-3 rounded-full border border-line px-4 py-2 text-xs font-semibold text-text">{retry}</button>}
    </div>
  );
}

function MoreButton({ show, loading, onClick, label }: { show: boolean; loading: boolean; onClick: () => void; label: string }) {
  if (!show) return null;
  return (
    <button type="button" onClick={onClick} disabled={loading}
      className="mx-auto mt-3 flex min-h-10 items-center gap-2 rounded-full border border-line px-5 text-sm font-semibold text-text disabled:opacity-60">
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{label}
    </button>
  );
}

const Grid = ({ children, square }: { children: ReactNode; square?: boolean }) => (
  <ul className={cn("grid gap-3", square ? "grid-cols-3 sm:grid-cols-4 lg:grid-cols-5" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4")}>{children}</ul>
);

const Skeletons = ({ n = 6 }: { n?: number }) => (
  <Grid>{Array.from({ length: n }, (_, i) => <li key={i} className="aspect-video animate-pulse rounded-xl bg-raised" />)}</Grid>
);

// ── Upload ──────────────────────────────────────────────────────────────────

function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

export function UploadButton({ academyId, accept, onUploaded, compact }: { academyId: number; accept: LibraryAccept; onUploaded?: (u: LibraryUpload) => void; compact?: boolean }) {
  const copy = useCreativeLibraryCopy();
  const upload = useUploadLibraryMedia(academyId);
  const ref = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const types = accept === "image" ? "image/jpeg,image/png,image/webp"
    : accept === "video" ? "video/mp4,video/quicktime,video/*"
      : "image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/*";
  const pick = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) { setError(copy.tooBig); return; }
    try {
      let created: LibraryUpload;
      if (file.type.startsWith("image/")) {
        const dataUrl = await resizeImage(file, 1440, 0.88);
        const size = await imageSize(dataUrl);
        const blob = await (await fetch(dataUrl)).blob();
        created = await upload.mutateAsync({ file: blob, name: file.name.replace(/\.[^.]+$/, ".jpg"), ...size });
      } else {
        created = await upload.mutateAsync({ file, name: file.name });
      }
      onUploaded?.(created);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <input ref={ref} type="file" accept={types} className="hidden" data-testid="library-upload-input"
        onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
      <button type="button" onClick={() => ref.current?.click()} disabled={upload.isPending} data-testid="library-upload"
        className="flex min-h-10 items-center gap-2 rounded-full bg-violet px-4 text-sm font-semibold text-white disabled:opacity-60" title={copy.uploadHint}>
        {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
        {!compact && (upload.isPending ? copy.uploading : copy.upload)}
        {compact && <span className="sr-only">{copy.upload}</span>}
      </button>
      {error && <p className="max-w-64 text-end text-xs text-live" role="alert">{error}</p>}
    </div>
  );
}

// ── The browser ─────────────────────────────────────────────────────────────

export type LibraryBrowserProps = {
  academyId: number;
  accept?: LibraryAccept;
  /** A tap on a moment, clip or upload. */
  onSelect: (item: LibraryItem) => void;
  /** Tab only: actions for the whole match, shown above its moments. */
  matchActions?: (match: LibraryMatch) => ReactNode;
  /** Shown before the views (the picker's crest). */
  extra?: ReactNode;
  initialView?: LibraryView;
  dense?: boolean;
};

export function LibraryBrowser({ academyId, accept = "any", onSelect, matchActions, extra, initialView = "matches", dense }: LibraryBrowserProps) {
  const copy = useCreativeLibraryCopy();
  const [view, setView] = useState<LibraryView>(initialView);
  const [match, setMatch] = useState<LibraryMatch | null>(null);
  const [player, setPlayer] = useState<number | null>(null);
  const [squadId, setSquadId] = useState<number | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [types, setTypes] = useState<LibraryMomentType[]>([]);
  const [kind, setKind] = useState<"image" | "video" | null>(accept === "any" ? null : accept);
  const players = useLibraryPlayers(academyId);

  const numbers = useMemo(() => {
    const byNumber = new Map<number, string[]>();
    for (const p of players.data?.players ?? []) {
      if (p.number === null) continue;
      if (squadId && p.squadId !== squadId) continue;
      const names = byNumber.get(p.number) ?? [];
      if (p.firstName) names.push(p.firstName);
      byNumber.set(p.number, names);
    }
    return [...byNumber.entries()].sort((a, b) => a[0] - b[0]);
  }, [players.data, squadId]);

  const views: LibraryView[] = ["matches", "clips", "uploads"];
  const showDates = view !== "matches" || !match;
  const anyFilter = player !== null || squadId !== null || from || to || types.length;

  return (
    <div className="flex flex-col gap-3" data-testid="library-browser">
      {extra}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-full border border-line p-1" role="tablist">
          {views.map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} data-testid={`library-view-${v}`}
              onClick={() => { setView(v); setMatch(null); }}
              className={cn("min-h-8 rounded-full px-3 text-xs font-semibold transition-colors", view === v ? "bg-turf text-void" : "text-muted-text hover:text-text")}>
              {copy.views[v]}
            </button>
          ))}
        </div>
      </div>

      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1">
        {(view === "matches") && (
          <Select label={copy.filters.player} value={player === null ? "" : String(player)} testId="library-filter-player"
            onChange={(v) => setPlayer(v === "" ? null : Number(v))}>
            <option value="">{copy.filters.anyPlayer}</option>
            {numbers.map(([n, names]) => (
              <option key={n} value={n}>{copy.filters.shirt(n)}{names.length ? ` · ${names.slice(0, 2).join(", ")}` : ""}</option>
            ))}
          </Select>
        )}
        {view !== "uploads" && !match && (players.data?.squads.length ?? 0) > 1 && (
          <Select label={copy.filters.squad} value={squadId === null ? "" : String(squadId)} testId="library-filter-squad"
            onChange={(v) => setSquadId(v === "" ? null : Number(v))}>
            <option value="">{copy.filters.anySquad}</option>
            {players.data?.squads.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        {showDates && (
          <>
            <label className="flex min-h-9 shrink-0 items-center gap-1 rounded-full border border-line px-3 text-xs text-muted-text">
              {copy.filters.from}
              <input type="date" dir="ltr" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}
                className="bg-transparent text-xs font-semibold text-text outline-none [color-scheme:dark]" data-testid="library-filter-from" />
            </label>
            <label className="flex min-h-9 shrink-0 items-center gap-1 rounded-full border border-line px-3 text-xs text-muted-text">
              {copy.filters.to}
              <input type="date" dir="ltr" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
                className="bg-transparent text-xs font-semibold text-text outline-none [color-scheme:dark]" data-testid="library-filter-to" />
            </label>
          </>
        )}
        {view === "uploads" && accept === "any" && (
          <>
            <Chip active={kind === null} onClick={() => setKind(null)}>{copy.filters.all}</Chip>
            <Chip active={kind === "image"} onClick={() => setKind("image")}>{copy.filters.photos}</Chip>
            <Chip active={kind === "video"} onClick={() => setKind("video")}>{copy.filters.videos}</Chip>
          </>
        )}
        {anyFilter ? (
          <button type="button" onClick={() => { setPlayer(null); setSquadId(null); setFrom(""); setTo(""); setTypes([]); }}
            className="flex min-h-9 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-semibold text-muted-text hover:text-text">
            <X className="h-3.5 w-3.5" aria-hidden />{copy.filters.clear}
          </button>
        ) : null}
      </div>

      {view === "matches" && !match && (
        <MatchesView academyId={academyId} filter={{ player, squadId, from, to }} onOpen={setMatch} dense={dense} />
      )}
      {view === "matches" && match && (
        <MomentsView academyId={academyId} match={match} player={player} types={types} setTypes={setTypes}
          onBack={() => setMatch(null)} onSelect={onSelect} actions={matchActions?.(match)} />
      )}
      {view === "clips" && <ClipsView academyId={academyId} accept={accept} filter={{ squadId, from, to }} onSelect={onSelect} />}
      {view === "uploads" && (
        <UploadsView academyId={academyId} accept={accept} filter={{ kind: accept === "any" ? kind : accept, from, to }} onSelect={onSelect} />
      )}
    </div>
  );
}

// ── Views ───────────────────────────────────────────────────────────────────

function MatchesView({ academyId, filter, onOpen, dense }: {
  academyId: number;
  filter: { player: number | null; squadId: number | null; from: string; to: string };
  onOpen: (m: LibraryMatch) => void;
  dense?: boolean;
}) {
  const copy = useCreativeLibraryCopy();
  const q = useLibraryMatches(academyId, { player: filter.player, squadId: filter.squadId, from: filter.from || null, to: filter.to || null });
  if (q.isLoading) return <Skeletons />;
  if (q.isError) return <Notice onRetry={() => void q.refetch()} retry={copy.retry}>{copy.failed}</Notice>;
  if (!q.items.length) return <Notice>{copy.noMatches}</Notice>;
  return (
    <div>
      <ul className={cn("grid gap-3", dense ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3")} data-testid="library-matches">
        {q.items.map((m) => (
          <li key={m.sessionId}>
            <button type="button" onClick={() => onOpen(m)} data-testid={`library-match-${m.sessionId}`}
              className="flex w-full items-center gap-3 rounded-2xl border border-line bg-surface p-2 text-start transition-colors hover:border-turf">
              <Thumb urls={stillUrls(academyId, m.still, m.thumbnailUrl)} length={formatLength(m.durationMs)} className="aspect-video w-32 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-text">{matchTitle(m, copy)}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-text">
                  <span>{dayLabel(m.date, copy.locale)} · <span dir="ltr">{m.time}</span></span>
                  {m.squad && m.type === "match" && <span>{m.squad.name}</span>}
                </span>
                <span className="mt-1 flex items-center gap-2">
                  {m.ownScore !== null && m.opponentScore !== null && (
                    <span className="rounded-md bg-void px-1.5 py-0.5 font-display text-sm font-bold text-floodlight" dir="ltr">{m.ownScore}–{m.opponentScore}</span>
                  )}
                  <span className={cn("inline-flex items-center gap-1 text-[11px] font-semibold", m.analysed ? "text-turf" : "text-muted-text")}>
                    <Sparkles className="h-3 w-3" aria-hidden />{m.analysed ? copy.analysed : copy.notAnalysed}
                  </span>
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <MoreButton show={Boolean(q.hasNextPage)} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} label={copy.loadMore} />
    </div>
  );
}

function MomentsView({ academyId, match, player, types, setTypes, onBack, onSelect, actions }: {
  academyId: number;
  match: LibraryMatch;
  player: number | null;
  types: LibraryMomentType[];
  setTypes: (t: LibraryMomentType[]) => void;
  onBack: () => void;
  onSelect: (item: LibraryItem) => void;
  actions?: ReactNode;
}) {
  const copy = useCreativeLibraryCopy();
  const q = useLibraryMoments(academyId, match.sessionId, { types, player });
  const Back = copy.locale === "ar" ? ArrowRight : ArrowLeft;
  const counts = q.first?.counts;
  const toggle = (t: LibraryMomentType) => setTypes(types.includes(t) ? types.filter((x) => x !== t) : [...types, t]);
  return (
    <div className="flex flex-col gap-3" data-testid="library-moments">
      <button type="button" onClick={onBack} className="flex min-h-9 w-fit items-center gap-1.5 text-sm font-semibold text-muted-text hover:text-text">
        <Back className="h-4 w-4" aria-hidden />{copy.backToMatches}
      </button>
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-3">
        <Thumb urls={stillUrls(academyId, match.still, match.thumbnailUrl)} length={formatLength(match.durationMs)} className="aspect-video w-28 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-lg font-bold text-text">{matchTitle(match, copy)}</p>
          <p className="text-xs text-muted-text">
            {dayLabel(match.date, copy.locale)}
            {match.ownScore !== null && match.opponentScore !== null && <> · <span dir="ltr" className="font-bold text-floodlight">{match.ownScore}–{match.opponentScore}</span></>}
          </p>
        </div>
        {actions}
      </div>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {LIBRARY_MOMENT_TYPES.map((t) => {
          const Icon = TYPE_ICON[t];
          return (
            <Chip key={t} active={types.includes(t)} onClick={() => toggle(t)} testId={`library-type-${t}`}>
              <Icon className="h-3.5 w-3.5" aria-hidden />{copy.types[t]}
              {counts ? <span className="opacity-70" dir="ltr">{counts[t]}</span> : null}
            </Chip>
          );
        })}
      </div>
      {q.isLoading ? <Skeletons />
        : q.isError ? <Notice onRetry={() => void q.refetch()} retry={copy.retry}>{copy.failed}</Notice>
          : (
            <>
              {q.first?.analysis === "none" && <p className="rounded-xl bg-raised p-3 text-xs text-muted-text">{copy.noMomentsAnalysis}</p>}
              {q.first?.analysis === "failed" && <p className="rounded-xl bg-raised p-3 text-xs text-muted-text">{copy.analysisFailed}</p>}
              {!q.items.length ? <Notice>{copy.noMoments}</Notice> : (
                <Grid>
                  {q.items.map((m) => {
                    const Icon = TYPE_ICON[m.type];
                    return (
                      <li key={m.id}>
                        <button type="button" onClick={() => onSelect({ kind: "moment", moment: m, match })} data-testid={`library-moment-${m.id}`}
                          className="group block w-full text-start">
                          <Thumb urls={stillUrls(academyId, m.still, m.thumbnailUrl)} video length={formatLength(m.durationMs)}
                            className="aspect-video w-full ring-turf transition group-hover:ring-2">
                            <span className={cn("absolute end-1.5 top-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold",
                              m.type === "goal" ? "bg-floodlight text-void" : m.type === "saved" ? "bg-violet text-white" : "bg-black/70 text-white")}>
                              <Icon className="h-3 w-3" aria-hidden />{copy.type[m.type]}
                            </span>
                          </Thumb>
                          <span className="mt-1 block truncate text-xs font-semibold text-text">{momentLabel(m, copy)}</span>
                        </button>
                      </li>
                    );
                  })}
                </Grid>
              )}
              <MoreButton show={Boolean(q.hasNextPage)} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} label={copy.loadMore} />
            </>
          )}
    </div>
  );
}

function clipBadge(c: LibraryClip, copy: LibraryCopy): string | null {
  return c.status === "processing" ? copy.processing : c.status === "live" ? copy.liveClip : c.status === "failed" ? copy.failedClip : null;
}

function ClipTile({ academyId, c, onSelect }: { academyId: number; c: LibraryClip; onSelect: (item: LibraryItem) => void }) {
  const copy = useCreativeLibraryCopy();
  const badge = clipBadge(c, copy);
  const usable = c.status === "ready" || c.status === "processing";
  return (
    <li>
      <button type="button" disabled={!usable} onClick={() => onSelect({ kind: "clip", clip: c })} data-testid={`library-clip-${c.clipId}`}
        className="group block w-full text-start disabled:opacity-50">
        <Thumb urls={stillUrls(academyId, c.source, c.thumbnailUrl)} video length={formatLength(c.durationMs)}
          className={cn("w-full ring-turf transition group-hover:ring-2", c.aspectRatio === "9:16" ? "aspect-[9/16]" : "aspect-video")}>
          {badge && <span className="absolute end-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white">{badge}</span>}
          {c.origin && (
            <span className={cn("absolute start-1.5 top-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold", c.origin === "auto" ? "bg-floodlight text-void" : "bg-black/70 text-white")}>
              {c.origin === "auto" && <Sparkles className="h-3 w-3" aria-hidden />}
              {c.origin === "auto" ? copy.madeByReplay : c.madeBy ?? copy.origin.player}
            </span>
          )}
        </Thumb>
        <span className="mt-1 block truncate text-xs font-semibold text-text">{clipLabel(c, copy)}</span>
      </button>
    </li>
  );
}

function ClipsView({ academyId, accept, filter, onSelect }: {
  academyId: number;
  accept: LibraryAccept;
  filter: { squadId: number | null; from: string; to: string };
  onSelect: (item: LibraryItem) => void;
}) {
  const copy = useCreativeLibraryCopy();
  const [origin, setOrigin] = useState<ClipOrigin | null>(null);
  const [sort, setSort] = useState<ClipSort>("newest");
  const q = useLibraryClips(academyId, { squadId: filter.squadId, from: filter.from || null, to: filter.to || null, origin, sort });
  // A picture slot can only take a clip we can take a frame of.
  const items = accept === "image" ? q.items.filter((c) => c.still) : q.items;
  // A field's clips come from players and from Replay: say which, filter by it, and sort by match or player.
  const counts = q.counts;
  const controls = counts && (counts.all > 0 || origin) ? (
    <div className="mb-3 flex flex-wrap items-center gap-1.5" data-testid="library-clip-controls">
      <div className="flex flex-wrap gap-1.5" role="group" data-testid="library-clip-origin">
        {([null, "player", "auto"] as const).map((o) => (
          <Chip key={o ?? "all"} active={origin === o} onClick={() => setOrigin(o)} testId={`library-origin-${o ?? "all"}`}>
            {o === "auto" && <Sparkles className="h-3.5 w-3.5" aria-hidden />}
            {copy.origin[o ?? "all"]} · {o ? counts[o] : counts.all}
          </Chip>
        ))}
      </div>
      <span className="mx-1 hidden h-5 w-px bg-line sm:block" aria-hidden />
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={copy.sortLabel} data-testid="library-clip-sort">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-text">{copy.sortLabel}</span>
        {(["newest", "match", "player"] as const).map((s) => (
          <Chip key={s} active={sort === s} onClick={() => setSort(s)} testId={`library-sort-${s}`}>{copy.sort[s]}</Chip>
        ))}
      </div>
    </div>
  ) : null;
  if (q.isLoading) return <>{controls}<Skeletons /></>;
  if (q.isError) return <Notice onRetry={() => void q.refetch()} retry={copy.retry}>{copy.failed}</Notice>;
  if (!items.length) return <>{controls}<Notice>{origin ? copy.noOriginClips[origin] : copy.noClips}</Notice></>;

  // By match / by player: consecutive runs of the same game or player, each under a header.
  const groups: Array<{ key: string; title: string; sub: string | null; clips: LibraryClip[] }> = [];
  if (sort !== "newest") {
    for (const c of items) {
      const key = sort === "match" ? c.match?.key ?? "none" : c.player?.key ?? "none";
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) {
        const title = sort === "match"
          ? (c.match ? `${dayLabel(c.match.date, copy.locale)} · ${c.match.time}` : copy.otherClips)
          : c.player?.name ?? copy.unknownPlayer;
        const sub = sort === "match" ? c.match?.pitch ?? null : null;
        g = { key, title, sub, clips: [] };
        groups.push(g);
      }
      g.clips.push(c);
    }
  }
  return (
    <div data-testid="library-clips">
      {controls}
      {sort === "newest" ? (
        <Grid>{items.map((c) => <ClipTile key={c.clipId} academyId={academyId} c={c} onSelect={onSelect} />)}</Grid>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <section key={g.key} data-testid={`library-clip-group-${g.key}`}>
              <header className="mb-2 flex items-baseline justify-between gap-3 border-b border-line pb-1.5">
                <h3 className="truncate text-sm font-bold text-text">
                  {g.title}{g.sub ? <span className="font-semibold text-muted-text"> · {g.sub}</span> : null}
                </h3>
                <span className="shrink-0 text-xs text-muted-text">{copy.clipCount(q.groupSizes[g.key] ?? g.clips.length)}</span>
              </header>
              <Grid>{g.clips.map((c) => <ClipTile key={c.clipId} academyId={academyId} c={c} onSelect={onSelect} />)}</Grid>
            </section>
          ))}
        </div>
      )}
      <MoreButton show={Boolean(q.hasNextPage)} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} label={copy.loadMore} />
    </div>
  );
}

function UploadsView({ academyId, accept, filter, onSelect }: {
  academyId: number;
  accept: LibraryAccept;
  filter: { kind: "image" | "video" | null; from: string; to: string };
  onSelect: (item: LibraryItem) => void;
}) {
  const copy = useCreativeLibraryCopy();
  const q = useLibraryUploads(academyId, { kind: filter.kind, from: filter.from || null, to: filter.to || null });
  return (
    <div className="flex flex-col gap-3" data-testid="library-uploads">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-text">{copy.uploadHint}</p>
        <UploadButton academyId={academyId} accept={accept} onUploaded={(u) => onSelect({ kind: "upload", upload: u })} />
      </div>
      {q.isLoading ? <Skeletons />
        : q.isError ? <Notice onRetry={() => void q.refetch()} retry={copy.retry}>{copy.failed}</Notice>
          : !q.items.length ? <Notice>{copy.noUploads}</Notice> : (
            <Grid square>
              {q.items.map((u) => (
                <li key={u.mediaId}>
                  <button type="button" onClick={() => onSelect({ kind: "upload", upload: u })} data-testid={`library-upload-${u.mediaId}`}
                    className="group block w-full text-start" title={u.name}>
                    <Thumb urls={stillUrls(academyId, u.source, u.thumbnailUrl)} video={u.kind === "video"}
                      length={u.kind === "video" ? formatLength(u.durationMs) : null}
                      className="aspect-square w-full ring-turf transition group-hover:ring-2">
                      {u.kind === "image" && <span className="absolute bottom-1.5 start-1.5 rounded-md bg-black/70 p-0.5 text-white"><Images className="h-3 w-3" aria-hidden /></span>}
                      {u.status === "processing" && <span className="absolute end-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white">{copy.processing}</span>}
                    </Thumb>
                  </button>
                </li>
              ))}
            </Grid>
          )}
      <MoreButton show={Boolean(q.hasNextPage)} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} label={copy.loadMore} />
    </div>
  );
}

