import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  FastForward,
  LocateFixed,
  LockKeyhole,
  MapPinned,
  Play,
  RotateCcw,
  ScanSearch,
  Sparkles,
  X,
} from "lucide-react";
import { useLocation, useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getGetClaimMatchQueryKey,
  useCreateClaimMatchOffPitchSpan,
  useCreateClaimMatchCorrection,
  useDeleteClaimMatchOffPitchSpan,
  useGetClaimMatch,
  useUndoClaimMatchCorrection,
  useUpdateClaimMatchProgress,
  useResetClaimMatchDemo,
} from "@workspace/api-client-react";
import type {
  ClaimCorrection,
  ClaimMatchResponse,
  ClaimOffPitchInput,
  ClaimPlayerStats,
  TrackingSegment,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { useTranslation } from "@/i18n";
import { ClaimStage } from "@/components/ClaimStage";
import { ClaimInlineConfirmation } from "@/components/ClaimInlineConfirmation";
import { useFullscreenVideo } from "@/lib/fullscreen-video";
import {
  boxesOverlap,
  findHitTracks,
  frameToTrackingSeconds,
  trackingSecondsToFrame,
  trackingToVideoTime,
  videoTimeToTracking,
  clampToTracked,
  type ClaimBundle,
  type ClaimBox,
  type ClaimTrack,
} from "@/lib/claim-match-engine";
import {
  enqueueClaimAction,
  readClaimQueue,
  removeClaimAction,
  removeClaimActionsForRecording,
  type ClaimQueueAction,
} from "@/lib/claim-match-storage";
import {
  createClaimQueueFlushController,
  flushClaimQueue,
  isPermanentClaimQueueError,
} from "@/lib/claim-match-queue";
import {
  retainNearbySegments,
  segmentIndexAtTime,
} from "@/lib/claim-match-segments";
import {
  buildClaimAnchors,
  claimAnswerMoment,
  nearestAnchorIndex,
  nextUnansweredAnchor,
} from "@/lib/claim-match-anchors";
import { applyClaimIdentities, identityMapMatchesBundle } from "@/lib/claim-match-identities";

type Stage = "find" | "picker" | "done";
const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 2] as const;
const EMPTY_ANCHOR_TRACK = "__none__";
type Candidate = {
  id: string;
  label: string;
  box: ClaimBox;
  overlap?: boolean;
  distance?: number;
  coasting?: boolean;
  taken?: boolean;
};

type ClaimOffPitchSpan = {
  id: number;
  clientId: string;
  fromSeconds: number;
  toSeconds: number;
  createdAt: string;
};

type OffPitchConflictState = {
  payload: ClaimOffPitchInput;
  rangeCount: number | null;
  answerCount: number | null;
  queueActionId?: string;
};

type ClaimConfirmation =
  | { kind: "offPitchConflict"; conflict: OffPitchConflictState }
  | { kind: "demoReset" };

function readOffPitchConflict(
  error: unknown,
  payload: ClaimOffPitchInput,
  queueActionId?: string,
): OffPitchConflictState | null {
  if (!error || typeof error !== "object" || (error as { status?: unknown }).status !== 409) return null;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    return { payload, rangeCount: null, answerCount: null, queueActionId };
  }
  const body = data as { conflicts?: unknown; correctionCount?: unknown };
  return {
    payload,
    rangeCount: Array.isArray(body.conflicts) ? body.conflicts.length : null,
    answerCount: typeof body.correctionCount === "number" && Number.isFinite(body.correctionCount)
      ? body.correctionCount
      : null,
    queueActionId,
  };
}

