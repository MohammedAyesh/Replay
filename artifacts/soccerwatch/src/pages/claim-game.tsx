/**
 * Find yourself in the whole game — the 19 Sep prototype's claim, in Replay.
 *
 * replayjo.b-cdn.net/proto/game is the reference: every screen, button and
 * rule here is that page's, running on this recording's tracking bundle
 * instead of files a separate pipeline wrote for one game. The flow:
 *
 *   intro   whole-game video; check what was play, mark or remove out-of-play
 *   kit     what were you wearing (first ten minutes with play)
 *   shirt   choose a shirt number and confirm it from the pictures
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getClaimMatchSegment,
  getGetClaimChainQueryKey,
  getGetClaimMatchQueryKey,
  useGetClaimChain,
  useGetClaimMatch,
  type TrackingManifest,
} from "@workspace/api-client-react";

import { useAuth } from "@/lib/auth";
import { useGameCopy, type GameStrings } from "@/i18n/game-strings";
import { GameMedia, type MediaHandle, type MediaView, type TapHit } from "@/components/game-claim/GameMedia";
import { Btn, ChunkTimeline, Crop, Eyebrow, GameTimeline, Lede, Row, Section, Stat, Title } from "@/components/game-claim/bits";
import { ClaimantNameDialog } from "@/components/claim/ClaimantNameDialog";
import { StatsScreen } from "@/components/game-claim/StatsScreen";
import { gameFromManifest, loadChunkData, kitNameKey, type LoadedChunk } from "@/lib/game-claim/load";
import { groupsForShirtIdentity, shirtNumbersForKit, type ShirtIdentity } from "@/lib/game-claim/jersey";
import { matchBenchRanges, type ClaimMatchWindow } from "@/lib/game-claim/match-windows";
import { claimCountsForGroups, claimStatusForGroup, type ClaimStatusIdentity } from "@/lib/game-claim/claim-status";
import { pictureForPiece, type PiecePicture } from "@/lib/game-claim/images";
import type { Game, Group, OffRange, Point } from "@/lib/game-claim/model";
import { chunkAt, L2G, mmss, spread } from "@/lib/game-claim/model";
import {
  addTap, afterChunk, benchInHole, benchSpans, candidates, chunkMeta, chunkPercent, inPlaySec, isSure, kept, mine,
  newState, nextHole, nextIllustratedJoin, ovPos, pick, questions, rankNext, startClaim, timeline, totals, twins, weakColour, Y, youIds,
  hkey, recordSwitch, type ClaimState, type Ctx, type Hole, type Step,
} from "@/lib/game-claim/claim";
import { benchSpansOut, chainParts } from "@/lib/game-claim/parts";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

type ClaimMatch = ClaimMatchWindow & {
  title: string;
  fieldName: string | null;
  rostered: boolean;
  teamCount: number;
  recordingOffsetSec: number;
};

type ServerGame = {
  state: (ClaimState & { saved?: number }) | null;
  bundleFingerprint: string;
  inPlaySpans: Array<[number, number]>;
  /** Optional Part 2 match windows; older responses omit this field. */
  matches?: ClaimMatch[];
  continuation?: null | { recordingId: number; timeLabel: string; matchCode: string };
};

type GameDecisionLabel =
  | { kind: "switch"; frame: number; wrongTrackId: string; rightTrackId: string }
  | { kind: "lost"; frame: number; wrongTrackId: string }
  | { kind: "confirm"; frame: number; rightTrackId: string };

