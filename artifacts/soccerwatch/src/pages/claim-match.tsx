import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Expand,
  FastForward,
  Film,
  Gauge,
  LocateFixed,
  LockKeyhole,
  Pause,
  Play,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Undo2,
  Volume2,
  VolumeX,
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
import {
  boxAtFrame,
  boxesOverlap,
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
type Candidate = {
  id: string;
  label: string;
  box: ClaimBox;
  x: number;
  y: number;
  w: number;
  h: number;
  overlap?: boolean;
  distance?: number;
};
type ShirtTone = "light" | "dark" | "unreadable";

function segmentAsBundle(
  manifest: ClaimMatchResponse["manifest"],
  segment: TrackingSegment,
) {
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
    tracks: segment.tracks,
    crossings: segment.crossings,
    inPlaySpans: segment.inPlaySpans,
    events: segment.events,
  };
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
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
  const before = track.boxes
    .filter((box) => box.frame <= frame)
    .sort((a, b) => b.frame - a.frame)[0];
  const after = track.boxes
    .filter((box) => box.frame >= frame)
    .sort((a, b) => a.frame - b.frame)[0];
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

function pointInVideoPixels(
  event: React.MouseEvent<HTMLDivElement>,
  width: number,
  height: number,
) {
  const rect = event.currentTarget.getBoundingClientRect();
  const videoAspect = width / height;
  const displayAspect = rect.width / rect.height;
  const scale = displayAspect > videoAspect ? rect.width / width : rect.height / height;
  const renderedWidth = width * scale;
  const renderedHeight = height * scale;
  const offsetX = (renderedWidth - rect.width) / 2;
  const offsetY = (renderedHeight - rect.height) / 2;
  return {
    x: (event.clientX - rect.left + offsetX) / scale,
    y: (event.clientY - rect.top + offsetY) / scale,
  };
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

function MiniVideo({
  recording,
  currentTime,
  playing,
  muted,
  slow,
  videoRef,
  onToggle,
  onToggleSlow,
  onSeek,
  onToggleMute,
  onFullscreen,
  onVideoTap,
  onVideoReady,
  candidates,
  activeTrackId,
  showCandidates,
  duration,
  onTimeUpdate,
}: {
  recording: ClaimMatchResponse["recording"] | { videoUrl?: string; fieldName?: string | null; court?: string; date?: string; score?: string | null };
  currentTime: number;
  playing: boolean;
  muted: boolean;
  slow: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onToggle: (forcePlaying?: boolean) => void;
  onToggleSlow: () => void;
  onSeek: (value: number) => void;
  onToggleMute: () => void;
  onFullscreen: () => void;
  onVideoTap: (event: React.MouseEvent<HTMLDivElement>) => void;
  onVideoReady: () => void;
  candidates: Candidate[];
  activeTrackId: string | null;
  showCandidates: boolean;
  duration: number;
  onTimeUpdate: (value: number) => void;
}) {
  const displayScore = recording.score || "—";
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = slow ? 0.5 : 1;
  }, [slow, videoRef]);
  return (
    <div className="claim-video-shell" data-testid="video-claim-match">
      <div className="claim-video-stage" onClick={onVideoTap}>
        {recording.videoUrl ? (
          <video
            ref={videoRef}
            className="claim-video"
            src={recording.videoUrl}
            muted={muted}
            playsInline
            onLoadedData={onVideoReady}
            onSeeked={onVideoReady}
            onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime)}
            onPlay={() => onToggle(true)}
            onPause={() => onToggle(false)}
            aria-label="Match recording"
          />
        ) : (
          <div className="claim-fallback-video" role="img" aria-label="Match recording preview">
            <div className="fallback-field-lines" />
            <div className="fallback-camera-stamp">MATCH VIDEO UNAVAILABLE · TRACKING DATA STILL LOADED</div>
          </div>
        )}
        <div className="claim-video-topline">
          <span className="claim-live-dot" /> MATCH RECORDING <span className="claim-video-divider" /> {recording.fieldName || "Amman Sports City"} / {recording.court || "Court 2"}
        </div>
        <div className="claim-scorebug">
          <span>RPL</span><b>{displayScore}</b><small>{formatTime(currentTime)}</small>
        </div>
        {showCandidates && candidates.map((candidate, index) => (
          <div
            key={candidate.id}
            className={`claim-track-box ${candidate.id === activeTrackId ? "is-active" : ""} ${candidate.overlap ? "is-overlap" : ""}`}
            style={{ left: `${candidate.x}%`, top: `${candidate.y}%`, width: `${candidate.w}%`, height: `${candidate.h}%` }}
            data-testid={`overlay-track-${candidate.id}`}
          >
            <span>{index + 1} / {candidate.label}</span>
          </div>
        ))}
        <div className="claim-video-bottom">
          <button type="button" className="claim-icon-button" data-testid="button-video-play" onClick={(event) => { event.stopPropagation(); onToggle(); }} aria-label={playing ? "Pause match" : "Play match"}>{playing ? <Pause size={17} /> : <Play size={17} fill="currentColor" />}</button>
          <div className="claim-video-time" onClick={(event) => event.stopPropagation()}><span>{formatTime(currentTime)}</span><input type="range" min={0} max={duration} value={Math.min(duration, currentTime)} onChange={(event) => onSeek(Number(event.target.value))} aria-label="Match position" data-testid="input-match-position" /><span>{formatTime(duration)}</span></div>
          <button type="button" className={`claim-icon-button ${slow ? "is-on" : ""}`} data-testid="button-slow-motion" onClick={(event) => { event.stopPropagation(); onToggleSlow(); }} aria-label="Toggle slow motion"><Gauge size={17} /></button>
          <button type="button" className="claim-icon-button" data-testid="button-video-mute" onClick={(event) => { event.stopPropagation(); onToggleMute(); }} aria-label={muted ? "Unmute match" : "Mute match"}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
          <button type="button" className="claim-icon-button" data-testid="button-video-fullscreen" onClick={(event) => { event.stopPropagation(); onFullscreen(); }} aria-label="Fullscreen video"><Expand size={17} /></button>
        </div>
      </div>
      <div className="claim-buffer-note"><span className="buffer-pulse" /> Video buffered ahead <b>you can keep watching</b><span>·</span> we’ll save in the background</div>
    </div>
  );
}

