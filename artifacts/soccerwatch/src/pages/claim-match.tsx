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
import type { ClaimCorrection, ClaimMatchResponse } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import {
  boxAtFrame,
  boxesOverlap,
  crossingsForWindow,
  frameToMatchSeconds,
  laterSeparatedFrame,
  matchSecondsToFrame,
  nextNarrowingQuestion,
  answerNarrowing,
  skipToClearPassage,
  startNarrowing,
  type NarrowingAnswer,
  type NarrowingState,
} from "@/lib/claim-match-engine";
import {
  enqueueClaimAction,
  readClaimQueue,
  removeClaimAction,
  type ClaimQueueAction,
} from "@/lib/claim-match-storage";

type Stage = "find" | "following" | "still" | "picker" | "look" | "done";
type Candidate = { id: string; label: string; x: number; y: number; w: number; h: number; overlap?: boolean };

const stageMeta: Record<Stage, { label: string; number: string }> = {
  find: { label: "Find yourself", number: "01" },
  following: { label: "Following", number: "02" },
  still: { label: "Still you here?", number: "03" },
  picker: { label: "Which one of these is you?", number: "04" },
  look: { label: "Take another look", number: "05" },
  done: { label: "Done", number: "06" },
};

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function initials(label: string) {
  return label.slice(0, 2).toUpperCase();
}

