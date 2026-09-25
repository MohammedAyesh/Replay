import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { chunkAt, G2L, mmss } from "@/lib/game-claim/model";
import { youIds, type Ctx } from "@/lib/game-claim/claim";
import { computeStats, peopleAt, type ZoneKey } from "@/lib/game-claim/stats";
import type { GameStrings } from "@/i18n/game-strings";
import { Btn, Eyebrow, Lede, Row, Section, Stat, Title } from "./bits";
import { ballAt, fetchPlay, loadBall, type Lab, type Play } from "@/lib/game-claim/play";
import { ReelSection } from "./Reel";
import { TeamsSection } from "./TeamsSection";

/**
 * The prototype's stats screen on the bundle: six numbers, the match from
 * above following the video, the heat map, speed zones and distance per ten
 * minutes, your highlights reel, and teams / passes / possession. Touches and
 * passes come from the server (one definition of a pass for this page and the
 * match page); the ball on the map comes from the bundle's ball data.
 */

const ZONE_COLOUR: Record<ZoneKey, string> = { walk: "#3a4f6b", jog: "#2FD8C4", run: "#D4FF4F", sprint: "#FF5A3C" };
const kmh = (v: number) => (v * 3.6).toFixed(1);

export function StatsScreen({
  ctx,
  copy,
  mediaSlot,
  now,
  eyebrow,
  onBack,
  onExport,
  ensure,
  recordingId,
  videoUrl,
  onTeams,
}: {
  recordingId: number;
  videoUrl: string | null;
  /** save the picked team colours with the claim */
  onTeams: (pick: { a: Lab; b: Lab }) => void;
  ctx: Ctx;
  copy: GameStrings;
  mediaSlot: React.ReactNode;
  /** tracking seconds at the video's playhead */
  now: () => number;
  eyebrow: string;
  onBack: () => void;
  onExport: () => void;
  ensure: (k: number) => Promise<unknown>;
}) {
  const c = copy.stats;
  const game = ctx.game;
  const loaded = Object.keys(ctx.CH).length;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const st = useMemo(() => computeStats(ctx), [ctx, loaded]);
  const heatRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("—");
  const [play, setPlay] = useState<Play | null>(null);
  const [playLoading, setPlayLoading] = useState(true);

  // Touches and passes, with the saved team colours (the server falls back to
  // the saved ones itself, and seeds yours against the most contrasting kit).
  useEffect(() => {
    let live = true;
    setPlayLoading(true);
    void fetchPlay(recordingId, ctx.S.teams ?? null).then((p) => { if (live) { setPlay(p); setPlayLoading(false); } });
    return () => { live = false; };
  }, [recordingId, ctx.S.teams]);
  // Saving the pick re-renders with ctx.S.teams changed, which refetches above.
  const pickTeams = (pick: { a: Lab; b: Lab }) => onTeams(pick);
  const balls = useRef(new Map<number, Awaited<ReturnType<typeof loadBall>>>());

  useEffect(() => {
    if (game.pitch) drawHeat(heatRef.current, st.heat);
  }, [st, game.pitch]);

  // The map from above follows the video: redraw whenever the playhead moves.
  useEffect(() => {
    const pitch = game.pitch;
    if (!pitch) return;
    let raf = 0;
    let shown = -1;
    let last = -1;
    let step = -1;
    let trail: Array<[number, number]> = [];
    const loading = new Set<number>();
    let lastStatus = "";
    const setSt = (s: string) => { if (s !== lastStatus) { lastStatus = s; setStatus(s); } };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const cv = mapRef.current;
      if (!cv) return;
      const gt = now();
      if (gt === shown) return;
      shown = gt;
      const k = chunkAt(game, gt);
      const lt = G2L(game, k, gt);
      const cx = cv.getContext("2d");
      if (!cx) return;
      const { px, py } = pitchPaint(cx, cv.width, cv.height, pitch.w, pitch.h);
      if (!ctx.CH[k]) {
        if (!loading.has(k)) { loading.add(k); void ensure(k).then(() => { shown = -1; }); }
        setSt(copy.common.loadingChunk);
        return;
      }
      const people = peopleAt(ctx, k, lt);
      if (!balls.current.has(k)) {
        balls.current.set(k, null);
        void loadBall(recordingId, game, k).then((b) => { balls.current.set(k, b); shown = -1; });
      }
      const ball = ballAt(balls.current.get(k), gt);
      const mine = youIds(ctx, k);
      if (Math.abs(gt - last) > 1.2) { trail = []; step = -1; } // a seek breaks the trail
      last = gt;
      let me: [number, number] | null = null;
      for (const [id, x, y] of people) if (mine.has(id)) me = [x, y];
      const i = Math.floor(lt * 2);
      if (me && i !== step) {
        trail.push(me); // one point per half second: 14 = 7 s
        if (trail.length > 14) trail.shift();
      }
      step = i;
      if (trail.length > 1) {
        cx.strokeStyle = "rgba(47,216,196,.45)";
        cx.lineWidth = 3;
        cx.beginPath();
        trail.forEach(([x, y], j) => (j ? cx.lineTo(px(x), py(y)) : cx.moveTo(px(x), py(y))));
        cx.stroke();
      }
      for (const [id, x, y] of people) {
        if (mine.has(id)) continue;
        cx.beginPath();
        cx.arc(px(x), py(y), 7, 0, 7);
        cx.fillStyle = "rgba(226,232,240,.82)";
        cx.fill();
        cx.strokeStyle = "rgba(0,0,0,.45)";
        cx.lineWidth = 1.5;
        cx.stroke();
      }
      if (ball) {
        cx.beginPath();
        cx.arc(px(ball.X), py(ball.Y), 5.5, 0, 7);
        if (ball.ok) { cx.fillStyle = "#fff"; cx.fill(); cx.strokeStyle = "#111"; cx.lineWidth = 2; cx.stroke(); }
        else { cx.strokeStyle = "rgba(255,255,255,.45)"; cx.lineWidth = 2; cx.stroke(); }
      }
      if (me) {
        cx.beginPath();
        cx.arc(px(me[0]), py(me[1]), 10, 0, 7);
        cx.fillStyle = "#2FD8C4";
        cx.fill();
        cx.strokeStyle = "#04231f";
        cx.lineWidth = 3;
        cx.stroke();
        cx.fillStyle = "#eaf7f5";
        cx.font = "700 15px system-ui,sans-serif";
        cx.textAlign = "center";
        cx.fillText(c.you, px(me[0]), py(me[1]) - 17);
        cx.textAlign = "left";
      }
      setSt(c.mapStatus(mmss(gt + game.matchOffset), people.length, !!me));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ctx, game, now, ensure, c, copy.common.loadingChunk, recordingId]);

  const zt = Object.values(st.zones).reduce((s, z) => s + z[0], 0) || 1;
  const maxK = Math.max(1, ...Object.values(st.perK));
  const zones: ZoneKey[] = ["walk", "jog", "run", "sprint"];

  return (
    <div className="flex flex-col gap-4">
      <Eyebrow>{eyebrow} · {c.eyebrow}</Eyebrow>
      <Title>{c.title}</Title>
      {!game.pitch ? (
        <>
          <Lede>{c.noPitch}</Lede>
          <div className="grid grid-cols-3 gap-2">
            <Stat value={mmss(st.found)} label={c.tracked} />
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Stat value={st.km.toFixed(1)} label={c.km} />
            <Stat value={kmh(st.top)} label={c.top} />
            <Stat value={kmh(st.avg)} label={c.avg} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat value={st.runsN} label={c.runs} />
            <Stat value={st.sprintsN} label={c.sprints} />
            <Stat value={mmss(st.time)} label={c.tracked} />
          </div>

          <Section title={c.mapTitle}>
            <Lede>{c.mapLead}</Lede>
            {mediaSlot}
            <canvas
              ref={mapRef}
              width={1000}
              height={Math.round(1000 * (game.pitch.h + 4) / (game.pitch.w + 4))}
              className="w-full rounded-xl bg-[#0d2b1a]"
              aria-label={c.mapTitle}
            />
            <p dir="ltr" className="text-xs text-muted-text">{status}</p>
          </Section>

          <Section title={c.heatTitle}>
            <canvas
              ref={heatRef}
              width={800}
              height={400}
              style={{ aspectRatio: (game.pitch.w / game.pitch.h).toFixed(3) }}
              className="w-full max-w-[800px] rounded-xl bg-[#1d4a2c]"
              aria-label={c.heatTitle}
            />
            <p className="text-xs text-muted-text">{c.heatNote}</p>
          </Section>

          <Section title={c.movedTitle}>
            <div className="flex flex-col gap-2">
              {zones.map((z) => (
                <ZoneRow
                  key={z}
                  label={<>{c.zones[z][0]} <em className="not-italic text-muted-text">{c.zones[z][1]}</em></>}
                  frac={st.zones[z][0] / zt}
                  colour={ZONE_COLOUR[z]}
                  right={`${mmss(st.zones[z][0])} · ${(st.zones[z][1] / 1000).toFixed(2)} km`}
                />
              ))}
            </div>
          </Section>

          <Section title={c.per10Title}>
            <div className="flex flex-col gap-2">
              {game.chunks.filter((ch) => st.perK[ch.k]).map((ch) => (
                <ZoneRow
                  key={ch.k}
                  label={<span dir="ltr">{mmss(ch.start + game.matchOffset)}</span>}
                  frac={st.perK[ch.k] / maxK}
                  colour="#2FD8C4"
                  right={`${(st.perK[ch.k] / 1000).toFixed(2)} km`}
                />
              ))}
            </div>
          </Section>

          <ReelSection ctx={ctx} copy={copy} play={play} videoUrl={videoUrl} recordingId={recordingId} />
          <TeamsSection copy={copy} play={play} loading={playLoading} onPick={pickTeams} />

          <p className="rounded-xl border border-line bg-surface p-3 text-xs leading-5 text-muted-text">
            {c.note(mmss(st.time), (st.dist / 1000).toFixed(2), mmss(st.found), game.pitch.w.toFixed(0), game.pitch.h.toFixed(1), st.dropped)}
          </p>
        </>
      )}
      <Row>
        <Btn onClick={onBack}>{c.backToTimeline}</Btn>
        <Btn onClick={onExport}>{copy.done.download}</Btn>
      </Row>
    </div>
  );
}

