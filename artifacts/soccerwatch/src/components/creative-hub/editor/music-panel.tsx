import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Film, Image as ImageIcon, Loader2, Music2, Pause, Play, Plus, Sparkles, Trash2, Upload, X } from "lucide-react";
import {
  MUSIC_MOODS, PHOTO_VIDEO_MAX_MS, PHOTO_VIDEO_MIN_MS, clampMusicStart, clampPhotoVideoMs, hasMusic, isPhotoVideo,
  type MusicMood, type SceneMusic,
} from "@workspace/api-zod";
import { useCreativeMusicCopy } from "@/i18n/creative-music-strings";
import {
  musicFileUrl, useCreativeMusic, useDeleteCreativeMusic, useTemplateMusicRecommendations, type MusicTrack,
} from "@/lib/creative-hub-music-api";
import { formatTrackLength, recommendedMusicChange, sceneTrack, windowOnTrack } from "@/lib/creative-music";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Chip, IconButton, NumberSlider, Section, Toggle, panelEmpty } from "./controls";
import type { EditorApi } from "./editor-api";
import { MusicUploadDialog } from "./music-upload";
import { Waveform } from "./waveform";

type Shelf = "replay" | "academy";

/** Settings a newly picked track starts with when the design had no music. */
const FRESH: Omit<SceneMusic, "trackId"> = { volume: 0.6, startMs: 0, fadeInMs: 300, fadeOutMs: 1200, duck: false };

/**
 * Editor → Music: the soundtrack, on videos and stills alike.
 *
 * Instagram and Facebook take music only inside a video, so on a still the
 * panel says so and "Add music" (or Use on any track) turns the design into a
 * short video of itself with the music on (EditorApi.addMusic: one undo step).
 * Such a photo video gets its length (5–30 s), the slow zoom toggle and "Back
 * to a photo"; removing its music asks whether to go back to a photo.
 *
 * "Recommended for <template>"
 * on top lists the template's recommended tracks (an admin's choice, else
 * Replay's). Browse Replay's library and
 * the academy's own uploads by mood, listen, pick one, then choose where it
 * starts on the waveform, its volume, fades and ducking. "Upload music" adds
 * the academy's own (rights confirmed).
 */
