import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { mmss } from "@/lib/game-claim/model";
import { ovPos, type Ctx } from "@/lib/game-claim/claim";
import { speedsOf, trackOfYou, type TrackPoint } from "@/lib/game-claim/stats";
import { ballAt, loadBall, type Play, type PlayPass } from "@/lib/game-claim/play";
import { chunkAt, G2L } from "@/lib/game-claim/model";
import type { GameStrings } from "@/i18n/game-strings";
import { Btn, Row, Section } from "./bits";

/**
 * "Your highlights": a clip that follows you, with your speed ticking live,
 * cut and rendered in the browser from the recording itself. The prototype's
 * reel, ported: runs (fast stretches), on the ball (your touches), passes
 * (the frame drifts from you to whoever the ball reaches, and the minimap
 * draws the pass) or both. Nothing is uploaded; MediaRecorder writes the file.
 */

type Seg = TrackPoint[];
type Clip = {
  seg: Seg;
  v: Array<number | null>;
  kind: "run" | "touch" | "pass";
  a: number;
  b: number;
  n: number;
  peak: number;
  bang: number;
  ts: number[];
  ps: Array<PlayPass & { ok: boolean }>;
};
export type ReelMode = "touches" | "runs" | "passes" | "dribbles" | "both";

const RUN_MS = 4.0; // 14.4 km/h, the same threshold the runs stat uses
const vCache = new WeakMap<Seg, Array<number | null>>();
const vOf = (s: Seg) => {
  let v = vCache.get(s);
  if (!v) { v = speedsOf(s); vCache.set(s, v); }
  return v;
};

function boxAt(seg: Seg, t: number): [number, number, number, number] {
  if (t <= seg[0].t) return seg[0].b;
  const last = seg[seg.length - 1];
  if (t >= last.t) return last.b;
  let lo = 0, hi = seg.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (seg[m].t <= t) lo = m; else hi = m; }
  const a = seg[lo], c = seg[hi], f = (t - a.t) / Math.max(1e-6, c.t - a.t);
  return a.b.map((v, i) => v + (c.b[i] - v) * f) as [number, number, number, number];
}

function meAt(seg: Seg, t: number): { X: number; Y: number } {
  if (t <= seg[0].t) return seg[0];
  const L = seg[seg.length - 1];
  if (t >= L.t) return L;
  let lo = 0, hi = seg.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (seg[m].t <= t) lo = m; else hi = m; }
  const a = seg[lo], b = seg[hi], f = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return { X: a.X + (b.X - a.X) * f, Y: a.Y + (b.Y - a.Y) * f };
}

function speedAt(c: Clip, t: number): number {
  const s = c.seg, v = c.v;
  let lo = -1, hi = -1;
  for (let i = 0; i < s.length; i++) { if (v[i] == null) continue; if (s[i].t <= t) lo = i; else { hi = i; break; } }
  if (lo < 0 && hi < 0) return 0;
  if (lo < 0) return v[hi]!;
  if (hi < 0) return v[lo]!;
  const f = (t - s[lo].t) / Math.max(1e-6, s[hi].t - s[lo].t);
  return v[lo]! + (v[hi]! - v[lo]!) * f;
}

const segAt = (segs: Seg[], trackId: string, t: number) =>
  segs.find((r) => String(r[0].pid) === trackId && t >= r[0].t - 0.4 && t <= r[r.length - 1].t + 0.4)
  ?? segs.find((r) => t >= r[0].t - 0.4 && t <= r[r.length - 1].t + 0.4);

function touchClips(segs: Seg[], play: Play | null): Clip[] {
  const out: Clip[] = [];
  for (const T of play?.mine.touches ?? []) {
    const seg = segs.find((r) => String(r[0].pid) === T.trackId && T.t >= r[0].t - 0.35 && T.t <= r[r.length - 1].t + 0.35);
    if (!seg) continue;
    const L = out[out.length - 1];
    if (L && L.seg === seg && T.t - L.ts[L.ts.length - 1] <= 3.5) {
      L.ts.push(T.t); L.n++; L.b = Math.min(seg[seg.length - 1].t, T.t + 2.5);
    } else {
      out.push({ seg, v: vOf(seg), kind: "touch", n: 1, ts: [T.t], ps: [], peak: 0, bang: 0,
        a: Math.max(seg[0].t, T.t - 2.0), b: Math.min(seg[seg.length - 1].t, T.t + 2.5) });
    }
  }
  return out.filter((c) => c.b - c.a >= 1.2);
}