function segmentAsBundle(
  manifest: ClaimMatchResponse["manifest"],
  segment: TrackingSegment,
) {
  // identityDecisions is passed even when the identity map itself is stale:
  // a piece the board struck off is struck off regardless of whether its
  // groupings still match this bundle, and offering a deleted player is worse
  // than offering an ungrouped one.
  const applied = identityMapMatchesBundle(manifest)
    ? applyClaimIdentities(segment, manifest.identities, manifest.identityDecisions)
    : applyClaimIdentities(segment, undefined, manifest.identityDecisions);
  const totalDuration = Math.max(
    manifest.duration,
    ...manifest.segments.map((range) => range.endSeconds),
  );
  return {
    version: manifest.version,
    label: manifest.label,
    width: manifest.width,
    height: manifest.height,
    frameRate: manifest.frameRate,
    frameCount: manifest.frameCount,
    duration: totalDuration,
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

function PlayerHeatmap({ heatmap }: Pick<ClaimPlayerStats, "heatmap">) {
  const cells = new Map(
    heatmap.cells.map((cell) => [
      `${Math.min(11, Math.floor(cell.x * 12))}:${Math.min(7, Math.floor(cell.y * 8))}`,
      cell.weight,
    ]),
  );
  const maxWeight = Math.max(...cells.values(), 0);
  return (
    <div className="claim-heatmap" data-testid="claim-player-heatmap" aria-label={`Player position heatmap in ${heatmap.coordinateSpace === "pitch" ? "pitch" : "camera"} coordinates`}>
      {Array.from({ length: 96 }, (_, index) => {
        const column = index % 12;
        const row = Math.floor(index / 12);
        const weight = cells.get(`${column}:${row}`) ?? 0;
        const intensity = maxWeight > 0 ? weight / maxWeight : 0;
        return (
          <span
            key={`${column}-${row}`}
            className="claim-heatmap-cell"
            style={{ opacity: intensity ? 0.12 + intensity * 0.88 : 0.08 }}
            title={weight ? `${Math.round(weight * 100)}% of confirmed time` : undefined}
          />
        );
      })}
      <span className="claim-heatmap-line claim-heatmap-line-mid" />
      <span className="claim-heatmap-circle" />
      <span className="claim-heatmap-goal claim-heatmap-goal-left" />
      <span className="claim-heatmap-goal claim-heatmap-goal-right" />
    </div>
  );
}

function detectionAtFrame(track: ClaimTrack, frame: number, tolerance = 2): ClaimBox | null {
  const box = track.boxes.reduce<ClaimBox | null>((nearest, candidate) => {
    if (Math.abs(candidate.frame - frame) > tolerance) return nearest;
    if (!nearest || Math.abs(candidate.frame - frame) < Math.abs(nearest.frame - frame)) return candidate;
    return nearest;
  }, null);
  return box;
}

function candidateMatchesTakenFragment(
  candidateId: string,
  frame: number,
  rawSegment: TrackingSegment,
  manifest: ClaimMatchResponse["manifest"],
  fragment: ClaimMatchResponse["progress"]["takenFragments"][number],
): boolean {
  const rawTrack = rawSegment.tracks.find((track) => track.id === candidateId);
  if (rawTrack) {
    return rawTrack.id === fragment.trackId
      && rawTrack.boxes.some((box) => box.frame === frame)
      && frame >= fragment.fromFrame
      && frame <= fragment.toFrame;
  }
  const identity = manifest.identities?.find((item) => item.id === candidateId);
  return Boolean(identity?.parts.some((part) =>
    part.trackId === fragment.trackId
    && frame >= part.fromFrame
    && frame <= part.toFrame
    && rawSegment.tracks.some((track) =>
      track.id === part.trackId && track.boxes.some((box) => box.frame === frame))));
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

function captionForTrack(track: ClaimTrack, frame: number, bundle: ClaimBundle) {
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
  return `${movement}${direction}`;
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
  const { t } = useTranslation();
  const isDemo = !params.id || params.id === "demo";
  const recordingId = isDemo ? 0 : Number(params.id);
  const queryKey = useMemo(() => getGetClaimMatchQueryKey(recordingId), [recordingId]);
  const responseQueryKey = useMemo(
    () => (isDemo ? ["claim-match", "demo"] as const : queryKey),
    [isDemo, queryKey],
  );
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
  const createOffPitch = useCreateClaimMatchOffPitchSpan();
  const deleteOffPitch = useDeleteClaimMatchOffPitchSpan();
  const resetClaimDemo = useResetClaimMatchDemo();
  const updateProgressAsync = updateProgress.mutateAsync;
  const createCorrectionAsync = createCorrection.mutateAsync;
  const undoCorrectionAsync = undoCorrection.mutateAsync;
  const createOffPitchAsync = createOffPitch.mutateAsync;
  const deleteOffPitchAsync = deleteOffPitch.mutateAsync;
  const queryClient = useQueryClient();
  const queueFlushControllerRef = useRef(createClaimQueueFlushController());
  const queueSyncRef = useRef({
    updateProgressAsync,
    createCorrectionAsync,
    undoCorrectionAsync,
    createOffPitchAsync,
    deleteOffPitchAsync,
    queryClient,
    responseQueryKey,
    activeRecordingId: 0,
  });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { setFullscreenVideo } = useFullscreenVideo();
  const [stage, setStage] = useState<Stage>("find");
  const [currentTime, setCurrentTime] = useState(0);
  const seekRequestIdRef = useRef(0);
  const [seekRequest, setSeekRequest] = useState<{ id: number; videoTime: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [slow, setSlow] = useState(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [anchorMode, setAnchorMode] = useState(false);
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  const [clipsUnlocked, setClipsUnlocked] = useState(0);
  const [corrections, setCorrections] = useState<ClaimCorrection[]>([]);
  const [notice, setNotice] = useState("");
  const [queuedCount, setQueuedCount] = useState(0);
  const [completionSyncPending, setCompletionSyncPending] = useState(false);
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  const [queueRetryToken, setQueueRetryToken] = useState(0);
  const [resettingDemo, setResettingDemo] = useState(false);
  const [demoResetError, setDemoResetError] = useState("");
  const [confirmation, setConfirmation] = useState<ClaimConfirmation | null>(null);
  const [segmentCache, setSegmentCache] = useState<Record<number, TrackingSegment>>({});
  const segmentCacheRef = useRef<Record<number, TrackingSegment>>({});
  const segmentRequestsRef = useRef<Record<number, Promise<void>>>({});
  const pendingSeekTrackingRef = useRef<number | null>(null);
  const [segmentLoading, setSegmentLoading] = useState(false);
  const [segmentError, setSegmentError] = useState("");
  const [segmentRetryToken, setSegmentRetryToken] = useState(0);
  const [videoReadyTick, setVideoReadyTick] = useState(0);
  const [offPitchStart, setOffPitchStart] = useState<number | null>(null);
  const [offPitchSaving, setOffPitchSaving] = useState(false);
  const snappedAnchorRef = useRef<string | null>(null);
  const anchorAnswerNonceRef = useRef(0);
  const offPitchNonceRef = useRef(0);
  const undoneClientIdsRef = useRef(new Set<string>());
  const restoredRecordingRef = useRef<number | null>(null);
  const resumeTrackingTimeRef = useRef<number | null>(null);
  const videoRestoreKeyRef = useRef<string | null>(null);

  const response = isDemo ? demoQuery.data : claimQuery.data;
  const activeRecordingId = isDemo ? response?.recording.id || 0 : recordingId;
  queueSyncRef.current = {
    updateProgressAsync,
    createCorrectionAsync,
    undoCorrectionAsync,
    createOffPitchAsync,
    deleteOffPitchAsync,
    queryClient,
    responseQueryKey,
    activeRecordingId,
  };
  const recording = response?.recording;
  const manifest = response?.manifest;
  const serverProgress = response?.progress;
  const offPitchSpans = (response?.offPitchSpans ?? []) as ClaimOffPitchSpan[];
  useEffect(() => {
    if (manifest && manifest.identities?.length && !identityMapMatchesBundle(manifest)) {
      setNotice("This recording's identity map belongs to an older tracking bundle, so it was not applied. An admin must reload the Identity Board and save it again.");
    }
  }, [manifest]);
  const allCorrections = useMemo(() => {
    const remote = response?.corrections || [];
    const remoteIds = new Set(remote.map((item) => item.clientId));
    return [...remote, ...corrections.filter((item) => !remoteIds.has(item.clientId))];
  }, [corrections, response]);
  const duration = manifest
    ? Math.max(manifest.duration, ...manifest.segments.map((segment) => segment.endSeconds), 1)
    : 1;
  const progressValue = serverProgress?.coveragePercent ?? 0;
  const earnedClips = serverProgress?.earnedClips || [];
  const playerStats = serverProgress?.playerStats;
  const currentSegmentIndex = manifest ? segmentIndexAtTime(manifest, currentTime) : 0;
  const activeSegment = segmentCache[currentSegmentIndex];
  const bundle = useMemo(
    () => (manifest && activeSegment ? segmentAsBundle(manifest, activeSegment) : null),
    [activeSegment, manifest],
  );
  const goalTimes = (bundle?.events ?? [])
    .filter((event) => event.type.toLowerCase() === "goal")
    .map((event) => event.time);
  const claimAnchors = useMemo(
    // Anchor ids are derived from their stable tracking times, never from the
    // currently loaded segment's array position.
    () => buildClaimAnchors(duration, [], duration < 120 ? 4 : 8, offPitchSpans),
    [duration, offPitchSpans],
  );
  const answeredAnchorMoments = useMemo(
    () => allCorrections
      .filter((item) => !item.undone && item.answerMethod.startsWith("anchor-"))
      .map((item) => item.momentSeconds),
    [allCorrections],
  );
  const nextAnchorIndex = nextUnansweredAnchor(claimAnchors, answeredAnchorMoments);
  const currentAnchor = activeAnchorId
    ? claimAnchors.find((anchor) => anchor.id === activeAnchorId) ?? null
    : claimAnchors[nextAnchorIndex] ?? null;
  const unresolvedAnchorReviews = useMemo(
    () => [...new Set([
      ...(serverProgress?.unresolvedMoments ?? []),
      ...(serverProgress?.conflictMoments ?? []),
    ])]
      .map((momentSeconds) => {
        const index = nearestAnchorIndex(claimAnchors, momentSeconds);
        return {
          momentSeconds,
          index,
          conflict: (serverProgress?.conflictMoments ?? []).includes(momentSeconds),
        };
      })
      .filter((item) => item.index >= 0),
    [claimAnchors, serverProgress?.conflictMoments, serverProgress?.unresolvedMoments],
  );
  const hasData = Boolean(response && recording && manifest && serverProgress);
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

  // The saved tracking position can be restored before HLS has attached to the
  // video element. Keep it separate from the live playhead and apply it once
  // when the media element is ready, rather than re-seeking on every timeupdate.
  useEffect(() => {
    videoRestoreKeyRef.current = null;
  }, [activeRecordingId, recording?.videoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    const resumeTrackingTime = resumeTrackingTimeRef.current;
    if (!video || !bundle || resumeTrackingTime === null || video.readyState < 1) return;
    const restoreKey = `${activeRecordingId}:${recording?.videoUrl ?? ""}`;
    if (videoRestoreKeyRef.current === restoreKey) return;
    const targetVideoTime = toVideoTime(resumeTrackingTime);
    if (!Number.isFinite(targetVideoTime)) return;
    video.currentTime = targetVideoTime;
    videoRestoreKeyRef.current = restoreKey;
  }, [activeRecordingId, bundle, currentTime, recording?.videoUrl, toVideoTime, videoReadyTick]);

  /** The only way this page moves the playhead. Tracking seconds in. */
  const seekTracking = useCallback((trackingSeconds: number) => {
    const next = bundle ? clampToTracked(trackingSeconds, bundle) : Math.max(0, trackingSeconds);
    pendingSeekTrackingRef.current = next;
    setCurrentTime(next);
    const targetVideoTime = toVideoTime(next);
    if (Number.isFinite(targetVideoTime)) {
      setSeekRequest({
        id: ++seekRequestIdRef.current,
        videoTime: targetVideoTime,
      });
    }
    if (videoRef.current && Number.isFinite(targetVideoTime)) {
      // Move the real media immediately, even when the tracking overlay for the
      // target segment is still loading. The overlay segment can catch up
      // asynchronously; waiting here makes the boxes move while the video
      // remains on the old picture.
      videoRef.current.currentTime = targetVideoTime;
    }
  }, [bundle, toVideoTime]);

  useEffect(() => {
    const pending = pendingSeekTrackingRef.current;
    if (pending === null || !manifest || !activeSegment || !bundle) return;
    if (activeSegment.segmentIndex !== segmentIndexAtTime(manifest, pending)) return;
    videoRef.current?.pause();
    if (videoRef.current) {
      const targetVideoTime = toVideoTime(pending);
      videoRef.current.currentTime = targetVideoTime;
      if (Math.abs(videoRef.current.currentTime - targetVideoTime) <= 0.5) {
        pendingSeekTrackingRef.current = null;
      }
    }
  }, [activeSegment, bundle, manifest, toVideoTime]);

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
    nextPosition = currentTime,
  ) => {
    const payload = {
      currentTrackId: null,
      stage: nextStage,
      confirmedFromSeconds: 0,
      currentPositionSeconds: nextPosition,
      claimedPercent: progressValue,
      clipsUnlocked: serverProgress?.clipsUnlocked ?? clipsUnlocked,
      completed: nextStage === "done",
      earnedClips,
    };
    if (isOffline) {
      if (nextStage === "done") {
        setCompletionSyncPending(true);
        setNotice("Completion saved on this device · will sync when you’re back");
      }
      void queueProgress(payload);
    } else {
      setNotice("Saving");
      updateProgress.mutate({ id: activeRecordingId, data: payload }, {
        onSuccess: (saved) => {
          queryClient.setQueryData<ClaimMatchResponse>(responseQueryKey, (current) => {
            if (!current || (current.progress.completed && !saved.completed)) return current;
            return { ...current, progress: saved };
          });
          setClipsUnlocked(saved.clipsUnlocked);
          if (saved.completed) {
            setStage("done");
            setAnchorMode(false);
            setCompletionSyncPending(false);
            setNotice("Match claimed · your tracking summary is ready");
          } else {
            setNotice("Saved just now");
          }
        },
        onError: (error) => {
          // A 4xx is a server decision, not a connectivity problem. Queuing it
          // showed the user "Saved on this device - will sync when you're
          // back", and the queue then discarded it permanently on the next
          // flush (claim-match-queue treats 4xx as permanent). The answer was
          // gone and nothing ever said so. Only queue what retrying can fix.
          if (isPermanentClaimQueueError(error)) {
            setNotice("This match could not be saved to your account. Your answers on this page are not being kept - reload once an admin has made the recording available.");
            return;
          }
          if (nextStage === "done") setCompletionSyncPending(true);
          void queueProgress(payload);
        },
      });
    }
  }, [clipsUnlocked, currentTime, earnedClips, isOffline, activeRecordingId, progressValue, queryClient, queueProgress, responseQueryKey, serverProgress?.clipsUnlocked, updateProgress]);

  const openAnchorReview = useCallback((index: number) => {
    const anchor = claimAnchors[index];
    if (!anchor) return;
    setAnchorMode(true);
    setActiveAnchorId(anchor.id);
    setStage("picker");
    setPlaying(false);
    videoRef.current?.pause();
    seekTracking(anchor.momentSeconds);
    if (!serverProgress?.completed) saveProgress("picker", anchor.momentSeconds);
    setNotice(`Identity check · ${formatTime(anchor.momentSeconds)}`);
  }, [claimAnchors, saveProgress, seekTracking, serverProgress?.completed]);

  const startAnchorReview = useCallback(() => {
    const first = nextUnansweredAnchor(claimAnchors, answeredAnchorMoments);
    openAnchorReview(first >= 0 ? first : 0);
  }, [answeredAnchorMoments, claimAnchors, openAnchorReview]);

  const toggleVideoPlayback = useCallback(() => {
    const next = !playing;
    setPlaying(next);
    const video = videoRef.current;
    if (!video) return;
    if (next) void video.play().catch(() => setPlaying(false));
    else video.pause();
  }, [playing]);

  const candidateFrame = currentFrame;

  useEffect(() => {
    if (stage !== "picker" || !currentAnchor || !bundle) {
      if (stage !== "picker") snappedAnchorRef.current = null;
      return;
    }
    if (snappedAnchorRef.current === currentAnchor.id) return;
    snappedAnchorRef.current = currentAnchor.id;
    const anchorFrame = trackingSecondsToFrame(currentAnchor.momentSeconds, bundle);
    const detectionFrame = nearestDetectionFrame(bundle, bundle.tracks, anchorFrame);
    if (detectionFrame !== null) {
      seekTracking(frameToTrackingSeconds(detectionFrame, bundle));
    } else {
      seekTracking(currentAnchor.momentSeconds);
    }
  }, [bundle, currentAnchor, seekTracking, stage]);

  const candidates = useMemo<Candidate[]>(() => {
    if (!bundle || !activeSegment || !manifest) return [];
    const anchor = { x: bundle.width / 2, y: bundle.height / 2 };
    const ranked = bundle.tracks
      .map((track) => {
        const box = detectionAtFrame(track, candidateFrame);
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
    return ranked
      .sort((a, b) => a.distance - b.distance)
      .map(({ track, box, distance }) => ({
        id: track.id,
         label: captionForTrack(track, candidateFrame, bundle),
        box,
        distance,
        coasting: Boolean((box as { interpolated?: boolean }).interpolated),
      }))
      .map((candidate, index, all) => ({
        ...candidate,
        overlap: all.some((other) => other.id !== candidate.id && boxesOverlap(candidate.box, other.box)),
        taken: serverProgress?.takenFragments.some((fragment) =>
          !fragment.ownedByCurrentUser
          && candidateMatchesTakenFragment(candidate.id, candidateFrame, activeSegment, manifest, fragment)) ?? false,
      }));
  }, [activeSegment, bundle, candidateFrame, manifest, serverProgress?.takenFragments]);

  useEffect(() => {
    if (!response || restoredRecordingRef.current === activeRecordingId) return;
    restoredRecordingRef.current = activeRecordingId;
    const savedAnchorMoments = response.corrections
      .filter((item) => !item.undone && item.answerMethod.startsWith("anchor-"))
      .map((item) => item.momentSeconds);
    const savedAnchorIndex = nextUnansweredAnchor(claimAnchors, savedAnchorMoments);
    const unresolvedIndex = (response.progress.unresolvedMoments ?? [])
      .concat(response.progress.conflictMoments ?? [])
      .map((moment) => nearestAnchorIndex(claimAnchors, moment))
      .find((index) => index >= 0) ?? -1;
    // savedAnchorIndex is -1 when every anchor is answered. Falling through to
    // 0 dropped a user who had finished all eight back onto checkpoint 1 with
    // nothing saying why. Send them to the last one instead, so the review
    // reads as finished rather than restarted.
    const allAnchorsAnswered = savedAnchorIndex < 0 && savedAnchorMoments.length > 0;
    const reviewIndex = savedAnchorIndex >= 0
      ? savedAnchorIndex
      : unresolvedIndex >= 0
        ? unresolvedIndex
        : allAnchorsAnswered
          ? Math.max(0, claimAnchors.length - 1)
          : 0;
    // Any saved answer at all means this is not a first run. The old test only
    // recognised anchor-era state, so a recording carrying corrections from
    // the retired "continuous following" flow -- which the server still
    // persists as stage "following" -- showed the first-run identity prompt on
    // every load despite having real saved answers.
    const hasSavedAnchorState = savedAnchorMoments.length > 0
      || response.progress.answeredAnchorCount > 0
      || response.progress.stage === "picker"
      || response.progress.stage === "following"
      || response.corrections.some((item) => !item.undone)
      || unresolvedIndex >= 0;
    const resumeReview = !response.progress.completed && claimAnchors.length > 0 && hasSavedAnchorState;
    resumeTrackingTimeRef.current = resumeReview
      ? claimAnchors[reviewIndex].momentSeconds
      : response.progress.currentPositionSeconds || 0;
    setAnchorMode(resumeReview);
    setActiveAnchorId(resumeReview ? claimAnchors[reviewIndex].id : null);
    setStage(response.progress.completed ? "done" : resumeReview ? "picker" : "find");
    if (response.progress.completed) setCompletionSyncPending(false);
    setCurrentTime(response.progress.currentPositionSeconds || 0);
    setClipsUnlocked(response.progress.clipsUnlocked || 0);
    setCorrections(response.corrections);
    if (resumeReview) {
      setCurrentTime(claimAnchors[reviewIndex].momentSeconds);
      setPlaying(false);
      videoRef.current?.pause();
    }
  }, [activeRecordingId, claimAnchors, response]);

  const lastSavedPosition = useRef(0);
  useEffect(() => {
    if (currentTime <= 0 || Math.abs(currentTime - lastSavedPosition.current) < 10) return;
    // Never let the position autosave demote a saved review back to "find".
    // Once a load had wrongly shown the first-run prompt, the next autosave
    // wrote stage:"find" over a stored "picker" and made the wrong state
    // permanent. Position is what this save is for; stage is not its business.
    const storedStage = serverProgress?.stage;
    const stageToSave = stage === "find" && (storedStage === "picker" || storedStage === "following")
      ? (storedStage as Stage)
      : stage;
    lastSavedPosition.current = currentTime;
    saveProgress(stageToSave, currentTime);
  }, [currentTime, progressValue, saveProgress, serverProgress?.stage, stage]);

  // Hides the tab bar and stops OrientationLock covering a phone held sideways -
  // this page is the player, like VideoPlayer on the field page.
  useEffect(() => {
    setFullscreenVideo(true);
    return () => setFullscreenVideo(false);
  }, [setFullscreenVideo]);

  useEffect(() => {
    const updateOnline = () => {
      const offline = !navigator.onLine;
      setIsOffline(offline);
      if (!offline) setQueueRetryToken((value) => value + 1);
    };
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    void readClaimQueue().then((items) => setQueuedCount(items.length));
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  const canFlushQueue = !isOffline && Boolean(user) && !isGuest;
  const flushQueue = useCallback(async () => {
    if (!canFlushQueue) return;
    const context = queueSyncRef.current;
    let queuedOffPitchConflict: OffPitchConflictState | null = null;
    const result = await queueFlushControllerRef.current.flush(() =>
      flushClaimQueue({
        readActions: readClaimQueue,
        removeAction: removeClaimAction,
        syncAction: async (action) => {
          if (action.kind === "progress") {
            await context.updateProgressAsync({ id: action.recordingId, data: action.payload as never });
          } else if (action.kind === "correction") {
            await context.createCorrectionAsync({ id: action.recordingId, data: action.payload as never });
          } else if (action.kind === "undo") {
            await context.undoCorrectionAsync({ correctionId: action.correctionId });
          } else if (action.kind === "offPitchCreate") {
            try {
              await context.createOffPitchAsync({
                id: action.recordingId,
                data: action.payload as unknown as ClaimOffPitchInput,
              });
            } catch (error) {
              queuedOffPitchConflict = readOffPitchConflict(
                error,
                action.payload as unknown as ClaimOffPitchInput,
                action.id,
              );
              throw error;
            }
          } else {
            await context.deleteOffPitchAsync({
              id: action.recordingId,
              clientId: action.clientId,
            });
          }
        },
      }),
    );
    setQueuedCount(result.remaining.length);
    if (queuedOffPitchConflict) {
      setConfirmation({ kind: "offPitchConflict", conflict: queuedOffPitchConflict });
    }
    if (result.discarded.length > 0) {
      setNotice(`${result.discarded.length} queued answer${result.discarded.length === 1 ? "" : "s"} could not be applied and was removed`);
    }
    if (result.changed) {
      await context.queryClient.invalidateQueries({ queryKey: context.responseQueryKey });
      if (result.succeeded.some((action) => action.recordingId === context.activeRecordingId)) {
        setCompletionSyncPending(false);
      }
    }
  }, [canFlushQueue]);

  useEffect(() => {
    if (canFlushQueue) void flushQueue();
  }, [canFlushQueue, flushQueue, queueRetryToken]);

  useEffect(() => {
    if (!playing || recording?.videoUrl) return;
    const timer = window.setInterval(() => {
      const rate = slow ? 0.5 : playbackRate;
      setCurrentTime((value) => Math.min(duration, value + (0.8 * rate)));
    }, 800);
    return () => window.clearInterval(timer);
  }, [duration, playbackRate, playing, recording?.videoUrl, slow]);

  const recordAnchorAnswer = useCallback((
    answer: "yes" | "no" | "skip",
    chosenTrackId: string = EMPTY_ANCHOR_TRACK,
  ) => {
    if (!anchorMode || !currentAnchor || !bundle) return;
    // Prefer a nearby usable detection so exports stay aligned with what was
    // shown, but never let a missing detection move the answer to frame zero
    // or another unrelated part of the match.
    const anchorFrame = trackingSecondsToFrame(currentAnchor.momentSeconds, bundle);
    const detectionFrame = nearestDetectionFrame(bundle, bundle.tracks, anchorFrame);
    const nearestDetectionSeconds = detectionFrame === null
      ? null
      : frameToTrackingSeconds(detectionFrame, bundle);
    const momentSeconds = claimAnswerMoment(currentAnchor.momentSeconds, nearestDetectionSeconds);
    const answerMethod = `anchor-${answer}`;
    const nextIndex = nextUnansweredAnchor(
      claimAnchors,
      [...answeredAnchorMoments, currentAnchor.momentSeconds],
    );
    const payload = {
      clientId: `claim-${activeRecordingId}-${currentAnchor.id}-${Date.now()}-${++anchorAnswerNonceRef.current}`,
      momentSeconds,
      rejectedTrackId: null,
      chosenTrackId: answer === "yes" ? chosenTrackId : EMPTY_ANCHOR_TRACK,
      answerMethod,
      questionCount: nextAnchorIndex >= 0 ? nextAnchorIndex : 0,
    };
    const optimistic: ClaimCorrection = {
      id: -Date.now(),
      ...payload,
      recordingId: activeRecordingId,
      undone: false,
      createdAt: new Date().toISOString(),
    };
    setCorrections((items) => [...items, optimistic]);
    setNotice(answer === "yes" ? "Answer saved · finding another moment" : "Moment noted · finding another moment");
    const queueAction = {
      id: `correction-${payload.clientId}`,
      kind: "correction" as const,
      recordingId: activeRecordingId,
      payload: { ...payload },
      createdAt: Date.now(),
    };
    if (isOffline) {
      if (nextIndex < 0) setCompletionSyncPending(true);
      void enqueueClaimAction(queueAction).then(async () => setQueuedCount((await readClaimQueue()).length));
    } else {
      void createCorrectionAsync({ id: activeRecordingId, data: payload })
        .then(async (correction) => {
          const wasUndone = undoneClientIdsRef.current.has(optimistic.clientId);
          setCorrections((items) => items.map((item) => item.id === optimistic.id
            ? { ...correction, undone: wasUndone }
            : item));
          if (wasUndone) {
            undoneClientIdsRef.current.delete(optimistic.clientId);
            await undoCorrectionAsync({ correctionId: correction.id });
          }
          await queryClient.refetchQueries({ queryKey: responseQueryKey, type: "active" });
          const latest = queryClient.getQueryData<ClaimMatchResponse>(responseQueryKey);
          if (latest?.progress.completed) {
            setAnchorMode(false);
            setActiveAnchorId(null);
            setStage("done");
            setCompletionSyncPending(false);
            setNotice("Match claimed · your tracking summary is ready");
            return;
          }
          const latestMoments = latest?.corrections
            .filter((item) => !item.undone && item.answerMethod.startsWith("anchor-"))
            .map((item) => item.momentSeconds) ?? [];
          const nextServerIndex = nextUnansweredAnchor(claimAnchors, latestMoments);
          const unresolvedIndex = (latest?.progress.unresolvedMoments ?? [])
            .concat(latest?.progress.conflictMoments ?? [])
            .map((moment) => nearestAnchorIndex(claimAnchors, moment))
            .find((index) => index >= 0) ?? -1;
          const reviewIndex = nextServerIndex >= 0 ? nextServerIndex : unresolvedIndex;
          if (reviewIndex >= 0) {
            setAnchorMode(true);
            setActiveAnchorId(claimAnchors[reviewIndex].id);
            setStage("picker");
            setPlaying(false);
            videoRef.current?.pause();
            seekTracking(claimAnchors[reviewIndex].momentSeconds);
            setCompletionSyncPending(false);
            setNotice("Coverage is still building · check the next moment");
          } else {
            setAnchorMode(true);
            setActiveAnchorId(null);
            setStage("picker");
            setCompletionSyncPending(true);
            setNotice("All identity moments answered · checking your saved coverage");
          }
        })
        .catch((error) => {
          if (undoneClientIdsRef.current.delete(optimistic.clientId)) return;
          if (isPermanentClaimQueueError(error, queueAction)) {
            // Same reason as the progress path: queueing a 4xx tells the user
            // it was saved and then throws it away. Say what happened instead.
            setCorrections((current) => current.filter((item) => item.clientId !== optimistic.clientId));
            setNotice("That answer was rejected by the server and has not been saved. Reload to see the current state.");
            return;
          }
          if (nextIndex < 0) setCompletionSyncPending(true);
          void enqueueClaimAction(queueAction).then(async () => setQueuedCount((await readClaimQueue()).length));
        });
    }
    if (nextIndex < 0) {
      setActiveAnchorId(null);
      setStage("picker");
      setNotice(isOffline ? "All moments answered on this device · will finish when you’re back online" : "All identity moments answered · checking your saved coverage");
    } else {
      const nextAnchor = claimAnchors[nextIndex];
      setActiveAnchorId(nextAnchor.id);
      setStage("picker");
      setPlaying(false);
      videoRef.current?.pause();
      seekTracking(nextAnchor.momentSeconds);
    }
  }, [
    activeRecordingId,
    anchorMode,
    answeredAnchorMoments,
    bundle,
    candidateFrame,
    claimAnchors,
    createCorrectionAsync,
    currentAnchor,
    anchorAnswerNonceRef,
    isOffline,
    queryClient,
    responseQueryKey,
    seekTracking,
    undoCorrectionAsync,
  ]);

  const onCorrection = useCallback((chosen: Candidate) => {
    if (!bundle || !anchorMode) return;
    if (chosen.taken) {
      setNotice("That fragment is already vouched for by another claimant");
      return;
    }
    recordAnchorAnswer("yes", chosen.id);
  }, [anchorMode, bundle, recordAnchorAnswer]);

  const undo = useCallback(() => {
    const active = [...allCorrections]
      .filter((item) => !item.undone)
      .sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        return bTime - aTime || b.id - a.id;
      })[0];
    if (!active) {
      setNotice("Nothing to undo yet");
      return;
    }

    setCorrections((items) => items.map((item) => item.clientId === active.clientId ? { ...item, undone: true } : item));
    setActiveAnchorId(null);
    setAnchorMode(true);
    setStage("picker");
    if (active.id < 0) {
      undoneClientIdsRef.current.add(active.clientId);
      void removeClaimAction(`correction-${active.clientId}`).then(async () => {
        setQueuedCount((await readClaimQueue()).length);
        setNotice("Newest answer undone before syncing");
      });
      return;
    }
    if (isOffline) {
      void enqueueClaimAction({
        id: `undo-${active.id}`,
        kind: "undo",
        recordingId: activeRecordingId,
        correctionId: active.id,
        createdAt: Date.now(),
      }).then(async () => setQueuedCount((await readClaimQueue()).length));
      setNotice("Newest answer undone · will sync when you’re back online");
      return;
    }
    void undoCorrectionAsync({ correctionId: active.id })
      .then(async () => {
        await queryClient.refetchQueries({ queryKey: responseQueryKey, type: "active" });
        setNotice("Newest answer undone");
      })
      .catch(() => {
        void enqueueClaimAction({
          id: `undo-${active.id}`,
          kind: "undo",
          recordingId: activeRecordingId,
          correctionId: active.id,
          createdAt: Date.now(),
        }).then(async () => setQueuedCount((await readClaimQueue()).length));
        setNotice("Undo saved on this device · will sync when you’re back online");
      });
  }, [activeRecordingId, allCorrections, isOffline, queryClient, responseQueryKey, undoCorrectionAsync]);

  /*
   * Anchor review is intentionally the only correction path. Taps use the
   * same candidate callback as the keyboard handler, so there is one answer
   * path regardless of input device.
   */
  const onVideoTap = useCallback((x: number, y: number) => {
    if (!bundle) return;
    const hits = findHitTracks(bundle, currentFrame, x, y);
    const chosen = hits[0];
    if (!chosen) {
      setNotice("No player detected at that point in this frame");
      return;
    }
    onCorrection({
      id: chosen.track.id,
      label: captionForTrack(chosen.track, currentFrame, bundle),
      box: chosen.box,
    });
  }, [bundle, currentFrame, onCorrection]);

  /*
   * The old continuous-following correction path is deliberately not used.
   * Keep this handler small and deterministic: every picker selection records
   * the current anchor and advances strictly forward through the anchor list.
   */
  const selectCandidate = onCorrection;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (event.target instanceof HTMLInputElement) return;
      if (event.code === "Space") {
        event.preventDefault();
        toggleVideoPlayback();
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
      } else if ((stage === "find" || stage === "picker") && /^[1-9]$/.test(key)) {
        const candidate = candidates[Number(key) - 1];
        if (candidate) selectCandidate(candidate);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [candidates, selectCandidate, seekBy, slow, stage, toggleVideoPlayback]);

  const handleVideoTimeUpdate = useCallback((videoSeconds: number) => {
    const pending = pendingSeekTrackingRef.current;
    if (pending !== null && manifest) {
      const targetVideoSeconds = pending + (manifest.videoStartSeconds ?? 0);
      if (Math.abs(videoSeconds - targetVideoSeconds) > 0.5) return;
      pendingSeekTrackingRef.current = null;
    }
    setCurrentTime(fromVideoTime(videoSeconds));
  }, [fromVideoTime, manifest]);

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
    setLocation("/home");
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
  const handleVideoReady = () => {
    setVideoReadyTick((value) => value + 1);
  };
  const cyclePlaybackRate = () => {
    setPlaybackRate((current) => {
      const currentIndex = PLAYBACK_SPEEDS.indexOf(current as (typeof PLAYBACK_SPEEDS)[number]);
      return PLAYBACK_SPEEDS[(currentIndex + 1) % PLAYBACK_SPEEDS.length];
    });
    setSlow(false);
  };
  const handlePrimaryAction = () => {
    if (stage === "find") {
      startAnchorReview();
    } else if (stage === "picker" && currentAnchor && candidates[0]) {
      selectCandidate(candidates[0]);
    }
  };

  const queueOffPitchCreate = async (payload: ClaimOffPitchInput) => {
    await enqueueClaimAction({
      id: `offpitch-create-${payload.clientId}`,
      kind: "offPitchCreate",
      recordingId: activeRecordingId,
      payload: { ...payload },
      createdAt: Date.now(),
    });
    setQueuedCount((await readClaimQueue()).length);
  };

  const submitOffPitchSpan = async (
    payload: ClaimOffPitchInput,
    confirmConflict = false,
    queuedActionId?: string,
  ) => {
    setOffPitchSaving(true);
    setNotice(t.fieldDetail.claimYourMatch.offPitchTitle);
    const requestPayload = confirmConflict ? { ...payload, confirmConflict: true } : payload;
    try {
      await createOffPitchAsync({ id: activeRecordingId, data: requestPayload });
      if (queuedActionId) await removeClaimAction(queuedActionId);
      setConfirmation(null);
      setOffPitchStart(null);
      setQueuedCount((await readClaimQueue()).length);
      await queryClient.invalidateQueries({ queryKey: responseQueryKey, refetchType: "active" });
      setNotice(t.fieldDetail.claimYourMatch.offPitchSaved);
    } catch (error) {
      const conflict = readOffPitchConflict(error, requestPayload, queuedActionId);
      if (conflict) {
        setConfirmation({ kind: "offPitchConflict", conflict });
        return;
      }
      await queueOffPitchCreate(requestPayload);
      setOffPitchStart(null);
      setNotice(t.fieldDetail.claimYourMatch.offPitchQueued);
    } finally {
      setOffPitchSaving(false);
    }
  };

  const saveOffPitchSpan = async (fromSeconds: number, toSeconds: number) => {
    if (offPitchSaving || confirmation || toSeconds <= fromSeconds) return;
    const payload: ClaimOffPitchInput = {
      clientId: `offpitch-${activeRecordingId}-${Date.now()}-${++offPitchNonceRef.current}`,
      fromSeconds,
      toSeconds,
    };
    if (isOffline) {
      await queueOffPitchCreate(payload);
      setOffPitchStart(null);
      setNotice(t.fieldDetail.claimYourMatch.offPitchQueued);
      return;
    }
    await submitOffPitchSpan(payload);
  };

  const removeOffPitchSpan = async (span: ClaimOffPitchSpan) => {
    if (offPitchSaving || confirmation) return;
    const queueAction = {
      id: `offpitch-delete-${activeRecordingId}-${span.clientId}`,
      kind: "offPitchDelete" as const,
      recordingId: activeRecordingId,
      clientId: span.clientId,
      createdAt: Date.now(),
    };
    if (isOffline) {
      await enqueueClaimAction(queueAction);
      setQueuedCount((await readClaimQueue()).length);
      setNotice(t.fieldDetail.claimYourMatch.offPitchRemoveQueued);
      return;
    }
    setOffPitchSaving(true);
    try {
      await deleteOffPitchAsync({ id: activeRecordingId, clientId: span.clientId });
      await queryClient.invalidateQueries({ queryKey: responseQueryKey, refetchType: "active" });
      setNotice(t.fieldDetail.claimYourMatch.offPitchRemoved);
    } catch {
      await enqueueClaimAction(queueAction);
      setQueuedCount((await readClaimQueue()).length);
      setNotice(t.fieldDetail.claimYourMatch.offPitchRemoveQueued);
    } finally {
      setOffPitchSaving(false);
    }
  };

  const confirmOffPitchConflict = async () => {
    if (confirmation?.kind !== "offPitchConflict" || offPitchSaving) return;
    await submitOffPitchSpan(
      confirmation.conflict.payload,
      true,
      confirmation.conflict.queueActionId,
    );
  };

  const cancelConfirmation = () => {
    setConfirmation(null);
    setNotice(t.fieldDetail.claimYourMatch.offPitchCancel);
  };

  const requestResetDemo = () => {
    if (!isDemo || resettingDemo) return;
    setConfirmation({ kind: "demoReset" });
  };

  const handleResetDemo = async () => {
    if (!isDemo || resettingDemo) return;
    setConfirmation(null);
    setResettingDemo(true);
    setDemoResetError("");
    setNotice(t.fieldDetail.claimYourMatch.resettingDemo);
    try {
      await queueFlushControllerRef.current.waitForFlush();
      const reset = await resetClaimDemo.mutateAsync();
      await removeClaimActionsForRecording(reset.recordingId);
      setQueuedCount((await readClaimQueue()).length);
      queryClient.setQueryData<ClaimMatchResponse>(responseQueryKey, (current) => {
        if (!current) return current;
        return {
          ...current,
          corrections: [],
          progress: {
            ...current.progress,
            recordingId: reset.recordingId,
            currentTrackId: null,
            stage: "find",
            confirmedFromSeconds: 0,
            currentPositionSeconds: 0,
            claimedPercent: 0,
            coverageSeconds: 0,
            coveragePercent: 0,
            answeredAnchorCount: 0,
            acceptedAnchorCount: 0,
            unresolvedMoments: [],
            conflictMoments: [],
            clipsUnlocked: 0,
            correctionCount: 0,
            completed: false,
            earnedClips: [],
            completionReason: "keep-confirming",
            playerStats: {
              ...current.progress.playerStats,
              confirmedSeconds: 0,
               minutesPlayed: 0,
              coveragePercent: 0,
              answeredMoments: 0,
              acceptedMoments: 0,
              trackedSegments: 0,
              matchedEvents: 0,
               distanceMetres: null,
               averageSpeedMetresPerSecond: null,
            },
            updatedAt: new Date().toISOString(),
          },
        };
      });

      setStage("find");
      setCurrentTime(0);
      setPlaying(false);
      setAnchorMode(false);
      setActiveAnchorId(null);
      setClipsUnlocked(0);
      setCorrections([]);
      undoneClientIdsRef.current.clear();
      setCompletionSyncPending(false);
      setSegmentCache({});
      setSegmentLoading(false);
      setSegmentError("");
      setVideoReadyTick(0);
      resumeTrackingTimeRef.current = 0;
      videoRestoreKeyRef.current = null;
      anchorAnswerNonceRef.current = 0;
      restoredRecordingRef.current = null;
      lastSavedPosition.current = 0;
      segmentCacheRef.current = {};
      segmentRequestsRef.current = {};
      pendingSeekTrackingRef.current = null;
      seekTracking(0);
      setSegmentRetryToken((value) => value + 1);

      await queryClient.invalidateQueries({
        queryKey: responseQueryKey,
        refetchType: "active",
      });
      setNotice(t.fieldDetail.claimYourMatch.demoResetDone);
    } catch {
      setDemoResetError(t.fieldDetail.claimYourMatch.demoResetFailed);
      setNotice(t.fieldDetail.claimYourMatch.demoResetFailed);
    } finally {
      setResettingDemo(false);
    }
  };

  const offPitchConflictCopy = confirmation?.kind === "offPitchConflict"
    && confirmation.conflict.rangeCount !== null
    && confirmation.conflict.answerCount !== null
    ? t.fieldDetail.claimYourMatch.offPitchConflictCounts(
      confirmation.conflict.rangeCount,
      confirmation.conflict.answerCount,
    )
    : t.fieldDetail.claimYourMatch.offPitchConflictFallback;

  const panelBody = (
    <>
        <div className="claim-coverage-summary" data-testid="claim-coverage-summary">
          <div><span>Match coverage</span><b>{Math.round(progressValue)}%</b></div>
          <small>
            {serverProgress?.coverageSeconds?.toFixed(1) ?? "0.0"} attributed seconds
            {serverProgress ? ` · ${serverProgress.humanVouchedSeconds.toFixed(1)} vouched` : ""}
            {serverProgress?.answeredAnchorCount ? ` · ${serverProgress.answeredAnchorCount} moments answered` : ""}
            {serverProgress?.unresolvedMoments?.length ? ` · ${serverProgress.unresolvedMoments.length} unresolved` : ""}
          </small>
           {completionSyncPending && <small className="claim-completion-sync" role="status">Checking the saved result…</small>}
        </div>
         <div className="claim-offpitch-tools" data-testid="claim-offpitch-tools">
           <div className="claim-offpitch-heading">
             <span><Clock3 size={15} /> {t.fieldDetail.claimYourMatch.offPitchTitle}</span>
             <small>{t.fieldDetail.claimYourMatch.offPitchDesc}</small>
           </div>
           <div className="claim-offpitch-actions">
             <button
               type="button"
               className="claim-button claim-button-secondary"
               data-testid="button-offpitch-toggle"
                disabled={offPitchSaving || Boolean(confirmation)}
               onClick={() => {
                 if (offPitchStart === null) {
                   setOffPitchStart(currentTime);
                   setNotice(t.fieldDetail.claimYourMatch.offPitchChooseEnd);
                 } else {
                   void saveOffPitchSpan(offPitchStart, currentTime);
                 }
               }}
             >
               {offPitchStart === null ? t.fieldDetail.claimYourMatch.offPitchStart : t.fieldDetail.claimYourMatch.offPitchEnd}
             </button>
             {offPitchStart !== null && (
                <button type="button" className="claim-text-button" data-testid="button-offpitch-cancel" disabled={Boolean(confirmation)} onClick={() => {
                 setOffPitchStart(null);
                 setNotice(t.fieldDetail.claimYourMatch.offPitchCancel);
               }}>{t.fieldDetail.claimYourMatch.offPitchCancel}</button>
             )}
           </div>
           {offPitchSpans.length > 0 && (
             <div className="claim-offpitch-list">
               {offPitchSpans.map((span) => (
                 <div className="claim-offpitch-row" key={span.clientId}>
                   <span>{formatTime(span.fromSeconds)} – {formatTime(span.toSeconds)}</span>
                   <button type="button" className="claim-text-button" onClick={() => void removeOffPitchSpan(span)} disabled={offPitchSaving}>{t.fieldDetail.claimYourMatch.offPitchRemove}</button>
                 </div>
               ))}
             </div>
           )}
         </div>
          {confirmation?.kind === "offPitchConflict" && (
            <ClaimInlineConfirmation
              kind="offPitchConflict"
              title={t.fieldDetail.claimYourMatch.offPitchConflictTitle}
              body={offPitchConflictCopy}
              irreversible={t.fieldDetail.claimYourMatch.offPitchConflictIrreversible}
              period={`${formatTime(confirmation.conflict.payload.fromSeconds)} – ${formatTime(confirmation.conflict.payload.toSeconds)}`}
              confirmLabel={t.fieldDetail.claimYourMatch.offPitchConflictConfirm}
              cancelLabel={t.fieldDetail.claimYourMatch.offPitchConflictCancel}
              onConfirm={() => void confirmOffPitchConflict()}
              onCancel={cancelConfirmation}
              confirming={offPitchSaving}
            />
          )}
          {confirmation?.kind === "demoReset" && (
            <ClaimInlineConfirmation
              kind="demoReset"
              title={t.fieldDetail.claimYourMatch.demoResetTitle}
              body={t.fieldDetail.claimYourMatch.demoResetDesc}
              confirmLabel={t.fieldDetail.claimYourMatch.demoResetConfirm}
              cancelLabel={t.fieldDetail.claimYourMatch.demoResetCancel}
              onConfirm={() => void handleResetDemo()}
              onCancel={cancelConfirmation}
              confirming={resettingDemo}
            />
          )}
        {serverProgress?.identityBinding?.state === "disputed" && (
          <div className="claim-panel claim-panel-warning" role="alert">
            <b>This player is already claimed by another account.</b>
            <span>Your answers are saved, but this claim is pending admin review. It will not unlock clips until the review is resolved.</span>
          </div>
        )}
        {serverProgress?.identityBinding?.state === "needs_resolution" && (
          <div className="claim-panel claim-panel-warning" role="status">
            <b>The tracking data changed.</b>
            <span>Your previous answers were kept for history, but please review the moments again before this match can be claimed.</span>
          </div>
        )}
        {(serverProgress?.conflictMoments?.length ?? 0) > 0 && (
          <div className="claim-panel claim-panel-warning" role="alert">
            {serverProgress.completionReason === "identity-unresolved" ? (
              <>
                <b>{t.fieldDetail.claimYourMatch.identityUnresolvedTitle}</b>
                <span>{t.fieldDetail.claimYourMatch.identityUnresolvedDesc}</span>
              </>
            ) : (
              <>
                <b>Some answers point to a different player.</b>
                <span>Review the highlighted moments and choose the same person throughout the match.</span>
              </>
            )}
          </div>
        )}
        {isDemo && (
          <div className="claim-demo-reset" data-testid="claim-demo-reset">
            <button
              type="button"
              className="claim-text-button"
              data-testid="button-reset-claim-demo"
               onClick={requestResetDemo}
              disabled={resettingDemo}
            >
               {resettingDemo ? t.fieldDetail.claimYourMatch.resettingDemo : t.fieldDetail.claimYourMatch.startDemoOver} <RotateCcw size={14} />
            </button>
            {demoResetError && <small className="claim-error-text" role="alert">{demoResetError}</small>}
          </div>
        )}
        {stage === "find" && (
          <div className="claim-panel claim-panel-find" data-testid="panel-find-yourself">
            <span className="claim-context"><ScanSearch size={16} /> IDENTITY CHECKPOINTS</span>
            <h2>First, identify yourself</h2>
            <p>Before we calculate your moments, we’ll show you clear checkpoints from different parts of the match. Choose the same player each time you see yourself.</p>
            <div className="claim-prompt-card"><div className="prompt-icon"><LocateFixed size={19} /></div><div><b>{claimAnchors.length} identity checks</b><span>Your choices confirm your player before coverage and clips are calculated.</span></div></div>
            <button type="button" className="claim-button claim-button-primary claim-button-wide" data-testid="button-start-following" onClick={handlePrimaryAction} disabled={!claimAnchors.length}>Start identity check <ChevronRight size={17} /></button>
          </div>
        )}
        {stage === "picker" && (
          <div className="claim-panel claim-panel-picker" data-testid="panel-picker">
            {(
              <>
                <span className="claim-context"><LocateFixed size={15} /> IDENTITY CHECKPOINT</span>
                <h2>Which player is you?</h2>
                <p>This is one clear moment from the match. Pick yourself, or tell us you’re not visible. Each answer is saved immediately.</p>
                {currentAnchor ? (
                  <div className="claim-question-card"><Clock3 size={18} /><span>Moment <b>{formatTime(currentAnchor.momentSeconds)}</b> · {Math.min(claimAnchors.length, Math.max(1, claimAnchors.findIndex((anchor) => anchor.id === currentAnchor.id) + 1))} of {claimAnchors.length}</span></div>
                ) : (
                  <div className="claim-question-card" role="status"><Clock3 size={18} /><span>All moments answered · checking your saved coverage</span></div>
                )}
                <div className="candidate-list">
                  {currentAnchor && candidates.map((candidate, index) => (
                    <button type="button" key={candidate.id} className={`candidate-row ${candidate.taken ? "is-taken" : ""}`} data-testid={`button-candidate-${index + 1}`} onClick={() => selectCandidate(candidate)} aria-disabled={candidate.taken}>
                      <span className="candidate-number">{index + 1}</span><CandidateThumb videoRef={videoRef} box={candidate.box} bundle={bundle} tick={videoReadyTick} /><span className="candidate-copy"><b>Player {index + 1}{candidate.taken ? " · Already vouched" : ""}</b><small>{candidate.taken ? "Unavailable at this time · choose an untouched fragment" : candidate.label}</small></span>{candidate.taken ? <LockKeyhole size={16} /> : <ChevronRight size={16} />}
                    </button>
                  ))}
                </div>
                {currentAnchor && candidates.length === 0 && <div className="claim-empty-detections">No player is clear in this moment. You can skip it and keep your coverage honest.</div>}
                {currentAnchor && <button type="button" className="claim-button claim-button-secondary claim-button-wide" data-testid="button-anchor-not-me" onClick={() => recordAnchorAnswer("no")}>I’m not visible here <X size={17} /></button>}
                {currentAnchor && <button type="button" className="claim-text-button claim-skip-button" data-testid="button-skip-picker" onClick={() => recordAnchorAnswer("skip")}>Skip this moment <FastForward size={14} /></button>}
                <p className="claim-key-note">Tap any player below. Keys <kbd>1</kbd>–<kbd>9</kbd> choose the first nine.</p>
              </>
                )}
          </div>
        )}
        {stage === "done" && (
          <div className="claim-panel claim-panel-complete" data-testid="panel-done">
            <div className="complete-graphic"><span className="complete-ring"><Check size={24} /></span><span className="complete-spark spark-a" /><span className="complete-spark spark-b" /><span className="complete-spark spark-c" /></div>
            <h2>Done. That’s all yours.</h2>
             <p>You reached <b>{Math.round(progressValue)}%</b> attributed coverage of this match. Directly vouched time and identity-grouped time are shown separately below.</p>
             {playerStats && (
                <div className="claim-player-summary" data-testid="claim-player-stats">
                  <div className="claim-summary-metric">
                    <span><Check size={13} /> Human-vouched time</span>
                    <b>{((serverProgress?.humanVouchedSeconds ?? 0) / 60).toFixed(1)} min</b>
                    <small>directly accepted contiguous fragments</small>
                  </div>
                  <div className="claim-summary-metric">
                    <span><Sparkles size={13} /> Inferred time</span>
                    <b>{((serverProgress?.inferredSeconds ?? 0) / 60).toFixed(1)} min</b>
                    <small>identity grouping, not direct confirmation</small>
                  </div>
                  <div className="claim-summary-metric">
                    <span><MapPinned size={13} /> Total distance</span>
                    <b>{playerStats.distanceMetres === null ? "Unavailable" : `${playerStats.distanceMetres.toLocaleString()} m`}</b>
                    <small>{playerStats.distanceMetres === null ? "No pitch model in this recording" : "smoothed pitch estimate"}</small>
                  </div>
                   <div className="claim-summary-metric">
                     <span><Clock3 size={13} /> Average speed</span>
                     <b>{playerStats.averageSpeedMetresPerSecond === null ? "Unavailable" : `${playerStats.averageSpeedMetresPerSecond.toFixed(2)} m/s`}</b>
                     <small>{playerStats.averageSpeedMetresPerSecond === null ? "No pitch model in this recording" : "distance ÷ attributed time present"}</small>
                   </div>
                  <div className="claim-heatmap-card">
                    <div className="claim-heatmap-heading">
                      <span><MapPinned size={13} /> Position heatmap</span>
                      <small>{playerStats.heatmap.coordinateSpace === "pitch" ? "pitch view" : "camera view"}</small>
                    </div>
                    <PlayerHeatmap heatmap={playerStats.heatmap} />
                  </div>
                   <div className="claim-unavailable-metrics">
                     {[
                       { label: "Touches", metric: playerStats.touches },
                       { label: "Passes", metric: playerStats.passes },
                       { label: "Shots", metric: playerStats.shots },
                       { label: "Dribbles", metric: playerStats.dribbles },
                     ].map(({ label }) => (
                       <div className="claim-summary-metric claim-summary-metric-unavailable" key={label}>
                         <span>{label}</span>
                         <b>Not yet available</b>
                         <small>Ball tracking and possession attribution unavailable</small>
                       </div>
                     ))}
                   </div>
               </div>
             )}
              <p className="claim-stats-note">Distance is approximate and derived from camera tracking. It is shown only when this recording includes a pitch model; we never estimate metres from player height in pixels.</p>
             {unresolvedAnchorReviews.length ? (
               <div className="claim-unresolved-review" data-testid="unresolved-anchor-list">
                 <div className="claim-unresolved-heading"><b>{unresolvedAnchorReviews.length} moments need another look</b><span>Review one without restarting your claim.</span></div>
                 <div className="claim-unresolved-list">
                   {unresolvedAnchorReviews.map((item, index) => (
                     <button
                       type="button"
                       className="claim-unresolved-row"
                       data-testid={`button-review-unresolved-${index + 1}`}
                       key={`${item.momentSeconds}-${item.index}`}
                       onClick={() => openAnchorReview(item.index)}
                     >
                       <span className="candidate-number">{index + 1}</span>
                        <span><b>Moment {formatTime(item.momentSeconds)}</b><small>{item.conflict ? "Different player selected" : "Not visible or skipped"}</small></span>
                       <ChevronRight size={16} />
                     </button>
                   ))}
                 </div>
               </div>
             ) : <p className="claim-muted">Every reviewed moment is resolved. You can return to the match whenever you want.</p>}
             <div className="earned-count"><Sparkles size={18} /><b>{clipsUnlocked} earned clips</b><span>ready in My Clips</span></div>
            <button type="button" className="claim-button claim-button-primary claim-button-wide" data-testid="button-done-view-clips" onClick={() => setLocation("/my-clips")}>View your clips <ChevronRight size={17} /></button>
            {user?.id && (
              <button
                type="button"
                className="claim-button claim-button-secondary claim-button-wide"
                data-testid="button-done-view-stats"
                onClick={() => setLocation(`/players/${user.id}`)}
              >
                {t.profile.viewStats} <ChevronRight size={17} />
              </button>
            )}
             <button type="button" className="claim-text-button" data-testid="button-done-back-match" onClick={() => setLocation("/home")}>Return to your matches <ArrowLeft size={14} /></button>
          </div>
        )}

        <div className="claim-resume-card" data-testid="card-resume-claim"><div className="resume-icon"><Play size={15} fill="currentColor" /></div><div><span className="resume-label">RESUME LATER</span><b>Your place is saved</b><span>Come back anytime — no need to start over.</span></div><LockKeyhole size={15} className="resume-lock" /></div>
        {allCorrections.some((item) => !item.undone) && stage !== "done" && (
          <div className="claim-correction-status" data-testid="status-correction"><span><Check size={13} /> Answer saved</span><button type="button" data-testid="button-undo-correction" onClick={() => undo()}>Undo newest</button></div>
        )}
    </>
  );

  return (
    <main className="claim-page claim-page-stage" data-testid="page-claim-match">
      <ClaimStage
        videoUrl={recording.videoUrl}
        bundle={bundle}
        candidates={candidates}
        showBoxes={stage !== "done"}
        viewKey={`${stage}:${activeAnchorId ?? ""}:${currentSegmentIndex}`}
        currentTime={currentTime}
        duration={duration}
        playing={playing}
        muted={muted}
        slow={slow}
        playbackRate={playbackRate}
        goalTimes={goalTimes}
         offPitchSpans={offPitchSpans}
        videoRef={videoRef}
         seekRequest={seekRequest}
        onToggle={handlePlay}
        onSeek={handleSeek}
        onSkip={seekBy}
        onToggleSlow={() => setSlow((value) => !value)}
        onCyclePlaybackRate={cyclePlaybackRate}
        onToggleMute={() => setMuted((value) => !value)}
        onTap={onVideoTap}
        onTimeUpdate={handleVideoTimeUpdate}
        onVideoReady={handleVideoReady}
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