export function MusicPanel({ ed }: { ed: EditorApi }) {
  const copy = useCreativeMusicCopy();
  const tracks = useCreativeMusic(ed.academyId, true);
  const remove = useDeleteCreativeMusic(ed.academyId);
  const templateKey = ed.template?.key ?? null;
  const recommendations = useTemplateMusicRecommendations(ed.academyId, !!templateKey);
  const rec = templateKey ? recommendations.data?.[templateKey] ?? null : null;
  const [shelf, setShelf] = useState<Shelf>("replay");
  const [mood, setMood] = useState<MusicMood | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const audition = useAudition();
  const still = !ed.isVideo;
  const photoVideo = isPhotoVideo(ed.scene);
  const music = ed.scene.music;
  const sceneMs = ed.scene.durationMs ?? 0;
  const current = sceneTrack(music, tracks.data);

  // The scene playing and a track audition never sound together.
  useEffect(() => { if (ed.playing) audition.stop(); }, [ed.playing]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => (tracks.data ?? []).filter((t) => t.scope === shelf && (!mood || t.mood === mood)), [tracks.data, shelf, mood]);
  const recommended = useMemo(() => {
    const byId = new Map((tracks.data ?? []).map((t) => [t.trackId, t]));
    return (rec?.trackIds ?? []).map((id) => byId.get(id)).filter((t): t is MusicTrack => !!t && t.scope === "replay");
  }, [tracks.data, rec]);

  const setMusic = (change: Partial<SceneMusic>, key?: string) => {
    if (!hasMusic(music)) return;
    ed.updateScene({ music: { ...music, ...change } }, key ? `music:${key}` : undefined);
  };
  const use = (t: MusicTrack) => {
    audition.stop();
    const base = hasMusic(music) ? { ...music } : { ...FRESH };
    delete base.trackKey;
    const next = { ...base, trackId: t.trackId, startMs: 0 };
    if (still) ed.addMusic(next);
    else ed.updateScene({ music: next });
  };
  const applyRecommended = (t: MusicTrack) => {
    if (!rec) return;
    audition.stop();
    const next = recommendedMusicChange(still ? undefined : music, rec, t.trackId);
    if (still) ed.addMusic(next);
    else ed.updateScene({ music: next });
  };
  const removeMusic = () => {
    audition.stop();
    if (photoVideo) setRemoving(true);
    else ed.updateScene({ music: undefined });
  };
  const row = (t: MusicTrack, onUse: () => void, testPrefix = "") => (
    <TrackRow key={t.trackId} track={t} inUse={current?.trackId === t.trackId} testPrefix={testPrefix}
      auditioning={audition.id === t.trackId} loading={audition.id === t.trackId && audition.loading}
      progressMs={audition.id === t.trackId ? audition.ms : null}
      onAudition={() => { ed.setPlaying(false); audition.toggle(t); }}
      onUse={onUse}
      onDelete={t.mine ? () => {
        if (!window.confirm(copy.deleteConfirm)) return;
        if (audition.id === t.trackId) audition.stop();
        remove.mutate(t.trackId);
      } : undefined} />
  );

  return (
    <div className="space-y-5" data-testid="editor-music-panel">
      {still ? (
        <Section title={copy.photoTitle}>
          <div className="space-y-3 rounded-xl border border-violet/40 bg-violet/5 p-3" data-testid="music-still">
            <p className="flex items-start gap-1.5 text-xs text-muted-text"><Film className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet" aria-hidden />{copy.photoNote}</p>
            {recommended[0] ? (
              <Button type="button" className="min-h-11 w-full rounded-xl" onClick={() => applyRecommended(recommended[0]!)} data-testid="music-add">
                <Plus className="h-4 w-4" />{copy.addMusic}
              </Button>
            ) : null}
            <p className="text-xs text-muted-text">{recommended[0] ? copy.addHint(recommended[0].title) : copy.pickHint}</p>
          </div>
        </Section>
      ) : (
      <Section title={copy.current}>
        {removing && photoVideo ? (
          <div className="space-y-2 rounded-xl border border-line p-3" data-testid="music-remove-choice">
            <p className="text-sm font-semibold text-text">{copy.removeChoice}</p>
            <p className="text-xs text-muted-text">{copy.backToPhotoHint}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" className="min-h-10 rounded-xl" onClick={() => { setRemoving(false); ed.backToPhoto(); }} data-testid="music-back-to-photo">
                <ImageIcon className="h-4 w-4" />{copy.backToPhoto}
              </Button>
              <Button type="button" size="sm" variant="outline" className="min-h-10 rounded-xl" onClick={() => { setRemoving(false); ed.updateScene({ music: undefined }); }} data-testid="music-keep-silent">
                {copy.keepSilent}
              </Button>
              <Button type="button" size="sm" variant="ghost" className="min-h-10 rounded-xl" onClick={() => setRemoving(false)}>{copy.cancel}</Button>
            </div>
          </div>
        ) : !hasMusic(music) ? <p className={panelEmpty}>{copy.noMusic}</p>
          : !current ? (
            tracks.isLoading ? <div className="h-24 animate-pulse rounded-xl bg-raised" /> : (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-line p-3">
                <p className="text-sm text-muted-text">{copy.missingTrack}</p>
                <IconButton label={copy.remove} onClick={removeMusic}><X className="h-4 w-4" /></IconButton>
              </div>
            )
          ) : (
            <CurrentTrack track={current} music={music} sceneMs={sceneMs} timeMs={ed.timeMs} playing={ed.playing}
              onChange={setMusic} onRemove={removeMusic} />
          )}
      </Section>
      )}

      {photoVideo ? (
        <Section title={copy.photoVideo}>
          <div className="space-y-3" data-testid="music-photo-video">
            <p className="flex items-start gap-1.5 text-xs text-muted-text"><Film className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet" aria-hidden />{copy.photoNote}</p>
            <NumberSlider label={copy.length} value={Math.round(sceneMs / 1000)} min={PHOTO_VIDEO_MIN_MS / 1000} max={PHOTO_VIDEO_MAX_MS / 1000} unit={copy.seconds}
              onChange={(v) => ed.updateScene({ durationMs: clampPhotoVideoMs(v * 1000) }, "duration")} testId="music-length" />
            <div>
              <Toggle id="music-slow-zoom" label={copy.slowZoom} checked={!!ed.scene.slowZoom} onChange={(v) => ed.updateScene({ slowZoom: v ? true : undefined })} testId="music-slow-zoom" />
              <p className="text-xs text-muted-text">{copy.slowZoomHint}</p>
            </div>
            <Button type="button" variant="outline" className="min-h-10 w-full rounded-xl" onClick={() => { audition.stop(); setRemoving(false); ed.backToPhoto(); }} data-testid="music-photo-back">
              <ImageIcon className="h-4 w-4" />{copy.backToPhoto}
            </Button>
          </div>
        </Section>
      ) : null}

      {recommended.length > 0 && ed.template ? (
        <Section title={copy.recommendedFor(ed.template.title[copy.locale])}>
          <div data-testid="music-recommended" className="space-y-2">
            <p className="flex items-center gap-1.5 text-xs text-muted-text"><Sparkles className="h-3.5 w-3.5 shrink-0 text-turf" aria-hidden />{copy.recommendedHint}</p>
            <ul className="space-y-2">{recommended.map((t) => row(t, () => applyRecommended(t), "rec-"))}</ul>
          </div>
        </Section>
      ) : null}

      <Section title={copy.tool} aside={
        <Button type="button" size="sm" variant="outline" className="min-h-9 rounded-xl" onClick={() => { audition.stop(); setUploadOpen(true); }} data-testid="music-upload-open">
          <Upload className="h-4 w-4" />{copy.upload}
        </Button>
      }>
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-raised p-1" role="tablist">
          {(["replay", "academy"] as const).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={shelf === s} onClick={() => setShelf(s)} data-testid={`music-shelf-${s}`}
              className={cn("min-h-10 rounded-lg text-sm font-semibold transition-colors", shelf === s ? "bg-surface text-text shadow" : "text-muted-text hover:text-text")}>
              {s === "replay" ? copy.library : copy.ours}
            </button>
          ))}
        </div>
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 no-scrollbar">
          <Chip active={mood === null} onClick={() => setMood(null)} className="shrink-0">{copy.allMoods}</Chip>
          {MUSIC_MOODS.map((m) => <Chip key={m} active={mood === m} onClick={() => setMood(mood === m ? null : m)} className="shrink-0" testId={`music-mood-${m}`}>{copy.moods[m]}</Chip>)}
        </div>

        {tracks.isLoading ? (
          <div className="space-y-2" aria-busy><div className="h-16 animate-pulse rounded-xl bg-raised" /><div className="h-16 animate-pulse rounded-xl bg-raised" /></div>
        ) : tracks.isError ? (
          <div className="space-y-2 text-center">
            <p className="text-sm text-live" role="alert">{copy.loadError}</p>
            <Button type="button" variant="outline" size="sm" className="rounded-xl" onClick={() => void tracks.refetch()}>{copy.retry}</Button>
          </div>
        ) : list.length === 0 ? (
          <p className={panelEmpty}>{shelf === "academy" && !mood ? copy.noOwn : copy.noneInMood}</p>
        ) : (
          <ul className="space-y-2" data-testid="music-track-list">
            {list.map((t) => row(t, () => use(t)))}
          </ul>
        )}
      </Section>

      <MusicUploadDialog academyId={ed.academyId} open={uploadOpen} onOpenChange={setUploadOpen} defaultMood={mood ?? undefined}
        onUploaded={(t) => { setShelf("academy"); setMood(null); use(t); }} />
    </div>
  );
}