/** Take-ons: every spell on the ball where an opponent closed you down, the ones you won first. */
function dribbleClips(segs: Seg[], play: Play | null): Clip[] {
  const out: Clip[] = [];
  const list = [...(play?.mine.dribbles ?? [])].sort((p, q) => Number(q.outcome === "won") - Number(p.outcome === "won"));
  for (const d of list) {
    const seg = segAt(segs, d.trackId, d.t0);
    if (!seg) continue;
    const a = Math.max(seg[0].t, d.t0 - 1.8), b = Math.min(seg[seg.length - 1].t, d.t1 + 2.2);
    if (b - a < 1.2) continue;
    out.push({ seg, v: vOf(seg), kind: "touch", a, b, n: d.touches, ps: [], ts: [d.t0, d.t1], peak: 0, bang: d.metres ?? 0 });
  }
  return out;
}

function passClips(segs: Seg[], play: Play | null): Clip[] {
  const out: Clip[] = [];
  for (const p of play?.mine.passes ?? []) {
    const seg = segAt(segs, p.trackId, p.give ? p.t0 : p.t1);
    if (!seg) continue;
    const a = Math.max(seg[0].t, p.t0 - 2.0), b = Math.min(seg[seg.length - 1].t, p.t1 + 1.8);
    if (b - a < 1.0) continue;
    const pp = { ...p, ok: p.completed };
    const L = out[out.length - 1];
    if (L && L.seg === seg && a - L.b < 1.2) { L.b = Math.max(L.b, b); L.ps.push(pp); L.ts.push(p.t0); L.n++; L.bang = Math.max(L.bang, p.metres); }
    else out.push({ seg, v: vOf(seg), kind: "pass", a, b, n: 1, ps: [pp], ts: [p.t0], peak: 0, bang: p.metres });
  }
  return out;
}

function runClips(segs: Seg[], TH: number, CAP: number): Clip[] {
  const raw: Clip[] = [];
  for (const r of segs) {
    if (r.length < 5) continue;
    const v = vOf(r);
    let i = 0;
    while (i < v.length) {
      if (v[i] == null || v[i]! < TH) { i++; continue; }
      let j = i;
      while (j + 1 < v.length && v[j + 1] != null && v[j + 1]! >= TH) j++;
      if (r[j].t - r[i].t >= 1.0) {
        let peak = 0;
        for (let q = i; q <= j; q++) peak = Math.max(peak, v[q]!);
        raw.push({ seg: r, v, kind: "run", peak, a: Math.max(r[0].t, r[i].t - 1.6), b: Math.min(r[r.length - 1].t, r[j].t + 1.4), n: 0, bang: 0, ts: [], ps: [] });
      }
      i = j + 1;
    }
  }
  raw.sort((p, q) => p.a - q.a);
  const merged: Clip[] = [];
  for (const c of raw) {
    const L = merged[merged.length - 1];
    if (L && L.seg === c.seg && c.a - L.b < 1.2) { L.b = Math.max(L.b, c.b); L.peak = Math.max(L.peak, c.peak); } else merged.push({ ...c });
  }
  return budget(merged, CAP, (p, q) => q.peak - p.peak);
}

function budget(list: Clip[], cap: number, score: (p: Clip, q: Clip) => number): Clip[] {
  const keep: Clip[] = [];
  let tot = 0;
  for (const c of list.slice().sort(score)) {
    const d = c.b - c.a;
    if (tot + d > cap && keep.length >= 3) continue;
    keep.push(c); tot += d;
    if (tot >= cap) break;
  }
  return keep.sort((p, q) => p.a - q.a);
}
const byTouch = (p: Clip, q: Clip) => (q.n - p.n) || (q.bang - p.bang);