export default function ClaimGamePage() {
  const params = useParams<{ id?: string }>();
  const [, setLocation] = useLocation();
  const { user, isLoading: authLoading, isGuest } = useAuth();
  const copy = useGameCopy();
  const recordingId = Number(params.id);
  const enabled = Number.isInteger(recordingId) && recordingId > 0 && Boolean(user) && !isGuest;
  const matchQueryKey = useMemo(() => getGetClaimMatchQueryKey(recordingId), [recordingId]);
  const chainQueryKey = useMemo(() => getGetClaimChainQueryKey(recordingId), [recordingId]);
  const claimQuery = useGetClaimMatch(recordingId, {
    query: {
      enabled,
      queryKey: matchQueryKey,
      refetchInterval: 60_000,
      refetchOnWindowFocus: "always",
    },
  });
  const chainQuery = useGetClaimChain(recordingId, { query: { enabled, queryKey: chainQueryKey } });
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
  if (!game || !manifest || !server || chainQuery.isLoading) {
    return <Shell><p className="py-10 text-center text-sm text-muted-text">{copy.common.loading}</p></Shell>;
  }
  const identities: ClaimStatusIdentity[] = (manifest.identities ?? []).map((identity) => ({
    id: identity.id,
    name: identity.name ?? null,
    parts: (identity.parts ?? []).map((part) => ({ trackId: part.trackId })),
  }));
  const chain = chainQuery.data;
  const resetByAdmin = Boolean(chain?.resetByAdmin && !chain.chain?.length);
  return (
    <GameClaim
      key={server.bundleFingerprint}
      game={game}
      manifest={manifest}
      recordingId={recordingId}
      videoUrl={recording?.videoUrl ?? null}
      eyebrow={recording ? `${recording.date ?? ""} · ${recording.court ?? ""}`.replace(/^ · | · $/g, "") : ""}
      saved={resetByAdmin ? null : server.state}
      fingerprint={server.bundleFingerprint}
      copy={copy}
      identities={identities}
      identityId={chain?.identityId ?? null}
      identityName={chain?.name ?? null}
      resetByAdmin={resetByAdmin}
      coveragePercent={chain?.coveragePercent ?? 0}
      accountName={user?.name ?? ""}
      matches={server.matches ?? []}
      continuation={server.continuation ?? null}
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
  identities: ClaimStatusIdentity[];
  identityId: string | null;
  identityName: string | null;
  resetByAdmin: boolean;
  coveragePercent: number;
  accountName: string;
  matches: ClaimMatch[];
  continuation: ServerGame["continuation"];
};

type PendingNamePick = {
  k: number;
  cid: string;
  expectedCid: string | null;
  shirtIdentity: ShirtIdentity | null;
};

export function GameClaim({
  game, manifest, recordingId, videoUrl, eyebrow, saved, fingerprint, copy,
  identities, identityId, identityName, resetByAdmin, coveragePercent, accountName,
  matches, continuation,
}: Props) {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [ver, setVer] = useState(0);
  const chunks = useRef<Record<number, LoadedChunk>>({});
  const [chunkVer, setChunkVer] = useState(0);
  const loading = useRef<Record<number, Promise<LoadedChunk>>>({});
  const ctxRef = useRef<Ctx>({ game, CH: chunks.current, S: newState(game) });
  const ctx = ctxRef.current;
  const S = ctx.S;
  const [savedClaim, setSavedClaim] = useState(saved);
  const [claimName, setClaimName] = useState(identityName);
  const namePromptHandled = useRef(Boolean(identityName));
  const pendingClaimName = useRef<string | null>(null);
  const [pendingNamePick, setPendingNamePick] = useState<PendingNamePick | null>(null);
  const [markA, setMarkA] = useState<number | null>(null);
  const [introT, setIntroT] = useState<number | null>(null);
  const [pickSet, setPickSet] = useState<Set<string>>(new Set());
  const [switchPrompt, setSwitchPrompt] = useState(false);
  const [pendingSwitchKind, setPendingSwitchKind] = useState<"new-new" | "same-new" | "new-same" | null>(null);
  const [switchSide, setSwitchSide] = useState<"A" | "B" | "C" | null>(null);
  const [switchMatchCode, setSwitchMatchCode] = useState<string | null>(null);
  const pendingSwitchNumber = useRef<string | null>(null);
  const pendingAutoKit = useRef<string | null>(null);
  const requestedMatchCode = new URLSearchParams(window.location.search).get("match");
  const initialMatchChoices = saved?.matchChoices?.length
    ? saved.matchChoices
    : requestedMatchCode && matches.some((match) => match.code === requestedMatchCode)
      ? [requestedMatchCode]
      : matches.filter((match) => match.rostered).map((match) => match.code);
  const [matchChoices, setMatchChoices] = useState<string[]>(initialMatchChoices);
  const [saveError, setSaveError] = useState(false);
  const [labelError, setLabelError] = useState(false);
  const t0 = useRef<number | null>(null);
  const pendingNextGuess = useRef<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setClaimName(identityName);
    namePromptHandled.current = Boolean(identityName);
  }, [identityName]);

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
        fetchJersey: async (index) => {
          const r = await fetch(`${basePath}/api/recordings/${recordingId}/claim-match/jersey/${index}`, { credentials: "include" });
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
    if (!Object.keys(ctxRef.current.S.you).length) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const currentCtx = ctxRef.current;
      const currentState = currentCtx.S;
      currentState.elapsed = t0.current ? Date.now() - t0.current : currentState.elapsed;
      const body = {
        state: { ...currentState, saved: Date.now() },
        parts: chainParts(currentCtx),
        bench: benchSpansOut(currentCtx),
        done: currentState.step === "done" || currentState.step === "stats",
        bundleFingerprint: fingerprint,
        ...(pendingClaimName.current ? { name: pendingClaimName.current } : {}),
      };
      try {
        const r = await fetch(`${basePath}/api/recordings/${recordingId}/claim-match/game`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          setSaveError(true);
          return;
        }
        setSaveError(false);
        if (body.name && pendingClaimName.current === body.name) {
          pendingClaimName.current = null;
          void queryClient.invalidateQueries({ queryKey: getGetClaimMatchQueryKey(recordingId) });
          void queryClient.invalidateQueries({ queryKey: getGetClaimChainQueryKey(recordingId) });
        }
      } catch {
        setSaveError(true);
      }
    }, 700);
  }, [fingerprint, recordingId, queryClient]);

  /**
   * Labels are decision events, not snapshots of ClaimState. In particular,
   * this is never called by save(), which runs after ordinary page steps.
   */
  const writeDecisionLabel = useCallback((decision: GameDecisionLabel) => {
    void fetch(`${basePath}/api/recordings/${recordingId}/claim-match/game/decision`, {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...decision, bundleFingerprint: fingerprint }),
    })
      .then(async (r) => {
        if (!r.ok) {
          setLabelError(true);
          return;
        }
        const result = await r.json() as { labelRecorded?: boolean };
        if (result.labelRecorded === false) setLabelError(true);
      })
      .catch(() => setLabelError(true));
  }, [fingerprint, recordingId]);

  const decisionFrame = (k: number, localSeconds: number) => Math.max(
    0,
    Math.round(L2G(game, k, localSeconds) * (manifest.frameRate > 0 ? manifest.frameRate : 20)),
  );

  const representativePiece = (d: LoadedChunk, group: Group) => group.members
    .map((id) => d.pieces[id])
    .filter((piece) => piece != null)
    .sort((a, b) => (b.t1 - b.t0) - (a.t1 - a.t0))[0] ?? null;

  const writeGroupDecision = (d: LoadedChunk, group: Group, rejected?: Group) => {
    const chosen = representativePiece(d, group);
    if (!chosen) return;
    const wrong = rejected && rejected.cid !== group.cid
      ? representativePiece(d, rejected)
      : null;
    const frame = decisionFrame(d.k, (chosen.t0 + chosen.t1) / 2);
    if (wrong) {
      writeDecisionLabel({ kind: "switch", frame, wrongTrackId: wrong.id, rightTrackId: chosen.id });
    } else {
      writeDecisionLabel({ kind: "confirm", frame, rightTrackId: chosen.id });
    }
  };

  const writeRejectedGroup = (d: LoadedChunk, group: Group) => {
    const rejected = representativePiece(d, group);
    if (!rejected) return;
    writeDecisionLabel({
      kind: "lost",
      frame: decisionFrame(d.k, (rejected.t0 + rejected.t1) / 2),
      wrongTrackId: rejected.id,
    });
  };

  const writeRejectedTrack = (k: number, trackId: string | null | undefined, localSeconds: number) => {
    if (!trackId) return;
    writeDecisionLabel({ kind: "lost", frame: decisionFrame(k, localSeconds), wrongTrackId: trackId });
  };

  const writeConfirmedTrack = (k: number, trackId: string | null | undefined, localSeconds: number) => {
    if (!trackId) return;
    writeDecisionLabel({ kind: "confirm", frame: decisionFrame(k, localSeconds), rightTrackId: trackId });
  };

  const tap = () => {
    const state = ctxRef.current.S;
    state.taps++;
    if (!t0.current) t0.current = Date.now() - state.elapsed;
  };
  /** Every action: mutate, re-render, save. */
  const act = (fn: () => void, counts = true) => {
    if (counts) tap();
    fn();
    setVer((v) => v + 1);
    save();
  };
  const go = (step: Step) => {
    ctxRef.current.S.step = step;
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

  const beginSwitch = (atVideoTime = false) => {
    const k = S.k;
    if (k === null) return;
    const atSeconds = atVideoTime ? mediaNow() : chunkMeta(ctx, k).start;
    // Store the prompt locally; no decision label is emitted for identity changes.
    (ctxRef.current as Ctx & { pendingSwitchTime?: number }).pendingSwitchTime = atSeconds;
    setSwitchPrompt(true);
  };

  const switchTime = () => (ctxRef.current as Ctx & { pendingSwitchTime?: number }).pendingSwitchTime
    ?? (S.k === null ? 0 : chunkMeta(ctx, S.k).start);

  const coveredSwitchMatches = () => matches.filter((match) => matchChoices.includes(match.code) && (
    match.games.length
      ? match.games.some((g) => g.startSeconds <= switchTime() && g.endSeconds > switchTime())
      : match.startSeconds <= switchTime() && match.endSeconds > switchTime()
  ));

  const chooseSwitch = (kind: "new-new" | "same-new" | "new-same") => {
    const covered = coveredSwitchMatches();
    if (kind !== "same-new" && covered.length) {
      const match = covered[0];
      const sides = (match.teamCount ?? 2) === 3 ? ["A", "B", "C"] as const : ["A", "B"] as const;
      const roster = match.rosterTeam ?? null;
      setSwitchMatchCode(covered.length === 1 ? match.code : null);
      setSwitchSide(sides.find((side) => side !== roster) ?? sides[0]);
      setPendingSwitchKind(kind);
      return;
    }
    commitSwitch(kind, covered.length === 1 ? covered[0].code : null, null);
  };

  const commitSwitch = (
    kind: "new-new" | "same-new" | "new-same",
    matchCode: string | null,
    side: "A" | "B" | "C" | null,
  ) => {
    const atSeconds = switchTime();
    const teamChanged = kind !== "same-new";
    const shirtChanged = kind !== "new-same";
    act(() => {
      recordSwitch(ctx, {
        atSeconds,
        teamChanged,
        shirtChanged,
        ...(teamChanged && side && matchCode ? { team: side, matchCode } : {}),
        kitKey: teamChanged ? null : S.team,
        number: shirtChanged ? null : S.shirtIdentity?.number ?? null,
      });
      if (shirtChanged) {
        S.shirtIdentity = null;
        S.shirtCandidate = null;
      } else if (teamChanged) {
        pendingSwitchNumber.current = S.shirtIdentity?.number ?? null;
        S.shirtIdentity = null;
      }
      S.step = "kit";
      if (pendingAutoKit.current && kind === "new-new") {
        const kit = pendingAutoKit.current;
        S.team = kit;
        const options = currentChunk ? shirtNumbersForKit(currentChunk.groups, currentChunk.jersey, kit) : [];
        S.step = options.length ? "shirt" : "gallery";
        pendingAutoKit.current = null;
      }
    });
    setSwitchPrompt(false);
    setPendingSwitchKind(null);
    setSwitchSide(null);
    setSwitchMatchCode(null);
  };

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
            if (hit.box) {
              writeDecisionLabel({
                kind: "confirm",
                frame: decisionFrame(k, hit.lt),
                rightTrackId: hit.box.id,
              });
            }
            act(() => addTap(ctx, k, h, hit.lt, hit.box, hit.pt));
          },
        });
        break;
      }
      case "next": {
        if (!d || k === null) break;
        const r = rankNext(ctx, k, chunkMeta(ctx, k).start);
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

  const applyShirtIdentityToChunk = (k: number): boolean => {
    const d = chunks.current[k];
    if (!d) return false;
    const state = ctxRef.current.S;
    const match = groupsForShirtIdentity(d.groups, d.jersey, state.shirtIdentity)[0];
    if (!match) return false;
    pick(ctxRef.current, k, match.groupId);
    state.step = "review";
    return true;
  };

  const startNew = async () => {
    pendingNextGuess.current = null;
    if (savedClaim || resetByAdmin) {
      try {
        await fetch(`${basePath}/api/recordings/${recordingId}/claim-match/game`, { method: "DELETE", credentials: "include" });
      } catch { /* the next save overwrites anyway */ }
      setSavedClaim(null);
      void queryClient.invalidateQueries({ queryKey: getGetClaimMatchQueryKey(recordingId) });
      void queryClient.invalidateQueries({ queryKey: getGetClaimChainQueryKey(recordingId) });
    }
    pendingClaimName.current = null;
    setPendingNamePick(null);
    const off = S.off;
    ctxRef.current.S = { ...newState(game), off };
    const continuationKit = new URLSearchParams(window.location.search).get("kit");
    const continuationNumber = new URLSearchParams(window.location.search).get("number");
    if (continuationKit) {
      ctxRef.current.S.team = continuationKit;
      if (continuationNumber) ctxRef.current.S.shirtIdentity = { kitKey: continuationKit, number: continuationNumber };
    }
    t0.current = null;
    tap();
    startClaim(ctxRef.current);
    applyMatchWindows(ctxRef.current, matchChoices);
    if (continuationKit) ctxRef.current.S.step = "gallery";
    bump();
    await ensure(ctxRef.current.S.k!);
    go("kit");
  };

  const applyMatchWindows = (target: Ctx, choices: string[]) => {
    if (!matches.length || !choices.length) return;
    const windows = matches.filter((m) => choices.includes(m.code))
      .flatMap((m) => m.games.length
        ? m.games.map((g) => [g.startSeconds, g.endSeconds] as [number, number])
        : [[m.startSeconds, m.endSeconds] as [number, number]]);
    if (!windows.length) return;
    const sorted = windows.sort((a, b) => a[0] - b[0]);
    let at = 0;
    for (const [a, b] of sorted) {
      if (a > at) target.S.off.push([at, a, "play"]);
      at = Math.max(at, b);
    }
    if (at < target.game.total) target.S.off.push([at, target.game.total, "play"]);
    for (const match of matches.filter((m) => choices.includes(m.code))) {
      for (const [from, to] of matchBenchRanges(match, target.S.switches ?? [])) {
        target.S.off.push([from, to, "bench"]);
      }
    }
    for (const c of target.game.chunks) {
      if (!sorted.some(([a, b]) => b > c.start && a < c.start + c.dur)) Y(target, c.k).skipped = true;
    }
    target.S.off.sort((a, b) => a[0] - b[0]);
  };

  const resume = async (j: ClaimState) => {
    ctxRef.current.S = { ...newState(game), ...j };
    const s = ctxRef.current.S;
    t0.current = Date.now() - (s.elapsed || 0);
    await Promise.all(Object.keys(s.you).map((k) => ensure(Number(k))));
    if (s.k !== null) await ensure(s.k);
    if (s.k !== null && s.step === "next") applyShirtIdentityToChunk(s.k);
    const st = s.step === "done" || s.step === "stats" ? s.step : s.step === "intro" ? "review" : s.step;
    go(st);
  };

  const completeGroupPick = (pending: PendingNamePick) => {
    const d = chunks.current[pending.k];
    const chosen = d?.byCid[pending.cid];
    if (!d || !chosen) {
      setPendingNamePick(null);
      return;
    }
    const expected = pending.expectedCid ? d.byCid[pending.expectedCid] : undefined;
    writeGroupDecision(d, chosen, expected);
    pendingNextGuess.current = null;
    act(() => {
      if (pending.shirtIdentity) {
        S.shirtIdentity = { ...pending.shirtIdentity };
        S.shirtCandidate = null;
      }
      pick(ctx, pending.k, pending.cid);
      S.step = "review";
    });
  };

  const chooseGroup = (pending: PendingNamePick) => {
    if (!claimName && !namePromptHandled.current) {
      setPendingNamePick(pending);
      return;
    }
    completeGroupPick(pending);
  };

  const confirmClaimName = (name: string) => {
    if (!pendingNamePick) return;
    pendingClaimName.current = name;
    namePromptHandled.current = true;
    setClaimName(name);
    setPendingNamePick(null);
    completeGroupPick(pendingNamePick);
  };

  const pickGroup = (cid: string) => {
    const k = S.k;
    const d = k === null ? null : chunks.current[k];
    if (!d || k === null || !d.byCid[cid]) return;
    const group = d.byCid[cid];
    const kit = group.kitKey ?? group.team;
    if (S.team && kit && kit !== S.team) {
      pendingAutoKit.current = kit;
      setSwitchPrompt(true);
      return;
    }
    const expectedCid = S.step === "next"
      ? rankNext(ctx, k, chunkMeta(ctx, k).start)[0]?.g.cid ?? null
      : pendingNextGuess.current;
    chooseGroup({ k, cid, expectedCid, shirtIdentity: null });
  };

  const chooseKit = (team: string | null) => {
    const shirtIdentity = team && S.shirtIdentity?.kitKey === team
      ? S.shirtIdentity
      : team && pendingSwitchNumber.current
        ? { number: pendingSwitchNumber.current, kitKey: team }
        : null;
    const hasNumbers = Boolean(currentChunk && shirtNumbersForKit(currentChunk.groups, currentChunk.jersey, team).length);
    const nextStep: Step = shirtIdentity || !hasNumbers ? "gallery" : "shirt";
    act(() => {
      S.team = team;
      S.shirtIdentity = shirtIdentity;
      S.shirtCandidate = null;
      S.step = nextStep;
    });
  };

  const chooseShirtNumber = (number: string) => {
    const kitKey = S.team;
    if (!kitKey) return;
    act(() => { S.shirtCandidate = { number, kitKey }; });
  };

  const chooseAnotherShirtNumber = () => act(() => { S.shirtCandidate = null; });

  const continueWithoutShirtNumber = () => act(() => {
    S.shirtIdentity = null;
    S.shirtCandidate = null;
    S.step = "gallery";
  });

  const backToKitFromShirt = () => act(() => {
    S.shirtCandidate = null;
    S.step = "kit";
  });

  const confirmShirtGroup = (cid: string) => {
    const k = S.k;
    const candidate = S.shirtCandidate;
    const d = k === null ? null : chunks.current[k];
    if (k === null || !candidate || !d) return;
    if (!groupsForShirtIdentity(d.groups, d.jersey, candidate).some((match) => match.groupId === cid)) return;
    chooseGroup({ k, cid, expectedCid: null, shirtIdentity: candidate });
  };

  const advance = async () => {
    pendingNextGuess.current = null;
    const where = afterChunk(ctx);
    setVer((v) => v + 1);
    save();
    window.scrollTo({ top: 0 });
    if (where === "next" && S.k !== null) {
      const nextK = S.k;
      await ensure(nextK);
      applyShirtIdentityToChunk(nextK);
      setVer((v) => v + 1);
      save();
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

  const answerJoin = (v: "yes" | "no" | "skip") => {
    const k = S.k;
    const d = k === null ? null : chunks.current[k];
    const j = k === null ? null : questions(ctx, k)[S.qi];
    const laterPiece = d && j ? d.pieces[j.b] : null;
    if (k !== null && laterPiece && v !== "skip") {
      const frame = decisionFrame(k, laterPiece.t0);
      if (v === "yes") {
        writeDecisionLabel({ kind: "confirm", frame, rightTrackId: laterPiece.id });
      } else {
        writeDecisionLabel({ kind: "lost", frame, wrongTrackId: laterPiece.id });
      }
    }
    act(() => {
      if (!j || k === null) return;
      if (v === "no") Y(ctx, k).out.push(j.b);
      else S.qi++;
    });
  };

  useLayoutEffect(() => {
    if (S.step !== "joins" || S.k === null || !chunks.current[S.k]) return;
    const next = nextIllustratedJoin(ctx, S.k, S.qi);
    if (next.skipped > 0) {
      act(() => {
        for (let i = 1; i < next.skipped; i++) tap();
        S.qi = next.index;
      });
    }
    // Keep the saved question index aligned: an unillustratable prompt is the
    // same as the claimant choosing "Can't tell".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ver, chunkVer]);

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
  const claimLabelForGroup = (group: Group): string | undefined => {
    const status = claimStatusForGroup(group.members, identities, identityId, claimName);
    if (!status.taken) return undefined;
    const names = status.owners.map((owner) => owner.name || copy.gallery.you);
    return copy.gallery.claimedBy(names.join(", "));
  };

  const needsChunk = ["kit", "shirt", "gallery", "review", "joins", "gaps", "next"].includes(S.step);
  let body: React.ReactNode = null;

  if (needsChunk && (S.k === null || !currentChunk)) {
    if (S.k !== null) void ensure(S.k).then(() => setVer((v) => v + 1));
    body = <p className="py-10 text-center text-sm text-muted-text">{S.step === "next" ? copy.common.loadingChunk : copy.common.loading}</p>;
  } else if (S.step === "intro") {
    body = (
      <IntroScreen
        ctx={ctx} copy={copy} eyebrow={eyebrow} mediaSlot={mediaSlot} markA={markA} saved={savedClaim}
        resetByAdmin={resetByAdmin} coveragePercent={coveragePercent}
        matches={matches} matchChoices={matchChoices} onMatchChoices={(choices) => {
          setMatchChoices(choices);
          S.matchChoices = choices;
        }}
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
            const claimCounts = claimCountsForGroups(gs, identities, identityId, claimName);
            const kitPictures = gs.slice(0, 3).flatMap((g) => {
              const picture = picturesForGroup(d, g, game.frameRate, 1)[0]?.picture;
              return picture ? [{ id: g.cid, picture }] : [];
            });
            return (
              <button key={kit.key} type="button" onClick={() => chooseKit(kit.key)}
                className="flex flex-col gap-2.5 rounded-2xl border border-line bg-surface p-3 text-start hover:border-floodlight">
                {kitPictures.length > 0 && (
                  <div className="flex h-24 gap-1 overflow-hidden">
                    {kitPictures.map(({ id, picture }) => (
                      <CropWithNote key={id} d={d} picture={picture} h={96} nearbyLabel={copy.media.nearbyPicture} />
                    ))}
                  </div>
                )}
                <div>
                  <strong className="font-display text-lg text-text">
                    <span className="me-2 inline-block h-3 w-3 rounded-full align-[-1px] ring-1 ring-white/25" style={{ background: kit.swatch }} />
                    {copy.kit.names[kit.key] ?? copy.kit.names[kitNameKey(kit.swatch)] ?? kit.key}
                  </strong>
                  <div className="text-xs text-muted-text">
                    {copy.kit.people(gs.length)} · {copy.kit.claimCounts(claimCounts.free, claimCounts.taken)}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <Row><Btn size="sm" onClick={() => chooseKit(null)}>{copy.kit.everyone}</Btn></Row>
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
  } else if (S.step === "shirt" && currentChunk) {
    const d = currentChunk;
    const kitLabel = S.team ? copy.kit.names[S.team] ?? S.team : "";
    const options = shirtNumbersForKit(d.groups, d.jersey, S.team);
    const candidate = S.shirtCandidate;
    const matches = candidate?.kitKey === S.team
      ? groupsForShirtIdentity(d.groups, d.jersey, candidate)
      : [];
    body = (
      <div className="flex flex-col gap-4">
        <Eyebrow>{span(d.k)}</Eyebrow>
        <Title>
          {candidate
            ? copy.shirtNumber.confirmTitle(candidate.number, kitLabel)
            : copy.shirtNumber.title}
        </Title>
        <Lede>
          {candidate
            ? copy.shirtNumber.confirmLead
            : options.length
              ? copy.shirtNumber.lead(kitLabel)
              : copy.shirtNumber.noNumbers}
        </Lede>
        {!candidate && options.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            {options.map((option) => (
              <button
                key={`${option.kitKey}:${option.number}`}
                type="button"
                onClick={() => chooseShirtNumber(option.number)}
                className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-2xl border border-line bg-surface px-3 py-4 text-center hover:border-floodlight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-floodlight"
              >
                <span dir="ltr" className="font-display text-4xl font-bold tabular-nums text-text">{option.number}</span>
                <span className="text-xs text-muted-text">{copy.shirtNumber.coverage(mmss(option.coverageSeconds))}</span>
              </button>
            ))}
          </div>
        )}
        {candidate && matches.length > 0 && (
          <div className="flex flex-col gap-3">
            {matches.map((match) => {
              const group = d.byCid[match.groupId];
              if (!group) return null;
              return (
                <div key={match.groupId} className="flex flex-col gap-2">
                  {match.uncertain && (
                    <p role="note" className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-text">
                      {copy.shirtNumber.hardToRead}
                    </p>
                  )}
                  <GroupCard
                    d={d}
                    g={group}
                    copy={copy}
                    game={game}
                    claimLabel={claimLabelForGroup(group)}
                    onWatch={() => previewGroup(d, group)}
                    action={
                      <Btn kind="primary" size="sm" onClick={() => confirmShirtGroup(group.cid)}>
                        {copy.shirtNumber.confirmAction}
                      </Btn>
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
        {candidate && matches.length === 0 && (
          <p role="status" className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-muted-text">
            {copy.shirtNumber.noMatch}
          </p>
        )}
        {candidate ? (
          <Row>
            <Btn onClick={chooseAnotherShirtNumber}>{copy.shirtNumber.pickAnother}</Btn>
            <Btn onClick={continueWithoutShirtNumber}>{copy.shirtNumber.skip}</Btn>
          </Row>
        ) : (
          <Row>
            <Btn onClick={backToKitFromShirt}>{copy.shirtNumber.backToKit}</Btn>
            <Btn kind="primary" onClick={continueWithoutShirtNumber}>{copy.shirtNumber.skip}</Btn>
          </Row>
        )}
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
            <GroupCard key={g.cid} d={d} g={g} copy={copy} game={game} claimLabel={claimLabelForGroup(g)} onWatch={() => previewGroup(d, g)}
              action={<Btn kind="primary" size="sm" onClick={() => pickGroup(g.cid)}>{copy.gallery.thatsMe}</Btn>} />
          ))}
        </div>
        <Row><Btn onClick={() => go("kit")}>{copy.gallery.changeKit}</Btn></Row>
      </div>
    );
  } else if (S.step === "review" && currentChunk && S.k !== null) {
    body = <ReviewScreen ctx={ctx} d={currentChunk} copy={copy} mediaSlot={mediaSlot} span={span(S.k)} disp={disp}
      act={act} go={go} show={show} media={media} previewGroup={previewGroup}
      writeGroupDecision={writeGroupDecision} writeRejectedGroup={writeRejectedGroup}
      writeRejectedTrack={writeRejectedTrack} />;
  } else if (S.step === "joins" && currentChunk && S.k !== null) {
    const next = nextIllustratedJoin(ctx, S.k, S.qi);
    const j = next.junction;
    const prompt = next.prompt;
    if (next.skipped > 0 || !j || !prompt || prompt.kind === "skip") {
      body = null;
    } else {
      const d = currentChunk;
      const A = d.pieces[j.a];
      const B = d.pieces[j.b];
      body = (
        <div className="flex flex-col gap-4">
          <Eyebrow>{copy.joins.eyebrow(S.qi + 1, questions(ctx, S.k).length)}</Eyebrow>
          <Title>{copy.joins.title}</Title>
          <Lede>{copy.joins.lead}</Lede>
          <div className="flex items-center justify-center gap-3">
            <Tile d={d} photo={prompt.before} nearbyLabel={copy.media.nearbyPicture} label={copy.joins.before(disp(L2G(game, d.k, A.t1)))} />
            <div className="text-center text-xs text-muted-text">{copy.joins.later(j.gap < 1 ? copy.joins.moments : mmss(j.gap), Math.round(j.dm))}</div>
            <Tile d={d} photo={prompt.after} nearbyLabel={copy.media.nearbyPicture} label={copy.joins.after(disp(L2G(game, d.k, B.t0)))} />
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
    body = (
      <div className="flex flex-col gap-4">
        {!switchPrompt ? (
          <Row><Btn onClick={() => beginSwitch()}>{copy.next.switchTeam}</Btn></Row>
        ) : (
          <Section title={copy.next.switchTitle}>
            {!pendingSwitchKind ? <Row>
              <Btn kind="primary" onClick={() => chooseSwitch("new-new")}>{copy.next.newTeamNewShirt}</Btn>
              <Btn onClick={() => chooseSwitch("same-new")}>{copy.next.sameTeamNewShirt}</Btn>
              <Btn onClick={() => chooseSwitch("new-same")}>{copy.next.newTeamSameShirt}</Btn>
            </Row> : (() => {
              const covered = coveredSwitchMatches();
              const selected = covered.find((m) => m.code === switchMatchCode) ?? covered[0];
              const sides = (selected?.teamCount ?? 2) === 3 ? ["A", "B", "C"] : ["A", "B"];
              return <Row>
                {covered.length > 1 && <select value={switchMatchCode ?? selected?.code ?? ""} onChange={(e) => setSwitchMatchCode(e.target.value)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-text">
                  {covered.map((m) => <option key={m.code} value={m.code}>{m.title}</option>)}
                </select>}
                <select value={switchSide ?? ""} onChange={(e) => setSwitchSide(e.target.value as "A" | "B" | "C")} className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-text">
                  {sides.map((side) => <option key={side} value={side}>{side}</option>)}
                </select>
                <Btn kind="primary" onClick={() => commitSwitch(pendingSwitchKind, switchMatchCode ?? selected?.code ?? null, switchSide)}>{copy.next.confirmSwitch}</Btn>
              </Row>;
            })()}
            <Row><Btn onClick={() => beginSwitch(true)}>Use current video time</Btn></Row>
          </Section>
        )}
        <GapsScreen ctx={ctx} d={currentChunk} copy={copy} mediaSlot={mediaSlot} span={span(S.k)} disp={disp}
          act={act} pickSet={pickSet} setPickSet={setPickSet} writeConfirmedTrack={writeConfirmedTrack} />
      </div>
    );
  } else if (S.step === "next" && currentChunk && S.k !== null) {
    const d = currentChunk;
    const r = rankNext(ctx, d.k, chunkMeta(ctx, d.k).start);
    const sure = isSure(r);
    const fastClaimLabel = r[0] ? claimLabelForGroup(r[0].g) : undefined;
    body = (
      <div className="flex flex-col gap-4">
        <Eyebrow>{copy.next.eyebrow(span(d.k))}</Eyebrow>
        <Title>{copy.next.title}</Title>
        <Lede>{copy.next.lead}</Lede>
        {!switchPrompt ? (
          <Row>
            <Btn onClick={() => beginSwitch()}>{copy.next.switchTeam}</Btn>
          </Row>
        ) : (
          <Section title={copy.next.switchTitle}>
            {!pendingSwitchKind ? <Row>
              <Btn kind="primary" onClick={() => chooseSwitch("new-new")}>{copy.next.newTeamNewShirt}</Btn>
              <Btn onClick={() => chooseSwitch("same-new")}>{copy.next.sameTeamNewShirt}</Btn>
              <Btn onClick={() => chooseSwitch("new-same")}>{copy.next.newTeamSameShirt}</Btn>
            </Row> : (() => {
              const covered = coveredSwitchMatches();
              const selected = covered.find((m) => m.code === switchMatchCode) ?? covered[0];
              const sides = (selected?.teamCount ?? 2) === 3 ? ["A", "B", "C"] : ["A", "B"];
              return <Row>
                {covered.length > 1 && <select value={switchMatchCode ?? selected?.code ?? ""} onChange={(e) => setSwitchMatchCode(e.target.value)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-text">
                  {covered.map((m) => <option key={m.code} value={m.code}>{m.title}</option>)}
                </select>}
                <select value={switchSide ?? ""} onChange={(e) => setSwitchSide(e.target.value as "A" | "B" | "C")} className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-text">
                  {sides.map((side) => <option key={side} value={side}>{side}</option>)}
                </select>
                <Btn kind="primary" onClick={() => commitSwitch(pendingSwitchKind, switchMatchCode ?? selected?.code ?? null, switchSide)}>{copy.next.confirmSwitch}</Btn>
              </Row>;
            })()}
            <Row><Btn onClick={() => beginSwitch(true)}>Use current video time</Btn></Row>
          </Section>
        )}
        {mediaSlot}
        <GameTimeline ctx={ctx} ph={chunkMeta(ctx, d.k).start} />
        {sure && r[0] && (
          <>
            <Row><Btn kind="primary" onClick={() => pickGroup(r[0].g.cid)}>{copy.next.fast}</Btn></Row>
            <p className="-mt-2 text-xs text-muted-text">
              {copy.next.fastNote}{fastClaimLabel ? ` · ${fastClaimLabel}` : ""}
            </p>
          </>
        )}
        <div className="flex flex-col gap-3">
          {r.map(({ g }) => (
            <GroupCard key={g.cid} d={d} g={g} copy={copy} game={game} claimLabel={claimLabelForGroup(g)} onWatch={() => previewGroup(d, g)}
              action={<Btn kind={sure ? "ghost" : "primary"} size="sm" onClick={() => pickGroup(g.cid)}>{copy.gallery.thatsMe}</Btn>} />
          ))}
        </div>
        <Row>
          <Btn onClick={() => {
            pendingNextGuess.current = r[0]?.g.cid ?? null;
            act(() => { S.step = "gallery"; });
          }}>{copy.next.showAll}</Btn>
          <Btn onClick={() => act(() => { Y(ctx, d.k).skipped = true; void advance(); })}>{copy.next.notPlay}</Btn>
        </Row>
      </div>
    );
  } else if (S.step === "done") {
    body = <DoneScreen ctx={ctx} copy={copy} elapsed={elapsed}
      onStats={() => go("stats")}
      onExport={() => exportClaim(S, recordingId)}
      continuation={continuation && (!matchChoices.length || matchChoices.includes(continuation.matchCode)) ? continuation : null}
      onContinue={() => continuation && (!matchChoices.length || matchChoices.includes(continuation.matchCode)) && setLocation(`/find/${continuation.recordingId}?match=${encodeURIComponent(continuation.matchCode)}&kit=${encodeURIComponent(S.shirtIdentity?.kitKey ?? S.team ?? "")}&number=${encodeURIComponent(S.shirtIdentity?.number ?? "")}`)}
      onAgain={async () => {
        if (!window.confirm(copy.done.againConfirm)) return;
        try { await fetch(`${basePath}/api/recordings/${recordingId}/claim-match/game`, { method: "DELETE", credentials: "include" }); } catch { /* ignore */ }
        setSavedClaim(null);
        pendingClaimName.current = null;
        setPendingNamePick(null);
        void queryClient.invalidateQueries({ queryKey: getGetClaimMatchQueryKey(recordingId) });
        void queryClient.invalidateQueries({ queryKey: getGetClaimChainQueryKey(recordingId) });
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
      {labelError && <p role="status" className="rounded-xl border border-line bg-surface px-3 py-2 text-xs text-muted-text">{copy.common.labelFailed}</p>}
      {body}
      {pendingNamePick && (
        <ClaimantNameDialog
          defaultName={claimName || accountName}
          saving={false}
          onCancel={() => setPendingNamePick(null)}
          onConfirm={confirmClaimName}
        />
      )}
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

function picturesForGroup(d: LoadedChunk, group: Group, frameRate: number, count: number) {
  const pictures = group.members.flatMap((id) => {
    const piece = d.pieces[id];
    if (!piece) return [];
    const picture = pictureForPiece(d, piece, (piece.t0 + piece.t1) / 2, frameRate);
    return picture ? [{ id: piece.id, picture }] : [];
  });
  return spread(pictures, count);
}

function exportClaim(S: ClaimState, recordingId: number) {
  const blob = new Blob([JSON.stringify(S)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `my-claim-${recordingId}.json`;
  a.click();
}

function CropWithNote({ d, picture, h, nearbyLabel }: {
  d: LoadedChunk; picture: PiecePicture | null; h: number; nearbyLabel: string;
}) {
  if (!picture || !d.crops[picture.key]) return null;
  return (
    <div className="relative inline-flex w-fit shrink-0">
      <Crop chunk={d} keyName={picture.key} h={h} />
      {picture.nearby && (
        <span role="note" className="absolute bottom-1 start-1 rounded bg-black/80 px-1.5 py-0.5 text-[9px] leading-tight text-white shadow">
          {nearbyLabel}
        </span>
      )}
    </div>
  );
}

function Tile({ d, photo, nearbyLabel, label, children, onClick, out, pickOn }: {
  d: LoadedChunk; photo: PiecePicture | null; nearbyLabel: string; label: string; children?: React.ReactNode;
  onClick?: () => void; out?: boolean; pickOn?: boolean;
}) {
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      className={`relative flex flex-col items-center gap-1 rounded-xl border bg-surface p-1 ${out ? "border-[#FF5A3C]" : pickOn ? "border-floodlight" : "border-line"} ${onClick ? "cursor-pointer" : ""}`}
    >
      <div className={out ? "opacity-25" : ""}>
        <CropWithNote d={d} picture={photo} h={108} nearbyLabel={nearbyLabel} />
      </div>
      <span dir="ltr" className="text-[11px] tabular-nums text-muted-text">{label}</span>
      {children}
    </div>
  );
}

function GroupCard({ d, g, copy, game, onWatch, action, claimLabel }: {
  d: LoadedChunk; g: Group; copy: GameStrings; game: Game; onWatch: () => void; action: React.ReactNode; claimLabel?: string;
}) {
  const ms = g.members.map((m) => d.pieces[m]).filter(Boolean);
  const photos = picturesForGroup(d, g, game.frameRate, 6);
  const t0 = Math.min(...ms.map((m) => m.t0));
  const t1 = Math.max(...ms.map((m) => m.t1));
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-line bg-surface p-3">
      {photos.length > 0 && (
        <div className="flex gap-1 overflow-x-auto">
          {photos.map(({ id, picture }) => (
            <CropWithNote key={id} d={d} picture={picture} h={104} nearbyLabel={copy.media.nearbyPicture} />
          ))}
        </div>
      )}
      {claimLabel && <p role="note" className="text-xs font-medium text-muted-text">{claimLabel}</p>}
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

 function IntroScreen({ ctx, copy, eyebrow, mediaSlot, markA, saved, resetByAdmin, coveragePercent, matches, matchChoices, onMatchChoices, onMarkA, onMarkB, onDel, onWatch, onStart, onResume }: {
  ctx: Ctx; copy: GameStrings; eyebrow: string; mediaSlot: React.ReactNode; markA: number | null; saved: (ClaimState & { saved?: number }) | null;
  resetByAdmin: boolean; coveragePercent: number; matches: ClaimMatch[]; matchChoices: string[]; onMatchChoices: (choices: string[]) => void;
  onMarkA: () => void; onMarkB: () => void; onDel: (i: number) => void; onWatch: (i: number) => void; onStart: () => void; onResume: () => void;
}) {
  const off = ctx.S.off;
  const mo = ctx.game.matchOffset;
  return (
    <div className="flex flex-col gap-4">
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <Title big>{copy.intro.title}</Title>
      <Lede>{copy.intro.lead}</Lede>
      {matches.length >= 2 && (
        <Section title={copy.intro.matchesTitle}>
          <Lede>{copy.intro.matchesLead}</Lede>
          <div className="flex flex-col gap-2">
            {matches.map((match) => {
              const checked = matchChoices.includes(match.code);
              return (
                <label key={match.code} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2 text-sm">
                  <input type="checkbox" checked={checked}
                    onChange={() => onMatchChoices(checked ? matchChoices.filter((x) => x !== match.code) : [...matchChoices, match.code])} />
                  <span className="flex-1"><b className="text-text">{match.title}</b><br /><span className="text-xs text-muted-text">{match.fieldName}</span></span>
                  {match.rostered && <span className="text-xs text-floodlight">{copy.intro.rostered}</span>}
                </label>
              );
            })}
          </div>
        </Section>
      )}
      {resetByAdmin && (
        <div role="status" className="rounded-2xl border border-line bg-surface p-3">
          <strong className="font-display text-sm text-text">{copy.intro.resetTitle}</strong>
          <p className="mt-1 text-sm leading-6 text-muted-text">{copy.intro.resetBody}</p>
        </div>
      )}
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
            <div className="mt-1">{copy.intro.resumeDesc(Math.max(0, Math.min(100, Math.round(coveragePercent))))}</div>
          </div>
          <Btn kind="primary" onClick={onResume}>{saved.step === "done" || saved.step === "stats" ? copy.intro.seeStats : copy.intro.resume}</Btn>
        </div>
      )}
      <Row><Btn kind={saved ? "ghost" : "primary"} onClick={onStart}>{saved ? copy.intro.startNew : copy.intro.start}</Btn></Row>
    </div>
  );
}

/* ----------------------------------------------------------------- review */

function ReviewScreen({
  ctx, d, copy, mediaSlot, span, disp, act, go, show, media, previewGroup,
  writeGroupDecision, writeRejectedGroup, writeRejectedTrack,
}: {
  ctx: Ctx; d: LoadedChunk; copy: GameStrings; mediaSlot: React.ReactNode; span: string; disp: (t: number) => string;
  act: (fn: () => void, counts?: boolean) => void; go: (s: Step) => void; show: (v: MediaView) => void;
  media: React.RefObject<MediaHandle | null>; previewGroup: (d: LoadedChunk, g: Group) => void;
  writeGroupDecision: (d: LoadedChunk, g: Group, rejected?: Group) => void;
  writeRejectedGroup: (d: LoadedChunk, g: Group) => void;
  writeRejectedTrack: (k: number, trackId: string | null | undefined, localSeconds: number) => void;
}) {
  const S = ctx.S;
  const k = d.k;
  const y = Y(ctx, k);
  const ms = mine(ctx, k);
  const g = y.cid ? d.byCid[y.cid] : null;
  const bs = benchSpans(ctx, k);
  const tw = twins(ctx, k, chunkMeta(ctx, k).start);
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
        {ms.map((m) => {
          const photo = pictureForPiece(d, m, (m.t0 + m.t1) / 2, G.frameRate);
          if (!photo) return null;
          return (
            <Tile key={m.id} d={d} photo={photo} nearbyLabel={copy.media.nearbyPicture} out={y.out.includes(m.id)}
              label={`${disp(L2G(G, k, m.t0))}–${disp(L2G(G, k, m.t1))}`}
              onClick={() => {
                const i = y.out.indexOf(m.id);
                if (i < 0) writeRejectedTrack(k, m.manual ? m.src : m.id, (m.t0 + m.t1) / 2);
                act(() => { if (i >= 0) y.out.splice(i, 1); else y.out.push(m.id); });
              }}>
              <button type="button" aria-label={copy.media.play} onClick={(e) => { e.stopPropagation(); watchPiece(m.id); }}
                className="absolute bottom-7 end-2 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-[10px] text-white">▶</button>
            </Tile>
          );
        })}
      </div>
      {bs.length > 0 && (
        <Section title={copy.review.offPitchTitle}>
          <Lede>{copy.review.offPitchLead(bs.map(([a, b]) => `\u2066${disp(a)}–${disp(b)}\u2069`).join(", "))}</Lede>
          <Row><Btn kind="primary" size="sm" onClick={() => act(() => { bs.forEach(([a, b]) => S.off.push([a, b, "bench"])); S.off.sort((x, z) => x[0] - z[0]); })}>{copy.review.benchYes}</Btn></Row>
        </Section>
      )}
      {tw.length > 0 && (
        <Section title={copy.review.alsoYouTitle}>
          <Lede>{weakColour(ctx, chunkMeta(ctx, k).start) ? copy.review.alsoYouLeadDark : copy.review.alsoYouLead}</Lede>
          <div className="flex flex-col gap-3">
            {tw.slice(0, 3).map(({ g: gg }) => (
              <GroupCard key={gg.cid} d={d} g={gg} copy={copy} game={G} onWatch={() => previewGroup(d, gg)}
                action={<Btn kind="primary" size="sm" onClick={() => {
                  writeGroupDecision(d, gg);
                  act(() => { y.added.push(gg.cid); });
                }}>{copy.review.alsoMe}</Btn>} />
            ))}
          </div>
          {tw.length > 1 && <Row><Btn size="sm" onClick={() => {
            for (const candidate of tw) writeGroupDecision(d, candidate.g);
            act(() => { tw.forEach((x) => { if (!y.added.includes(x.g.cid)) y.added.push(x.g.cid); }); });
          }}>{copy.review.allOfThese}</Btn></Row>}
        </Section>
      )}
      {nb.length > 0 && (
        <Section title={copy.review.mightTitle}>
          <div className="flex flex-col gap-3">
            {nb.slice(0, 3).map(([, c]) => (
              <GroupCard key={c} d={d} g={d.byCid[c]} copy={copy} game={G} onWatch={() => previewGroup(d, d.byCid[c])}
                action={<Btn size="sm" onClick={() => {
                  const candidate = d.byCid[c];
                  if (candidate) writeGroupDecision(d, candidate);
                  act(() => { y.added.push(c); });
                }}>{copy.review.alsoMe}</Btn>} />
            ))}
          </div>
        </Section>
      )}
      <Row>
        <Btn kind="primary" onClick={() => {
          if (g) writeGroupDecision(d, g);
          act(() => { S.qi = 0; S.step = "joins"; });
        }}>{copy.review.looksRight}</Btn>
        <Btn onClick={() => {
          if (g) writeRejectedGroup(d, g);
          go(S.oi ? "next" : "gallery");
        }}>{copy.review.notMe}</Btn>
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

function GapsScreen({ ctx, d, copy, mediaSlot, span, disp, act, pickSet, setPickSet, writeConfirmedTrack }: {
  ctx: Ctx; d: LoadedChunk; copy: GameStrings; mediaSlot: React.ReactNode; span: string; disp: (t: number) => string;
  act: (fn: () => void, counts?: boolean) => void; pickSet: Set<string>; setPickSet: (s: Set<string>) => void;
  writeConfirmedTrack: (k: number, trackId: string | null | undefined, localSeconds: number) => void;
}) {
  const S = ctx.S;
  const k = d.k;
  const G = ctx.game;
  const h = nextHole(ctx, k);
  if (!h) return null;
  const bg = benchInHole(ctx, k, h);
  const c = candidates(ctx, k, h, L2G(G, k, h.t0));
  const prefilledBench = h && ctx.S.off.find((r) => r[2] === "bench" &&
    r[0] < L2G(G, k, h.t1) && r[1] > L2G(G, k, h.t0));
  const ref = [h.a, h.b].filter((p): p is NonNullable<Hole["a"]> => Boolean(p));
  const refPictures = ref.flatMap((piece) => {
    const at = piece === h.a ? piece.t1 : piece.t0;
    const photo = pictureForPiece(d, piece, at, G.frameRate);
    return photo ? [{ piece, photo }] : [];
  });
  const candidatePictures = c.flatMap((piece) => {
    const photo = pictureForPiece(d, piece, (piece.t0 + piece.t1) / 2, G.frameRate);
    return photo ? [{ piece, photo }] : [];
  });
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
      {refPictures.length > 0 && (
        <Row>
          {refPictures.map(({ piece, photo }) => (
            <Tile key={piece.id} d={d} photo={photo} nearbyLabel={copy.media.nearbyPicture}
              label={piece === h.a ? copy.gaps.youBefore : copy.gaps.youAfter} />
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
      {prefilledBench && (
        <Section title={copy.gaps.benchTitle}>
          <Lede>{copy.gaps.benchLead(disp(prefilledBench[0]), disp(prefilledBench[1]))}</Lede>
          <Row>
            <Btn kind="primary" onClick={() => act(() => { const i = ctx.S.off.indexOf(prefilledBench); if (i >= 0) ctx.S.off.splice(i, 1); })}>{copy.gaps.undoBench}</Btn>
          </Row>
        </Section>
      )}
      {candidatePictures.length > 0 && (
        <>
          <h3 className="font-display text-lg font-bold text-text">{copy.gaps.orOne}</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
            {candidatePictures.map(({ piece, photo }) => (
              <Tile key={piece.id} d={d} photo={photo} nearbyLabel={copy.media.nearbyPicture}
                pickOn={pickSet.has(piece.id)} label={`${disp(L2G(G, k, piece.t0))}–${disp(L2G(G, k, piece.t1))}`}
                onClick={() => { const n = new Set(pickSet); if (n.has(piece.id)) n.delete(piece.id); else n.add(piece.id); setPickSet(n); }} />
            ))}
          </div>
          <Row><Btn kind="primary" disabled={!pickSet.size} onClick={() => {
            for (const candidate of c) {
              if (!pickSet.has(candidate.id)) continue;
              const from = Math.max(h.t0, candidate.t0);
              const to = Math.min(h.t1, candidate.t1);
              if (to > from) writeConfirmedTrack(k, candidate.id, (from + to) / 2);
            }
            act(() => { pickSet.forEach((id) => { if (!y.extra.includes(id)) y.extra.push(id); }); setPickSet(new Set()); });
          }}>{copy.gaps.addPicked}</Btn></Row>
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

function DoneScreen({ ctx, copy, elapsed, onStats, onExport, onAgain, continuation, onContinue }: {
  ctx: Ctx; copy: GameStrings; elapsed: number; onStats: () => void; onExport: () => void; onAgain: () => void;
  continuation: ServerGame["continuation"]; onContinue: () => void;
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
        {continuation && <Btn onClick={onContinue}>{copy.done.keepGoing}</Btn>}
        <Btn onClick={onExport}>{copy.done.download}</Btn>
        <Btn onClick={onAgain}>{copy.done.again}</Btn>
      </Row>
    </div>
  );
}