function StageRail({ stage, progress, onJump }: { stage: Stage; progress: number; onJump: (stage: Stage) => void }) {
  const stages = Object.keys(stageMeta) as Stage[];
  return (
    <div className="claim-stage-rail" aria-label="Claim progress">
      <div className="claim-stage-line" aria-hidden="true">
        <span style={{ width: `${Math.min(100, progress)}%` }} />
      </div>
      {stages.map((item, index) => {
        const complete = index < stages.indexOf(stage);
        const active = item === stage;
        return (
          <button
            key={item}
            type="button"
            data-testid={`button-stage-${item}`}
            className={`claim-stage ${active ? "is-active" : ""} ${complete ? "is-complete" : ""}`}
            onClick={() => (complete ? onJump(item) : undefined)}
            aria-current={active ? "step" : undefined}
            disabled={!complete && !active}
          >
            <span className="claim-stage-dot">{complete ? <Check size={12} /> : stageMeta[item].number}</span>
            <span className="claim-stage-label">{stageMeta[item].label}</span>
          </button>
        );
      })}
    </div>
  );
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

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="claim-page claim-centered" data-testid="claim-error">
      <div className="claim-error-mark"><CircleHelp size={28} /></div>
      <p className="claim-eyebrow">Replay / Claim your match</p>
      <h1>We lost the thread for a moment.</h1>
      <p className="claim-muted">Your progress is safe. Try loading the match again and we’ll pick up from the last calm checkpoint.</p>
      <button type="button" className="claim-button claim-button-primary" data-testid="button-retry-claim" onClick={onRetry}>Try again <RotateCcw size={16} /></button>
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
      <div className="claim-video-stage">
        {recording.videoUrl ? (
          <video
            ref={videoRef}
            className="claim-video"
            src={recording.videoUrl}
            muted={muted}
            playsInline
            onClick={() => onToggle()}
            onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime)}
            onPlay={() => onToggle(true)}
            onPause={() => onToggle(false)}
            aria-label="Match recording"
          />
        ) : (
          <div className="claim-fallback-video" role="img" aria-label="Match recording preview">
            <div className="fallback-field-lines" />
            <div className="fallback-player p-one"><span>7</span></div>
            <div className="fallback-player p-two"><span>11</span></div>
            <div className="fallback-player p-three"><span>4</span></div>
            <div className="fallback-ball" />
            <div className="fallback-camera-stamp">CAM 02 / LIVE REC</div>
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
          <button type="button" className="claim-icon-button" data-testid="button-video-play" onClick={() => onToggle()} aria-label={playing ? "Pause match" : "Play match"}>{playing ? <Pause size={17} /> : <Play size={17} fill="currentColor" />}</button>
          <div className="claim-video-time"><span>{formatTime(currentTime)}</span><input type="range" min={0} max={duration} value={Math.min(duration, currentTime)} onChange={(event) => onSeek(Number(event.target.value))} aria-label="Match position" data-testid="input-match-position" /><span>{formatTime(duration)}</span></div>
          <button type="button" className={`claim-icon-button ${slow ? "is-on" : ""}`} data-testid="button-slow-motion" onClick={onToggleSlow} aria-label="Toggle slow motion"><Gauge size={17} /></button>
          <button type="button" className="claim-icon-button" data-testid="button-video-mute" onClick={onToggleMute} aria-label={muted ? "Unmute match" : "Mute match"}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
          <button type="button" className="claim-icon-button" data-testid="button-video-fullscreen" onClick={onFullscreen} aria-label="Fullscreen video"><Expand size={17} /></button>
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
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [stage, setStage] = useState<Stage>("find");
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [slow, setSlow] = useState(false);
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [claimedPercent, setClaimedPercent] = useState(0);
  const [clipsUnlocked, setClipsUnlocked] = useState(0);
  const [corrections, setCorrections] = useState<ClaimCorrection[]>([]);
  const [notice, setNotice] = useState("");
  const [queuedCount, setQueuedCount] = useState(0);
  const [undoExpiresAt, setUndoExpiresAt] = useState(0);
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);

  const response = isDemo ? demoQuery.data : claimQuery.data;
  const activeRecordingId = isDemo ? response?.recording.id || 0 : recordingId;
  const recording = response?.recording;
  const bundle = response?.bundle;
  const serverProgress = response?.progress;
  const allCorrections = useMemo(() => {
    const remote = response?.corrections || [];
    const remoteIds = new Set(remote.map((item) => item.clientId));
    return [...remote, ...corrections.filter((item) => !remoteIds.has(item.clientId))];
  }, [corrections, response]);
  const progressValue = Math.max(claimedPercent, serverProgress?.claimedPercent || 0);
  const duration = bundle?.duration || 1;
  const earnedClips = serverProgress?.earnedClips || [];
  const hasData = Boolean(response && recording && bundle && serverProgress);
  const activeCorrection = allCorrections.find((item) => !item.undone);
  const currentFrame = bundle ? matchSecondsToFrame(currentTime, bundle) : 0;

  const seekBy = useCallback((delta: number) => {
    const next = Math.max(0, Math.min(duration, currentTime + delta));
    setCurrentTime(next);
    if (videoRef.current) videoRef.current.currentTime = next;
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

  const saveProgress = useCallback((nextStage: Stage, nextTrackId = currentTrackId, nextPercent = progressValue, nextClips = clipsUnlocked) => {
    const payload = {
      currentTrackId: nextTrackId,
      stage: nextStage,
      confirmedFromSeconds: currentTime,
      currentPositionSeconds: currentTime,
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
  }, [currentTime, currentTrackId, progressValue, clipsUnlocked, earnedClips, isOffline, activeRecordingId, updateProgress, queueProgress]);

  const [narrowing, setNarrowing] = useState<NarrowingState | null>(null);

  const goStage = useCallback((next: Stage, trackId = currentTrackId) => {
    const percentByStage: Record<Stage, number> = { find: 0, following: 19, still: 38, picker: 55, look: 73, done: 100 };
    setStage(next);
    setClaimedPercent(percentByStage[next]);
    setCurrentTrackId(trackId);
    if (next === "following" && trackId && bundle) {
      setNarrowing(startNarrowing(
        crossingsForWindow(bundle, trackId, currentTime, bundle.duration),
        currentTime,
        bundle.duration,
      ));
    }
    setClipsUnlocked((value) => Math.max(value, next === "done" ? earnedClips.length : value));
    saveProgress(next, trackId, Math.max(progressValue, percentByStage[next]), clipsUnlocked);
  }, [bundle, currentTime, currentTrackId, earnedClips.length, progressValue, clipsUnlocked, saveProgress]);

  const stillQuestion = narrowing ? nextNarrowingQuestion(narrowing) : null;

  const confirmStill = useCallback((answer: NarrowingAnswer) => {
    if (!narrowing || !bundle) {
      goStage("picker");
      return;
    }
    if (answer === "not-sure") {
      setNotice("No problem — we’ll keep this moment and check again later");
      return;
    }
    const next = answerNarrowing(narrowing, answer, stillQuestion?.momentSeconds ?? currentTime);
    setNarrowing(next);
    const nextQuestion = nextNarrowingQuestion(next);
    if (nextQuestion.kind === "picker" || nextQuestion.kind === "complete") {
      goStage("picker");
    } else {
      setCurrentTime(nextQuestion.momentSeconds);
      saveProgress("still", currentTrackId, progressValue, clipsUnlocked);
      setNotice("Here’s the next clear passage");
    }
  }, [bundle, clipsUnlocked, currentTime, currentTrackId, goStage, narrowing, progressValue, saveProgress, stillQuestion]);

  const skipAhead = useCallback(() => {
    if (!bundle) return;
    const next = skipToClearPassage(currentTime, bundle.inPlaySpans, bundle.duration);
    setCurrentTime(next);
    if (videoRef.current) videoRef.current.currentTime = next;
    setNotice("Skipped ahead to a clearer passage");
  }, [bundle, currentTime]);

  const candidates = useMemo<Candidate[]>(() => {
    if (!bundle) return [];
    const tracks = bundle.tracks.slice(0, stage === "picker" || stage === "look" ? 4 : 1);
    return tracks.map((track, index) => {
      const box = boxAtFrame(track, currentFrame) || track.boxes[0];
      return {
        id: track.id,
        label: track.label || String(index + 1),
        x: (box?.x || 500) / bundle.width * 100,
        y: (box?.y || 200) / bundle.height * 100,
        w: (box?.w || 100) / bundle.width * 100,
        h: (box?.h || 220) / bundle.height * 100,
        overlap: stage === "look" && index < 2,
      };
    });
  }, [bundle, currentFrame, stage]);

  const firstCandidate = candidates[0];
  const currentLabel = bundle?.tracks.find((track) => track.id === currentTrackId)?.label
    || firstCandidate?.label
    || "player";

  useEffect(() => {
    if (!response || !bundle) return;
    setStage((response.progress.stage as Stage) || "find");
    setCurrentTrackId(response.progress.currentTrackId || null);
    setCurrentTime(response.progress.currentPositionSeconds || 0);
    setClaimedPercent(response.progress.claimedPercent || 0);
    setClipsUnlocked(response.progress.clipsUnlocked || 0);
    setCorrections(response.corrections);
    if (response.progress.currentTrackId && response.progress.stage === "following") {
      setNarrowing(startNarrowing(
        crossingsForWindow(
          bundle,
          response.progress.currentTrackId,
          response.progress.confirmedFromSeconds,
          bundle.duration,
        ),
        response.progress.confirmedFromSeconds,
        bundle.duration,
      ));
    }
  }, [bundle, response]);

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
    for (const action of actions) {
      try {
        if (action.kind === "progress") {
          await updateProgress.mutateAsync({ id: action.recordingId, data: action.payload as never });
        } else if (action.kind === "correction") {
          await createCorrection.mutateAsync({ id: action.recordingId, data: action.payload as never });
        } else {
          await undoCorrection.mutateAsync({ correctionId: action.correctionId });
        }
        await removeClaimAction(action.id);
      } catch {
        break;
      }
    }
    const remaining = await readClaimQueue();
    setQueuedCount(remaining.length);
    await queryClient.invalidateQueries({ queryKey: ["claim-match"] });
  }, [createCorrection, isGuest, isOffline, queryClient, undoCorrection, updateProgress, user]);

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
          setNotice("No problem — we’ll try another moment");
          goStage("picker");
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
          setCurrentTrackId(candidate.id);
          goStage("following", candidate.id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [candidates, confirmStill, goStage, seekBy, slow, stage]);

  useEffect(() => {
    if (!playing || recording?.videoUrl) return;
    const timer = window.setInterval(() => setCurrentTime((value) => Math.min(duration, value + (slow ? 0.2 : 0.8))), 800);
    return () => window.clearInterval(timer);
  }, [duration, playing, recording?.videoUrl, slow]);

  const onCorrection = (chosen: Candidate, method = "picker", allowOverlap = false) => {
    const rejected = currentTrackId && currentTrackId !== chosen.id ? currentTrackId : null;
    const chosenTrack = bundle?.tracks.find((track) => track.id === chosen.id);
    const otherTrack = candidates.find((candidate) => candidate.id !== chosen.id);
    const chosenBox = chosenTrack && boxAtFrame(chosenTrack, currentFrame);
    const otherBox = otherTrack && bundle?.tracks.find((track) => track.id === otherTrack.id) &&
      boxAtFrame(bundle.tracks.find((track) => track.id === otherTrack.id)!, currentFrame);
    if (!allowOverlap && chosenBox && otherBox && boxesOverlap(chosenBox, otherBox) && bundle) {
      const separated = laterSeparatedFrame(bundle, [chosen.id, otherTrack!.id], currentFrame);
      if (separated !== null) {
        setCurrentTime(frameToMatchSeconds(separated, bundle));
        setCurrentTrackId(chosen.id);
        goStage("look", chosen.id);
        setNotice("We found a clearer frame after they separate");
        return;
      }
    }
    setCurrentTrackId(chosen.id);
    goStage(stage === "look" ? "done" : "following", chosen.id);
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
  if (!user || isGuest) return <ErrorState onRetry={() => setLocation("/login")} />;
  if ((isDemo && demoQuery.isLoading) || (!isDemo && claimQuery.isLoading)) return <SkeletonPage />;
  if ((isDemo && demoQuery.isError) || (!isDemo && claimQuery.isError) || !hasData || !recording || !bundle || !serverProgress) {
    return <ErrorState onRetry={() => (isDemo ? demoQuery.refetch() : claimQuery.refetch())} />;
  }

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
    if (videoRef.current) videoRef.current.currentTime = value;
  };
  const handleStageMain = () => {
    if (stage === "find") {
      if (firstCandidate) {
        setCurrentTrackId(firstCandidate.id);
        goStage("following", firstCandidate.id);
      }
    } else if (stage === "following") {
      const question = narrowing ? nextNarrowingQuestion(narrowing) : null;
      if (question?.kind === "question") {
        setCurrentTime(question.momentSeconds);
        if (videoRef.current) videoRef.current.currentTime = question.momentSeconds;
      }
      goStage("still");
    }
    else if (stage === "still") goStage("picker");
    else if (stage === "picker" && firstCandidate) onCorrection(firstCandidate);
    else if (stage === "look" && firstCandidate) onCorrection(firstCandidate, "overlap-resolved");
    else if (stage === "done") setLocation("/my-clips");
  };

  const activeBox = firstCandidate;
  const overlapPair = candidates.length > 1 && activeBox && boxesOverlap(
    { x: activeBox.x, y: activeBox.y, w: activeBox.w, h: activeBox.h, frame: currentFrame },
    { x: candidates[1].x, y: candidates[1].y, w: candidates[1].w, h: candidates[1].h, frame: currentFrame },
  );

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

        <StageRail stage={stage} progress={progressValue} onJump={(next) => { setStage(next); saveProgress(next); }} />

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
              candidates={candidates}
              activeTrackId={currentTrackId}
              showCandidates={stage !== "done"}
               duration={duration}
               onTimeUpdate={setCurrentTime}
            />

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
                <span className="claim-step-count">01 / 06</span>
                <h2>Find yourself</h2>
                <p>We picked a player to start. Watch a few seconds, then tell us if this feels like you.</p>
                <div className="claim-prompt-card"><div className="prompt-icon"><ScanSearch size={19} /></div><div><b>Follow the highlighted player</b><span>The outline stays with them as the match moves.</span></div></div>
                <button type="button" className="claim-button claim-button-primary claim-button-wide" data-testid="button-start-following" onClick={handleStageMain}>That’s me <ChevronRight size={17} /></button>
                <button type="button" className="claim-text-button" data-testid="button-skip-find" onClick={() => goStage("picker")}>I can’t see myself yet <ArrowLeft size={14} /></button>
              </div>
            )}
            {stage === "following" && (
              <div className="claim-panel" data-testid="panel-following">
                <span className="claim-step-count">02 / 06 <span className="claim-live-pill"><span /> FOLLOWING</span></span>
                <h2>Following your player</h2>
                <p>Nice. We’ll keep an eye on this player and pause when we need a quick check-in.</p>
                <div className="claim-follow-status"><div className="claim-follow-avatar">{initials(currentLabel)}</div><div><b>Player {currentLabel}</b><span>Tracking is steady</span></div><ShieldCheck size={19} /></div>
                <button type="button" className="claim-button claim-button-primary claim-button-wide" data-testid="button-confirm-still-here" onClick={handleStageMain}>Keep going <ChevronRight size={17} /></button>
                <button type="button" className="claim-text-button" data-testid="button-change-identity" onClick={() => goStage("picker")}>Not me — show me options <RotateCcw size={14} /></button>
                <p className="claim-undo-copy"><Undo2 size={13} /> Changed your mind? You can undo any correction for the next 10 seconds.</p>
              </div>
            )}
            {stage === "still" && (
              <div className="claim-panel" data-testid="panel-still-you">
                <span className="claim-step-count">03 / 06</span>
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
                <span className="claim-step-count">04 / 06</span>
                <h2>Which one of these<br />is you?</h2>
                <p>It’s okay if they look similar. Pick the player you mean — we’ll use the next clear moment to confirm.</p>
                <div className="candidate-list">
                  {candidates.map((candidate, index) => (
                    <button type="button" key={candidate.id} className="candidate-row" data-testid={`button-candidate-${index + 1}`} onClick={() => onCorrection(candidate)}>
                      <span className="candidate-number">{index + 1}</span><span className="candidate-avatar">{initials(candidate.label)}</span><span className="candidate-copy"><b>Player {candidate.label}</b><small>{index === 0 ? "Closest to your last pick" : "In this frame"}</small></span><ChevronRight size={16} />
                    </button>
                  ))}
                </div>
                <button type="button" className="claim-text-button claim-skip-button" data-testid="button-skip-picker" onClick={() => goStage("look")}>I’m hidden — show a clearer passage <FastForward size={14} /></button>
                <p className="claim-key-note">Choose with <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> on your keyboard</p>
              </div>
            )}
            {stage === "look" && (
              <div className="claim-panel claim-panel-overlap" data-testid="panel-take-another-look">
                <span className="claim-step-count">05 / 06</span>
                <div className="overlap-tag"><ScanSearch size={14} /> OVERLAP MOMENT</div>
                <h2>Take another look</h2>
                <p>Two players crossed paths here. We paused just after they separate so you can choose with a little more room.</p>
                <div className="overlap-callout"><div className="overlap-visual"><span className="overlap-box one" /><span className="overlap-box two" /><span className="overlap-seam" /></div><div><b>Nothing went wrong.</b><span>Busy frames happen in every match.</span></div></div>
                <div className="look-controls"><button type="button" className={`look-control ${slow ? "selected" : ""}`} data-testid="button-look-slow" onClick={() => setSlow((value) => !value)}><Gauge size={15} /> Slow motion <kbd>S</kbd></button><button type="button" className="look-control" data-testid="button-look-back" onClick={() => setCurrentTime((value) => Math.max(0, value - 5))}><RotateCcw size={15} /> 5 sec back</button></div>
                <button type="button" className="claim-button claim-button-primary claim-button-wide" data-testid="button-resolve-overlap" onClick={handleStageMain}>Choose this player <ChevronRight size={17} /></button>
                <button type="button" className="claim-text-button" data-testid="button-skip-overlap" onClick={() => goStage("following", currentTrackId)}>Skip this moment — no guess <FastForward size={14} /></button>
              </div>
            )}
            {stage === "done" && (
              <div className="claim-panel claim-panel-complete" data-testid="panel-done">
                <div className="complete-graphic"><span className="complete-ring"><Check size={24} /></span><span className="complete-spark spark-a" /><span className="complete-spark spark-b" /><span className="complete-spark spark-c" /></div>
                <span className="claim-step-count">06 / 06</span>
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