export function reelFor(mode: ReelMode, segs: Seg[], play: Play | null): Clip[] {
  const CAP = { runs: 80, touches: 130, both: 150, passes: 140, dribbles: 120 }[mode];
  const runs = (cap: number) => {
    const c = runClips(segs, RUN_MS, cap);
    if (c.reduce((s, x) => s + (x.b - x.a), 0) < 20) { const c2 = runClips(segs, 3.3, cap); if (c2.length > c.length) return c2; }
    return c;
  };
  let cl: Clip[];
  if (mode === "passes") cl = passClips(segs, play);
  else if (mode === "dribbles") cl = dribbleClips(segs, play);
  else if (mode === "touches") cl = touchClips(segs, play);
  else if (mode === "both") cl = budget(touchClips(segs, play), 90, byTouch).concat(runs(60));
  else cl = runs(80);
  cl = cl.slice().sort((p, q) => p.a - q.a);
  const merged: Clip[] = []; // a run through a touch is one clip, not two
  for (const c of cl) {
    const L = merged[merged.length - 1];
    if (L && L.seg === c.seg && c.a - L.b < 0.8) {
      L.b = Math.max(L.b, c.b); L.peak = Math.max(L.peak, c.peak); L.n += c.n; L.bang = Math.max(L.bang, c.bang);
      L.ps = L.ps.concat(c.ps); L.ts = L.ts.concat(c.ts);
      if (c.kind === "touch") L.kind = "touch";
      if (c.kind === "pass") L.kind = "pass";
    } else merged.push({ ...c, ts: [...c.ts], ps: [...c.ps] });
  }
  const tot = merged.reduce((s, c) => s + (c.b - c.a), 0);
  return tot > CAP ? budget(merged, CAP, mode === "runs" ? (p, q) => q.peak - p.peak : byTouch) : merged;
}

const passAt = (c: Clip, t: number) => c.ps.find((q) => t >= q.t0 - 0.5 && t <= q.t1 + 1.4) ?? null;

function pickMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of ["video/mp4;codecs=avc1.4d002a", "video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

function browserSafeVideoUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("/api/hls-proxy/")) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith(".b-cdn.net") && parsed.pathname.endsWith(".m3u8")) return `/api/hls-proxy/manifest?url=${encodeURIComponent(url)}`;
  } catch { /* relative */ }
  return url;
}

