/**
 * Find yourself in the whole game — the 19 Sep prototype's claim, in Replay.
 *
 * replayjo.b-cdn.net/proto/game is the reference: every screen, button and
 * rule here is that page's, running on this recording's tracking bundle
 * instead of files a separate pipeline wrote for one game. The flow:
 *
 *   intro   whole-game video; check what was play, mark or remove out-of-play
 *   kit     what were you wearing (first ten minutes with play)
 *   gallery which one is you, with ▶ Watch
 *   review  check it's all you: strike pictures, bench, look-alikes
 *   joins   same person? at each handover the tracker was unsure of
 *   gaps    where were you? tap yourself in the video, or say why not
 *   next    is this you? for every following ten minutes, then review again
 *   done    the whole game, found vs on camera, time and taps
 *   stats   distance, speeds, runs, the map from above, heat map, zones
 *
 * The claim saves to the server after every step (the prototype kept it in the
 * browser), and each save also becomes the claimant's identity row, so the
 * rest of Replay sees it.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useParams } from "wouter";
import { getClaimMatchSegment, useGetClaimMatch, getGetClaimMatchQueryKey, type TrackingManifest } from "@workspace/api-client-react";

import { useAuth } from "@/lib/auth";
import { useGameCopy, type GameStrings } from "@/i18n/game-strings";
import { GameMedia, type MediaHandle, type MediaView, type TapHit } from "@/components/game-claim/GameMedia";
import { Btn, ChunkTimeline, Crop, Eyebrow, GameTimeline, Lede, Row, Section, Stat, Title } from "@/components/game-claim/bits";
import { StatsScreen } from "@/components/game-claim/StatsScreen";
import { gameFromManifest, loadChunkData, kitNameKey, type LoadedChunk } from "@/lib/game-claim/load";
import type { Game, Group, OffRange, Point } from "@/lib/game-claim/model";
import { chunkAt, L2G, mmss, spread } from "@/lib/game-claim/model";
import {
  addTap, afterChunk, benchInHole, benchSpans, candidates, chunkMeta, chunkPercent, inPlaySec, isSure, kept, mine,
  newState, nextHole, ovPos, pick, questions, rankNext, startClaim, timeline, totals, twins, weakColour, Y, youIds,
  hkey, type ClaimState, type Ctx, type Hole, type Step,
} from "@/lib/game-claim/claim";
import { benchSpansOut, chainParts } from "@/lib/game-claim/parts";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

type ServerGame = {
  state: (ClaimState & { saved?: number }) | null;
  bundleFingerprint: string;
  inPlaySpans: Array<[number, number]>;
};

export default function ClaimGamePage() {
  const params = useParams<{ id?: string }>();
  const [, setLocation] = useLocation();
  const { user, isLoading: authLoading, isGuest } = useAuth();
  const copy = useGameCopy();
  const recordingId = Number(params.id);
  const enabled = Number.isInteger(recordingId) && recordingId > 0 && Boolean(user) && !isGuest;
  const claimQuery = useGetClaimMatch(recordingId, { query: { enabled, queryKey: getGetClaimMatchQueryKey(recordingId) } });
  const manifest = claimQuery.data?.manifest;
  const recording = claimQuery.data?.recording ?? null;

  const [server, setServer] = useState<ServerGame | null>(null);
  const [serverError, setServerError] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch(`${basePath}/api/recordings/${recordingId}/claim-match/game`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: ServerGame) => { if (!cancelled) setServer(j); })
      .catch(() => { if (!cancelled) setServerError(true); });
    return () => { cancelled = true; };
  }, [enabled, recordingId]);

  const game: Game | null = useMemo(
    () => (manifest && server ? gameFromManifest(manifest, server.inPlaySpans) : null),
    [manifest, server],
  );

  if (!authLoading && (!user || isGuest)) {
    return (
      <Shell>
        <Title>{copy.common.signedOut}</Title>
        <Lede>{copy.common.signedOutDesc}</Lede>
        <Row><Btn kind="primary" onClick={() => setLocation("/sign-in")}>{copy.common.signIn}</Btn></Row>
      </Shell>
    );
  }
  if (claimQuery.isError || serverError || (manifest && manifest.segments.length === 0)) {
    return (
      <Shell>
        <Title>{copy.common.notReady}</Title>
        <Lede>{copy.common.notReadyDesc}</Lede>
        <Row><Btn onClick={() => setLocation(recording?.fieldId ? `/fields/${recording.fieldId}` : "/fields")}>{copy.common.back}</Btn></Row>
      </Shell>
    );
  }
  if (!game || !manifest || !server) {
    return <Shell><p className="py-10 text-center text-sm text-muted-text">{copy.common.loading}</p></Shell>;
  }
  return (
    <GameClaim
      key={server.bundleFingerprint}
      game={game}
      manifest={manifest}
      recordingId={recordingId}
      videoUrl={recording?.videoUrl ?? null}
      eyebrow={recording ? `${recording.date ?? ""} · ${recording.court ?? ""}`.replace(/^ · | · $/g, "") : ""}
      saved={server.state}
      fingerprint={server.bundleFingerprint}
      copy={copy}
    />
  );
}

function Shell({ children, meter }: { children: React.ReactNode; meter?: React.ReactNode }) {
  return (
    <div className="min-h-full bg-void px-4 pb-12">
      <div className="mx-auto max-w-[760px]">
        <div className="sticky top-0 z-10 mb-5 flex items-center gap-3 border-b border-line bg-void/95 py-3 backdrop-blur">
          <div className="font-display text-xl font-bold tracking-wide text-text">RE<b className="text-floodlight">PLAY</b></div>
          <div className="ms-auto">{meter}</div>
        </div>
        <div className="flex flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}

type Props = {
  game: Game;
  manifest: TrackingManifest;
  recordingId: number;
  videoUrl: string | null;
  eyebrow: string;
  saved: (ClaimState & { saved?: number }) | null;
  fingerprint: string;
  copy: ReturnType<typeof useGameCopy>;
};

export function GameClaim({ game, manifest, recordingId, videoUrl, eyebrow, saved, fingerprint, copy }: Props) {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [ver, setVer] = useState(0);
  const chunks = useRef<Record<number, LoadedChunk>>({});
  const [chunkVer, setChunkVer] = useState(0);
  const loading = useRef<Record<number, Promise<LoadedChunk>>>({});
  const ctxRef = useRef<Ctx>({ game, CH: chunks.current, S: newState(game) });
  const ctx = ctxRef.current;
  const S = ctx.S;
  const [savedClaim, setSavedClaim] = useState(saved);
  const [markA, setMarkA] = useState<number | null>(null);
  const [introT, setIntroT] = useState<number | null>(null);
  const [pickSet, setPickSet] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState(false);
  const t0 = useRef<number | null>(null);
  const [now, setNow] = useState(Date.now());

  /* ------------------------------------------------------------ chunks */

  const loadChunk = useCallback((k: number): Promise<LoadedChunk> => {
    if (chunks.current[k]) return Promise.resolve(chunks.current[k]);
    if (!loading.current[k]) {
      loading.current[k] = loadChunkData({
        manifest,
        k,
        fetchSegment: (index) => getClaimMatchSegment(recordingId, index) as never,
        fetchSprites: async (index) => {
          const r = await fetch(`${basePath}/api/recordings/${recordingId}/claim-match/sprites/${index}`, { credentials: "include" });
          return r.ok ? r.json() : {};
        },
        fetchPeople: async (index) => {
          const r = await fetch(`${basePath}/api/recordings/${recordingId}/claim-match/people/${index}`, { credentials: "include" });
          return r.ok ? r.json() : null;
        },
      }).then((c) => {
        chunks.current[k] = c;
        setChunkVer((v) => v + 1);
        return c;
      }).catch((error) => {
        delete loading.current[k];
        throw error;
      });
    }
    return loading.current[k];
  }, [manifest, recordingId]);

  /* -------------------------------------------------------------- saving */

  const saveTimer = useRef<number | null>(null);
  const save = useCallback(() => {
    if (!Object.keys(S.you).length) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      S.elapsed = t0.current ? Date.now() - t0.current : S.elapsed;
      const body = {
        state: { ...S, saved: Date.now() },
        parts: chainParts(ctx),
        bench: benchSpansOut(ctx),
        done: S.step === "done" || S.step === "stats",
        bundleFingerprint: fingerprint,
      };
      try {
        const r = await fetch(`${basePath}/api/recordings/${recordingId}/claim-match/game`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        setSaveError(!r.ok);
      } catch {
        setSaveError(true);
      }
    }, 700);
  }, [S, ctx, fingerprint, recordingId]);

  const tap = () => {
    S.taps++;
    if (!t0.current) t0.current = Date.now() - S.elapsed;
  };
  /** Every action: mutate, re-render, save. */
  const act = (fn: () => void, counts = true) => {
    if (counts) tap();
    fn();
    setVer((v) => v + 1);
    save();
  };
  const go = (step: Step) => {
    S.step = step;
    setVer((v) => v + 1);
    window.scrollTo({ top: 0 });
    save();
  };

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  /* --------------------------------------------------------------- media */

  const media = useRef<MediaHandle>(null);
  const holder = useMemo(() => {
    const el = document.createElement("div");
    return el;
  }, []);
  const mediaSlot = (
    <div
      ref={(el) => {
        if (el && holder.parentElement !== el) el.appendChild(holder);
      }}
    />
  );
  const show = (v: MediaView) => media.current?.show(v);
  const mediaNow = useCallback(() => media.current?.now() ?? 0, []);

  const currentChunk = S.k !== null ? chunks.current[S.k] : undefined;

  // Kits that don't separate leave nothing to choose between: straight to everyone.
  useEffect(() => {
    if (S.step === "kit" && currentChunk && !currentChunk.kits.separated) {
      act(() => { S.team = null; S.step = "gallery"; }, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [S.step, currentChunk]);

  // The screen's picture, set after each action the way the prototype's after() did.
  useEffect(() => {
    const k = S.k;
    const d = k !== null ? chunks.current[k] : undefined;
    const L = (kk: number, t: number) => L2G(game, kk, t);
    switch (S.step) {
      case "intro": {
        const t = introT ?? game.inplay[0]?.[0] ?? 0;
        show({ t, lo: 0, hi: game.total, k: chunkAt(game, t), label: copy.media.wholeGame });
        break;
      }
      case "gallery": {
        if (!d) break;
        const gs = galleryGroups(d, S.team);
        if (gs[0]) previewGroup(d, gs[0]);
        break;
      }
      case "review": {
        if (!d || k === null) break;
        const K = kept(ctx, k);
        const p = K.filter((x) => !x.manual).sort((a, b) => (b.t1 - b.t0) - (a.t1 - a.t0))[0] ?? K[0];
        if (p) {
          const tm = (p.t0 + p.t1) / 2;
          show({ t: L(k, tm), lo: L(k, 0), hi: L(k, chunkMeta(ctx, k).dur), k, hl: youIds(ctx, k), focus: (!p.manual ? ovPos(ctx, k, p.id, tm)?.foot : null) ?? p.a, label: copy.media.you });
        }
        break;
      }
      case "joins": {
        if (!d || k === null) break;
        const qs = questions(ctx, k);
        const j = qs[S.qi];
        if (!j) break;
        const A = d.pieces[j.a];
        const B = d.pieces[j.b];
        show({ t: L(k, A.t1), lo: L(k, Math.max(0, A.t1 - 3)), hi: L(k, B.t0 + 3), k, hl: new Set([j.a, j.b]), focus: A.b, label: copy.media.handover, loop: true });
        break;
      }
      case "gaps": {
        if (!d || k === null) break;
        const h = nextHole(ctx, k);
        if (!h) break;
        const focus: Point | null = h.a ? h.a.b : h.b ? h.b.a : null;
        const tStart = Math.min(h.t1, h.t0 + 0.6);
        show({
          t: L(k, tStart),
          lo: L(k, Math.max(0, h.t0 - 1)),
          hi: L(k, Math.min(chunkMeta(ctx, k).dur, h.t1 + 1)),
          k,
          hl: youIds(ctx, k),
          focus,
          label: copy.media.tapYour,
          loop: true,
          onTap: (hit: TapHit) => {
            if (hit.k !== k) return;
            act(() => addTap(ctx, k, h, hit.lt, hit.box, hit.pt));
          },
        });
        break;
      }
      case "next": {
        if (!d || k === null) break;
        const r = rankNext(ctx, k);
        if (r[0]) previewGroup(d, r[0].g);
        break;
      }
      case "stats": {
        const t = game.inplay[0]?.[0] ?? 0;
        show({ t, lo: 0, hi: game.total, k: chunkAt(game, t), label: copy.media.wholeGame });
        break;
      }
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ver, S.step, chunkVer === 0 ? 0 : S.k !== null && chunks.current[S.k] ? S.k : -1]);

  function previewGroup(d: LoadedChunk, g: Group) {
    const ms = g.members.map((m) => d.pieces[m]).sort((a, b) => (b.t1 - b.t0) - (a.t1 - a.t0));
    const p = ms[0];
    if (!p) return;
    const t = (p.t0 + p.t1) / 2;
    show({
      t: L2G(game, d.k, t),
      lo: L2G(game, d.k, p.t0),
      hi: L2G(game, d.k, p.t1),
      k: d.k,
      hl: new Set(g.members),
      focus: ovPos(ctx, d.k, p.id, t)?.foot ?? null,
      label: copy.media.highlighted,
      loop: true,
    });
    holder.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ------------------------------------------------------- step helpers */

  const ensure = async (k: number) => {
    await loadChunk(k);
    ctx.CH = chunks.current;
  };

  const startNew = async () => {
    if (savedClaim) {
      try {
        await fetch(`${basePath}/api/recordings/${recordingId}/claim-match/game`, { method: "DELETE", credentials: "include" });
      } catch { /* the next save overwrites anyway */ }
      setSavedClaim(null);
    }
    const off = S.off;
    ctxRef.current.S = { ...newState(game), off };
    t0.current = null;
    tap();
    startClaim(ctxRef.current);
    bump();
    await ensure(ctxRef.current.S.k!);
    go("kit");
  };

  const resume = async (j: ClaimState) => {
    ctxRef.current.S = { ...newState(game), ...j };
    const s = ctxRef.current.S;
    t0.current = Date.now() - (s.elapsed || 0);
    await Promise.all(Object.keys(s.you).map((k) => ensure(Number(k))));
    if (s.k !== null) await ensure(s.k);
    const st = s.step === "done" || s.step === "stats" ? s.step : s.step === "intro" ? "review" : s.step;
    go(st);
  };

  const pickGroup = (cid: string) => act(() => { pick(ctx, S.k!, cid); S.step = "review"; });

  const advance = async () => {
    const where = afterChunk(ctx);
    setVer((v) => v + 1);
    save();
    window.scrollTo({ top: 0 });
    if (where === "next" && S.k !== null) {
      await ensure(S.k);
      setVer((v) => v + 1);
    }
  };

  // Gaps screen: when the last hole is answered, move on.
  useEffect(() => {
    if (S.step === "gaps" && S.k !== null && chunks.current[S.k] && !nextHole(ctx, S.k)) void advance();
    if (S.step === "joins" && S.k !== null && chunks.current[S.k] && S.qi >= questions(ctx, S.k).length) go("gaps");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ver, chunkVer]);

  /* ------------------------------------------------------------ keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT") return;
      if (S.step === "joins") {
        if (e.key === "y") answerJoin("yes");
        if (e.key === "n") answerJoin("no");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const answerJoin = (v: "yes" | "no" | "skip") => act(() => {
    const qs = questions(ctx, S.k!);
    const j = qs[S.qi];
    if (!j) return;
    if (v === "no") Y(ctx, S.k!).out.push(j.b);
    else S.qi++;
  });

  /* -------------------------------------------------------------- render */

  const elapsed = t0.current ? ((S.step === "done" || S.step === "stats") && S.elapsed ? S.elapsed : now - t0.current) : S.elapsed;
  const meter = (
    <div dir="ltr" className="flex gap-4 font-display text-base font-semibold tabular-nums text-text">
      <span><small className="me-1 font-sans text-[10px] font-medium uppercase tracking-wider text-muted-text">{copy.common.time}</small>{mmss(elapsed / 1000)}</span>
      <span><small className="me-1 font-sans text-[10px] font-medium uppercase tracking-wider text-muted-text">{copy.common.taps}</small>{S.taps}</span>
    </div>
  );
  const span = (k: number) => {
    const c = chunkMeta(ctx, k);
    return `\u2066${mmss(c.start + game.matchOffset)}–${mmss(c.start + c.dur + game.matchOffset)}\u2069`;
  };
  const disp = (t: number) => mmss(t + game.matchOffset);

  const needsChunk = ["kit", "gallery", "review", "joins", "gaps", "next"].includes(S.step);
  let body: React.ReactNode = null;

  if (needsChunk && (S.k === null || !currentChunk)) {
    if (S.k !== null) void ensure(S.k).then(() => setVer((v) => v + 1));
    body = <p className="py-10 text-center text-sm text-muted-text">{S.step === "next" ? copy.common.loadingChunk : copy.common.loading}</p>;
  } else if (S.step === "intro") {
    body = (
      <IntroScreen
        ctx={ctx} copy={copy} eyebrow={eyebrow} mediaSlot={mediaSlot} markA={markA} saved={savedClaim}
        onMarkA={() => { const t = media.current?.now() ?? 0; setMarkA(t); setIntroT(t); }}
        onMarkB={() => {
          const a = markA;
          const b = media.current?.now() ?? 0;
          if (a !== null && b > a) { S.off.push([a, b, "play"]); S.off.sort((x, y) => x[0] - y[0]); }
          setMarkA(null);
          setIntroT(b);
          setVer((v) => v + 1);
        }}
        onDel={(i) => { S.off.splice(i, 1); setVer((v) => v + 1); }}
        onWatch={(i) => { const r = S.off[i]; setIntroT(r[0]); show({ t: r[0], lo: 0, hi: game.total, k: chunkAt(game, r[0]), label: copy.media.outOfPlay(disp(r[0]), disp(r[1])) }); }}
        onStart={() => void startNew()}
        onResume={() => savedClaim && void resume(savedClaim)}
      />
    );
  } else if (S.step === "kit" && currentChunk) {
    const d = currentChunk;
    body = (
      <div className="flex flex-col gap-4">
        <Eyebrow>{span(d.k)}</Eyebrow>
        <Title>{copy.kit.title}</Title>
        <div className="grid grid-cols-2 gap-3">
          {d.kits.groups.map((kit) => {
            const gs = d.groups.filter((g) => g.team === kit.key);
            if (!gs.length) return null;
            return (
              <button key={kit.key} type="button" onClick={() => act(() => { S.team = kit.key; S.step = "gallery"; })}
                className="flex flex-col gap-2.5 rounded-2xl border border-line bg-surface p-3 text-start hover:border-floodlight">
                <div className="flex h-24 gap-1 overflow-hidden">
                  {gs.slice(0, 3).map((g) => <Crop key={g.cid} chunk={d} keyName={d.pieces[spread(g.members, 1)[0]]?.img} h={96} />)}
                </div>
                <div>
                  <strong className="font-display text-lg text-text">
                    <span className="me-2 inline-block h-3 w-3 rounded-full align-[-1px] ring-1 ring-white/25" style={{ background: kit.swatch }} />
                    {copy.kit.names[kitNameKey(kit.swatch)] ?? kit.key}
                  </strong>
                  <div className="text-xs text-muted-text">{copy.kit.people(gs.length)}</div>
                </div>
              </button>
            );
          })}
        </div>
        <Row><Btn size="sm" onClick={() => act(() => { S.team = null; S.step = "gallery"; })}>{copy.kit.everyone}</Btn></Row>
        <Row>
          <span className="text-xs text-muted-text">{copy.kit.startElsewhere}</span>
          <select
            value={d.k}
            onChange={async (e) => {
              const k = Number(e.target.value);
              S.k = k;
              S.order = game.chunks.map((c) => c.k).filter((x) => x >= k);
              S.oi = 0;
              await ensure(k);
              setVer((v) => v + 1);
            }}
            className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-text"
          >
            {game.chunks.map((c) => (
              <option key={c.k} value={c.k}>{span(c.k)}{inPlaySec(ctx, c.k) < 60 ? ` ${copy.kit.noPlay}` : ""}</option>
            ))}
          </select>
        </Row>
      </div>
    );
  } else if (S.step === "gallery" && currentChunk) {
    const d = currentChunk;
    const gs = galleryGroups(d, S.team);
    body = (
      <div className="flex flex-col gap-4">
        <Eyebrow>{span(d.k)}</Eyebrow>
        <Title>{copy.gallery.title}</Title>
        <Lede>{copy.gallery.lead}</Lede>
        {mediaSlot}
        <div className="flex flex-col gap-3">
          {gs.length === 0 && <p className="text-sm text-muted-text">{copy.gallery.empty}</p>}
          {gs.map((g) => (
            <GroupCard key={g.cid} d={d} g={g} copy={copy} game={game} onWatch={() => previewGroup(d, g)}
              action={<Btn kind="primary" size="sm" onClick={() => pickGroup(g.cid)}>{copy.gallery.thatsMe}</Btn>} />
          ))}
        </div>
        <Row><Btn onClick={() => go("kit")}>{copy.gallery.changeKit}</Btn></Row>
      </div>
    );
  } else if (S.step === "review" && currentChunk && S.k !== null) {
    body = <ReviewScreen ctx={ctx} d={currentChunk} copy={copy} mediaSlot={mediaSlot} span={span(S.k)} disp={disp}
      act={act} go={go} show={show} media={media} previewGroup={previewGroup} />;
  } else if (S.step === "joins" && currentChunk && S.k !== null) {
    const qs = questions(ctx, S.k);
    const j = qs[S.qi];
    if (!j) {
      body = null;
    } else {
      const d = currentChunk;
      const A = d.pieces[j.a];
      const B = d.pieces[j.b];
      body = (
        <div className="flex flex-col gap-4">
          <Eyebrow>{copy.joins.eyebrow(S.qi + 1, qs.length)}</Eyebrow>
          <Title>{copy.joins.title}</Title>
          <Lede>{copy.joins.lead}</Lede>
          <div className="flex items-center justify-center gap-3">
            <Tile d={d} img={A.img} label={copy.joins.before(disp(L2G(game, d.k, A.t1)))} />
            <div className="text-center text-xs text-muted-text">{copy.joins.later(j.gap < 1 ? copy.joins.moments : mmss(j.gap), Math.round(j.dm))}</div>
            <Tile d={d} img={B.img} label={copy.joins.after(disp(L2G(game, d.k, B.t0)))} />
          </div>
          {mediaSlot}
          <Row>
            <Btn kind="primary" onClick={() => answerJoin("yes")}>{copy.joins.same}</Btn>
            <Btn kind="violet" onClick={() => answerJoin("no")}>{copy.joins.different}</Btn>
            <Btn onClick={() => answerJoin("skip")}>{copy.joins.cantTell}</Btn>
          </Row>
        </div>
      );
    }
  } else if (S.step === "gaps" && currentChunk && S.k !== null) {
    body = <GapsScreen ctx={ctx} d={currentChunk} copy={copy} mediaSlot={mediaSlot} span={span(S.k)} disp={disp}
      act={act} pickSet={pickSet} setPickSet={setPickSet} />;
  } else if (S.step === "next" && currentChunk && S.k !== null) {
    const d = currentChunk;
    const r = rankNext(ctx, d.k);
    const sure = isSure(r);
    body = (
      <div className="flex flex-col gap-4">
        <Eyebrow>{copy.next.eyebrow(span(d.k))}</Eyebrow>
        <Title>{copy.next.title}</Title>
        <Lede>{copy.next.lead}</Lede>
        {mediaSlot}
        <GameTimeline ctx={ctx} ph={chunkMeta(ctx, d.k).start} />
        {sure && r[0] && (
          <>
            <Row><Btn kind="primary" onClick={() => pickGroup(r[0].g.cid)}>{copy.next.fast}</Btn></Row>
            <p className="-mt-2 text-xs text-muted-text">{copy.next.fastNote}</p>
          </>
        )}
        <div className="flex flex-col gap-3">
          {r.map(({ g }) => (
            <GroupCard key={g.cid} d={d} g={g} copy={copy} game={game} onWatch={() => previewGroup(d, g)}
              action={<Btn kind={sure ? "ghost" : "primary"} size="sm" onClick={() => pickGroup(g.cid)}>{copy.gallery.thatsMe}</Btn>} />
          ))}
        </div>
        <Row>
          <Btn onClick={() => act(() => { S.step = "gallery"; })}>{copy.next.showAll}</Btn>
          <Btn onClick={() => act(() => { Y(ctx, d.k).skipped = true; void advance(); })}>{copy.next.notPlay}</Btn>
        </Row>
      </div>
    );
  } else if (S.step === "done") {
    body = <DoneScreen ctx={ctx} copy={copy} elapsed={elapsed}
      onStats={() => go("stats")}
      onExport={() => exportClaim(S, recordingId)}
      onAgain={async () => {
        if (!window.confirm(copy.done.againConfirm)) return;
        try { await fetch(`${basePath}/api/recordings/${recordingId}/claim-match/game`, { method: "DELETE", credentials: "include" }); } catch { /* ignore */ }
        setSavedClaim(null);
        ctxRef.current.S = newState(game);
        t0.current = null;
        go("intro");
      }} />;
  } else if (S.step === "stats") {
    body = <StatsScreen ctx={ctx} copy={copy} mediaSlot={mediaSlot} now={mediaNow} eyebrow={eyebrow}
      recordingId={recordingId} videoUrl={videoUrl}
      onTeams={(pick) => act(() => { S.teams = pick; }, false)}
      onBack={() => go("done")} onExport={() => exportClaim(S, recordingId)} ensure={ensure} />;
  }

  return (
    <Shell meter={meter}>
      {saveError && <p className="rounded-xl border border-line bg-surface px-3 py-2 text-xs text-muted-text">{copy.common.saveFailed}</p>}
      {body}
      {createPortal(
        <GameMedia ref={media} game={game} chunks={chunks.current} videoUrl={videoUrl} copy={copy.media} />,
        holder,
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------ helpers */

function galleryGroups(d: LoadedChunk, team: string | null): Group[] {
  return d.groups.filter((g) => !team || g.team === team);
}

function exportClaim(S: ClaimState, recordingId: number) {
  const blob = new Blob([JSON.stringify(S)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `my-claim-${recordingId}.json`;
  a.click();
}

function Tile({ d, img, label, children, onClick, out, pickOn }: {
  d: LoadedChunk; img: string | null | undefined; label: string; children?: React.ReactNode; onClick?: () => void; out?: boolean; pickOn?: boolean;
}) {
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      className={`relative flex flex-col items-center gap-1 rounded-xl border bg-surface p-1 ${out ? "border-[#FF5A3C]" : pickOn ? "border-floodlight" : "border-line"} ${onClick ? "cursor-pointer" : ""}`}
    >
      <div className={out ? "opacity-25" : ""}>
        {img && d.crops[img] ? <Crop chunk={d} keyName={img} h={108} /> : <span className="grid h-[108px] w-14 place-items-center text-[10px] text-muted-text">·</span>}
      </div>
      <span dir="ltr" className="text-[11px] tabular-nums text-muted-text">{label}</span>
      {children}
    </div>
  );
}

function GroupCard({ d, g, copy, game, onWatch, action }: {
  d: LoadedChunk; g: Group; copy: GameStrings; game: Game; onWatch: () => void; action: React.ReactNode;
}) {
  const ms = g.members.map((m) => d.pieces[m]).filter(Boolean);
  const t0 = Math.min(...ms.map((m) => m.t0));
  const t1 = Math.max(...ms.map((m) => m.t1));
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-line bg-surface p-3">
      <div className="flex gap-1 overflow-x-auto">
        {spread(ms, 6).map((m) => <Crop key={m.id} chunk={d} keyName={m.img} h={104} />)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="me-auto text-xs text-muted-text">
          <b dir="ltr" className="me-1.5 font-display text-lg font-semibold tabular-nums text-text">{mmss(g.dur)}</b>
          {copy.gallery.onCamera} · <span dir="ltr" className="tabular-nums">{mmss(L2G(game, d.k, t0) + game.matchOffset)}–{mmss(L2G(game, d.k, t1) + game.matchOffset)}</span>
        </div>
        <Btn size="sm" onClick={onWatch}>{copy.gallery.watch}</Btn>
        {action}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ intro */

function IntroScreen({ ctx, copy, eyebrow, mediaSlot, markA, saved, onMarkA, onMarkB, onDel, onWatch, onStart, onResume }: {
  ctx: Ctx; copy: GameStrings; eyebrow: string; mediaSlot: React.ReactNode; markA: number | null; saved: (ClaimState & { saved?: number }) | null;
  onMarkA: () => void; onMarkB: () => void; onDel: (i: number) => void; onWatch: (i: number) => void; onStart: () => void; onResume: () => void;
}) {
  const off = ctx.S.off;
  const mo = ctx.game.matchOffset;
  return (
    <div className="flex flex-col gap-4">
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <Title big>{copy.intro.title}</Title>
      <Lede>{copy.intro.lead}</Lede>
      {mediaSlot}
      <GameTimeline ctx={ctx} />
      <Row>
        <Btn size="sm" onClick={onMarkA}>{copy.intro.outFromHere}</Btn>
        <Btn size="sm" disabled={markA === null} onClick={onMarkB}>{copy.intro.backInPlay}</Btn>
        {markA !== null && <span className="text-xs text-muted-text">{copy.intro.startedAt(mmss(markA + mo))}</span>}
      </Row>
      <h3 className="font-display text-lg font-bold text-text">{copy.intro.outOfPlay}</h3>
      <div className="flex flex-col gap-2">
        {off.every((r) => r[2] !== "play") && <span className="text-xs text-muted-text">{copy.intro.nothingMarked}</span>}
        {off.map((r, i) => r[2] === "play" && (
          <div key={`${r[0]}-${i}`} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
            <b dir="ltr" className="font-display tabular-nums text-text">{mmss(r[0] + mo)} – {mmss(r[1] + mo)}</b>
            <span dir="ltr" className="text-xs tabular-nums text-muted-text">{mmss(r[1] - r[0])}</span>
            <span className="flex-1" />
            <Btn size="sm" onClick={() => onWatch(i)}>{copy.intro.watch}</Btn>
            <Btn size="sm" onClick={() => onDel(i)}>{copy.intro.remove}</Btn>
          </div>
        ))}
      </div>
      {saved && (
        <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3">
          <div className="me-auto text-xs text-muted-text">
            <b className="me-1.5 font-display text-base text-text">{copy.intro.savedClaim}</b>
            {copy.intro.savedMeta(Object.keys(saved.you ?? {}).length)}
            {saved.saved ? ` · ${new Date(saved.saved).toLocaleString()}` : ""}
          </div>
          <Btn kind="primary" onClick={onResume}>{saved.step === "done" || saved.step === "stats" ? copy.intro.seeStats : copy.intro.resume}</Btn>
        </div>
      )}
      <Row><Btn kind={saved ? "ghost" : "primary"} onClick={onStart}>{saved ? copy.intro.startNew : copy.intro.start}</Btn></Row>
    </div>
  );
}

/* ----------------------------------------------------------------- review */

function ReviewScreen({ ctx, d, copy, mediaSlot, span, disp, act, go, show, media, previewGroup }: {
  ctx: Ctx; d: LoadedChunk; copy: GameStrings; mediaSlot: React.ReactNode; span: string; disp: (t: number) => string;
  act: (fn: () => void, counts?: boolean) => void; go: (s: Step) => void; show: (v: MediaView) => void;
  media: React.RefObject<MediaHandle | null>; previewGroup: (d: LoadedChunk, g: Group) => void;
}) {
  const S = ctx.S;
  const k = d.k;
  const y = Y(ctx, k);
  const ms = mine(ctx, k);
  const g = y.cid ? d.byCid[y.cid] : null;
  const bs = benchSpans(ctx, k);
  const tw = twins(ctx, k);
  const twc = new Set(tw.map((x) => x.g.cid));
  const nb = (g ? g.nb : []).filter(([, c]) => !y.added.includes(c) && d.byCid[c] && c !== y.cid && !twc.has(c));
  const G = ctx.game;
  const watchPiece = (id: string) => {
    const p = ms.find((x) => x.id === id);
    if (!p) return;
    const src = p.manual ? p.src : p.id;
    const tm = (p.t0 + p.t1) / 2;
    show({ t: L2G(G, k, tm), lo: L2G(G, k, p.t0), hi: L2G(G, k, p.t1), k, hl: new Set(src ? [src] : []), focus: (src ? ovPos(ctx, k, src, tm)?.foot : null) ?? p.a, label: copy.media.thisPicture, loop: true });
    media.current?.element()?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  return (
    <div className="flex flex-col gap-4">
      <Eyebrow>{span} · {copy.review.eyebrow}</Eyebrow>
      <Title>{copy.review.title}</Title>
      <Lede>{copy.review.lead}{S.autoAdded && y.added.length ? copy.review.autoAdded(y.added.length) : ""}</Lede>
      {mediaSlot}
      <ChunkTimeline ctx={ctx} k={k} copy={copy.timeline} />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
        {ms.map((m) => (
          <Tile key={m.id} d={d} img={m.img} out={y.out.includes(m.id)}
            label={`${disp(L2G(G, k, m.t0))}–${disp(L2G(G, k, m.t1))}`}
            onClick={() => act(() => { const i = y.out.indexOf(m.id); if (i >= 0) y.out.splice(i, 1); else y.out.push(m.id); })}>
            <button type="button" aria-label={copy.media.play} onClick={(e) => { e.stopPropagation(); watchPiece(m.id); }}
              className="absolute bottom-7 end-2 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-[10px] text-white">▶</button>
          </Tile>
        ))}
      </div>
      {bs.length > 0 && (
        <Section title={copy.review.offPitchTitle}>
          <Lede>{copy.review.offPitchLead(bs.map(([a, b]) => `\u2066${disp(a)}–${disp(b)}\u2069`).join(", "))}</Lede>
          <Row><Btn kind="primary" size="sm" onClick={() => act(() => { bs.forEach(([a, b]) => S.off.push([a, b, "bench"])); S.off.sort((x, z) => x[0] - z[0]); })}>{copy.review.benchYes}</Btn></Row>
        </Section>
      )}
      {tw.length > 0 && (
        <Section title={copy.review.alsoYouTitle}>
          <Lede>{weakColour(ctx) ? copy.review.alsoYouLeadDark : copy.review.alsoYouLead}</Lede>
          <div className="flex flex-col gap-3">
            {tw.slice(0, 3).map(({ g: gg }) => (
              <GroupCard key={gg.cid} d={d} g={gg} copy={copy} game={G} onWatch={() => previewGroup(d, gg)}
                action={<Btn kind="primary" size="sm" onClick={() => act(() => { y.added.push(gg.cid); })}>{copy.review.alsoMe}</Btn>} />
            ))}
          </div>
          {tw.length > 1 && <Row><Btn size="sm" onClick={() => act(() => { tw.forEach((x) => { if (!y.added.includes(x.g.cid)) y.added.push(x.g.cid); }); })}>{copy.review.allOfThese}</Btn></Row>}
        </Section>
      )}
      {nb.length > 0 && (
        <Section title={copy.review.mightTitle}>
          <div className="flex flex-col gap-3">
            {nb.slice(0, 3).map(([, c]) => (
              <GroupCard key={c} d={d} g={d.byCid[c]} copy={copy} game={G} onWatch={() => previewGroup(d, d.byCid[c])}
                action={<Btn size="sm" onClick={() => act(() => { y.added.push(c); })}>{copy.review.alsoMe}</Btn>} />
            ))}
          </div>
        </Section>
      )}
      <Row>
        <Btn kind="primary" onClick={() => act(() => { S.qi = 0; S.step = "joins"; })}>{copy.review.looksRight}</Btn>
        <Btn onClick={() => go(S.oi ? "next" : "gallery")}>{copy.review.notMe}</Btn>
        <Btn title={copy.review.cameOff} onClick={() => act(() => {
          const t = media.current?.now() ?? 0;
          const end = S.off.find((r) => r[2] === "bench" && r[0] > t);
          S.off.push([t, end ? end[0] : G.total, "bench"]);
          S.off.sort((x, z) => x[0] - z[0]);
        })}>{copy.review.cameOff}</Btn>
      </Row>
    </div>
  );
}

/* ------------------------------------------------------------------- gaps */

function GapsScreen({ ctx, d, copy, mediaSlot, span, disp, act, pickSet, setPickSet }: {
  ctx: Ctx; d: LoadedChunk; copy: GameStrings; mediaSlot: React.ReactNode; span: string; disp: (t: number) => string;
  act: (fn: () => void, counts?: boolean) => void; pickSet: Set<string>; setPickSet: (s: Set<string>) => void;
}) {
  const S = ctx.S;
  const k = d.k;
  const G = ctx.game;
  const h = nextHole(ctx, k);
  if (!h) return null;
  const bg = benchInHole(ctx, k, h);
  const c = candidates(ctx, k, h);
  const ref = [h.a, h.b].filter((p): p is NonNullable<Hole["a"]> => Boolean(p));
  const toG = (x: Hole): [number, number] => [L2G(G, k, x.t0), L2G(G, k, x.t1)];
  const y = Y(ctx, k);
  const lastManual = y.manual[y.manual.length - 1];
  const mark = (kind: OffRange[2]) => act(() => { const [a, b] = toG(h); S.off.push([a, b, kind]); S.off.sort((x, z) => x[0] - z[0]); });
  return (
    <div className="flex flex-col gap-4">
      <Eyebrow>{span} · {copy.gaps.eyebrow}</Eyebrow>
      <Title>{copy.gaps.title(disp(L2G(G, k, h.t0)), disp(L2G(G, k, h.t1)))}</Title>
      <Lede>{copy.gaps.lead(mmss(h.t1 - h.t0))}</Lede>
      <ChunkTimeline ctx={ctx} k={k} cur={h} copy={copy.timeline} />
      {mediaSlot}
      {ref.some((p) => p.img) && (
        <Row>
          {ref.filter((p) => p.img).map((p) => (
            <Tile key={p.id} d={d} img={p.img} label={p === h.a ? copy.gaps.youBefore : copy.gaps.youAfter} />
          ))}
        </Row>
      )}
      {bg && (
        <Section title={copy.gaps.benchTitle}>
          <Lede>{copy.gaps.benchLead(disp(bg.a), disp(bg.b))}</Lede>
          <GroupCard d={d} g={bg.g} copy={copy} game={G} onWatch={() => undefined}
            action={<Btn kind="primary" size="sm" onClick={() => act(() => { const [, b] = toG(h); S.off.push([bg.a, Math.max(bg.b, b), "bench"]); S.off.sort((x, z) => x[0] - z[0]); })}>{copy.gaps.benchMe}</Btn>} />
        </Section>
      )}
      {c.length > 0 && (
        <>
          <h3 className="font-display text-lg font-bold text-text">{copy.gaps.orOne}</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
            {c.map((x) => (
              <Tile key={x.id} d={d} img={x.img} pickOn={pickSet.has(x.id)} label={`${disp(L2G(G, k, x.t0))}–${disp(L2G(G, k, x.t1))}`}
                onClick={() => { const n = new Set(pickSet); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); setPickSet(n); }} />
            ))}
          </div>
          <Row><Btn kind="primary" disabled={!pickSet.size} onClick={() => act(() => { pickSet.forEach((id) => { if (!y.extra.includes(id)) y.extra.push(id); }); setPickSet(new Set()); })}>{copy.gaps.addPicked}</Btn></Row>
        </>
      )}
      <Row>
        <Btn onClick={() => mark("play")}>{copy.gaps.outOfPlay}</Btn>
        <Btn onClick={() => mark("cam")}>{copy.gaps.offCamera}</Btn>
        <Btn onClick={() => mark("bench")}>{copy.gaps.bench}</Btn>
        <Btn onClick={() => act(() => { y.seen.push(hkey(h)); })}>{copy.gaps.skip}</Btn>
        {lastManual && <Btn size="sm" onClick={() => act(() => { y.manual.pop(); }, false)}>{copy.gaps.undoTap}</Btn>}
      </Row>
    </div>
  );
}

/* ------------------------------------------------------------------- done */

function DoneScreen({ ctx, copy, elapsed, onStats, onExport, onAgain }: {
  ctx: Ctx; copy: GameStrings; elapsed: number; onStats: () => void; onExport: () => void; onAgain: () => void;
}) {
  const tt = totals(ctx);
  const mo = ctx.game.matchOffset;
  return (
    <div className="flex flex-col gap-4">
      <Eyebrow>{copy.done.eyebrow}</Eyebrow>
      <Title>{copy.done.title}</Title>
      <GameTimeline ctx={ctx} />
      <div className="grid grid-cols-3 gap-2.5">
        <Stat value={mmss(tt.fs)} label={copy.done.found(mmss(Math.max(tt.ip - tt.os, 0)))} />
        <Stat value={mmss(elapsed / 1000)} label={copy.done.timeTaken} />
        <Stat value={ctx.S.taps} label={copy.done.taps} />
      </div>
      <div className="flex flex-col gap-1.5">
        {ctx.game.chunks.map((c) => {
          const y = ctx.S.you[String(c.k)];
          const sk = y?.skipped;
          const has = ctx.CH[c.k] && y && !sk && (y.cid || y.manual.length);
          const v = inPlaySec(ctx, c.k);
          return (
            <div key={c.k} className="grid grid-cols-[64px_1fr_72px] items-center gap-2 text-xs">
              <span dir="ltr" className="tabular-nums text-text">{mmss(c.start + mo)}</span>
              {has ? <ChunkTimeline ctx={ctx} k={c.k} copy={copy.timeline} bare /> : <div className="h-5 rounded-md bg-raised" />}
              <span className="text-end text-muted-text">{has ? `${chunkPercent(timeline(ctx, c.k))}%` : sk ? copy.done.notPlaying : v < 30 ? copy.done.noPlay : "—"}</span>
            </div>
          );
        })}
      </div>
      <p className="border-s-2 border-violet ps-2.5 text-xs text-muted-text">{copy.done.note}</p>
      <Row>
        <Btn kind="primary" onClick={onStats}>{copy.done.toStats}</Btn>
        <Btn onClick={onExport}>{copy.done.download}</Btn>
        <Btn onClick={onAgain}>{copy.done.again}</Btn>
      </Row>
    </div>
  );
}