function ZoneRow({ label, frac, colour, right }: { label: React.ReactNode; frac: number; colour: string; right: string }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,auto)_1fr_auto] items-center gap-3 text-sm">
      <span className="text-text">{label}</span>
      <div className="h-2.5 overflow-hidden rounded-full bg-raised">
        <i className="block h-full rounded-full" style={{ width: `${(100 * Math.max(0, Math.min(1, frac))).toFixed(1)}%`, background: colour }} />
      </div>
      <span dir="ltr" className="text-xs tabular-nums text-muted-text">{right}</span>
    </div>
  );
}

/** The prototype's pitch drawing: stripes, lines, centre circle, goal mouths and 6 m boxes. */
function pitchPaint(c: CanvasRenderingContext2D, W: number, H: number, L: number, Wd: number) {
  const px = (v: number) => 18 + (v / L) * (W - 36);
  const py = (v: number) => 18 + (v / Wd) * (H - 36);
  c.fillStyle = "#0d2b1a";
  c.fillRect(0, 0, W, H);
  for (let i = 0; i < 8; i++) {
    c.fillStyle = i % 2 ? "#11331f" : "#0f2e1c";
    c.fillRect(px((i * L) / 8), py(0), (W - 36) / 8, py(Wd) - py(0));
  }
  c.strokeStyle = "rgba(255,255,255,.5)";
  c.lineWidth = 2;
  c.strokeRect(px(0), py(0), px(L) - px(0), py(Wd) - py(0));
  c.beginPath(); c.moveTo(px(L / 2), py(0)); c.lineTo(px(L / 2), py(Wd)); c.stroke();
  c.beginPath(); c.arc(px(L / 2), py(Wd / 2), px(3) - px(0), 0, 7); c.stroke();
  c.beginPath(); c.arc(px(L / 2), py(Wd / 2), 3, 0, 7); c.fillStyle = "rgba(255,255,255,.5)"; c.fill();
  for (const [gx, dir] of [[0, 1], [L, -1]] as const) {
    c.strokeStyle = "rgba(255,255,255,.8)";
    c.lineWidth = 4;
    c.beginPath(); c.moveTo(px(gx), py(Wd / 2 - 1.5)); c.lineTo(px(gx), py(Wd / 2 + 1.5)); c.stroke();
    c.strokeStyle = "rgba(255,255,255,.28)";
    c.lineWidth = 2;
    c.strokeRect(px(gx + (dir < 0 ? -6 : 0)), py(Wd / 2 - 5), Math.abs(px(6) - px(0)), py(Wd / 2 + 5) - py(Wd / 2 - 5));
  }
  return { px, py };
}