export function ReelSection({ ctx, copy, play, videoUrl, recordingId }: {
  ctx: Ctx;
  copy: GameStrings;
  play: Play | null;
  videoUrl: string | null;
  recordingId: number;
}) {
  const c = copy.reel;
  const game = ctx.game;
  const [mode, setMode] = useState<ReelMode>("touches");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<{ href: string; ext: string } | null>(null);
  const loaded = Object.keys(ctx.CH).length;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const segs = useMemo(() => trackOfYou(ctx), [ctx, loaded]);
  const clips = useMemo(() => reelFor(mode, segs, play), [mode, segs, play]);
  const secs = clips.reduce((s, x) => s + (x.b - x.a), 0);
  const mime = typeof window !== "undefined" ? pickMime() : null;
  const cancel = useRef(false);
  useEffect(() => () => { cancel.current = true; }, []);

  const nTouch = play?.mine.touches.length ?? 0;
  const nPass = clips.reduce((s, x) => s + x.ps.length, 0);
  const nPassOk = clips.reduce((s, x) => s + x.ps.filter((p) => p.ok).length, 0);
  const summary = !game.pitch ? c.noPitch
    : mode === "passes" && !play?.teams ? c.pickTeams
      : !clips.length ? (mode === "runs" ? c.noRuns : mode === "passes" ? c.noPasses : mode === "dribbles" ? c.noDribbles : c.noTouches)
        : `${mode === "passes" ? c.passes(nPass, nPassOk) : mode === "touches" ? c.touches(nTouch) : mode === "runs" ? c.runs(clips.length) : mode === "dribbles" ? c.dribbles(play?.mine.dribbles?.length ?? 0, play?.mine.dribblesWon ?? 0) : c.both(nTouch)} · ${c.clips(clips.length, mmss(secs))}`;

  const make = async () => {
    if (busy || !clips.length || !mime) return;
    if (document.hidden) { setStatus(c.front); return; }
    const vurl = browserSafeVideoUrl(videoUrl);
    if (!vurl) return;
    setBusy(true);
    cancel.current = false;
    const vs = game.videoStartSeconds || 0;
    const OW = 1280, OH = 720;
    const cv = document.createElement("canvas"); cv.width = OW; cv.height = OH;
    const c2 = cv.getContext("2d")!;
    c2.fillStyle = "#000"; c2.fillRect(0, 0, OW, OH);
    const vid = document.createElement("video");
    vid.muted = true; vid.playsInline = true; vid.preload = "auto";
    vid.style.cssText = "position:fixed;left:-9999px;width:320px";
    document.body.appendChild(vid);
    let hls: Hls | null = null;
    // the minimap's ball, one segment at a time
    const balls = new Map<number, Awaited<ReturnType<typeof loadBall>>>();
    for (const k of new Set(clips.map((x) => x.seg[0].k))) balls.set(k, await loadBall(recordingId, game, k));
    try {
      if (Hls.isSupported()) {
        hls = new Hls({ maxBufferLength: 30 });
        hls.loadSource(vurl); hls.attachMedia(vid);
        await new Promise<void>((r) => hls!.on(Hls.Events.MANIFEST_PARSED, () => r()));
        hls.currentLevel = hls.levels.length - 1;
      } else {
        vid.src = vurl;
        await new Promise<void>((r, x) => { vid.addEventListener("loadedmetadata", () => r(), { once: true }); setTimeout(x, 15000); });
      }
      const ready = () => new Promise<void>((r) => { if (vid.readyState >= 3) return r(); const f = () => { vid.removeEventListener("canplay", f); r(); }; vid.addEventListener("canplay", f); setTimeout(f, 6000); });
      const seek = (t: number) => new Promise<void>((r) => { let done = false; const f = () => { if (done) return; done = true; vid.removeEventListener("seeked", f); r(); }; vid.addEventListener("seeked", f); vid.currentTime = t + vs; setTimeout(f, 6000); });
      const stream = cv.captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data?.size) parts.push(e.data); };
      const done = new Promise((r) => { rec.onstop = r; });
      let panX: number | null = null;
      const frame = (clip: Clip, t: number) => {
        const PW = vid.videoWidth || game.srcW, PH = vid.videoHeight || game.srcH;
        const SC = PW / game.srcW;
        const CW = Math.min(PW, Math.round((PH * 16) / 9)), CH = Math.min(PH, Math.round((CW * 9) / 16));
        const b = boxAt(clip.seg, t), fx = (b[0] + b[2] / 2) * SC, fy = (b[1] + b[3]) * SC;
        let tgt = fx;
        const p = clip.kind === "pass" ? passAt(clip, t) : null;
        if (p) { // drift the frame from you to whoever the ball reaches
          const other = p.give ? p.otherTrackId : p.trackId;
          const k = chunkAt(game, Math.min(t, p.t1));
          const a = ovPos(ctx, k, other, G2L(game, k, Math.min(t, p.t1)));
          if (a) { const f = Math.max(0, Math.min(1, (t - p.t0) / Math.max(0.35, p.t1 - p.t0))); tgt = fx + (a.foot[0] * SC - fx) * f; }
        }
        panX = panX == null ? tgt : panX + (tgt - panX) * 0.12;
        const sx = Math.max(0, Math.min(PW - CW, Math.round(panX - CW / 2)));
        const sy = Math.max(0, Math.min(PH - CH, Math.round(fy - CH * 0.55)));
        c2.drawImage(vid, sx, sy, CW, CH, 0, 0, OW, OH);
        const mx = (fx - sx) * (OW / CW), my = (fy - sy) * (OH / CH);
        c2.strokeStyle = "#2FD8C4"; c2.lineWidth = 3.5; c2.beginPath(); c2.ellipse(mx, my, 30, 11, 0, 0, 7); c2.stroke();
        for (const tt of clip.ts) { // the instant the ball tracker says you touched it
          const age = t - tt;
          if (age < 0 || age > 0.55) continue;
          c2.strokeStyle = `rgba(255,196,60,${(1 - age / 0.55).toFixed(2)})`; c2.lineWidth = 4;
          c2.beginPath(); c2.ellipse(mx, my, 34 + age * 150, 13 + age * 56, 0, 0, 7); c2.stroke();
        }
        drawMini(c2, OW, clip, t, ballAt(balls.get(clip.seg[0].k), t), copy, game.pitch!);
        const sp = speedAt(clip, t) * 3.6, col = sp < 7.2 ? "#8fa0b5" : sp < 14.4 ? "#2FD8C4" : sp < 19.8 ? "#D4FF4F" : "#FF5A3C";
        c2.fillStyle = "rgba(0,0,0,.58)"; c2.fillRect(0, OH - 104, 372, 104);
        c2.textBaseline = "middle"; c2.fillStyle = "#9fb0c2"; c2.font = "500 20px system-ui,sans-serif";
        c2.fillText(mmss(t + game.matchOffset), 22, OH - 80);
        let lab: string, labCol = "#9fb0c2";
        if (clip.kind === "pass") { const q = p ?? clip.ps[0]; lab = `${q.give ? c.passLabel : c.receivedLabel} ${q.metres.toFixed(0)} m ${q.ok ? "✓" : "✗"}`; labCol = q.ok ? "#2FD8C4" : "#FF5A3C"; }
        else if (clip.kind === "touch") { lab = c.touchLabel(clip.n); labCol = "#FFC43C"; }
        else lab = c.peakLabel((clip.peak * 3.6).toFixed(1));
        c2.fillStyle = labCol; c2.fillText(lab, 215, OH - 80);
        c2.fillStyle = col; c2.font = "700 48px system-ui,sans-serif";
        const num = sp.toFixed(1); c2.fillText(num, 22, OH - 44);
        const w = c2.measureText(num).width;
        c2.fillStyle = "#cfd8e3"; c2.font = "500 22px system-ui,sans-serif"; c2.fillText("km/h", 30 + w, OH - 36);
        c2.fillStyle = "rgba(255,255,255,.18)"; c2.fillRect(22, OH - 16, 328, 6);
        c2.fillStyle = col; c2.fillRect(22, OH - 16, 328 * Math.min(1, sp / 25), 6);
      };
      const visible = () => (document.hidden ? new Promise<void>((r) => { const f = () => { if (!document.hidden) { document.removeEventListener("visibilitychange", f); r(); } }; document.addEventListener("visibilitychange", f); }) : Promise.resolve());
      let label = "";
      const playClip = (clip: Clip) => new Promise<void>((res) => {
        let end = false, last = -1, still = 0, timer: number | undefined;
        const stop = () => { if (end) return; end = true; window.clearTimeout(timer); vid.pause(); res(); };
        const step = async () => {
          if (end) return;
          if (cancel.current) { stop(); return; }
          if (document.hidden) {
            vid.pause(); try { rec.pause(); } catch { /* */ }
            setStatus(c.paused);
            await visible(); if (end) return;
            try { rec.resume(); } catch { /* */ }
            try { await vid.play(); } catch { /* */ }
            setStatus(label);
          }
          const t = vid.currentTime - vs;
          frame(clip, t);
          if (t >= clip.b - 0.02 || vid.ended) { stop(); return; }
          if (Math.abs(t - last) < 1e-3) { if (++still > 300) { stop(); return; } } else { still = 0; last = t; }
          timer = window.setTimeout(step, 33);
        };
        vid.play().then(() => { timer = window.setTimeout(step, 0); }).catch(() => stop());
      });
      rec.start(1000);
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        label = c.rendering(i + 1, clips.length, mmss(clips.slice(i).reduce((s, x) => s + (x.b - x.a), 0)));
        setStatus(label);
        try { rec.pause(); } catch { /* */ }
        await seek(clip.a); await ready(); panX = null;
        try { rec.resume(); } catch { /* */ }
        await playClip(clip);
        if (cancel.current) break;
      }
      rec.stop(); await done;
      if (url) URL.revokeObjectURL(url.href);
      setUrl({ href: URL.createObjectURL(new Blob(parts, { type: mime })), ext: mime.includes("mp4") ? "mp4" : "webm" });
      setStatus(c.clips(clips.length, mmss(secs)));
    } catch (e) {
      setStatus(c.failed(e instanceof Error ? e.message : String(e)));
    } finally {
      try { hls?.destroy(); } catch { /* */ }
      vid.remove();
      setBusy(false);
    }
  };

  return (
    <Section title={c.title}>
      <p className="max-w-[62ch] text-sm leading-6 text-muted-text">{c.lead}</p>
      <Row>
        {(["touches", "runs", "passes", "dribbles", "both"] as ReelMode[]).filter((m) => m !== "dribbles" || (play?.mine.dribbles?.length ?? 0) > 0).map((m) => (
          <Btn key={m} size="sm" kind={mode === m ? "primary" : "ghost"} onClick={() => setMode(m)}>{c.modes[m]}</Btn>
        ))}
      </Row>
      <Row>
        <Btn kind="violet" onClick={() => void make()} disabled={busy || !clips.length || !mime || !game.pitch}>{c.make}</Btn>
        <span className="text-xs text-muted-text">{busy ? status : !mime ? c.cantRecord : status || summary}</span>
      </Row>
      {url && (
        <div className="flex flex-col gap-2">
          <video src={url.href} controls playsInline className="w-full max-w-[800px] rounded-xl bg-black" />
          <Row><a className="text-sm font-semibold text-floodlight underline" href={url.href} download={`my-${mode}-reel.${url.ext}`}>{c.download}</a></Row>
        </div>
      )}
    </Section>
  );
}