function ClipCard({ title, moment, kind, index }: { title: string; moment: number; kind: string; index: number }) {
  return (
    <article className="claim-clip-card" data-testid={`card-earned-clip-${index}`}>
      <div className={`claim-clip-thumb thumb-${index % 3}`}>
        <span className="clip-play"><Play size={14} fill="currentColor" /></span>
        <span className="clip-time">{formatTime(moment)}</span>
        <span className="clip-kind">{kind}</span>
      </div>
      <div className="claim-clip-details"><b>{title}</b><span>Ready to watch · saved to your clips</span></div>
      <ChevronRight size={16} className="claim-clip-arrow" />
    </article>
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
  const [stage, setStage] = useState<Stage>("find");
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [slow, setSlow] = useState(false);
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
    const next = Math.max(0, Math.min(duration, currentTime + delta));
    setCurrentTime(next);
    if (videoRef.current) videoRef.current.currentTime = toVideoTime(next);
  }, [currentTime, duration]);

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
    if (!manifest || !crossedSegmentBoundary(previousSegmentIndex.current, currentSegmentIndex)) {
      if (manifest) previousSegmentIndex.current = currentSegmentIndex;
      return;
    }
    previousSegmentIndex.current = currentSegmentIndex;
    setCurrentTrackId(null);
    setNarrowing(null);
    setBoundaryNotice("Lost you at the ten-minute mark. Which one is you?");
    setBoundaryRepickPending(true);
    setStage("picker");
    setNotice("Choose yourself again — this keeps segment boundaries honest");
    saveProgress("picker", null, progressValue, clipsUnlocked);
  }, [clipsUnlocked, currentSegmentIndex, manifest, progressValue, saveProgress]);

  const goStage = useCallback((next: Stage, trackId = currentTrackId) => {
    const percentByStage: Record<Stage, number> = { find: 0, following: 19, still: 38, picker: 55, look: 73, done: 100 };
    setStage(next);
    setClaimedPercent(percentByStage[next]);
    setCurrentTrackId(trackId);
    setClipsUnlocked((value) => Math.max(value, next === "done" ? earnedClips.length : value));
    saveProgress(next, trackId, Math.max(progressValue, percentByStage[next]), clipsUnlocked);
  }, [currentTrackId, earnedClips.length, progressValue, clipsUnlocked, saveProgress]);

  const stillQuestion = narrowing ? nextNarrowingQuestion(narrowing) : null;

  const beginFollowing = useCallback((trackId: string, atSeconds = currentTime) => {
    if (!bundle) return;
    const confirmedAt = atSeconds;
    const track = bundle.tracks.find((item) => item.id === trackId);
    const box = track ? detectionAtFrame(track, trackingSecondsToFrame(confirmedAt, bundle)) : null;
    if (box) lastKnownPositionRef.current = boxCenter(box);
    setCurrentTrackId(trackId);
    setConfirmedFromSeconds(confirmedAt);
    setNarrowing(null);
    setCrossingOtherTrackId(null);
    setStage("following");
    setClaimedPercent((value) => Math.max(value, 19));
    setNotice("Following you through the match");
    saveProgress("following", trackId, Math.max(progressValue, 19), clipsUnlocked, confirmedAt, confirmedAt);
  }, [bundle, clipsUnlocked, currentTime, progressValue, saveProgress]);

  const seekToFrame = useCallback((frame: number) => {
    if (!bundle) return;
    const seconds = frameToTrackingSeconds(frame, bundle);
    setCurrentTime(seconds);
    if (videoRef.current) videoRef.current.currentTime = toVideoTime(seconds);
  }, [bundle]);

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
      setCurrentTime(question.momentSeconds);
      if (videoRef.current) videoRef.current.currentTime = toVideoTime(question.momentSeconds);
      setStage("still");
      setClaimedPercent((value) => Math.max(value, 38));
      setNotice("Quick check — keep watching");
      saveProgress("still", currentTrackId, Math.max(progressValue, 38), clipsUnlocked, confirmedFromSeconds, question.momentSeconds);
    } else {
      setCurrentTime(question.momentSeconds);
      if (videoRef.current) videoRef.current.currentTime = toVideoTime(question.momentSeconds);
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
      setCurrentTime(nextQuestion.momentSeconds);
      if (videoRef.current) videoRef.current.currentTime = toVideoTime(nextQuestion.momentSeconds);
      saveProgress("picker", null, Math.max(progressValue, 55), clipsUnlocked, confirmedFromSeconds, nextQuestion.momentSeconds);
    } else {
      setCurrentTime(nextQuestion.momentSeconds);
      saveProgress("still", currentTrackId, progressValue, clipsUnlocked, answer === "yes" ? answerMoment : confirmedFromSeconds, nextQuestion.momentSeconds);
      setNotice("Here’s the next clear passage");
    }
  }, [bundle, clipsUnlocked, confirmedFromSeconds, currentTime, currentTrackId, narrowing, progressValue, saveProgress, stillQuestion]);

  const skipAhead = useCallback(() => {
    if (!bundle) return;
    const next = skipToClearPassage(currentTime, bundle.inPlaySpans, bundle.duration);
    setCurrentTime(next);
    if (videoRef.current) videoRef.current.currentTime = toVideoTime(next);
    setNotice("Skipped ahead to a clearer passage");
  }, [bundle, currentTime]);

  const candidateStage = stage === "find" || stage === "picker" || stage === "look";
  const candidateFrame = useMemo(() => {
    if (!bundle || !candidateStage) return currentFrame;
    return nearestDetectionFrame(bundle, bundle.tracks, currentFrame, crossingOtherTrackId) ?? currentFrame;
  }, [bundle, candidateStage, crossingOtherTrackId, currentFrame]);

  useEffect(() => {
    if (!bundle || !candidateStage || candidateFrame === currentFrame) return;
    const seconds = frameToTrackingSeconds(candidateFrame, bundle);
    setCurrentTime(seconds);
    if (videoRef.current) videoRef.current.currentTime = toVideoTime(seconds);
  }, [bundle, candidateFrame, candidateStage, currentFrame]);

  const candidates = useMemo<Candidate[]>(() => {
    if (!bundle) return [];
    const sourceTracks = candidateStage
      ? bundle.tracks
      : bundle.tracks.filter((track) => track.id === currentTrackId);
    const anchorTrack = currentTrackId ? bundle.tracks.find((track) => track.id === currentTrackId) : null;
    const anchorBox = anchorTrack ? detectionAtFrame(anchorTrack, candidateFrame) : null;
    const anchor = lastKnownPositionRef.current || (anchorBox ? boxCenter(anchorBox) : { x: bundle.width / 2, y: bundle.height / 2 });
    const ranked = sourceTracks
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
        x: box.x / bundle.width * 100,
        y: box.y / bundle.height * 100,
        w: box.w / bundle.width * 100,
        h: box.h / bundle.height * 100,
      }))
      .map((candidate, index, all) => ({
        ...candidate,
        overlap: all.some((other) => other.id !== candidate.id && boxesOverlap(candidate.box, other.box)),
      }));
  }, [bundle, candidateFrame, candidateStage, crossingOtherTrackId, currentTrackId, shirtToneByTrack]);

  const followedTrack = bundle?.tracks.find((track) => track.id === currentTrackId);
  const followedBox = followedTrack ? detectionAtFrame(followedTrack, currentFrame) : null;
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
    setStage((response.progress.stage as Stage) || "find");
    setCurrentTrackId(response.progress.currentTrackId || null);
    setConfirmedFromSeconds(response.progress.confirmedFromSeconds || 0);
    setCurrentTime(response.progress.currentPositionSeconds || 0);
    setClaimedPercent(response.progress.claimedPercent || 0);
    setClipsUnlocked(response.progress.clipsUnlocked || 0);
    setCorrections(response.corrections);
    setNarrowing(null);
    setCrossingOtherTrackId(null);
  }, [bundle, response]);

  useEffect(() => {
    if (!bundle || !currentTrackId) return;
    const track = bundle.tracks.find((item) => item.id === currentTrackId);
    const box = track ? detectionAtFrame(track, currentFrame) : null;
    if (box) lastKnownPositionRef.current = boxCenter(box);
  }, [bundle, currentFrame, currentTrackId]);

  useEffect(() => {
    if (stage !== "following" || !bundle || !currentTrackId || followedBox || currentTime <= confirmedFromSeconds + 0.05) return;
    setStage("picker");
    setCurrentTrackId(null);
    setNarrowing(null);
    setNotice("Tracking ended here — choose yourself in the next clear frame");
    saveProgress("picker", null, Math.max(progressValue, 55), clipsUnlocked, confirmedFromSeconds, currentTime);
  }, [bundle, clipsUnlocked, confirmedFromSeconds, currentTime, currentTrackId, followedBox, progressValue, saveProgress, stage]);

  const lastSavedPosition = useRef(0);
  useEffect(() => {
    if (currentTime <= 0 || currentTime - lastSavedPosition.current < 10) return;
    lastSavedPosition.current = currentTime;
    saveProgress(stage, currentTrackId, progressValue, clipsUnlocked);
  }, [currentTime, currentTrackId, clipsUnlocked, progressValue, saveProgress, stage]);

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
      } else if (key === "f") {
        event.preventDefault();
        videoRef.current?.requestFullscreen?.();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekBy(-5);
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
    const timer = window.setInterval(() => setCurrentTime((value) => Math.min(duration, value + (slow ? 0.2 : 0.8))), 800);
    return () => window.clearInterval(timer);
  }, [duration, playing, recording?.videoUrl, slow]);

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
    setCurrentTime(selectionMoment);
    if (videoRef.current) videoRef.current.currentTime = toVideoTime(selectionMoment);
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
  const handleFullscreen = () => videoRef.current?.requestFullscreen?.();
  const handleSeek = (value: number) => {
    setCurrentTime(value);
    if (videoRef.current) videoRef.current.currentTime = toVideoTime(value);
  };
  const handleVideoTap = (event: React.MouseEvent<HTMLDivElement>) => {
    const point = pointInVideoPixels(event, bundle.width, bundle.height);
    if (point.x < 0 || point.y < 0 || point.x > bundle.width || point.y > bundle.height) return;
    const hits = findHitTracks(bundle, currentFrame, point.x, point.y)
      .filter(({ box }) => Math.abs(box.frame - currentFrame) <= 2);
    if (!hits.length) {
      setNotice("No player detected at that point in this frame");
      return;
    }
    const hitCandidates = hits.map(({ track, box }) => ({
      id: track.id,
      label: captionForTrack(track, currentFrame, bundle, shirtToneByTrack[track.id] || "unreadable"),
      box,
      x: box.x / bundle.width * 100,
      y: box.y / bundle.height * 100,
      w: box.w / bundle.width * 100,
      h: box.h / bundle.height * 100,
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

  return (
    <main className="claim-page" data-testid="page-claim-match">
      <header className="claim-header">
        <button type="button" className="claim-back" data-testid="button-back-claim" onClick={handleBack}><ArrowLeft size={17} /><span>Leave claim</span></button>
        <div className="claim-brand"><span className="claim-brand-mark"><LocateFixed size={15} /></span><span>REPLAY<span className="claim-brand-slash">/</span>CLAIM</span></div>
        <div className="claim-save-status" data-testid="status-claim-saving"><span className={notice === "Saving" ? "saving-dot" : "saved-dot"} /> {notice || (isOffline ? "Saved on this device" : "Progress saves automatically")}{queuedCount > 0 && ` · ${queuedCount} waiting to sync`}</div>
      </header>

      <div className="claim-wrap">
        <div className="claim-intro-row">
          <div>
            <p className="claim-eyebrow"><span className="eyebrow-line" /> Claim your match</p>
            <h1>Find the moments<br /><em>that are yours.</em></h1>
            <p className="claim-intro-copy">We’ll follow one player through the recording. If we lose you, just point us back in the right direction.</p>
          </div>
          <div className="claim-match-card" data-testid="card-match-summary">
            <div className="claim-match-icon"><Film size={18} /></div>
            <div><b>{recording.fieldName || "Amman Sports City"}</b><span>{recording.court || "Court 2"} · {recording.date || "Friday, 14 Jun"}</span></div>
            <strong>{recording.score || "—"}</strong>
          </div>
        </div>

        <section className="claim-workspace">
          <div className="claim-video-column">
            <MiniVideo
              recording={recording}
              currentTime={currentTime}
              playing={playing}
              muted={muted}
              slow={slow}
              videoRef={videoRef}
              onToggle={handlePlay}
              onToggleSlow={() => setSlow((value) => !value)}
               onSeek={handleSeek}
              onToggleMute={() => setMuted((value) => !value)}
              onFullscreen={handleFullscreen}
               onVideoTap={handleVideoTap}
               onVideoReady={() => setVideoReadyTick((value) => value + 1)}
              candidates={candidates}
              activeTrackId={currentTrackId}
              showCandidates={stage !== "done"}
               duration={duration}
               onTimeUpdate={(value) => setCurrentTime(fromVideoTime(value))}
            />
            {segmentLoading && (
              <div className="mt-2 flex items-center gap-2 text-xs text-zinc-500" role="status" data-testid="status-loading-tracking-segment">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                Loading tracking for this ten-minute section…
              </div>
            )}

            <div className="claim-timeline" aria-label="Match timeline">
              <div className="timeline-track">
                <span className="timeline-played" style={{ width: `${currentTime / duration * 100}%` }} />
                {bundle.events.filter((event) => event.type.toLowerCase() === "goal").map((event) => (
                  <span key={`${event.type}-${event.time}`} className="timeline-marker marker-goal" style={{ left: `${event.time / duration * 100}%` }} />
                ))}
                <span className="timeline-marker marker-claim" style={{ left: `${Math.min(100, progressValue)}%` }} />
              </div>
              <div className="timeline-labels"><span>00:00</span><span><Sparkles size={12} /> {clipsUnlocked} clips unlocked</span><span>{formatTime(duration)}</span></div>
            </div>

            {stage === "done" ? (
              <div className="claim-done-panel" data-testid="panel-claim-done">
                <div className="done-stamp"><Check size={24} /></div>
                <div><p className="claim-eyebrow">Claim complete</p><h2>That’s your match.</h2><p>{clipsUnlocked} moments are ready in My Clips. Take a look whenever you’re ready.</p></div>
                <button type="button" className="claim-button claim-button-primary" data-testid="button-open-earned-clips" onClick={() => setLocation("/my-clips")}>Open earned clips <ChevronRight size={17} /></button>
              </div>
            ) : (
              <div className="claim-bottom-row">
                <div className="claim-key-hints"><span><kbd>←</kbd> 5 sec back</span><span><kbd>F</kbd> fullscreen</span><span><kbd>S</kbd> slow motion</span></div>
                <span className="claim-help"><CircleHelp size={14} /> Need a hand?</span>
              </div>
            )}
          </div>

          <aside className="claim-action-column">
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
                      <span className="candidate-number">{index + 1}</span><span className="candidate-avatar">{initials(candidate.label)}</span><span className="candidate-copy"><b>Detection {index + 1}</b><small>{candidate.label}{candidate.overlap ? " · overlap" : ""}</small></span><ChevronRight size={16} />
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
                <div className="look-controls"><button type="button" className={`look-control ${slow ? "selected" : ""}`} data-testid="button-look-slow" onClick={() => setSlow((value) => !value)}><Gauge size={15} /> Slow motion <kbd>S</kbd></button><button type="button" className="look-control" data-testid="button-look-back" onClick={() => setCurrentTime((value) => Math.max(0, value - 5))}><RotateCcw size={15} /> 5 sec back</button></div>
                <div className="candidate-list">{candidates.map((candidate, index) => <button type="button" key={candidate.id} className="candidate-row" data-testid={`button-overlap-candidate-${index + 1}`} onClick={() => onCorrection(candidate, "overlap-resolved", true)}><span className="candidate-number">{index + 1}</span><span className="candidate-copy"><b>{candidate.id === currentTrackId ? "Follow this track" : "Crossing track"}</b><small>{candidate.label}</small></span><ChevronRight size={16} /></button>)}</div>
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
            {allCorrections.length > 0 && stage !== "done" && (
              <div className="claim-correction-status" data-testid="status-correction"><span><Check size={13} /> Correction saved</span>{activeCorrection && <button type="button" data-testid="button-undo-correction" onClick={undo}>Undo</button>}</div>
            )}
          </aside>
        </section>

        <section className="claim-earned-section" data-testid="section-earned-clips">
          <div className="claim-section-heading"><div><p className="claim-eyebrow"><span className="eyebrow-line" /> Your match, in moments</p><h2>Earned clips <span>{clipsUnlocked || serverProgress.earnedClips.length || 0}</span></h2></div><p>As you claim your player, the best parts quietly collect here.</p></div>
           <div className="claim-clips-grid">
             {earnedClips.slice(0, 3).map((clip, index) => <ClipCard key={clip.id} title={clip.title} moment={clip.momentSeconds} kind={clip.kind} index={index} />)}
             {earnedClips.length === 0 && <div className="claim-locked-clip" data-testid="card-locked-clip"><LockKeyhole size={17} /><b>Your earned moments will appear here</b><span>Keep watching to unlock the next moment.</span></div>}
          </div>
        </section>
      </div>

      <footer className="claim-footer"><span>Replay / Claim your match</span><span><ShieldCheck size={13} /> Your choices are private until you share them</span><span>Need help? <button type="button" data-testid="button-claim-help" onClick={() => setNotice("Help is on the way")}>Ask Replay</button></span></footer>
    </main>
  );
}