import { useEffect, useRef, useState } from "react";
import { MUSIC_MOODS, MUSIC_UPLOAD_ACCEPT, MUSIC_UPLOAD_MAX_BYTES, type MusicMood } from "@workspace/api-zod";
import type { MusicTrack } from "@/lib/creative-hub-music-api";
import { TemplateMusicSection } from "./TemplateMusicSection";

/**
 * Admin → Creative music: Replay's music library for every academy's Creative
 * hub (video soundtracks). Upload a track (any licence you hold; write it in
 * Licence), set title / artist / mood / BPM, listen, hide or show it. Hidden
 * tracks leave every academy's list and stop playing in new exports.
 * Bundled tracks come from scripts/creative-music/generate.py ("Replay
 * original (generated)") and scripts/creative-music/import_cc0.py (CC0 tracks
 * from OpenGameArt, source page in the licence), and are seeded on boot.
 * Template music (TemplateMusicSection): which tracks each template
 * recommends, in order, and how they play.
 * API: GET/POST /admin/creative/music, PATCH /admin/creative/music/:id, GET …/:id/file,
 * GET /admin/creative/music/templates, PUT|DELETE …/templates/:key.
 */

const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
const api = (p: string) => `${basePath}/api${p}`;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = init?.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : undefined;
  const res = await fetch(api(path), { credentials: "include", ...init, headers: { ...(headers ?? {}), ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => null) as { error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

const length = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const field = "rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-white";

export default function CreativeMusicTab() {
  const [tracks, setTracks] = useState<MusicTrack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  const load = () => call<{ tracks: MusicTrack[] }>("/admin/creative/music").then((r) => setTracks(r.tracks)).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); return () => audio.current?.pause(); }, []);

  const play = (t: MusicTrack) => {
    audio.current?.pause();
    if (playing === t.trackId) { setPlaying(null); return; }
    const a = new Audio(api(t.url.replace(/^\/api/, "")));
    a.onended = () => setPlaying(null);
    audio.current = a;
    setPlaying(t.trackId);
    void a.play().catch(() => setPlaying(null));
  };
  const saved = (t: MusicTrack) => setTracks((cur) => (cur ?? []).map((x) => (x.trackId === t.trackId ? t : x)));

  return (
    <div className="space-y-5 p-4" data-testid="admin-creative-music">
      <div>
        <h2 className="text-lg font-bold text-white">Creative music</h2>
        <p className="text-sm text-zinc-400">Replay&apos;s soundtrack library for academies&apos; video posts. Only upload music Replay may use and say how in Licence.</p>
      </div>
      <TemplateMusicSection call={call} tracks={tracks} playing={playing} onPlay={play} />
      <UploadForm onAdded={(t) => setTracks((cur) => [...(cur ?? []), t])} />
      {error ? <p className="text-sm text-red-400" role="alert">{error}</p> : null}
      {!tracks ? <p className="text-sm text-zinc-500">Loading…</p> : tracks.length === 0 ? <p className="text-sm text-zinc-500">No tracks yet.</p> : (
        <ul className="space-y-2">
          {tracks.map((t) => <TrackRow key={t.trackId} track={t} playing={playing === t.trackId} onPlay={() => play(t)} onSaved={saved} />)}
        </ul>
      )}
    </div>
  );
}