/** The prototype's heat map: a 40 × 20 grid, blurred, coloured turf → floodlight → red. */
function drawHeat(cv: HTMLCanvasElement | null, heat: Float32Array) {
  if (!cv) return;
  const c = cv.getContext("2d");
  if (!c) return;
  const W = cv.width;
  const H = cv.height;
  const sx = W / 40;
  const sy = H / 20;
  c.fillStyle = "#1d4a2c";
  c.fillRect(0, 0, W, H);
  for (let i = 0; i < 8; i++) { c.fillStyle = i % 2 ? "#1f4f2f" : "#1b4529"; c.fillRect((i * W) / 8, 0, W / 8, H); }
  const k = [0.06, 0.24, 0.4, 0.24, 0.06];
  const B = new Float32Array(800);
  const T = new Float32Array(800);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) {
    let v = 0;
    for (let i = -2; i <= 2; i++) v += heat[y * 40 + Math.min(39, Math.max(0, x + i))] * k[i + 2];
    T[y * 40 + x] = v;
  }
  for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) {
    let v = 0;
    for (let i = -2; i <= 2; i++) v += T[Math.min(19, Math.max(0, y + i)) * 40 + x] * k[i + 2];
    B[y * 40 + x] = v;
  }
  const sorted = [...B].filter((v) => v > 0).sort((p, q) => p - q);
  const top = sorted.length ? sorted[Math.floor(sorted.length * 0.98)] : 1;
  const stops: Array<[number, number[]]> = [[0, [47, 216, 196, 0]], [0.25, [47, 216, 196, 120]], [0.6, [212, 255, 79, 190]], [1, [255, 90, 60, 230]]];
  const col = (f: number) => {
    f = Math.min(1, Math.max(0, f));
    let i = 0;
    while (i < stops.length - 2 && f > stops[i + 1][0]) i++;
    const [a0, c0] = stops[i];
    const [a1, c1] = stops[i + 1];
    const t = (f - a0) / (a1 - a0);
    return c0.map((v, j) => Math.round(v + (c1[j] - v) * t));
  };
  const off = document.createElement("canvas");
  off.width = 40;
  off.height = 20;
  const oc = off.getContext("2d");
  if (!oc) return;
  const im = oc.createImageData(40, 20);
  for (let i = 0; i < 800; i++) im.data.set(col(Math.sqrt(B[i] / (top || 1))), i * 4);
  oc.putImageData(im, 0, 0);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = "high";
  c.drawImage(off, 0, 0, W, H);
  c.strokeStyle = "rgba(255,255,255,.75)";
  c.lineWidth = 2;
  c.strokeRect(1, 1, W - 2, H - 2);
  c.beginPath(); c.moveTo(W / 2, 0); c.lineTo(W / 2, H); c.stroke();
  c.beginPath(); c.arc(W / 2, H / 2, 3 * sx, 0, 7); c.stroke();
  c.beginPath(); c.arc(W / 2, H / 2, 3, 0, 7); c.fillStyle = "#fff"; c.fill();
  for (const side of [0, 1]) {
    const x0 = side ? W : 0;
    const d = side ? -1 : 1;
    c.beginPath(); c.arc(x0, H / 2 - 1.5 * sy, 6 * sx, side ? Math.PI / 2 : -Math.PI / 2, side ? Math.PI : 0); c.stroke();
    c.beginPath(); c.moveTo(x0 + d * 6 * sx, H / 2 - 1.5 * sy); c.lineTo(x0 + d * 6 * sx, H / 2 + 1.5 * sy); c.stroke();
    c.beginPath(); c.arc(x0, H / 2 + 1.5 * sy, 6 * sx, side ? Math.PI : 0, side ? Math.PI * 1.5 : Math.PI / 2); c.stroke();
  }
}