function CurrentTrack({ track, music, sceneMs, timeMs, playing, onChange, onRemove }: {
  track: MusicTrack; music: SceneMusic; sceneMs: number; timeMs: number; playing: boolean;
  onChange: (c: Partial<SceneMusic>, key?: string) => void; onRemove: () => void;
}) {
  const copy = useCreativeMusicCopy();
  const startMs = clampMusicStart(music.startMs ?? 0, track.durationMs, sceneMs);
  const win = windowOnTrack(startMs, track.durationMs, sceneMs);
  const playAt = playing || timeMs > 0 ? (startMs + timeMs) % Math.max(1, track.durationMs) : null;
  const sec = (ms: number | undefined) => Math.round((ms ?? 0) / 100) / 10;
  return (
    <div className="space-y-4 rounded-xl border border-turf/40 bg-turf/5 p-3" data-testid="music-current">
      <div className="flex items-center gap-2">
        <Music2 className="h-4 w-4 shrink-0 text-turf" aria-hidden />
        <div className="min-w-0 flex-1">
          <bdi dir="auto" className="block truncate text-sm font-semibold text-text">{track.title}</bdi>
          <span className="block truncate text-xs text-muted-text">
            {copy.moods[track.mood]}{track.artist ? ` · ${copy.by(track.artist)}` : ""} · <bdi dir="ltr">{formatTrackLength(track.durationMs)}</bdi>
          </span>
        </div>
        <IconButton label={copy.remove} onClick={onRemove} className="hover:text-live" testId="music-remove"><Trash2 className="h-4 w-4" /></IconButton>
      </div>
      <div className="space-y-1.5">
        <Waveform peaks={track.waveform} trackMs={track.durationMs} sceneMs={sceneMs} startMs={startMs} progressMs={playAt}
          onStartChange={(s) => onChange({ startMs: s }, "start")} label={copy.startsAt} height={56} bars={80} testId="music-waveform" />
        <div className="flex items-center justify-between gap-2 text-xs text-muted-text">
          <span>{copy.startHint}</span>
          <span className="shrink-0">{copy.startsAt} <bdi dir="ltr" className="font-mono text-text">{formatTrackLength(startMs)}</bdi></span>
        </div>
        {win.loops ? <p className="text-xs text-muted-text">{copy.loops}</p> : null}
      </div>
      <NumberSlider label={copy.volume} value={Math.round((music.volume ?? 0.6) * 100)} min={0} max={100} unit="%"
        onChange={(v) => onChange({ volume: Math.round(v) / 100 }, "volume")} testId="music-volume" />
      <div className="grid gap-3 sm:grid-cols-2">
        <NumberSlider label={copy.fadeIn} value={sec(music.fadeInMs)} min={0} max={5} step={0.1} unit={copy.seconds}
          onChange={(v) => onChange({ fadeInMs: Math.round(v * 1000) }, "fadeIn")} testId="music-fade-in" />
        <NumberSlider label={copy.fadeOut} value={sec(music.fadeOutMs)} min={0} max={5} step={0.1} unit={copy.seconds}
          onChange={(v) => onChange({ fadeOutMs: Math.round(v * 1000) }, "fadeOut")} testId="music-fade-out" />
      </div>
      <div>
        <Toggle id="music-duck" label={copy.duck} checked={!!music.duck} onChange={(v) => onChange({ duck: v })} testId="music-duck" />
        <p className="text-xs text-muted-text">{copy.duckHint}</p>
      </div>
    </div>
  );
}

