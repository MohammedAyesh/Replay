import { useEffect, useRef } from "react";
import type { SceneMusic } from "@workspace/api-zod";
import { musicSyncAction, previewVolume } from "@/lib/creative-music";

export type MusicPreviewSource = { url: string; trackMs: number; loudnessLufs: number | null };

/**
 * Plays the scene's soundtrack in step with the editor's clock: an <audio>
 * that follows timeMs (start point, looping) and playing, at the export's
 * volume and fades. Re-seeks only when it drifts or the playhead jumps, so
 * playback stays smooth. Ducking is the export's job; the preview doesn't
 * duck. Nothing plays without a source or music.
 */
export function useMusicPreview(source: MusicPreviewSource | null, music: SceneMusic | undefined, sceneMs: number | undefined, timeMs: number, playing: boolean) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = source?.url ?? null;

  useEffect(() => {
    if (!url || typeof Audio === "undefined") return;
    const a = new Audio();
    a.preload = "auto";
    a.loop = true;
    a.src = url;
    audio.current = a;
    return () => {
      a.pause();
      a.removeAttribute("src");
      a.load();
      if (audio.current === a) audio.current = null;
    };
  }, [url]);

  useEffect(() => {
    const a = audio.current;
    if (!a || !source || !music || !sceneMs) {
      if (a && !a.paused) a.pause();
      return;
    }
    const act = musicSyncAction({
      playing, sceneMs, t: timeMs, trackMs: source.trackMs, startMs: music.startMs ?? 0,
      audioSec: a.currentTime, audioPaused: a.paused,
    });
    if (act.seekSec !== null && a.readyState >= 1) {
      try { a.currentTime = act.seekSec; } catch { /* not seekable yet */ }
    } else if (act.seekSec !== null) {
      const at = act.seekSec;
      a.addEventListener("loadedmetadata", () => { try { a.currentTime = at; } catch { /* ignore */ } }, { once: true });
    }
    a.volume = previewVolume(music, sceneMs, timeMs, source.loudnessLufs);
    if (act.play) void a.play().catch(() => {});
    if (act.pause) a.pause();
  }, [source, music, sceneMs, timeMs, playing]);
}