function TrackRow({ track, playing, onPlay, onSaved }: { track: MusicTrack; playing: boolean; onPlay: () => void; onSaved: (t: MusicTrack) => void }) {
  const [draft, setDraft] = useState({ title: track.title, artist: track.artist ?? "", mood: track.mood, bpm: track.bpm ? String(track.bpm) : "", license: track.license });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft.title !== track.title || draft.artist !== (track.artist ?? "") || draft.mood !== track.mood
    || draft.bpm !== (track.bpm ? String(track.bpm) : "") || draft.license !== track.license;
  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      onSaved((await call<{ track: MusicTrack }>(`/admin/creative/music/${track.trackId}`, { method: "PATCH", body: JSON.stringify(body) })).track);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const hidden = track.status === "hidden";
  return (
    <li className={`rounded-lg border p-3 ${hidden ? "border-zinc-800 opacity-60" : "border-zinc-700"} bg-zinc-950/40`} data-testid={`admin-music-${track.trackId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onPlay} className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-800">
          {playing ? "Pause" : "Play"}
        </button>
        <input className={`${field} min-w-40 flex-1`} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Title" />
        <input className={`${field} w-36`} value={draft.artist} onChange={(e) => setDraft({ ...draft, artist: e.target.value })} placeholder="Artist" aria-label="Artist" />
        <select className={field} value={draft.mood} onChange={(e) => setDraft({ ...draft, mood: e.target.value as MusicMood })} aria-label="Mood">
          {MUSIC_MOODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input className={`${field} w-16`} value={draft.bpm} onChange={(e) => setDraft({ ...draft, bpm: e.target.value.replace(/\D/g, "").slice(0, 3) })} placeholder="BPM" aria-label="BPM" />
        <span className="font-mono text-xs text-zinc-400">{length(track.durationMs)}{track.loudnessLufs !== null ? ` · ${track.loudnessLufs} LUFS` : ""}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input className={`${field} min-w-60 flex-1`} value={draft.license} onChange={(e) => setDraft({ ...draft, license: e.target.value })} aria-label="Licence" />
        <button type="button" disabled={!dirty || busy} onClick={() => void patch({ ...draft, bpm: draft.bpm || null })}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">Save</button>
        <button type="button" disabled={busy} onClick={() => void patch({ status: hidden ? "active" : "hidden" })}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-800 disabled:opacity-40" data-testid={`admin-music-toggle-${track.trackId}`}>
          {hidden ? "Show" : "Hide"}
        </button>
        {hidden ? <span className="text-xs text-amber-400">Hidden from academies</span> : null}
      </div>
      {error ? <p className="mt-1 text-xs text-red-400" role="alert">{error}</p> : null}
    </li>
  );
}

function UploadForm({ onAdded }: { onAdded: (t: MusicTrack) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [mood, setMood] = useState<MusicMood>("hype");
  const [bpm, setBpm] = useState("");
  const [license, setLicense] = useState("Replay licensed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!file) return;
    if (file.size > MUSIC_UPLOAD_MAX_BYTES) { setError("Files can be at most 20 MB."); return; }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("title", title);
      form.append("artist", artist);
      form.append("mood", mood);
      if (bpm) form.append("bpm", bpm);
      form.append("license", license);
      const r = await call<{ track: MusicTrack }>("/admin/creative/music", { method: "POST", body: form });
      onAdded(r.track);
      setNote(`Added “${r.track.title}”.`);
      setFile(null); setTitle(""); setArtist(""); setBpm("");
      if (input.current) input.current.value = "";
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <p className="text-sm font-semibold text-white">Upload a track</p>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept={MUSIC_UPLOAD_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-xs text-zinc-300" data-testid="admin-music-file" />
        <input className={`${field} min-w-40 flex-1`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (from file name if empty)" />
        <input className={`${field} w-36`} value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Artist" />
        <select className={field} value={mood} onChange={(e) => setMood(e.target.value as MusicMood)} aria-label="Mood">
          {MUSIC_MOODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input className={`${field} w-16`} value={bpm} onChange={(e) => setBpm(e.target.value.replace(/\D/g, "").slice(0, 3))} placeholder="BPM" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${field} min-w-60 flex-1`} value={license} onChange={(e) => setLicense(e.target.value)} placeholder="Licence (who owns it, how Replay may use it)" aria-label="Licence" />
        <button type="button" disabled={!file || busy || !license.trim()} onClick={() => void submit()}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40" data-testid="admin-music-upload">
          {busy ? "Uploading…" : "Upload"}
        </button>
      </div>
      <p className="text-[11px] text-zinc-500">MP3, M4A, AAC or WAV, up to 20 MB and 10 minutes. It is converted to AAC and measured (length, loudness, waveform).</p>
      {note ? <p className="text-xs text-emerald-400">{note}</p> : null}
      {error ? <p className="text-xs text-red-400" role="alert">{error}</p> : null}
    </div>
  );
}
