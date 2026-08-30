import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  FastForward,
  Gauge,
  LocateFixed,
  LockKeyhole,
  Play,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { useLocation, useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getGetClaimMatchQueryKey,
  useCreateClaimMatchCorrection,
  useGetClaimMatch,
  useUndoClaimMatchCorrection,
  useUpdateClaimMatchProgress,
} from "@workspace/api-client-react";
import type { ClaimCorrection, ClaimMatchResponse, TrackingSegment } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { ClaimStage } from "@/components/ClaimStage";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import {
  boxAtFrame,
  boxesOverlap,
  continuationsFor,
  positionAtFrame,
  crossingsForWindow,
  findHitTracks,
  frameToTrackingSeconds,
  laterSeparatedFrame,
  trackingSecondsToFrame,
  trackingToVideoTime,
  videoTimeToTracking,
  clampToTracked,
  nextNarrowingQuestion,
  answerNarrowing,
  skipToClearPassage,
  startNarrowing,
  type NarrowingAnswer,
  type NarrowingState,
  type ClaimBundle,
  type ClaimBox,
  type ClaimTrack,
} from "@/lib/claim-match-engine";
import {
  enqueueClaimAction,
  readClaimQueue,
  removeClaimAction,
  type ClaimQueueAction,
} from "@/lib/claim-match-storage";
import {
  crossedSegmentBoundary,
  retainNearbySegments,
  segmentIndexAtTime,
} from "@/lib/claim-match-segments";

type Stage = "find" | "following" | "still" | "picker" | "look" | "done";
type ReviewState = "watching" | "prompt" | "replay";
const AUTO_LINK_MAX = 3;
const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 2] as const;
const REVIEW_WINDOW_SECONDS = 10;
type Candidate = {
  id: string;
  label: string;
  box: ClaimBox;
  overlap?: boolean;
  distance?: number;
  coasting?: boolean;
};
type ShirtTone = "light" | "dark" | "unreadable";

/**
 * Apply the identity board's map to one segment: every part of an identity
 * that lives in this segment becomes one track under the identity's id, so a
 * player follows one long track across segment boundaries. Tracks the board
 * never touched are kept as they are. Crossings are re-pointed.
 */
function applyIdentities(
  segment: TrackingSegment,
  identities: ClaimMatchResponse["manifest"]["identities"] | undefined,
): Pick<TrackingSegment, "tracks" | "crossings"> {
  if (!identities || identities.length === 0) return segment;
  const byId = new Map(segment.tracks.map((track) => [track.id, track] as const));
  const rename = new Map<string, string>();
  const merged: TrackingSegment["tracks"] = [];
  const consumed = new Set<string>();
  for (const identity of identities) {
    const boxes: ClaimBox[] = [];
    for (const part of identity.parts) {
      const track = byId.get(part.trackId);
      if (!track) continue;
      consumed.add(track.id);
      rename.set(track.id, identity.id);
      for (const box of track.boxes) if (box.frame >= part.fromFrame && box.frame <= part.toFrame) boxes.push(box);
    }
    if (!boxes.length) continue;
    boxes.sort((a, b) => a.frame - b.frame);
    merged.push({ id: identity.id, label: identity.name ?? null, startFrame: boxes[0].frame, endFrame: boxes[boxes.length - 1].frame, boxes });
  }
  const tracks = [...merged, ...segment.tracks.filter((track) => !consumed.has(track.id))];
  const crossings = segment.crossings
    .map((crossing) => ({ ...crossing, trackId: rename.get(crossing.trackId) ?? crossing.trackId, otherTrackId: rename.get(crossing.otherTrackId) ?? crossing.otherTrackId }))
    .filter((crossing) => crossing.trackId !== crossing.otherTrackId);
  return { tracks, crossings };
}

function segmentAsBundle(
  manifest: ClaimMatchResponse["manifest"],
  segment: TrackingSegment,
) {
  const applied = applyIdentities(segment, manifest.identities);
  return {
    version: manifest.version,
    label: manifest.label,
    width: manifest.width,
    height: manifest.height,
    frameRate: manifest.frameRate,
    frameCount: manifest.frameCount,
    duration: manifest.duration,
    matchOffset: manifest.matchOffset,
    videoStartSeconds: manifest.videoStartSeconds ?? 0,
    tracks: applied.tracks,
    crossings: applied.crossings,
    inPlaySpans: segment.inPlaySpans,
    events: segment.events,
  };
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function reviewWindowAt(seconds: number, duration: number) {
  const start = Math.max(0, Math.min(duration, Math.floor(Math.max(0, seconds) / REVIEW_WINDOW_SECONDS) * REVIEW_WINDOW_SECONDS));
  return {
    start,
    end: Math.min(duration, start + REVIEW_WINDOW_SECONDS),
  };
}

function initials(label: string) {
  return label.slice(0, 2).toUpperCase();
}

function detectionAtFrame(track: ClaimTrack, frame: number, tolerance = 2): ClaimBox | null {
  const box = boxAtFrame(track, frame);
  return box && Math.abs(box.frame - frame) <= tolerance ? box : null;
}

function boxCenter(box: ClaimBox) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function nearestDetectionFrame(
  bundle: ClaimBundle,
  tracks: ClaimTrack[],
  targetFrame: number,
  requiredTrackId?: string | null,
): number | null {
  const maxOffset = Math.max(2, Math.round(bundle.frameRate * 4));
  let bestFrame: number | null = null;
  let bestCount = -1;
  for (let offset = 0; offset <= maxOffset; offset += 1) {
    const frames = offset === 0 ? [targetFrame] : [targetFrame - offset, targetFrame + offset];
    for (const frame of frames) {
      if (frame < 0 || frame >= bundle.frameCount) continue;
      if (requiredTrackId && !tracks.some((track) => track.id === requiredTrackId && detectionAtFrame(track, frame))) continue;
      const count = tracks.reduce((total, track) => total + (detectionAtFrame(track, frame) ? 1 : 0), 0);
      if (count > bestCount) {
        bestCount = count;
        bestFrame = frame;
      }
    }
    if (bestCount >= 2) return bestFrame;
  }
  return bestCount >= 2 ? bestFrame : null;
}

function nearestCrossingOtherTrack(
  bundle: ClaimBundle,
  trackId: string | null,
  momentSeconds: number,
): string | null {
  if (!trackId) return null;
  const frame = trackingSecondsToFrame(momentSeconds, bundle);
  const crossing = bundle.crossings
    ?.filter((item) => item.trackId === trackId)
    .sort((a, b) => Math.abs(a.frame - frame) - Math.abs(b.frame - frame))[0];
  return crossing?.otherTrackId || null;
}

function captionForTrack(track: ClaimTrack, frame: number, bundle: ClaimBundle, shirtTone: ShirtTone) {
  let before: ClaimBox | undefined;
  let after: ClaimBox | undefined;
  for (const box of track.boxes) {
    if (box.frame <= frame) before = box;
    if (box.frame >= frame) { after = box; break; }
  }
  let movement = "standing";
  let direction = "";
  if (before && after && after.frame > before.frame) {
    const beforeCenter = boxCenter(before);
    const afterCenter = boxCenter(after);
    const seconds = (after.frame - before.frame) / bundle.frameRate;
    const pixelsPerSecond = Math.hypot(afterCenter.x - beforeCenter.x, afterCenter.y - beforeCenter.y) / Math.max(seconds, 0.01);
    const bodyHeight = Math.max((before.h + after.h) / 2, 1);
    const bodyLengthsPerSecond = pixelsPerSecond / bodyHeight;
    if (bodyLengthsPerSecond >= 1.2) movement = "sprinting";
    else if (bodyLengthsPerSecond >= 0.55) movement = "running";
    else if (bodyLengthsPerSecond >= 0.15) movement = "jogging";
    if (movement !== "standing") {
      direction = Math.abs(afterCenter.x - beforeCenter.x) >= Math.abs(afterCenter.y - beforeCenter.y)
        ? (afterCenter.x < beforeCenter.x ? " left" : " right")
        : (afterCenter.y < beforeCenter.y ? " up" : " down");
    }
  }
  const shirt = shirtTone === "unreadable" ? "shirt unclear" : `${shirtTone} shirt`;
  return `${movement}${direction}, ${shirt}`;
}


/**
 * A cropped still of one candidate, drawn from the paused <video> at the
 * candidate frame. drawImage works on a cross-origin video even when the
 * canvas is tainted, and nothing reads the pixels back, so this is safe on
 * the real Bunny stream. Redrawn whenever the video reports a new frame.
 */
function CandidateThumb({ videoRef, box, bundle, tick, size = 64 }: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  box: ClaimBox;
  bundle: ClaimBundle;
  tick: number;
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    const canvas = ref.current;
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth) return;
    const sx = video.videoWidth / bundle.width;
    const sy = video.videoHeight / bundle.height;
    // a little context around the box, keeping the player's aspect
    const padX = box.w * 0.35;
    const padY = box.h * 0.12;
    const x0 = Math.max(0, (box.x - padX) * sx);
    const y0 = Math.max(0, (box.y - padY) * sy);
    const w = Math.min(video.videoWidth - x0, (box.w + 2 * padX) * sx);
    const h = Math.min(video.videoHeight - y0, (box.h + 2 * padY) * sy);
    canvas.width = Math.round(size * (w / h));
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return;
    try {
      context.drawImage(video, x0, y0, w, h, 0, 0, canvas.width, canvas.height);
    } catch {
      // nothing to draw yet
    }
  }, [videoRef, box, bundle, tick, size]);
  return <canvas ref={ref} className="candidate-thumb" aria-hidden="true" />;
}

