/**
 * Claim Your Match, rebuilt as a chain.
 *
 * The flow the person actually does:
 *
 *     seek anywhere -> tap yourself -> name yourself -> play forward
 *       -> we stop where we are no longer sure -> answer -> repeat
 *
 * WHY THE OLD MODEL IS GONE
 *
 * The anchor model asked eight sampled questions at fixed intervals, voted on
 * the answers, and resolved a person from the winner. It asks where nothing is
 * happening, never asks where the tracker actually failed, and its coverage
 * could be inflated by one lucky tap or collapsed to zero by a tie. Worse, the
 * questions and the identity board were separate objects that had to be kept
 * in agreement, and were not: the board's deletions were read by nothing.
 *
 * Here the claim IS an identity row on the board, and there is only one map.
 * Naming yourself names you on the board; a merge in the video is a merge on
 * the board; frames you take leave whoever held them. Not synchronised --
 * singular.
 *
 * WHERE THE LOGIC LIVES
 *
 * The interrupt rule is the part that has to be right, so it is computed
 * server-side from geometry (api-server/src/lib/claimChain.ts) and honoured
 * here by pure functions in lib/claim-chain-flow.ts. This file is wiring:
 * video, taps, and a panel. Anything with a decision in it belongs in one of
 * those two modules where it can be tested without a video.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import {
  getGetClaimMatchQueryKey,
  useGetClaimChain,
  useGetClaimMatch,
  useTapClaimChain,
  useRejectClaimChainFrom,
  useConfirmClaimChainAt,
  useUndoClaimChainLast,
  getGetClaimChainQueryKey,
  type ClaimChain,
  type TrackingSegment,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Crosshair, FastForward, Undo2, UserX } from "lucide-react";

import { ClaimStage, type StageCandidate } from "@/components/ClaimStage";
import { useAuth } from "@/lib/auth";
import { segmentAsBundle } from "@/lib/claim-match-bundle";
import {
  findHitTracks,
  formatClaimTime,
  trackingSecondsToFrame,
  type ClaimBundle,
} from "@/lib/claim-match-engine";
import { segmentIndexAtTime, retainNearbySegments } from "@/lib/claim-match-segments";
import {
  approachSeconds,
  candidatesAtFrame,
  canConfirmAtStop,
  chainSpans,
  questionFor,
  reachedStop,
  resumeSecondsAfter,
  rewindSecondsAfterUndo,
  stageFor,
  stopSeconds,
} from "@/lib/claim-chain-flow";

/**
 * How long a decision took, measured from when the question appeared.
 *
 * Free difficulty weighting for the training corpus: the human picks already
 * on vps1 range from under a second to fourteen, and the slow ones are the
 * hard cases. It is also the only honest measure of whether this tool is
 * getting faster to use than the thing it replaced.
 */
function useDecisionClock() {
  const startedAt = useRef<number>(Date.now());
  const restart = useCallback(() => { startedAt.current = Date.now(); }, []);
  const elapsed = useCallback(() => Math.max(0, Date.now() - startedAt.current), []);
  return { restart, elapsed };
}