function drawMini(c2: CanvasRenderingContext2D, OW: number, clip: Clip, t: number, ball: ReturnType<typeof ballAt>, copy: GameStrings, pitch: { w: number; h: number }) {
  const L = pitch.w, pitchH = pitch.h;
  const MW = 300, MH = Math.round((MW * pitchH) / L), X0 = OW - MW - 18, Y0 = 18;
  const px = (v: number) => X0 + (v / L) * MW, py = (v: number) => Y0 + (v / pitchH) * MH;
  c2.save();
  c2.fillStyle = "rgba(8,14,10,.68)"; c2.fillRect(X0 - 8, Y0 - 8, MW + 16, MH + 42);
  c2.strokeStyle = "rgba(255,255,255,.55)"; c2.lineWidth = 1.5; c2.strokeRect(X0, Y0, MW, MH);
  c2.beginPath(); c2.moveTo(px(L / 2), Y0); c2.lineTo(px(L / 2), Y0 + MH); c2.stroke();
  c2.beginPath(); c2.arc(px(L / 2), py(pitchH / 2), (3 / L) * MW, 0, 7); c2.stroke();
  const me = meAt(clip.seg, t);
  if (clip.kind === "pass") { // the pass on the pitch: where it went, and whether it got there
    const p = passAt(clip, t);
    if (p?.from && p.to) {
      const f = Math.max(0, Math.min(1, (t - p.t0) / Math.max(0.3, p.t1 - p.t0)));
      const x0 = px(p.from[0]), y0 = py(p.from[1]), x1 = px(p.to[0]), y1 = py(p.to[1]);
      const col = p.ok ? "#2FD8C4" : "#FF5A3C";
      c2.setLineDash([5, 4]); c2.strokeStyle = col + "aa"; c2.lineWidth = 2;
      c2.beginPath(); c2.moveTo(x0, y0); c2.lineTo(x1, y1); c2.stroke(); c2.setLineDash([]);
      c2.strokeStyle = col; c2.lineWidth = 3;
      c2.beginPath(); c2.moveTo(x0, y0); c2.lineTo(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f); c2.stroke();
      c2.beginPath(); c2.arc(x1, y1, 5, 0, 7);
      if (p.ok) { c2.fillStyle = col; c2.fill(); } else { c2.strokeStyle = col; c2.lineWidth = 2; c2.stroke(); }
    }
  }
  if (ball) {
    if (ball.ok) { c2.beginPath(); c2.moveTo(px(me.X), py(me.Y)); c2.lineTo(px(ball.X), py(ball.Y)); c2.strokeStyle = "rgba(255,255,255,.35)"; c2.lineWidth = 1.5; c2.stroke(); }
    c2.beginPath(); c2.arc(px(ball.X), py(ball.Y), 6, 0, 7);
    if (ball.ok) { c2.fillStyle = "#fff"; c2.fill(); } else { c2.strokeStyle = "rgba(255,255,255,.5)"; c2.lineWidth = 2; c2.stroke(); }
  }
  c2.beginPath(); c2.arc(px(me.X), py(me.Y), 7, 0, 7); c2.fillStyle = "#2FD8C4"; c2.fill();
  c2.strokeStyle = "#04231f"; c2.lineWidth = 2; c2.stroke();
  c2.font = "500 17px system-ui,sans-serif"; c2.textBaseline = "top";
  if (ball?.ok) {
    const d = Math.hypot(ball.X - me.X, ball.Y - me.Y);
    c2.fillStyle = d < 2 ? "#FFC43C" : "#8fa0b5";
    c2.fillText(copy.reel.ballAway(d.toFixed(1)), X0, Y0 + MH + 10);
  } else {
    c2.fillStyle = "#6b7787";
    c2.fillText(ball ? copy.reel.ballUncertain : copy.reel.ballNotTracked, X0, Y0 + MH + 10);
  }
  c2.restore();
  c2.textBaseline = "middle";
}