function SkeletonPage() {
  return (
    <main className="claim-page" data-testid="claim-loading">
      <div className="claim-skeleton-top" />
      <div className="claim-skeleton-video" />
      <div className="claim-skeleton-copy" />
      <div className="claim-skeleton-copy short" />
    </main>
  );
}

function ErrorState({
  onRetry,
  title = "We lost the thread for a moment.",
  message = "Your progress is safe. Try loading the match again and we’ll pick up from the last calm checkpoint.",
  actionLabel = "Try again",
}: {
  onRetry: () => void;
  title?: string;
  message?: string;
  actionLabel?: string;
}) {
  return (
    <main className="claim-page claim-centered" data-testid="claim-error">
      <div className="claim-error-mark"><CircleHelp size={28} /></div>
      <p className="claim-eyebrow">Replay / Claim your match</p>
      <h1>{title}</h1>
      <p className="claim-muted">{message}</p>
      <button type="button" className="claim-button claim-button-primary" data-testid="button-retry-claim" onClick={onRetry}>{actionLabel} <RotateCcw size={16} /></button>
    </main>
  );
}

export default function ClaimMatchPage() {
  const params = useParams<{ id?: string }>();
  const [, setLocation] = useLocation();
  const { user, isLoading: authLoading, isGuest } = useAuth();
  const isDemo = !params.id || params.id === "demo";
  const recordingId = isDemo ? 0 : Number(params.id);
  const queryKey = getGetClaimMatchQueryKey(recordingId);
  const claimQuery = useGetClaimMatch(recordingId, { query: { enabled: !isDemo, queryKey } });
  const demoQuery = useQuery<ClaimMatchResponse>({
    queryKey: ["claim-match", "demo"],
    enabled: isDemo && Boolean(user) && !isGuest,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const response = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/claim-match/demo`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error(`${response.status}`);
      return response.json() as Promise<ClaimMatchResponse>;
    },
  });
  const updateProgress = useUpdateClaimMatchProgress();
  const createCorrection = useCreateClaimMatchCorrection();
  const undoCorrection = useUndoClaimMatchCorrection();
  const updateProgressAsync = updateProgress.mutateAsync;
  const createCorrectionAsync = createCorrection.mutateAsync;
  const undoCorrectionAsync = undoCorrection.mutateAsync;
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { setFullscreenVideo } = useFullscreenVideo();
  const [stage, setStage] = useState<Stage>("find");
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [slow, setSlow] = useState(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [reviewState, setReviewState] = useState<ReviewState>("watching");
  const [reviewWindowStart, setReviewWindowStart] = useState(0);
  const [reviewWindowEnd, setReviewWindowEnd] = useState(10);
  const [reviewNoCount, setReviewNoCount] = useState(0);
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [confirmedFromSeconds, setConfirmedFromSeconds] = useState(0);
  const [narrowing, setNarrowing] = useState<NarrowingState | null>(null);
  const [crossingOtherTrackId, setCrossingOtherTrackId] = useState<string | null>(null);
  const [claimedPercent, setClaimedPercent] = useState(0);
  const [clipsUnlocked, setClipsUnlocked] = useState(0);
  const [corrections, setCorrections] = useState<ClaimCorrection[]>([]);
  const [notice, setNotice] = useState("");
  const [queuedCount, setQueuedCount] = useState(0);
  const [undoExpiresAt, setUndoExpiresAt] = useState(0);
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  const [segmentCache, setSegmentCache] = useState<Record<number, TrackingSegment>>({});
  const segmentCacheRef = useRef<Record<number, TrackingSegment>>({});
  const segmentRequestsRef = useRef<Record<number, Promise<void>>>({});
  const [segmentLoading, setSegmentLoading] = useState(false);
  const [segmentError, setSegmentError] = useState("");
  const [segmentRetryToken, setSegmentRetryToken] = useState(0);
  const [boundaryNotice, setBoundaryNotice] = useState("");
  const [boundaryRepickPending, setBoundaryRepickPending] = useState(false);
  const [shirtToneByTrack, setShirtToneByTrack] = useState<Record<string, ShirtTone>>({});
  const [videoReadyTick, setVideoReadyTick] = useState(0);
  const [continuationIds, setContinuationIds] = useState<string[] | null>(null);
  const [autoLinks, setAutoLinks] = useState<Array<{ from: string; to: string; at: number }>>([]);
  const autoLinkRunRef = useRef(0);
  const lastKnownPositionRef = useRef<{ x: number; y: number } | null>(null);

  const response = isDemo ? demoQuery.data : claimQuery.data;
  const activeRecordingId = isDemo ? response?.recording.id || 0 : recordingId;
  const recording = response?.recording;
  const manifest = response?.manifest;
  const serverProgress = response?.progress;
  const allCorrections = useMemo(() => {
    const remote = response?.corrections || [];
    const remoteIds = new Set(remote.map((item) => item.clientId));
    return [...remote, ...corrections.filter((item) => !remoteIds.has(item.clientId))];
  }, [corrections, response]);
  const progressValue = Math.max(claimedPercent, serverProgress?.claimedPercent || 0);
  const duration = manifest?.duration || 1;
  const earnedClips = serverProgress?.earnedClips || [];
  const currentSegmentIndex = manifest ? segmentIndexAtTime(manifest, currentTime) : 0;
  const activeSegment = segmentCache[currentSegmentIndex];
  const bundle = useMemo(
    () => (manifest && activeSegment ? segmentAsBundle(manifest, activeSegment) : null),
    [activeSegment, manifest],
  );
  const hasData = Boolean(response && recording && manifest && serverProgress);
  const activeCorrection = allCorrections.find((item) => !item.undone);
  const currentFrame = bundle ? trackingSecondsToFrame(currentTime, bundle) : 0;

  /**
   * THE BOUNDARY BETWEEN THE TWO CLOCKS.
   *
   * Everything on this screen - currentTime, crossings, in-play spans, events,
   * saved progress - is TRACKING time, 0..duration. The <video> element is the
   * only thing that speaks video time, and the recording is usually longer than
   * the tracked window: the 2026-08-24 recording is two hours and tracking
   * starts 18 minutes into it. Every assignment to video.currentTime goes
   * through toVideoTime, and every reading of it comes back through
   * fromVideoTime. Nothing else in this file may touch video.currentTime
   * directly - one field doing both jobs is what drew every box on empty grass.
   */
  const toVideoTime = useCallback(
    (trackingSeconds: number) => bundle
      ? trackingToVideoTime(clampToTracked(trackingSeconds, bundle), bundle)
      : trackingSeconds,
    [bundle],
  );
  const fromVideoTime = useCallback(
    (videoSeconds: number) => bundle
      ? clampToTracked(videoTimeToTracking(videoSeconds, bundle), bundle)
      : videoSeconds,
    [bundle],
  );
  /** The only way this page moves the playhead. Tracking seconds in. */
  const seekTracking = useCallback((trackingSeconds: number) => {
    const next = bundle ? clampToTracked(trackingSeconds, bundle) : Math.max(0, trackingSeconds);
    setCurrentTime(next);
    if (videoRef.current) videoRef.current.currentTime = toVideoTime(next);
  }, [bundle, toVideoTime]);

  const loadSegment = useCallback((index: number): Promise<void> => {
    if (!manifest || !activeRecordingId || segmentCacheRef.current[index]) {
      return Promise.resolve();
    }
    const existingRequest = segmentRequestsRef.current[index];
    if (existingRequest) return existingRequest;

    const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
    const request = fetch(`${basePath}/api/recordings/${activeRecordingId}/claim-match/segments/${index}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    })
      .then(async (segmentResponse) => {
        if (!segmentResponse.ok) {
          throw new Error(`Segment ${index} failed: ${segmentResponse.status}`);
        }
        const segment = await segmentResponse.json() as TrackingSegment;
        segmentCacheRef.current = { ...segmentCacheRef.current, [index]: segment };
        setSegmentCache(segmentCacheRef.current);
      })
      .finally(() => {
        delete segmentRequestsRef.current[index];
      });
    segmentRequestsRef.current[index] = request;
    return request;
  }, [activeRecordingId, manifest]);

  useEffect(() => {
    segmentCacheRef.current = {};
    segmentRequestsRef.current = {};
    setSegmentCache({});
    setSegmentError("");
  }, [activeRecordingId]);

  useEffect(() => {
    if (!manifest || !activeRecordingId) return;
    let cancelled = false;
    const neighborIndexes = [currentSegmentIndex - 1, currentSegmentIndex, currentSegmentIndex + 1]
      .filter((index) => manifest.segments.some((segment) => segment.index === index));
    const currentReady = Boolean(segmentCacheRef.current[currentSegmentIndex]);
    setSegmentLoading(!currentReady);
    setSegmentError("");

    void loadSegment(currentSegmentIndex)
      .then(() => {
        if (cancelled) return;
        setSegmentLoading(false);
        const retained = retainNearbySegments(segmentCacheRef.current, currentSegmentIndex);
        segmentCacheRef.current = retained;
        setSegmentCache(retained);

        // Neighbor segments improve boundary seeking, but they must never block
        // the current segment from rendering or turn a background failure into
        // a permanent loading skeleton.
        for (const index of neighborIndexes) {
          if (index !== currentSegmentIndex) void loadSegment(index).catch(() => undefined);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSegmentLoading(false);
          setSegmentError("The tracking segment could not be loaded. Your saved progress is safe.");
        }
      });

    return () => { cancelled = true; };
  }, [activeRecordingId, currentSegmentIndex, loadSegment, manifest, segmentRetryToken]);

  const seekBy = useCallback((delta: number) => {
    seekTracking(currentTime + delta);
  }, [currentTime, seekTracking]);

  const queueProgress = useCallback(async (payload: Record<string, unknown>) => {
    await enqueueClaimAction({
      id: `progress-${activeRecordingId}`,
      kind: "progress",
      recordingId: activeRecordingId,
      payload,
      createdAt: Date.now(),
    });
    setQueuedCount((await readClaimQueue()).length);
    setNotice("Saved on this device · will sync when you’re back");
  }, [activeRecordingId]);

  const saveProgress = useCallback((
    nextStage: Stage,
    nextTrackId = currentTrackId,
    nextPercent = progressValue,
    nextClips = clipsUnlocked,
    nextConfirmedFrom = confirmedFromSeconds,
    nextPosition = currentTime,
  ) => {
    const payload = {
      currentTrackId: nextTrackId,
      stage: nextStage,
      confirmedFromSeconds: nextConfirmedFrom,
      currentPositionSeconds: nextPosition,
      claimedPercent: nextPercent,
      clipsUnlocked: nextClips,
      completed: nextStage === "done",
      earnedClips,
    };
    if (isOffline) {
      void queueProgress(payload);
    } else {
      setNotice("Saving");
      updateProgress.mutate({ id: activeRecordingId, data: payload }, {
        onSuccess: () => setNotice("Saved just now"),
        onError: () => void queueProgress(payload),
      });
    }
  }, [currentTime, currentTrackId, progressValue, clipsUnlocked, confirmedFromSeconds, earnedClips, isOffline, activeRecordingId, updateProgress, queueProgress]);

  const previousSegmentIndex = useRef<number | null>(null);
  useEffect(() => {
    // wait for the new segment's bundle so an identity that continues into it
    // can be recognised before anyone is asked anything
    if (!manifest || !bundle) return;
    if (!crossedSegmentBoundary(previousSegmentIndex.current, currentSegmentIndex)) {
      previousSegmentIndex.current = currentSegmentIndex;
      return;
    }
    previousSegmentIndex.current = currentSegmentIndex;
    // An identity from the board spans segments under one id: keep following.
    if (currentTrackId && bundle.tracks.some((track) => track.id === currentTrackId)) {
      setNotice("Still with you into the next section");
      return;
    }
    setCurrentTrackId(null);
    setNarrowing(null);
    setBoundaryNotice("Lost you at the ten-minute mark. Which one is you?");
    setBoundaryRepickPending(true);
    setStage("picker");
    setNotice("Choose yourself again — this keeps segment boundaries honest");
    saveProgress("picker", null, progressValue, clipsUnlocked);
  }, [bundle, clipsUnlocked, currentSegmentIndex, currentTrackId, manifest, progressValue, saveProgress]);

  const goStage = useCallback((next: Stage, trackId = currentTrackId) => {
    const percentByStage: Record<Stage, number> = { find: 0, following: 19, still: 38, picker: 55, look: 73, done: 100 };
    setStage(next);
    setClaimedPercent(percentByStage[next]);
    setCurrentTrackId(trackId);
    setClipsUnlocked((value) => Math.max(value, next === "done" ? earnedClips.length : value));
    saveProgress(next, trackId, Math.max(progressValue, percentByStage[next]), clipsUnlocked);
  }, [currentTrackId, earnedClips.length, progressValue, clipsUnlocked, saveProgress]);

  const stillQuestion = narrowing ? nextNarrowingQuestion(narrowing) : null;

  const startVideoPlayback = useCallback(() => {
    setPlaying(true);
    const video = videoRef.current;
    if (video) void video.play().catch(() => setPlaying(false));
  }, []);

  const beginFollowing = useCallback((trackId: string, atSeconds = currentTime) => {
    if (!bundle) return;
    const confirmedAt = atSeconds;
    const nextWindow = reviewWindowAt(confirmedAt, duration);
    const track = bundle.tracks.find((item) => item.id === trackId);
    const box = track ? detectionAtFrame(track, trackingSecondsToFrame(confirmedAt, bundle)) : null;
    if (box) lastKnownPositionRef.current = boxCenter(box);
    setContinuationIds(null);
    autoLinkRunRef.current = 0;
    setCurrentTrackId(trackId);
    setConfirmedFromSeconds(confirmedAt);
    setNarrowing(null);
    setCrossingOtherTrackId(null);
    setReviewWindowStart(nextWindow.start);
    setReviewWindowEnd(nextWindow.end);
    setReviewNoCount(0);
    setReviewState("watching");
    setStage("following");
    setClaimedPercent((value) => Math.max(value, 19));
    setNotice("Following you through the match");
    startVideoPlayback();
    saveProgress("following", trackId, Math.max(progressValue, 19), clipsUnlocked, confirmedAt, confirmedAt);
  }, [bundle, clipsUnlocked, currentTime, duration, progressValue, saveProgress, startVideoPlayback]);

  const seekToFrame = useCallback((frame: number) => {
    if (!bundle) return;
    const seconds = frameToTrackingSeconds(frame, bundle);
    seekTracking(seconds);
  }, [bundle, seekTracking]);

  const startCorrectionCheck = useCallback(() => {
    if (!bundle || !currentTrackId) {
      setStage("picker");
      setNotice("Choose yourself in this frame");
      return;
    }
    const observedAt = currentTime;
    const state = startNarrowing(
      crossingsForWindow(bundle, currentTrackId, confirmedFromSeconds, observedAt),
      confirmedFromSeconds,
      observedAt,
    );
    setNarrowing(state);
    const question = nextNarrowingQuestion(state);
    const otherTrackId = question.kind === "complete"
      ? null
      : nearestCrossingOtherTrack(bundle, currentTrackId, question.momentSeconds);
    setCrossingOtherTrackId(otherTrackId);
    if (question.kind === "question") {
      seekTracking(question.momentSeconds);
      setStage("still");
      setClaimedPercent((value) => Math.max(value, 38));
      setNotice("Quick check — keep watching");
      saveProgress("still", currentTrackId, Math.max(progressValue, 38), clipsUnlocked, confirmedFromSeconds, question.momentSeconds);
    } else {
      seekTracking(question.momentSeconds);
      setStage("picker");
      setClaimedPercent((value) => Math.max(value, 55));
      setNotice("Choose yourself at this clear moment");
      saveProgress("picker", null, Math.max(progressValue, 55), clipsUnlocked, confirmedFromSeconds, question.momentSeconds);
    }
  }, [bundle, clipsUnlocked, confirmedFromSeconds, currentTime, currentTrackId, progressValue, saveProgress]);

  const confirmStill = useCallback((answer: NarrowingAnswer) => {
    if (!narrowing || !bundle) {
      goStage("picker");
      return;
    }
    if (answer === "not-sure") {
      setNotice("No problem — we’ll keep this moment and check again later");
      return;
    }
    const answerMoment = stillQuestion?.momentSeconds ?? currentTime;
    const next = answerNarrowing(narrowing, answer, answerMoment);
    setNarrowing(next);
    if (answer === "yes") setConfirmedFromSeconds(answerMoment);
    const nextQuestion = nextNarrowingQuestion(next);
    const nextOtherTrackId = nextQuestion.kind === "complete"
      ? null
      : nearestCrossingOtherTrack(bundle, currentTrackId, nextQuestion.momentSeconds);
    setCrossingOtherTrackId(nextOtherTrackId);
    if (nextQuestion.kind === "picker" || nextQuestion.kind === "complete") {
      setStage("picker");
      setClaimedPercent((value) => Math.max(value, 55));
      seekTracking(nextQuestion.momentSeconds);
      saveProgress("picker", null, Math.max(progressValue, 55), clipsUnlocked, confirmedFromSeconds, nextQuestion.momentSeconds);
    } else {
      seekTracking(nextQuestion.momentSeconds);
      saveProgress("still", currentTrackId, progressValue, clipsUnlocked, answer === "yes" ? answerMoment : confirmedFromSeconds, nextQuestion.momentSeconds);
      setNotice("Here’s the next clear passage");
    }
  }, [bundle, clipsUnlocked, confirmedFromSeconds, currentTime, currentTrackId, narrowing, progressValue, saveProgress, stillQuestion]);

  const skipAhead = useCallback(() => {
    if (!bundle) return;
    const next = skipToClearPassage(currentTime, bundle.inPlaySpans, bundle.duration);
    seekTracking(next);
    setNotice("Skipped ahead to a clearer passage");
  }, [bundle, currentTime, seekTracking]);

  const answerReview = useCallback((answer: "yes" | "no") => {
    if (reviewState !== "prompt" || !bundle || !currentTrackId) return;

    if (answer === "no") {
      if (reviewNoCount === 0) {
        setReviewNoCount(1);
        setReviewState("replay");
        setSlow(false);
        seekTracking(reviewWindowStart);
        startVideoPlayback();
        setNotice("Replaying this window at 3×");
        return;
      }

      setReviewState("watching");
      setReviewNoCount(0);
      setCurrentTrackId(null);
      setNarrowing(null);
      setContinuationIds(null);
      setStage("picker");
      seekTracking(reviewWindowStart);
      setNotice("Choose yourself in this ten-second window");
      saveProgress("picker", null, Math.max(progressValue, 55), clipsUnlocked, confirmedFromSeconds, reviewWindowStart);
      return;
    }

    const nextWindow = reviewWindowAt(reviewWindowEnd, duration);
    if (reviewWindowEnd >= duration - 0.05 || nextWindow.end <= nextWindow.start) {
      setReviewState("watching");
      setPlaying(false);
      videoRef.current?.pause();
      setStage("done");
      setClaimedPercent(100);
      setNotice("Match claimed");
      saveProgress("done", currentTrackId, 100, clipsUnlocked, confirmedFromSeconds, reviewWindowEnd);
      return;
    }

    setConfirmedFromSeconds(nextWindow.start);
    setReviewWindowStart(nextWindow.start);
    setReviewWindowEnd(nextWindow.end);
    setReviewNoCount(0);
    setReviewState("watching");
    seekTracking(nextWindow.start);
    startVideoPlayback();
    setClaimedPercent((value) => Math.max(value, Math.min(99, (nextWindow.start / Math.max(duration, 1)) * 100)));
    setNotice(`Reviewing ${formatTime(nextWindow.start)}–${formatTime(nextWindow.end)}`);
    saveProgress("following", currentTrackId, Math.max(progressValue, 19), clipsUnlocked, nextWindow.start, nextWindow.start);
  }, [
    bundle,
    clipsUnlocked,
    confirmedFromSeconds,
    currentTrackId,
    duration,
    progressValue,
    reviewNoCount,
    reviewState,
    reviewWindowEnd,
    reviewWindowStart,
    saveProgress,
    seekTracking,
    startVideoPlayback,
  ]);

  const candidateStage = stage === "find" || stage === "picker" || stage === "look";
  const candidateFrame = useMemo(() => {
    if (!bundle || !candidateStage) return currentFrame;
    return nearestDetectionFrame(bundle, bundle.tracks, currentFrame, crossingOtherTrackId) ?? currentFrame;
  }, [bundle, candidateStage, crossingOtherTrackId, currentFrame]);

  useEffect(() => {
    if (!bundle || !candidateStage || candidateFrame === currentFrame) return;
    const seconds = frameToTrackingSeconds(candidateFrame, bundle);
    seekTracking(seconds);
  }, [bundle, candidateFrame, candidateStage, currentFrame, seekTracking]);

  const candidates = useMemo<Candidate[]>(() => {
    if (!bundle) return [];
    const sourceTracks = candidateStage
      ? (continuationIds ? bundle.tracks.filter((track) => continuationIds.includes(track.id)) : bundle.tracks)
      : bundle.tracks.filter((track) => track.id === currentTrackId);
    const anchorTrack = currentTrackId ? bundle.tracks.find((track) => track.id === currentTrackId) : null;
    const anchorBox = anchorTrack ? detectionAtFrame(anchorTrack, candidateFrame) : null;
    const anchor = lastKnownPositionRef.current || (anchorBox ? boxCenter(anchorBox) : { x: bundle.width / 2, y: bundle.height / 2 });
    const ranked = sourceTracks
      .map((track) => {
        const box = candidateStage ? detectionAtFrame(track, candidateFrame) : positionAtFrame(track, candidateFrame, bundle);
        if (!box) return null;
        const center = boxCenter(box);
        return {
          track,
          box,
          distance: Math.hypot(center.x - anchor.x, center.y - anchor.y),
        };
      })
      .filter((item): item is { track: ClaimTrack; box: ClaimBox; distance: number } => Boolean(item))
      .sort((a, b) => a.distance - b.distance);
    const forced = crossingOtherTrackId ? ranked.find((item) => item.track.id === crossingOtherTrackId) : undefined;
    const selected = ranked.slice(0, 4);
    if (forced && !selected.some((item) => item.track.id === forced.track.id)) {
      selected.splice(Math.max(0, selected.length - 1), 1, forced);
    }
    return selected
      .sort((a, b) => a.distance - b.distance)
      .map(({ track, box, distance }) => ({
        id: track.id,
        label: captionForTrack(track, candidateFrame, bundle, shirtToneByTrack[track.id] || "unreadable"),
        box,
        distance,
        coasting: Boolean((box as { interpolated?: boolean }).interpolated),
      }))
      .map((candidate, index, all) => ({
        ...candidate,
        overlap: all.some((other) => other.id !== candidate.id && boxesOverlap(candidate.box, other.box)),
      }));
  }, [bundle, candidateFrame, candidateStage, continuationIds, crossingOtherTrackId, currentTrackId, shirtToneByTrack]);

  const followedTrack = bundle?.tracks.find((track) => track.id === currentTrackId);
  // Alive through internal gaps: the linker coasts a track through an occlusion,
  // and a missing detection is not the end of the track.
  const followedBox = followedTrack && bundle ? positionAtFrame(followedTrack, currentFrame, bundle) : null;
  const followedEnded = Boolean(followedTrack && currentFrame > followedTrack.endFrame);
  const currentLabel = currentTrackId
    ? (bundle?.tracks.find((track) => track.id === currentTrackId)?.label || "player")
    : candidates[0]?.label || "player";

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !bundle || !candidates.length || video.readyState < 2) return;
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = Math.max(1, Math.round(canvas.width * bundle.height / bundle.width));
    const context = canvas.getContext("2d");
    if (!context) return;
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const nextTones: Record<string, ShirtTone> = {};
      for (const candidate of candidates) {
        const sx = Math.max(0, Math.floor(candidate.box.x / bundle.width * canvas.width));
        const sy = Math.max(0, Math.floor((candidate.box.y + candidate.box.h * 0.18) / bundle.height * canvas.height));
        const sw = Math.max(1, Math.floor(candidate.box.w / bundle.width * canvas.width));
        const sh = Math.max(1, Math.floor(candidate.box.h * 0.38 / bundle.height * canvas.height));
        const pixels = context.getImageData(sx, sy, Math.min(sw, canvas.width - sx), Math.min(sh, canvas.height - sy)).data;
        let luminance = 0;
        let samples = 0;
        for (let index = 0; index < pixels.length; index += 16) {
          luminance += pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722;
          samples += 1;
        }
        nextTones[candidate.id] = samples ? (luminance / samples >= 132 ? "light" : "dark") : "unreadable";
      }
      setShirtToneByTrack((previous) => {
        const changed = Object.entries(nextTones).some(([id, tone]) => previous[id] !== tone);
        return changed ? { ...previous, ...nextTones } : previous;
      });
    } catch {
      // Canvas can be unavailable for a cross-origin recording; captions stay honest.
    }
  }, [bundle, candidates, videoReadyTick]);

  useEffect(() => {
    if (!response || !bundle) return;
    const resumedStage = (response.progress.stage as Stage) || "find";
    const resumedPosition = response.progress.currentPositionSeconds || 0;
    const normalizedStage = resumedStage === "still" ? "following" : resumedStage;
    setStage(normalizedStage);
    setCurrentTrackId(response.progress.currentTrackId || null);
    setConfirmedFromSeconds(response.progress.confirmedFromSeconds || 0);
    setCurrentTime(resumedPosition);
    setClaimedPercent(response.progress.claimedPercent || 0);
    setClipsUnlocked(response.progress.clipsUnlocked || 0);
    setCorrections(response.corrections);
    setNarrowing(null);
    setCrossingOtherTrackId(null);
    if ((normalizedStage === "following") && response.progress.currentTrackId) {
      const resumedWindow = reviewWindowAt(resumedPosition, bundle.duration);
      setReviewWindowStart(resumedWindow.start);
      setReviewWindowEnd(resumedWindow.end);
      setReviewNoCount(0);
      setReviewState("watching");
    }
  }, [bundle, response]);

  useEffect(() => {
    if (!bundle || !currentTrackId) return;
    const track = bundle.tracks.find((item) => item.id === currentTrackId);
    const box = track ? detectionAtFrame(track, currentFrame) : null;
    if (box) lastKnownPositionRef.current = boxCenter(box);
  }, [bundle, currentFrame, currentTrackId]);

  /**
   * The track under the player ended. Measured on the real hour, a third of
   * track ends have exactly one track starting nearby within three seconds
   * that a person could physically have reached - those are stitched
   * silently (at most AUTO_LINK_MAX in a row, each undoable). Several
   * candidates is a question with only those candidates. None is the picker.
   */
  useEffect(() => {
    if (stage !== "following" || !bundle || !followedTrack || !followedEnded || currentTime <= confirmedFromSeconds + 0.05) return;
    const next = continuationsFor(bundle, followedTrack);
    if (next.length === 1 && autoLinkRunRef.current < AUTO_LINK_MAX) {
      autoLinkRunRef.current += 1;
      const chosen = next[0].track;
      setCurrentTrackId(chosen.id);
      setAutoLinks((list) => [...list, { from: followedTrack.id, to: chosen.id, at: currentTime }]);
      setNotice(`Followed you through a crossing (${next[0].gapSeconds.toFixed(1)} s) · undo if that's wrong`);
      setUndoExpiresAt(Date.now() + 10_000);
      saveProgress("following", chosen.id, progressValue, clipsUnlocked, confirmedFromSeconds, currentTime);
      return;
    }
    autoLinkRunRef.current = 0;
    setContinuationIds(next.length > 1 ? next.map((item) => item.track.id) : null);
    setStage("picker");
    setCurrentTrackId(null);
    setNarrowing(null);
    setNotice(next.length > 1
      ? `Lost you in a crossing — which of these ${next.length} is you?`
      : "Tracking ended here — choose yourself in the next clear frame");
    saveProgress("picker", null, Math.max(progressValue, 55), clipsUnlocked, confirmedFromSeconds, currentTime);
  }, [bundle, clipsUnlocked, confirmedFromSeconds, currentTime, followedEnded, followedTrack, progressValue, saveProgress, stage]);

  const lastSavedPosition = useRef(0);
  useEffect(() => {
    if (currentTime <= 0 || currentTime - lastSavedPosition.current < 10) return;
    lastSavedPosition.current = currentTime;
    saveProgress(stage, currentTrackId, progressValue, clipsUnlocked);
  }, [currentTime, currentTrackId, clipsUnlocked, progressValue, saveProgress, stage]);

  // Hides the tab bar and stops OrientationLock covering a phone held sideways -
  // this page is the player, like VideoPlayer on the field page.
  useEffect(() => {
    setFullscreenVideo(true);
    return () => setFullscreenVideo(false);
  }, [setFullscreenVideo]);

  useEffect(() => {
    const updateOnline = () => setIsOffline(!navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    void readClaimQueue().then((items) => setQueuedCount(items.length));
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  const flushQueue = useCallback(async () => {
    if (isOffline || !user || isGuest) return;
    const actions = await readClaimQueue();
    if (actions.length === 0) {
      setQueuedCount(0);
      return;
    }
    let changed = false;
    for (const action of actions) {
      try {
        if (action.kind === "progress") {
          await updateProgressAsync({ id: action.recordingId, data: action.payload as never });
        } else if (action.kind === "correction") {
          await createCorrectionAsync({ id: action.recordingId, data: action.payload as never });
        } else {
          await undoCorrectionAsync({ correctionId: action.correctionId });
        }
        await removeClaimAction(action.id);
        changed = true;
      } catch {
        break;
      }
    }
    const remaining = await readClaimQueue();
    setQueuedCount(remaining.length);
    if (changed) {
      await queryClient.invalidateQueries({ queryKey: ["claim-match"] });
    }
  }, [
    createCorrectionAsync,
    isGuest,
    isOffline,
    queryClient,
    undoCorrectionAsync,
    updateProgressAsync,
    user,
  ]);

  useEffect(() => { void flushQueue(); }, [flushQueue]);

  useEffect(() => {
    if (!undoExpiresAt) return;
    const timer = window.setInterval(() => {
      if (Date.now() >= undoExpiresAt) {
        setUndoExpiresAt(0);
        window.clearInterval(timer);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [undoExpiresAt]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (event.target instanceof HTMLInputElement) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (stage === "still") {
          confirmStill("no");
        } else if (stage === "following") {
          startCorrectionCheck();
        }
      } else if (key === "s") {
        event.preventDefault();
        setSlow((value) => !value);
        setNotice(slow ? "Normal speed" : "Slow motion on");
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekBy(-5);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekBy(5);
      } else if (stage === "picker" && /^[1-4]$/.test(key)) {
        const candidate = candidates[Number(key) - 1];
        if (candidate) {
          beginFollowing(candidate.id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [beginFollowing, candidates, confirmStill, seekBy, slow, stage, startCorrectionCheck]);

  useEffect(() => {
    if (!playing || recording?.videoUrl) return;
    const timer = window.setInterval(() => {
      const rate = slow ? 0.5 : playbackRate;
      setCurrentTime((value) => Math.min(duration, value + (0.8 * rate)));
    }, 800);
    return () => window.clearInterval(timer);
  }, [duration, playbackRate, playing, recording?.videoUrl, slow]);

  useEffect(() => {
    if (stage !== "following" || !bundle || !currentTrackId || reviewWindowEnd <= reviewWindowStart) return;

    if (reviewState === "watching" && currentTime >= reviewWindowEnd - 0.05) {
      const checkpoint = reviewWindowEnd;
      setPlaying(false);
      videoRef.current?.pause();
      setCurrentTime(checkpoint);
      setReviewState("prompt");
      setReviewNoCount(0);
      setNotice(`Checkpoint ready · ${formatTime(reviewWindowStart)}–${formatTime(checkpoint)}`);
      saveProgress("following", currentTrackId, progressValue, clipsUnlocked, confirmedFromSeconds, checkpoint);
    } else if (reviewState === "replay" && currentTime >= reviewWindowEnd - 0.05) {
      setPlaying(false);
      videoRef.current?.pause();
      setCurrentTime(reviewWindowEnd);
      setReviewState("prompt");
      setNotice("Replay complete · is this you?");
    }
  }, [
    bundle,
    clipsUnlocked,
    confirmedFromSeconds,
    currentTime,
    currentTrackId,
    progressValue,
    reviewState,
    reviewWindowEnd,
    reviewWindowStart,
    saveProgress,
    stage,
  ]);

  const onCorrection = (chosen: Candidate, method = "picker", allowOverlap = false) => {
    if (!bundle) return;
    const isBoundaryRepick = boundaryRepickPending;
    const rejected = currentTrackId && currentTrackId !== chosen.id ? currentTrackId : null;
    const overlapping = candidates.find((candidate) => candidate.id !== chosen.id && boxesOverlap(chosen.box, candidate.box));
    if (!allowOverlap && overlapping) {
      const separated = laterSeparatedFrame(bundle, [chosen.id, overlapping.id], candidateFrame);
      if (separated !== null) {
        seekToFrame(separated);
        setCurrentTrackId(chosen.id);
        setCrossingOtherTrackId(overlapping.id);
        setStage("look");
        setClaimedPercent((value) => Math.max(value, 73));
        setNotice("We found a clearer frame after they separate");
        return;
      }
      setNotice("These two tracks are still overlapped — choose a box with a clean edge");
      return;
    }
    const selectionMoment = frameToTrackingSeconds(candidateFrame, bundle);
    seekTracking(selectionMoment);
    beginFollowing(chosen.id, selectionMoment);
    if (isBoundaryRepick) {
      setBoundaryRepickPending(false);
      setBoundaryNotice("");
      setNotice("Following you in this segment");
      return;
    }
    const payload = {
      clientId: `claim-${activeRecordingId}-${Math.round(currentTime * 10)}-${chosen.id}`,
      momentSeconds: currentTime,
      rejectedTrackId: rejected,
      chosenTrackId: chosen.id,
      answerMethod: method,
      questionCount: stage === "look" ? 2 : 1,
    };
    const optimistic: ClaimCorrection = {
      id: -Date.now(),
      ...payload,
      recordingId: activeRecordingId,
      undone: false,
      createdAt: new Date().toISOString(),
    };
    setCorrections((items) => [...items, optimistic]);
    setUndoExpiresAt(Date.now() + 10_000);
    if (isOffline) {
      const action: ClaimQueueAction = { id: `correction-${payload.clientId}`, kind: "correction", recordingId: activeRecordingId, payload, createdAt: Date.now() };
      void enqueueClaimAction(action).then(async () => setQueuedCount((await readClaimQueue()).length));
    } else {
      createCorrection.mutate({ id: activeRecordingId, data: payload }, {
        onSuccess: (correction) => setCorrections((items) => items.map((item) => item.id === optimistic.id ? correction : item)),
        onError: () => void enqueueClaimAction({ id: `correction-${payload.clientId}`, kind: "correction", recordingId: activeRecordingId, payload, createdAt: Date.now() }).then(async () => setQueuedCount((await readClaimQueue()).length)),
      });
    }
  };

  const undo = () => {
    const lastAuto = autoLinks[autoLinks.length - 1];
    if (lastAuto && undoExpiresAt && Date.now() < undoExpiresAt && (!activeCorrection || activeCorrection.id > 0 || activeCorrection.createdAt < new Date(Date.now() - 10_000).toISOString())) {
      // undo an automatic stitch: back to the track that ended, at the moment it ended,
      // and ask instead of guessing
      setAutoLinks((list) => list.slice(0, -1));
      setUndoExpiresAt(0);
      autoLinkRunRef.current = AUTO_LINK_MAX; // no re-stitch straight after an undo
      seekTracking(lastAuto.at);
      setCurrentTrackId(null);
      setStage("picker");
      setNotice("Stitch undone — choose yourself here");
      return;
    }
    if (!activeCorrection || !undoExpiresAt || Date.now() >= undoExpiresAt) {
      setNotice("Nothing to undo yet");
      return;
    }
    setCorrections((items) => items.map((item) => item.id === activeCorrection.id ? { ...item, undone: true } : item));
    setUndoExpiresAt(0);
    if (activeCorrection.id < 0 || isOffline) {
      if (activeCorrection.id > 0) {
        void enqueueClaimAction({ id: `undo-${activeCorrection.id}`, kind: "undo", recordingId: activeRecordingId, correctionId: activeCorrection.id, createdAt: Date.now() }).then(async () => setQueuedCount((await readClaimQueue()).length));
      } else {
        void removeClaimAction(`correction-${activeCorrection.clientId}`).then(async () => {
          setQueuedCount((await readClaimQueue()).length);
          setNotice("Correction dismissed before syncing");
        });
      }
    } else {
      undoCorrection.mutate({ correctionId: activeCorrection.id }, { onSuccess: () => setNotice("Correction undone"), onError: () => void enqueueClaimAction({ id: `undo-${activeCorrection.id}`, kind: "undo", recordingId: activeRecordingId, correctionId: activeCorrection.id, createdAt: Date.now() }).then(async () => setQueuedCount((await readClaimQueue()).length)) });
    }
    setCurrentTrackId(null);
    goStage("picker", null);
  };

  if (authLoading) return <SkeletonPage />;
  if (!user || isGuest) {
    return (
      <ErrorState
        title="Sign in to claim your match."
        message="Claim Your Match needs a player account so your answers and unlocked clips can be saved."
        actionLabel="Sign in"
        onRetry={() => setLocation("/sign-in")}
      />
    );
  }
  if ((isDemo && demoQuery.isLoading) || (!isDemo && claimQuery.isLoading)) return <SkeletonPage />;
  if ((isDemo && demoQuery.isError) || (!isDemo && claimQuery.isError) || !hasData || !recording || !manifest || !serverProgress) {
    return <ErrorState onRetry={() => (isDemo ? demoQuery.refetch() : claimQuery.refetch())} />;
  }
  if (segmentError) {
    return (
      <ErrorState
        title="The tracking data did not finish loading."
        message={segmentError}
        onRetry={() => setSegmentRetryToken((value) => value + 1)}
      />
    );
  }
  if (segmentLoading || !bundle) return <SkeletonPage />;

  const handleBack = () => {
    const previous: Record<Stage, Stage> = { find: "find", following: "find", still: "following", picker: "still", look: "picker", done: "look" };
    if (stage === "find") setLocation("/home");
    else goStage(previous[stage]);
  };

  const handlePlay = (forcePlaying?: boolean) => {
    const video = videoRef.current;
    const next = forcePlaying ?? !playing;
    setPlaying(next);
    if (video) {
      if (next) void video.play().catch(() => setPlaying(false));
      else video.pause();
    }
  };
  const handleSeek = (value: number) => {
    seekTracking(value);
  };
  const cyclePlaybackRate = () => {
    setPlaybackRate((current) => {
      const currentIndex = PLAYBACK_SPEEDS.indexOf(current as (typeof PLAYBACK_SPEEDS)[number]);
      return PLAYBACK_SPEEDS[(currentIndex + 1) % PLAYBACK_SPEEDS.length];
    });
    setSlow(false);
  };
  const handleVideoTap = (x: number, y: number) => {
    if (x < 0 || y < 0 || x > bundle.width || y > bundle.height) return;
    const hits = findHitTracks(bundle, currentFrame, x, y)
      .filter(({ box }) => Math.abs(box.frame - currentFrame) <= 2);
    if (!hits.length) {
      setNotice("No player detected at that point in this frame");
      return;
    }
    const hitCandidates = hits.map(({ track, box }) => ({
      id: track.id,
      label: captionForTrack(track, currentFrame, bundle, shirtToneByTrack[track.id] || "unreadable"),
      box,
    }));
    const chosen = hitCandidates.find((candidate) => candidate.id !== currentTrackId) || hitCandidates[0];
    if (chosen.id === currentTrackId && stage === "following") {
      setNotice("Still following this player");
      return;
    }
    if (hits.length > 1) {
      const other = hits.find(({ track }) => track.id !== chosen.id);
      if (other) {
        const separated = laterSeparatedFrame(bundle, [chosen.id, other.track.id], currentFrame);
        if (separated === null) {
          setNotice("Those detections stay overlapped here — no guess recorded");
          return;
        }
        seekToFrame(separated);
        setCurrentTrackId(chosen.id);
        setCrossingOtherTrackId(other.track.id);
        setStage("look");
        setClaimedPercent((value) => Math.max(value, 73));
        setNotice("We found the first clean frame after the overlap");
        return;
      }
    }
    onCorrection(chosen, "video-tap");
  };
  const handlePrimaryAction = () => {
    if (stage === "find") {
      if (candidates[0]) beginFollowing(candidates[0].id);
    } else if (stage === "following") {
      startCorrectionCheck();
    } else if (stage === "still") {
      confirmStill("yes");
    } else if (stage === "picker" && candidates[0]) {
      onCorrection(candidates[0]);
    } else if (stage === "look" && candidates[0]) {
      onCorrection(candidates[0], "overlap-resolved", true);
    }
  };

  const goalTimes = bundle.events
    .filter((event) => event.type.toLowerCase() === "goal")
    .map((event) => event.time);
  const panelBody = (
    <>
        {stage === "find" && (
          <div className="claim-panel claim-panel-find" data-testid="panel-find-yourself">
            <span className="claim-context"><ScanSearch size={16} /> DETECTIONS IN THIS FRAME</span>
            <h2>Tap your player</h2>
            <p>We’ll follow one real tracked player through the recording. Tap a highlighted box, or choose the closest clear detection below.</p>
            <div className="claim-prompt-card"><div className="prompt-icon"><LocateFixed size={19} /></div><div><b>{candidates.length} players detected</b><span>Boxes never come from placeholder positions.</span></div></div>
            <button type="button" className="claim-button claim-button-primary claim-button-wide" data-testid="button-start-following" onClick={handlePrimaryAction} disabled={!candidates[0]}>Follow the closest detection <ChevronRight size={17} /></button>
            <button type="button" className="claim-text-button" data-testid="button-skip-find" onClick={() => goStage("picker")}>Show all detections <ArrowLeft size={14} /></button>
          </div>
        )}
        {stage === "following" && (
          <div className="claim-panel" data-testid="panel-following">
            <span className="claim-live-pill"><span /> FOLLOWING</span>
            <h2>Following your player</h2>
            <p>The outlined box follows the selected track continuously. We’ll only interrupt when a real crossing needs your help.</p>
            <div className="claim-follow-status"><div className="claim-follow-avatar">{initials(currentLabel)}</div><div><b>Tracked player</b><span>{followedBox && followedTrack ? captionForTrack(followedTrack, currentFrame, bundle, shirtToneByTrack[currentTrackId || ""] || "unreadable") : "Detection temporarily out of range"}</span></div><ShieldCheck size={19} /></div>
            <button type="button" className="claim-button claim-button-secondary claim-button-wide" data-testid="button-change-identity" onClick={startCorrectionCheck}>That’s not me <RotateCcw size={14} /></button>
            <p className="claim-undo-copy"><Undo2 size={13} /> Changed your mind? You can undo any correction for the next 10 seconds.</p>
          </div>
        )}
        {stage === "still" && (
          <div className="claim-panel" data-testid="panel-still-you">
            <span className="claim-context"><Clock3 size={15} /> NARROWING A CROSSING</span>
            <h2>Still you here?</h2>
            <p>We’re checking in before the next busy passage. No rush — a quick yes or no is enough.</p>
            <div className="claim-question-card"><Clock3 size={18} /><span>At <b>{formatTime(stillQuestion?.momentSeconds ?? currentTime)}</b>, does the outlined player still look like you?</span></div>
            <button type="button" className="claim-button claim-button-primary claim-button-wide" data-testid="button-still-yes" onClick={() => confirmStill("yes")}>Yes, keep following <Check size={17} /></button>
            <button type="button" className="claim-button claim-button-secondary claim-button-wide" data-testid="button-still-no" onClick={() => confirmStill("no")}>Not me <X size={17} /></button>
            <button type="button" className="claim-text-button" data-testid="button-still-not-sure" onClick={() => confirmStill("not-sure")}>Not sure — show me this passage again <CircleHelp size={14} /></button>
            <button type="button" className="claim-text-button" data-testid="button-skip-ahead" onClick={skipAhead}>Skip ahead 30s <FastForward size={14} /></button>
            <p className="claim-key-note">Press <kbd>Space</kbd> for “Not me”</p>
          </div>
        )}
        {stage === "picker" && (
          <div className="claim-panel claim-panel-picker" data-testid="panel-picker">
            <span className="claim-context"><LocateFixed size={15} /> REAL DETECTIONS ONLY</span>
            {boundaryNotice && (
              <div className="mb-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm font-medium text-primary" role="status" data-testid="notice-segment-boundary">
                {boundaryNotice}
              </div>
            )}
            <h2>Which detection is you?</h2>
            <p>These boxes are from the current tracking frame, ranked by distance from your last confirmed position.</p>
            <div className="candidate-list">
              {candidates.map((candidate, index) => (
                <button type="button" key={candidate.id} className="candidate-row" data-testid={`button-candidate-${index + 1}`} onClick={() => onCorrection(candidate)}>
                  <span className="candidate-number">{index + 1}</span><CandidateThumb videoRef={videoRef} box={candidate.box} bundle={bundle} tick={videoReadyTick} /><span className="candidate-copy"><b>Detection {index + 1}</b><small>{candidate.label}{candidate.overlap ? " · overlap" : ""}</small></span><ChevronRight size={16} />
                </button>
              ))}
            </div>
            {candidates.length === 0 && <div className="claim-empty-detections">No valid boxes are visible in this frame. Scrub or use the video to find a clear passage.</div>}
            <button type="button" className="claim-text-button claim-skip-button" data-testid="button-skip-picker" onClick={skipAhead}>I’m hidden — show a clearer passage <FastForward size={14} /></button>
            <p className="claim-key-note">Choose with <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> on your keyboard</p>
          </div>
        )}
        {stage === "look" && (
          <div className="claim-panel claim-panel-overlap" data-testid="panel-take-another-look">
            <span className="claim-context"><ScanSearch size={14} /> OVERLAP RESOLVED</span>
            <div className="overlap-tag"><ScanSearch size={14} /> OVERLAP MOMENT</div>
            <h2>Choose after the crossing</h2>
            <p>We waited for real boxes to separate. Pick the tracked player now — no guess is recorded until a clean frame exists.</p>
            <div className="overlap-callout"><div className="prompt-icon"><ScanSearch size={17} /></div><div><b>Real overlap detected.</b><span>The video is paused on the first later frame where both tracks are separated.</span></div></div>
            <div className="look-controls"><button type="button" className={`look-control ${slow ? "selected" : ""}`} data-testid="button-look-slow" onClick={() => setSlow((value) => !value)}><Gauge size={15} /> Slow motion <kbd>S</kbd></button><button type="button" className="look-control" data-testid="button-look-back" onClick={() => seekTracking(currentTime - 5)}><RotateCcw size={15} /> 5 sec back</button></div>
            <div className="candidate-list">{candidates.map((candidate, index) => <button type="button" key={candidate.id} className="candidate-row" data-testid={`button-overlap-candidate-${index + 1}`} onClick={() => onCorrection(candidate, "overlap-resolved", true)}><span className="candidate-number">{index + 1}</span><CandidateThumb videoRef={videoRef} box={candidate.box} bundle={bundle} tick={videoReadyTick} /><span className="candidate-copy"><b>{candidate.id === currentTrackId ? "Follow this track" : "Crossing track"}</b><small>{candidate.label}</small></span><ChevronRight size={16} /></button>)}</div>
            <button type="button" className="claim-text-button" data-testid="button-skip-overlap" onClick={() => currentTrackId && beginFollowing(currentTrackId)}>Skip this moment — keep the confirmed track <FastForward size={14} /></button>
          </div>
        )}
        {stage === "done" && (
          <div className="claim-panel claim-panel-complete" data-testid="panel-done">
            <div className="complete-graphic"><span className="complete-ring"><Check size={24} /></span><span className="complete-spark spark-a" /><span className="complete-spark spark-b" /><span className="complete-spark spark-c" /></div>
            <h2>Done. That’s all yours.</h2>
             <p>You claimed <b>{Math.round(progressValue)}%</b> of this match. We found the moments where you made the difference.</p>
             <div className="earned-count"><Sparkles size={18} /><b>{clipsUnlocked} earned clips</b><span>ready in My Clips</span></div>
            <button type="button" className="claim-button claim-button-primary claim-button-wide" data-testid="button-done-view-clips" onClick={() => setLocation("/my-clips")}>View your clips <ChevronRight size={17} /></button>
            <button type="button" className="claim-text-button" data-testid="button-done-back-match" onClick={() => setStage("look")}>Take another look <ArrowLeft size={14} /></button>
          </div>
        )}

        <div className="claim-resume-card" data-testid="card-resume-claim"><div className="resume-icon"><Play size={15} fill="currentColor" /></div><div><span className="resume-label">RESUME LATER</span><b>Your place is saved</b><span>Come back anytime — no need to start over.</span></div><LockKeyhole size={15} className="resume-lock" /></div>
        {(allCorrections.length > 0 || autoLinks.length > 0) && stage !== "done" && (
          <div className="claim-correction-status" data-testid="status-correction"><span><Check size={13} /> {autoLinks.length > 0 && undoExpiresAt ? "Stitched through a crossing" : "Correction saved"}</span>{(activeCorrection || (autoLinks.length > 0 && undoExpiresAt > 0)) && <button type="button" data-testid="button-undo-correction" onClick={undo}>Undo</button>}</div>
        )}
    </>
  );

  return (
    <main className="claim-page claim-page-stage" data-testid="page-claim-match">
      <ClaimStage
        videoUrl={recording.videoUrl}
        bundle={bundle}
        candidates={candidates}
        activeTrackId={currentTrackId}
        followBox={stage === "following" || stage === "still" ? followedBox : null}
        showBoxes={stage !== "done"}
        followKey={`${stage}:${currentTrackId ?? ""}:${currentSegmentIndex}`}
        currentTime={currentTime}
        duration={duration}
        playing={playing}
        muted={muted}
        slow={slow}
        playbackRate={playbackRate}
        goalTimes={goalTimes}
        videoRef={videoRef}
        onToggle={handlePlay}
        onSeek={handleSeek}
        onSkip={seekBy}
        onToggleSlow={() => setSlow((value) => !value)}
        onCyclePlaybackRate={cyclePlaybackRate}
        onToggleMute={() => setMuted((value) => !value)}
        onTap={handleVideoTap}
        onTimeUpdate={(value) => setCurrentTime(fromVideoTime(value))}
        onVideoReady={() => setVideoReadyTick((value) => value + 1)}
        topLeft={(
          <>
            <button type="button" className="claim-back" data-testid="button-back-claim" onClick={handleBack}><ArrowLeft size={17} /><span>Leave claim</span></button>
            <div className="claim-stage-title"><b>{recording.fieldName || "Amman Sports City"}</b><span>{recording.court || ""}{recording.date ? ` · ${recording.date}` : ""}{recording.score ? ` · ${recording.score}` : ""}</span></div>
          </>
        )}
        topRight={(
          <div className="claim-save-status" data-testid="status-claim-saving"><span className={notice === "Saving" ? "saving-dot" : "saved-dot"} /> {notice || (isOffline ? "Saved on this device" : "Progress saves automatically")}{queuedCount > 0 && ` · ${queuedCount} waiting to sync`}{segmentLoading ? " · loading tracking…" : ""}</div>
        )}
        panel={panelBody}
      />
    </main>
  );
}