function TrackRow({ track, inUse, auditioning, loading, progressMs, onAudition, onUse, onDelete, testPrefix = "" }: {
  track: MusicTrack; inUse: boolean; auditioning: boolean; loading: boolean; progressMs: number | null;
  onAudition: () => void; onUse: () => void; onDelete?: () => void; testPrefix?: string;
}) {
  const copy = useCreativeMusicCopy();
  return (
    <li className={cn("space-y-2 rounded-xl border p-2.5", inUse ? "border-turf bg-turf/5" : "border-line bg-surface")} data-testid={`music-${testPrefix}track-${track.trackId}`}>
      <div className="flex items-center gap-2">
        <IconButton label={auditioning ? copy.pause : copy.play} onClick={onAudition} active={auditioning} testId={`music-${testPrefix}play-${track.trackId}`}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : auditioning ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </IconButton>
        <div className="min-w-0 flex-1">
          <bdi dir="auto" className="block truncate text-sm font-semibold text-text">{track.title}</bdi>
          <span className="block truncate text-[11px] text-muted-text">
            {copy.moods[track.mood]}{track.bpm ? ` · ${copy.bpm(track.bpm)}` : ""} · <bdi dir="ltr">{formatTrackLength(track.durationMs)}</bdi>
          </span>
        </div>
        {onDelete ? <IconButton label={copy.deleteTrack} onClick={onDelete} className="hover:text-live"><Trash2 className="h-4 w-4" /></IconButton> : null}
        <Button type="button" size="sm" variant={inUse ? "outline" : "default"} className="min-h-10 shrink-0 rounded-xl px-3" onClick={onUse} disabled={inUse} data-testid={`music-${testPrefix}use-${track.trackId}`}>
          {inUse ? <><Check className="h-4 w-4" />{copy.using}</> : copy.use}
        </Button>
      </div>
      <Waveform peaks={track.waveform} trackMs={track.durationMs} progressMs={progressMs} height={28} bars={56} />
    </li>
  );
}

/** One <audio> for listening to tracks in the list: one at a time, with its position for the waveform. */
function useAudition() {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [id, setId] = useState<number | null>(null);
  const [ms, setMs] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => () => { ref.current?.pause(); ref.current = null; }, []);
  const stop = () => { ref.current?.pause(); setId(null); setLoading(false); };
  const toggle = (t: MusicTrack) => {
    if (id === t.trackId) { stop(); return; }
    ref.current?.pause();
    const a = new Audio(musicFileUrl(t));
    a.preload = "auto";
    a.ontimeupdate = () => setMs(a.currentTime * 1000);
    a.onended = () => { if (ref.current === a) setId(null); };
    a.onplaying = () => setLoading(false);
    ref.current = a;
    setId(t.trackId);
    setMs(0);
    setLoading(true);
    void a.play().catch(() => { if (ref.current === a) { setId(null); setLoading(false); } });
  };
  return { id, ms, loading, stop, toggle };
}