export default function ClaimChainPage() {
  const params = useParams<{ id?: string }>();
  const [, setLocation] = useLocation();
  const { user, isLoading: authLoading, isGuest } = useAuth();
  const recordingId = Number(params.id);
  const queryClient = useQueryClient();
  const chainQueryKey = useMemo(() => getGetClaimChainQueryKey(recordingId), [recordingId]);

  const matchQueryKey = useMemo(() => getGetClaimMatchQueryKey(recordingId), [recordingId]);
  const enabled = Number.isInteger(recordingId) && recordingId > 0;
  const claimQuery = useGetClaimMatch(recordingId, {
    query: { enabled, queryKey: matchQueryKey },
  });
  const chainQuery = useGetClaimChain(recordingId, {
    query: { enabled, queryKey: chainQueryKey },
  });

  const manifest = claimQuery.data?.manifest;
  const recording = claimQuery.data?.recording;
  const chain = chainQuery.data ?? null;

  /* ---------------- video clock ---------------- */

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [slow, setSlow] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const seekIdRef = useRef(0);
  const pendingSeekRef = useRef<number | null>(null);
  const [seekRequest, setSeekRequest] = useState<{ id: number; videoTime: number } | null>(null);
  const [notice, setNotice] = useState("");

  /* ---------------- tracking segments ---------------- */

  const [segmentCache, setSegmentCache] = useState<Record<number, TrackingSegment>>({});
  const segmentCacheRef = useRef(segmentCache);
  const segmentRequestsRef = useRef<Record<number, Promise<void>>>({});
  const [segmentLoading, setSegmentLoading] = useState(false);
  const [segmentError, setSegmentError] = useState("");

  const currentSegmentIndex = useMemo(
    () => (manifest ? segmentIndexAtTime(manifest, currentTime) : 0),
    [manifest, currentTime],
  );
  const activeSegment = segmentCache[currentSegmentIndex] ?? null;

  const loadSegment = useCallback((index: number): Promise<void> => {
    if (!manifest || !recordingId || segmentCacheRef.current[index]) return Promise.resolve();
    const existing = segmentRequestsRef.current[index];
    if (existing) return existing;
    const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
    const request = fetch(
      `${basePath}/api/recordings/${recordingId}/claim-match/segments/${index}`,
      { credentials: "include", headers: { Accept: "application/json" } },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`Segment ${index} failed: ${response.status}`);
        const segment = await response.json() as TrackingSegment;
        segmentCacheRef.current = { ...segmentCacheRef.current, [index]: segment };
        setSegmentCache(segmentCacheRef.current);
      })
      .finally(() => { delete segmentRequestsRef.current[index]; });
    segmentRequestsRef.current[index] = request;
    return request;
  }, [manifest, recordingId]);

  useEffect(() => {
    if (!manifest || !recordingId) return;
    let cancelled = false;
    setSegmentLoading(!segmentCacheRef.current[currentSegmentIndex]);
    setSegmentError("");
    void loadSegment(currentSegmentIndex)
      .then(() => {
        if (cancelled) return;
        setSegmentLoading(false);
        const retained = retainNearbySegments(segmentCacheRef.current, currentSegmentIndex);
        segmentCacheRef.current = retained;
        setSegmentCache(retained);
        // Neighbours make boundary seeking smooth but must never block the
        // current segment or turn a background failure into a stuck skeleton.
        for (const index of [currentSegmentIndex - 1, currentSegmentIndex + 1]) {
          if (manifest.segments.some((segment) => segment.index === index)) {
            void loadSegment(index).catch(() => undefined);
          }
        }
      })
      .catch(() => {
        if (cancelled) return;
        setSegmentLoading(false);
        setSegmentError("The tracking for this part of the match could not be loaded.");
      });
    return () => { cancelled = true; };
  }, [manifest, recordingId, currentSegmentIndex, loadSegment]);

  /**
   * Source tracks, not merged people.
   *
   * A chain part names a source track id. Merging identities would re-key the
   * boxes to identity ids, so the claimant's very first tap would fold their
   * own tracks into their own identity and the second tap would be on a track
   * that no longer exists under that name.
   */
  const bundle: ClaimBundle | null = useMemo(
    () => (manifest && activeSegment
      ? segmentAsBundle(manifest, activeSegment, { mergeIdentities: false })
      : null),
    [manifest, activeSegment],
  );

  const currentFrame = bundle ? trackingSecondsToFrame(currentTime, bundle) : 0;

  /* ---------------- the flow ---------------- */

  const [answered, setAnswered] = useState(true);
  const [pendingName, setPendingName] = useState<{ trackId: string; frame: number } | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  /** Which candidate the number picker is pointing at, so its box lights up. */
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const stage = stageFor(chain, currentFrame, answered);
  const clock = useDecisionClock();

  const tap = useTapClaimChain();
  const reject = useRejectClaimChainFrom();
  const confirm = useConfirmClaimChainAt();
  const undo = useUndoClaimChainLast();
  const busy = tap.isPending || reject.isPending || confirm.isPending || undo.isPending;

  const applyChain = useCallback((next: ClaimChain) => {
    queryClient.setQueryData(chainQueryKey, next);
    setNotice(next.labelRecorded === false ? "Saved — but the training label could not be stored" : "");
  }, [chainQueryKey, queryClient]);

  /**
   * The only thing that moves the playhead. Tracking seconds in.
   *
   * Three parts, and leaving any of them out is why seeking did nothing:
   * the seek REQUEST alone only asks the player to catch up, so the media
   * element has to be moved directly as well, and a seek into a segment whose
   * tracking has not loaded has to be re-applied once it has. Without the
   * last one, seeking across a segment boundary lands nowhere at all.
   */
  const seekTracking = useCallback((seconds: number) => {
    if (!bundle) return;
    const clamped = Math.max(0, Math.min(bundle.duration, seconds));
    const videoTime = clamped + (bundle.videoStartSeconds || 0);
    pendingSeekRef.current = clamped;
    setCurrentTime(clamped);
    seekIdRef.current += 1;
    setSeekRequest({ id: seekIdRef.current, videoTime });
    if (videoRef.current && Number.isFinite(videoTime)) {
      // Move the real media now rather than waiting for the overlay. Waiting
      // makes the boxes jump while the picture stays where it was.
      videoRef.current.currentTime = videoTime;
    }
  }, [bundle]);

  // Re-apply a pending seek once the segment it lands in has actually loaded.
  useEffect(() => {
    const pending = pendingSeekRef.current;
    if (pending === null || !manifest || !activeSegment || !bundle) return;
    if (activeSegment.segmentIndex !== segmentIndexAtTime(manifest, pending)) return;
    const video = videoRef.current;
    if (!video) return;
    const videoTime = pending + (bundle.videoStartSeconds || 0);
    video.currentTime = videoTime;
    if (Math.abs(video.currentTime - videoTime) <= 0.5) pendingSeekRef.current = null;
  }, [activeSegment, bundle, manifest]);

  /**
   * Stop where the server said to, and nowhere else.
   *
   * Checked on every timeupdate rather than scheduled: timeupdate fires about
   * four times a second and a seek jumps outright, so anything waiting for an
   * exact moment sails past the question and attributes footage to the wrong
   * person before anyone is asked about it.
   */
  const handleTimeUpdate = useCallback((videoSeconds: number) => {
    if (!bundle) return;
    const tracking = Math.max(0, videoSeconds - (bundle.videoStartSeconds || 0));
    setCurrentTime(tracking);
    if (!chain || !answered) return;
    if (reachedStop(chain, tracking)) {
      setAnswered(false);
      setPlaying(false);
      videoRef.current?.pause();
      clock.restart();
    }
  }, [bundle, chain, answered, clock]);

  /**
   * Jump to the next check rather than playing the whole way to it.
   *
   * "Fast forward until he sees that he is lost" -- with checks minutes apart,
   * playing straight through means watching the match rather than claiming it.
   * We land a few seconds short so the moment arrives in context: dropped onto
   * the exact frame, a crossing is unreadable and the person is guessing.
   */
  const skipToNextCheck = useCallback((from: ClaimChain, currentSeconds: number) => {
    const target = approachSeconds(from, currentSeconds);
    if (target === null) return false;
    seekTracking(target);
    setPlaying(true);
    void videoRef.current?.play().catch(() => setPlaying(false));
    return true;
  }, [seekTracking]);

  const askAgainFrom = useCallback((chainAfter: ClaimChain, frame: number) => {
    setAnswered(true);
    const resume = resumeSecondsAfter(chainAfter, frame);
    // Past the answered frame first, so the question just answered cannot fire
    // again, then straight on to whatever is next.
    if (!skipToNextCheck(chainAfter, resume)) seekTracking(resume);
  }, [seekTracking, skipToNextCheck]);

  const submitTap = useCallback(async (trackId: string, frame: number, name?: string) => {
    if (!chain && !manifest) return;
    /*
     * What the human took frames away from -- which is the track the chain was
     * FOLLOWING at this frame, and nothing else.
     *
     * It used to prefer `nextUncertainty.trackId`, which is also set for a
     * track END. So an ordinary handoff -- the tracker stopped following you,
     * you found yourself again and tapped -- was recorded as
     * `kind: "switch", wrongTrackId: <the track that simply ran out>`,
     * teaching the model that track was the wrong person at a frame where
     * nothing was wrong. At a real swap the chain IS still following the old
     * track at the crossing, so this finds it and the switch label is
     * unchanged; at a track end nothing is being followed, so no rejection is
     * recorded and it lands as a plain confirm.
     */
    const rejectedTrackId = candidatesAtFrame(bundle!, chain, frame)
      .find((candidate) => candidate.mine)?.id ?? null;
    try {
      const next = await tap.mutateAsync({
        id: recordingId,
        data: {
          trackId,
          frame,
          rejectedTrackId: rejectedTrackId === trackId ? null : rejectedTrackId,
          name: name ?? null,
          decisionMs: clock.elapsed(),
          bundleFingerprint: chain?.bundleFingerprint ?? null,
        },
      });
      applyChain(next);
      askAgainFrom(next, frame);
    } catch (error) {
      setNotice(errorMessage(error, "That tap could not be saved."));
    }
  }, [applyChain, askAgainFrom, bundle, chain, clock, manifest, recordingId, tap]);

  /**
   * Claim a track as yourself at the current frame.
   *
   * Both ways in land here: tapping the picture, and picking the number drawn
   * on the box. On a laptop the boxes in a 3840-wide panorama are a few pixels
   * across and a mouse is not a finger, so the number is the usable target --
   * and it is already on screen, so choosing one is the same act, not a new
   * concept.
   */
  const claimTrack = useCallback((trackId: string) => {
    if (busy) return;
    // First tap of the whole claim: the person names themselves, and that name
    // is what the identity board shows. A row labelled by the person in it
    // beats one labelled by whoever was doing the linking.
    if (!chain?.chain.length) {
      setPendingName({ trackId, frame: currentFrame });
      setNameDraft(user?.name ?? "");
      return;
    }
    void submitTap(trackId, currentFrame);
  }, [busy, chain, currentFrame, submitTap, user?.name]);

  const onVideoTap = useCallback((x: number, y: number) => {
    if (!bundle || busy) return;
    const hit = findHitTracks(bundle, currentFrame, x, y)[0];
    if (!hit) {
      setNotice("No player there — or pick a number below.");
      return;
    }
    claimTrack(hit.track.id);
  }, [bundle, busy, claimTrack, currentFrame]);

  const onNotMe = useCallback(async () => {
    if (!chain) return;
    try {
      const next = await reject.mutateAsync({
        id: recordingId,
        data: {
          frame: currentFrame,
          decisionMs: clock.elapsed(),
          bundleFingerprint: chain.bundleFingerprint,
        },
      });
      applyChain(next);
      setAnswered(true);
      setPlaying(false);
      videoRef.current?.pause();
      setNotice("Given up from here — tap yourself again when you see yourself.");
    } catch (error) {
      setNotice(errorMessage(error, "That could not be saved."));
    }
  }, [applyChain, chain, clock, currentFrame, recordingId, reject]);

  const onStillMe = useCallback(async () => {
    if (!chain?.nextUncertainty) return;
    const frame = chain.nextUncertainty.frame;
    try {
      const next = await confirm.mutateAsync({
        id: recordingId,
        data: {
          frame,
          decisionMs: clock.elapsed(),
          bundleFingerprint: chain.bundleFingerprint,
        },
      });
      applyChain(next);
      askAgainFrom(next, frame);
      setPlaying(true);
    } catch (error) {
      setNotice(errorMessage(error, "That could not be saved."));
    }
  }, [applyChain, askAgainFrom, chain, clock, confirm, recordingId]);

  const onUndo = useCallback(async () => {
    try {
      const next = await undo.mutateAsync({ id: recordingId });
      applyChain(next);
      setAnswered(true);
      // An undo reopens the check the undone decision answered, and that check
      // is behind the playhead. Staying put would fire it on the next
      // timeupdate with no way to reach it -- see rewindSecondsAfterUndo.
      const target = rewindSecondsAfterUndo(next);
      if (target !== null) seekTracking(target);
      setPlaying(false);
      videoRef.current?.pause();
      setNotice("Last decision undone.");
    } catch (error) {
      setNotice(errorMessage(error, "That could not be undone."));
    }
  }, [applyChain, recordingId, seekTracking, undo]);

  /* ---------------- rendering ---------------- */

  const candidates: StageCandidate[] = useMemo(() => {
    if (!bundle) return [];
    return candidatesAtFrame(bundle, chain, currentFrame).map((candidate) => ({
      id: candidate.id,
      label: candidate.mine ? `${candidate.label} (you)` : candidate.suspect ? "Crossed you here" : candidate.label,
      box: candidate.box,
      overlap: candidate.suspect,
    }));
  }, [bundle, chain, currentFrame]);

  /**
   * Pick by the number drawn on the box.
   *
   * `candidates` is the very array ClaimStage numbers, so index n-1 IS the box
   * labelled n. That equality is the whole trick and it is why this recomputes
   * nothing: a second list, however carefully derived, would drift from the
   * one on screen the moment either changed.
   *
   * The numbers are positional -- left to right at this frame -- so they
   * reshuffle as players move. That is fine for the only two moments you pick
   * in (stopped at a check, or paused hunting for yourself) and it is why a
   * number is never stored anywhere: it is a target, not a name.
   */
  const claimNumber = useCallback((n: number) => {
    const candidate = candidates[n - 1];
    if (!candidate) {
      setNotice(`There is no player ${n} on screen right now.`);
      return;
    }
    claimTrack(candidate.id);
  }, [candidates, claimTrack]);

  /*
   * Type the number instead of hunting for the box.
   *
   * Two digits are supported because a busy frame runs past nine: after "1" we
   * wait, because 10, 11 and 12 may still be coming, but after "3" with twelve
   * on screen we fire at once because no longer number can exist. That keeps
   * the common case instant and the two-digit case possible without a modifier.
   */
  const digits = useRef<{ text: string; timer: number | null }>({ text: "", timer: null });
  useEffect(() => {
    const fire = () => {
      const n = Number(digits.current.text);
      digits.current = { text: "", timer: null };
      if (n > 0) claimNumber(n);
    };
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      // Never take a keystroke off the name box.
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (pendingName || busy || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!/^[0-9]$/.test(event.key)) return;
      event.preventDefault();
      if (digits.current.timer) window.clearTimeout(digits.current.timer);
      const text = digits.current.text + event.key;
      const n = Number(text);
      if (n === 0 || n > candidates.length) { digits.current = { text: "", timer: null }; return; }
      digits.current.text = text;
      if (n * 10 > candidates.length) fire();
      else digits.current.timer = window.setTimeout(fire, 600);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (digits.current.timer) window.clearTimeout(digits.current.timer);
    };
  }, [busy, candidates.length, claimNumber, pendingName]);

  const claimedSpans = useMemo(
    () => (chain
      ? chainSpans(chain.chain, chain.frameRate).map((span) => ({
        fromSeconds: span.fromSeconds,
        toSeconds: span.toSeconds,
      }))
      : []),
    [chain],
  );

  useEffect(() => {
    if (!authLoading && (!user || isGuest)) setLocation("/login");
  }, [authLoading, isGuest, setLocation, user]);

  if (claimQuery.isLoading || chainQuery.isLoading || !manifest || !recording || !bundle) {
    return (
      <main className="claim-page" data-testid="page-claim-chain-loading">
        <div className="claim-centered">
          <h1>Loading your match</h1>
          <p className="claim-muted">
            {segmentError || (segmentLoading ? "Fetching the tracking…" : "One moment.")}
          </p>
        </div>
      </main>
    );
  }

  const question = questionFor(chain);
  const stop = chain ? stopSeconds(chain) : null;

  const panel = (
    <>
      <div className="claim-coverage-summary" data-testid="claim-chain-coverage">
        <div>
          <span>Your match</span>
          <b>{Math.round(chain?.coveragePercent ?? 0)}%</b>
        </div>
        <small>
          {(chain?.coverageSeconds ?? 0).toFixed(1)} seconds claimed
          {chain?.name ? ` · you are “${chain.name}”` : ""}
        </small>
      </div>

      {chain && (chain.identityMap.people === 0 || !chain.identityMap.matchesBundle) && (
        <div className="claim-panel" data-testid="claim-chain-map-warning">
          <h2>You will be stopped a lot here</h2>
          <p className="claim-muted">
            {chain.identityMap.people === 0
              ? `Nobody has been linked on this recording yet — ${chain.identityMap.tracks} separate tracks across ${chain.identityMap.segments} segments, none joined into people. Every time the tracker drops you, we have to ask.`
              : `The identity map was built from different tracking, so all ${chain.identityMap.people} of its people are being ignored. It needs rebuilding against the current bundle.`}
          </p>
        </div>
      )}

      {stage === "identify" && (
        <div className="claim-panel" data-testid="claim-chain-identify">
          <h2>Find yourself</h2>
          <p className="claim-muted">
            Scrub to any moment where you can see yourself clearly, then tap yourself in the
            picture. You only have to do this once — we follow you from there.
          </p>
        </div>
      )}

      {stage === "following" && (
        <div className="claim-panel" data-testid="claim-chain-following">
          <h2>Following you</h2>
          <p className="claim-muted">
            {stop === null
              ? "Nothing left to check — you are claimed to the end of this stretch."
              : `Playing on. We will stop at ${formatClaimTime(stop)} to check.`}
          </p>
          {stop !== null && (
            <button
              type="button"
              className="claim-button claim-button-primary claim-button-wide"
              data-testid="button-chain-skip-to-check"
              disabled={busy}
              onClick={() => { if (chain) skipToNextCheck(chain, currentTime); }}
            >
              <FastForward size={16} /> Skip to the next check
            </button>
          )}
          <button
            type="button"
            className="claim-button claim-button-secondary claim-button-wide"
            data-testid="button-chain-not-me"
            disabled={busy}
            onClick={() => void onNotMe()}
          >
            <UserX size={16} /> That is not me from here
          </button>
        </div>
      )}

      {stage === "asking" && (
        <div className="claim-panel" data-testid="claim-chain-asking">
          <h2>Is this still you?</h2>
          <p className="claim-muted">{question}</p>
          {canConfirmAtStop(chain) && (
            <button
              type="button"
              className="claim-button claim-button-primary claim-button-wide"
              data-testid="button-chain-still-me"
              disabled={busy}
              onClick={() => void onStillMe()}
            >
              <Check size={16} /> Yes, still me
            </button>
          )}
          <button
            type="button"
            className="claim-button claim-button-secondary claim-button-wide"
            data-testid="button-chain-tap-again"
            disabled={busy}
            onClick={() => setNotice("Tap yourself in the picture.")}
          >
            <Crosshair size={16} /> Tap me in the picture
          </button>
          <button
            type="button"
            className="claim-button claim-button-secondary claim-button-wide"
            data-testid="button-chain-give-up"
            disabled={busy}
            onClick={() => void onNotMe()}
          >
            <UserX size={16} /> Stop here — I cannot see myself
          </button>
        </div>
      )}

      {(stage === "identify" || stage === "asking") && (
        <div className="claim-panel claim-number-picker" data-testid="claim-chain-numbers">
          <h2>Or pick your number</h2>
          {candidates.length === 0 ? (
            <p className="claim-muted">No players detected at this moment.</p>
          ) : (
            <>
              <p className="claim-muted">The number on the box. Type it, or click it.</p>
              <div className="claim-number-grid">
                {candidates.map((candidate, index) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className={`claim-number-chip ${candidate.overlap ? "is-suspect" : ""}`}
                    data-testid={`button-chain-number-${index + 1}`}
                    disabled={busy}
                    onMouseEnter={() => setHighlightId(candidate.id)}
                    onMouseLeave={() => setHighlightId(null)}
                    onFocus={() => setHighlightId(candidate.id)}
                    onBlur={() => setHighlightId(null)}
                    onClick={() => claimNumber(index + 1)}
                  >
                    <b>{index + 1}</b><span>{candidate.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {Boolean(chain?.chain.length) && (
        <button
          type="button"
          className="claim-text-button"
          data-testid="button-chain-undo"
          disabled={busy}
          onClick={() => void onUndo()}
        >
          <Undo2 size={14} /> Undo the last link
        </button>
      )}
    </>
  );

  return (
    <main className="claim-page claim-page-stage" data-testid="page-claim-chain">
      <ClaimStage
        videoUrl={recording.videoUrl}
        bundle={bundle}
        candidates={candidates}
        highlightedId={highlightId}
        showBoxes
        viewKey={`${stage}:${currentSegmentIndex}`}
        currentTime={currentTime}
        duration={bundle.duration}
        playing={playing}
        muted={muted}
        slow={slow}
        playbackRate={playbackRate}
        goalTimes={[]}
        claimedSpans={claimedSpans}
        videoRef={videoRef}
        seekRequest={seekRequest}
        onToggle={(force) => setPlaying((value) => force ?? !value)}
        onSeek={seekTracking}
        onSkip={(delta) => seekTracking(currentTime + delta)}
        onToggleSlow={() => setSlow((value) => !value)}
        onCyclePlaybackRate={() => setPlaybackRate((rate) => (rate >= 4 ? 1 : rate * 2))}
        onToggleMute={() => setMuted((value) => !value)}
        onTap={onVideoTap}
        onTimeUpdate={handleTimeUpdate}
        onVideoReady={() => undefined}
        topLeft={(
          <>
            <button
              type="button"
              className="claim-back"
              data-testid="button-chain-back"
              onClick={() => setLocation("/home")}
            >
              <ArrowLeft size={17} /><span>Leave claim</span>
            </button>
            <div className="claim-stage-title">
              <b>{recording.fieldName || "Your match"}</b>
              <span>{recording.date ?? ""}</span>
            </div>
          </>
        )}
        topRight={(
          <div className="claim-save-status" data-testid="status-chain">
            {notice || (segmentLoading ? "Loading tracking…" : "Saved as you go")}
          </div>
        )}
        panel={panel}
      />

      {pendingName && (
        <div className="claim-name-prompt" role="dialog" aria-modal="true" data-testid="dialog-chain-name">
          <div className="claim-panel">
            <h2>What should we call you?</h2>
            <p className="claim-muted">
              This is the name on the match — the identity board shows it too. Leave it as it
              is to use your account name.
            </p>
            <input
              className="claim-name-input"
              data-testid="input-chain-name"
              value={nameDraft}
              maxLength={60}
              placeholder={user?.name ?? "Your name"}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  const { trackId, frame } = pendingName;
                  setPendingName(null);
                  void submitTap(trackId, frame, nameDraft.trim() || undefined);
                }
              }}
            />
            <button
              type="button"
              className="claim-button claim-button-primary claim-button-wide"
              data-testid="button-chain-name-confirm"
              disabled={busy}
              onClick={() => {
                const { trackId, frame } = pendingName;
                setPendingName(null);
                void submitTap(trackId, frame, nameDraft.trim() || undefined);
              }}
            >
              That is me
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

/**
 * The server's own words when it has any.
 *
 * A 409 here is not a failure to report generically: it means another player
 * has vouched for that stretch, or the tracking has been replaced underneath
 * this session. Both need the person to know what happened, and both have a
 * sentence written for them on the server.
 */
function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const body = (error as { data?: { error?: unknown } }).data;
    if (body && typeof body.error === "string") return body.error;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length < 200) return message;
  }
  return fallback;
}
