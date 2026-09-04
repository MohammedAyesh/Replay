import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import {
  Eye, EyeOff, UserCheck, UserX, Shield, ShieldOff, Trash2, Plus, Save, X,
  ExternalLink, Image, RefreshCw, Search, Pencil, ChevronDown, ChevronUp,
  GraduationCap, Video, Check, Radio, Square, AlertTriangle,
  Play, Clock, CheckCircle2, XCircle, Loader2, ExternalLink as LinkIcon,
  CalendarDays, ChevronLeft, ChevronRight,
  Download, Upload,
} from "lucide-react";
import Hls from "hls.js";
import { HlsPlayer as SharedHlsPlayer } from "@/components/HlsPlayer";
import { TrackingAlignmentCheck } from "@/components/TrackingAlignmentCheck";
import { cn } from "@/lib/utils";
import SettingsTab from "@/components/admin/SettingsTab";
import {
  getGetFeedQueryKey,
  getListClipsQueryKey,
  getListUserClipsQueryKey,
  getGetMeQueryKey,
  getGetAccountStatsQueryKey,
  getGetUserProfileQueryKey,
  getListSavedClipsQueryKey,
  getGetBunnyCollectionsQueryKey,
  getGetFieldQueryKey,
  getGetFieldVideosQueryKey,
  getGetFieldRecordingsQueryKey,
  getListBannersQueryKey,
} from "@workspace/api-client-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

type Tab = "clips" | "accounts" | "fields" | "banners" | "academies" | "live" | "recordings" | "matches" | "var" | "claim-disputes" | "settings";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminClip {
  id: number;
  userId: number;
  videoId: string;
  title: string;
  visibility: string;
  isHidden: boolean;
  likeCount: number;
  viewCount: number;
  shareCount: number;
  score: number;
  createdAt: string;
  thumbnailUrl: string | null;
  playbackUrl: string | null;
  startTime: number;
  endTime: number;
  exportStatus: string | null;
  exportedUrl: string | null;
  userName: string;
  userEmail: string;
}

interface AdminUser {
  id: number;
  name: string;
  email: string;
  isAdmin: boolean;
  isDisabled: boolean;
  isGuest: boolean;
  profileComplete: boolean;
  phone: string | null;
  position: string | null;
  age: number | null;
  gender: string | null;
  clerkId: string | null;
  createdAt: string;
  academyId: number | null;
}

interface AdminField {
  id: number;
  name: string;
  location: string;
  courts: number;
  weight: number;
  thumbnailUrl: string | null;
  isHidden: boolean;
  lastRecordedAt: string | null;
  bunnyGuid: string | null;
  cameraId: string | null;
}

interface AdminMatch {
  id: number;
  fieldId: number;
  fieldName: string;
  fieldCameraId: string | null;
  title: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
  autoStartLive: boolean;
  liveStartedAt: string | null;
  liveStoppedAt: string | null;
  createdAt: string;
}

interface AdminRecording {
  id: number;
  fieldId: number;
  fieldName: string | null;
  court: string;
  date: string;
  timeSlot: string;
  duration: string;
  score: string | null;
  videoUrl: string;
  isVisible: boolean;
  hasTrackingBundle?: boolean;
  trackingSegmentCount?: number | null;
  trackingFrameCoverage?: string | null;
  trackingVideoStartSeconds?: number | null;
  trackingPitchModel?: {
    calibrationId: string | null;
    fittedAt: string | null;
    calibratedAspectRatio?: number | null;
    gridRows: number;
    gridColumns: number;
    pitchWidthMetres: number;
    pitchHeightMetres: number;
  } | null;
  hasIdentityMap?: boolean;
  identityMapMatchesBundle?: boolean;
}

interface ClaimDispute {
  id: number;
  recordingId: number;
  recordingLabel: string;
  claimantUserId: number;
  claimantName: string;
  claimantEmail: string;
  personId: string;
  supportCount: number;
  acceptedAnswerCount: number;
  supportPercent: number;
  state: string;
  currentOwnerUserId: number | null;
  currentOwnerName: string | null;
  createdAt: string;
}

interface AdminRecordingPlayerMetric {
  userId: number;
  displayName: string;
  email: string;
  playerStats: {
    minutesPlayed: number;
    distanceMetres: number | null;
    averageSpeedMetresPerSecond: number | null;
  };
  topSpeedMetresPerSecond: number | null;
  topSpeedUsableTimeFraction: number | null;
}

function calibrationDateLabel(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "unknown date";
}

function calibrationLabel(model: AdminRecording["trackingPitchModel"]): string {
  if (!model) return "No valid pitch model";
  if (!model.calibrationId || !model.fittedAt || typeof model.calibratedAspectRatio !== "number") {
    return "Legacy pitch model · reattach required";
  }
  return `Calibration ${model.calibrationId} · fitted ${calibrationDateLabel(model.fittedAt)}`;
}

function calibrationAspectLabel(model: AdminRecording["trackingPitchModel"]): string {
  return typeof model?.calibratedAspectRatio === "number"
    ? `${model.calibratedAspectRatio.toFixed(4)} aspect`
    : "aspect ratio unavailable";
}

interface AdminBanner {
  id: string;
  title: string;
  upperSubtext: string;
  lowerSubtext: string;
  hyperlink: string | null;
  imageUrl: string;
}

interface AdminAcademy {
  id: number;
  name: string;
  fieldId: number;
  fieldName: string;
  fieldLocation: string;
  daysOfWeek: string[];
  description: string | null;
  logoUrl: string | null;
  introVideoUrl: string | null;
  liveAccess: boolean;
  cameraIds: string[];
  recordingCount: number;
}

interface AdminSchedule {
  id: number;
  fieldId: number;
  dayOfWeek: number | null;
  allowedDate: string | null;
  startTime: string;
  endTime: string;
  label: string | null;
}

interface FieldVideo {
  guid: string;
  title: string;
  collectionName?: string;
  thumbnailUrl: string;
  playbackUrl: string;
  duration: number; // seconds
}

function AdminClipPlayer({
  clip,
  onClose,
}: {
  clip: AdminClip;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [renderStatus, setRenderStatus] = useState(clip.exportStatus ?? "idle");
  const playbackUrl = `${basePath}/api/admin/clips/${clip.id}/playback`;
  const [renderedUrl, setRenderedUrl] = useState<string | null>(
    clip.exportedUrl ? playbackUrl : null,
  );
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        if (!clip.exportedUrl) {
          setRenderStatus("pending");
          await apiFetch(`/user-clips/${clip.id}/export`, { method: "POST" });
        }
        const status = await apiFetch(`/user-clips/${clip.id}/export-status`) as {
          status: string;
          url?: string | null;
        };
        if (cancelled) return;
        setRenderStatus(status.status);
        if (status.status === "done" && status.url) {
          setRenderedUrl(playbackUrl);
          return;
        }
        if (status.status === "error") {
          setRenderError("Could not render this clip.");
          return;
        }
        timer = setTimeout(poll, 2000);
      } catch {
        if (!cancelled) setRenderError("Could not prepare this clip for playback.");
      }
    };

    if (!clip.exportedUrl) void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [clip.id, clip.exportedUrl, playbackUrl]);

  return (
    <div className="fixed inset-0 z-[80] bg-black/80 flex items-center justify-center p-4">
      <div className="w-full max-w-3xl rounded-2xl overflow-hidden border border-zinc-700 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-zinc-800">
          <div className="min-w-0">
            <p className="text-white font-semibold truncate">{clip.title}</p>
            <p className="text-zinc-500 text-xs truncate">{clip.userName} · {clip.userEmail}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800"
            aria-label="Close recording"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="aspect-video bg-black flex items-center justify-center">
          {renderedUrl ? (
            <video
              ref={videoRef}
              src={renderedUrl}
              controls
              playsInline
              className="w-full h-full"
              preload="metadata"
            />
          ) : (
            <div className="px-6 text-center">
              {renderError ? (
                <p className="text-red-400 text-sm">{renderError}</p>
              ) : (
                <>
                  <p className="text-white text-sm font-medium">Preparing clip…</p>
                  <p className="text-zinc-500 text-xs mt-1">
                    The selected segment is being rendered for playback.
                  </p>
                  {renderStatus === "pending" && (
                    <div className="mt-3 mx-auto w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── SD-pull types ────────────────────────────────────────────────────────────

interface SdHourInfo {
  hour: number;
  segments: number;
  bytes: number;
}

interface SdAvailability {
  cam: string;
  date: string;
  totalSegments: number;
  hours: SdHourInfo[];
}

type JobPhase = "search" | "download" | "assemble" | "upload" | "encode" | "done" | "failed";

/** Unified type covering both the new rich playback-engine shape and older HQ job shapes. */
interface PlaybackJob {
  jobId: string;
  // camera id — may be "cam" (old) or "cameraId" (new); normalise at read time
  cam?: string;
  cameraId?: string;
  source?: string;
  title?: string;
  // status: new engine uses "running"/"done"/"failed"; old engine had more values
  status: "running" | "done" | "failed" | "queued" | "searching" | "downloading" | "waiting_for_camera" | "assembling" | "uploading";
  phase?: JobPhase;
  percent?: number;
  // requested window — new engine wraps in {start,end}; old engine has top-level start/end
  requested?: { start: string; end: string };
  start?: string;
  end?: string;
  // segments — new engine: {total,done,failed}; old engine: plain number
  segments?: { total: number; done: number; failed: number } | number;
  // bytes — new engine: {downloaded,total}; old engine: bytesExpected/bytesDownloaded
  bytes?: { downloaded: number; total: number };
  bytesExpected?: number;
  bytesDownloaded?: number;
  rate?: number;      // MB/s
  eta?: number | null; // seconds; null during encode
  workers?: number; // active parallel streams
  workerCeiling?: number; // maximum streams this job will use
  message?: string;
  startedAt?: string;
  updatedAt?: string;
  createdAt?: string;
  videoId?: string | null;
  playbackUrl?: string | null; // new field name
  playback?: string | null;    // old field name
  error?: string | null;
  note?: string; // old downloading note
  engine?: string; // which pull method actually ran: "playback" | "download"
}

interface LiveJobRef {
  cam: string;
  jobId: string;
  initialJob: PlaybackJob;
  /** Saved so the retry button can re-submit the identical request. */
  savedRequest?: { date: string; startHour: number; endHour: number; title: string; camera: Camera; source: "playback" | "sd" };
}

interface FtpAvailability {
  cam: string;
  clips: Array<{ start: string; end: string; seconds: number; bytes: number }>;
  earliest?: string; // "YYYY-MM-DD HH:MM:SS" Amman local
  latest?: string;
  note?: string;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function apiFetch(path: string, opts?: RequestInit) {
  const isMultipart = typeof FormData !== "undefined" && opts?.body instanceof FormData;
  const res = await fetch(`${basePath}/api${path}`, {
    credentials: "include",
    headers: {
      ...(isMultipart ? {} : { "Content-Type": "application/json" }),
      ...(opts?.headers ?? {}),
    },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

// ─── Clips Tab ────────────────────────────────────────────────────────────────

function ClaimDisputesTab() {
  const [disputes, setDisputes] = useState<ClaimDispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDisputes(await apiFetch("/admin/claim-match/disputes"));
    } catch {
      setNotice("Could not load claim disputes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const resolve = async (dispute: ClaimDispute, winnerUserId: number) => {
    setWorking(dispute.id);
    setNotice(null);
    try {
      await apiFetch(`/admin/claim-match/disputes/${dispute.id}`, {
        method: "PATCH",
        body: JSON.stringify({ winnerUserId }),
      });
      setNotice("Claim transferred and the previous owner was released.");
      await load();
    } catch {
      setNotice("Could not resolve this dispute.");
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-white text-sm font-semibold">Claim disputes</h2>
        <p className="text-zinc-500 text-xs mt-1">A disputed claimant is never confirmed or awarded clips until you choose the owner.</p>
      </div>
      {notice && <div className="rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-300">{notice}</div>}
      {loading ? <div className="py-16 text-center text-zinc-500">Loading…</div> : disputes.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-10 text-center text-sm text-zinc-500">No disputes waiting for review.</div>
      ) : disputes.map((dispute) => (
        <div key={dispute.id} className="rounded-xl border border-amber-500/20 bg-zinc-900 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-white">{dispute.recordingLabel}</p>
              <p className="mt-1 text-xs text-zinc-400">Person {dispute.personId} · {Math.round(dispute.supportPercent)}% support from {dispute.acceptedAnswerCount} accepted answers</p>
            </div>
          </div>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <div className="rounded-lg bg-zinc-800/70 p-3">
              <p className="text-[10px] uppercase tracking-wide text-zinc-500">Current owner</p>
              <p className="mt-1 text-zinc-200">{dispute.currentOwnerName ?? "Unassigned"}</p>
              {dispute.currentOwnerUserId && <button disabled={working === dispute.id} onClick={() => void resolve(dispute, dispute.currentOwnerUserId!)} className="mt-2 text-xs font-semibold text-primary hover:underline">Keep current owner</button>}
            </div>
            <div className="rounded-lg bg-zinc-800/70 p-3">
              <p className="text-[10px] uppercase tracking-wide text-zinc-500">Pending claimant</p>
              <p className="mt-1 text-zinc-200">{dispute.claimantName}</p>
              <p className="text-xs text-zinc-500">{dispute.claimantEmail}</p>
              <button disabled={working === dispute.id} onClick={() => void resolve(dispute, dispute.claimantUserId)} className="mt-2 text-xs font-semibold text-primary hover:underline">Transfer to claimant</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ClipsTab() {
  const [clips, setClips] = useState<AdminClip[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedPlayer, setSelectedPlayer] = useState<number | null>(null);
  const [bulkWorking, setBulkWorking] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [playingClip, setPlayingClip] = useState<AdminClip | null>(null);
  const queryClient = useQueryClient();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/admin/clips");
      setClips(data ?? []);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const invalidateFeeds = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getGetFeedQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListUserClipsQueryKey() });
  }, [queryClient]);

  const toggleHidden = async (clip: AdminClip) => {
    await apiFetch(`/admin/clips/${clip.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isHidden: !clip.isHidden }),
    });
    setClips((prev) => prev.map((c) => c.id === clip.id ? { ...c, isHidden: !c.isHidden } : c));
    invalidateFeeds();
  };

  const deleteClip = async (clip: AdminClip) => {
    if (!confirm(`Delete "${clip.title}"? This cannot be undone.`)) return;
    setDeleting(clip.id);
    try {
      await apiFetch(`/admin/clips/${clip.id}`, { method: "DELETE" });
      setClips((prev) => prev.filter((c) => c.id !== clip.id));
      invalidateFeeds();
    } catch { /* silent */ }
    setDeleting(null);
  };

  const players = Array.from(
    new Map(clips.map((c) => [c.userId, { id: c.userId, name: c.userName }])).values()
  ).sort((a, b) => a.name.localeCompare(b.name));

  const bulkSetHidden = async (hidden: boolean) => {
    const targets = clips.filter((c) => c.userId === selectedPlayer && c.isHidden !== hidden);
    if (!targets.length) return;
    setBulkWorking(true);
    try {
      for (const clip of targets) {
        await apiFetch(`/admin/clips/${clip.id}`, {
          method: "PATCH",
          body: JSON.stringify({ isHidden: hidden }),
        });
      }
      setClips((prev) =>
        prev.map((c) => c.userId === selectedPlayer ? { ...c, isHidden: hidden } : c)
      );
      invalidateFeeds();
    } catch { /* silent */ }
    setBulkWorking(false);
  };

  const filtered = clips.filter((c) => {
    if (selectedPlayer !== null && c.userId !== selectedPlayer) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.title.toLowerCase().includes(q) ||
      c.userName.toLowerCase().includes(q) ||
      c.userEmail.toLowerCase().includes(q)
    );
  });

  const selectedPlayerClips = selectedPlayer !== null ? clips.filter((c) => c.userId === selectedPlayer) : [];
  const allHidden = selectedPlayerClips.length > 0 && selectedPlayerClips.every((c) => c.isHidden);
  const noneHidden = selectedPlayerClips.every((c) => !c.isHidden);

  return (
    <div className="space-y-4">
      {/* Player filter row */}
      <div className="flex items-center gap-2">
        <select
          value={selectedPlayer ?? ""}
          onChange={(e) => setSelectedPlayer(e.target.value === "" ? null : Number(e.target.value))}
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-primary appearance-none"
        >
          <option value="">All players</option>
          {players.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {selectedPlayer !== null && (
          <>
            <button
              onClick={() => bulkSetHidden(true)}
              disabled={bulkWorking || allHidden}
              className="px-3 py-2 rounded-xl bg-red-900/40 text-red-400 border border-red-800/50 text-xs font-medium hover:bg-red-900/60 disabled:opacity-40 transition-colors"
              title="Hide all clips from this player"
            >
              <EyeOff className="w-4 h-4" />
            </button>
            <button
              onClick={() => bulkSetHidden(false)}
              disabled={bulkWorking || noneHidden}
              className="px-3 py-2 rounded-xl bg-primary/20 text-primary border border-primary/30 text-xs font-medium hover:bg-primary/30 disabled:opacity-40 transition-colors"
              title="Show all clips from this player"
            >
              <Eye className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
      {/* Search + count row */}
      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clips or players…"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-primary"
          />
        </div>
        <span className="text-zinc-500 text-xs shrink-0">{filtered.length} clips</span>
      </div>

      {loading ? (
        <div className="text-center py-16 text-zinc-500">Loading…</div>
      ) : (
        <div className="space-y-2">
          {filtered.map((clip) => (
            <div
              key={clip.id}
              className={cn(
                "flex items-center gap-3 p-3 rounded-xl border transition-colors",
                clip.isHidden
                  ? "bg-zinc-900/50 border-zinc-800 opacity-60"
                  : "bg-zinc-900 border-zinc-800"
              )}
            >
              {clip.thumbnailUrl ? (
                <img
                  src={clip.thumbnailUrl}
                  alt={clip.title}
                  className="w-16 h-10 object-cover rounded-lg flex-shrink-0 bg-zinc-800"
                />
              ) : (
                <div className="w-16 h-10 rounded-lg bg-zinc-800 flex-shrink-0 flex items-center justify-center">
                  <Image className="w-4 h-4 text-zinc-600" />
                </div>
              )}

              <div className="flex-1 min-w-0">
                <p className="text-white text-sm font-medium truncate">{clip.title}</p>
                <p className="text-zinc-500 text-xs truncate">{clip.userName} · {clip.viewCount}v · {clip.likeCount}♥</p>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                {clip.isHidden && (
                  <span className="text-[10px] bg-red-900/40 text-red-400 px-2 py-0.5 rounded-full border border-red-800/50">
                    Hidden
                  </span>
                )}
                <button
                  onClick={() => setPlayingClip(clip)}
                  disabled={!clip.playbackUrl}
                  className="p-2 rounded-lg bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title={clip.playbackUrl ? "Watch clip" : "Playback unavailable"}
                >
                  <Play className="w-4 h-4 fill-current" />
                </button>
                <button
                  onClick={() => toggleHidden(clip)}
                  className={cn(
                    "p-2 rounded-lg transition-colors",
                    clip.isHidden
                      ? "bg-primary/20 text-primary hover:bg-primary/30"
                      : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white"
                  )}
                  title={clip.isHidden ? "Show clip" : "Hide clip"}
                >
                  {clip.isHidden ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => deleteClip(clip)}
                  disabled={deleting === clip.id}
                  className="p-2 rounded-lg bg-zinc-800 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50"
                  title="Delete clip"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {playingClip && (
        <AdminClipPlayer
          clip={playingClip}
          onClose={() => setPlayingClip(null)}
        />
      )}
    </div>
  );
}

// ─── Accounts Tab ─────────────────────────────────────────────────────────────

function AccountsTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [academies, setAcademies] = useState<{ id: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const { user: me } = useAuth();
  const [editing, setEditing] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<Partial<AdminUser>>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, acData] = await Promise.all([
        apiFetch("/admin/users"),
        apiFetch("/academies"),
      ]);
      setUsers(data ?? []);
      setAcademies((acData ?? []).map((a: AdminAcademy) => ({ id: a.id, name: a.name })));
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = (user: AdminUser) => {
    setEditing(user.id);
    setEditForm({
      name: user.name,
      email: user.email,
      phone: user.phone ?? "",
      position: user.position ?? "",
      age: user.age ?? undefined,
      gender: user.gender ?? "",
      academyId: user.academyId ?? null,
    });
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditForm({});
  };

  const saveUser = async (user: AdminUser) => {
    setSaving(true);
    const body: Record<string, unknown> = {};
    if (editForm.name !== undefined) body.name = editForm.name;
    if (editForm.email !== undefined) body.email = editForm.email;
    if (editForm.phone !== undefined) body.phone = editForm.phone;
    if (editForm.position !== undefined) body.position = editForm.position;
    if (editForm.age !== undefined) body.age = editForm.age == null ? null : Number(editForm.age);
    if (editForm.gender !== undefined) body.gender = editForm.gender;
    if (editForm.academyId !== undefined) body.academyId = editForm.academyId ?? null;

    try {
      const updated = await apiFetch(`/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, ...updated } : u));
      cancelEdit();
      queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetAccountStatsQueryKey() });
      if (user.clerkId) {
        queryClient.invalidateQueries({ queryKey: getGetUserProfileQueryKey(user.id) });
      }
    } catch { /* silent */ }
    setSaving(false);
  };

  const patchToggle = async (user: AdminUser, updates: Partial<AdminUser>) => {
    try {
      await apiFetch(`/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      });
      setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, ...updates } : u));
      queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetAccountStatsQueryKey() });
      if (user.clerkId) {
        queryClient.invalidateQueries({ queryKey: getGetUserProfileQueryKey(user.id) });
      }
    } catch { /* silent */ }
  };

  const deleteUser = async (user: AdminUser) => {
    if (!confirm(`Permanently delete ${user.name} (${user.email})? This cannot be undone.`)) return;
    setDeleting(user.id);
    try {
      await apiFetch(`/admin/users/${user.id}`, { method: "DELETE" });
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
      queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetAccountStatsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListSavedClipsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetFeedQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
    } catch { /* silent */ }
    setDeleting(null);
  };

  const filtered = users.filter((u) =>
    u.name.toLowerCase().includes(search.toLowerCase()) ||
    u.email.toLowerCase().includes(search.toLowerCase()) ||
    (u.phone ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search accounts…"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-primary"
          />
        </div>
        <span className="text-zinc-500 text-xs shrink-0">{filtered.length} accounts</span>
      </div>

      {loading ? (
        <div className="text-center py-16 text-zinc-500">Loading…</div>
      ) : (
        <div className="space-y-2">
          {filtered.map((user) => {
            const isSelf = user.id === me?.id;
            const isEdit = editing === user.id;
            return (
              <div
                key={user.id}
                className={cn(
                  "rounded-xl border overflow-hidden",
                  user.isDisabled ? "bg-zinc-900/50 border-zinc-800 opacity-60" : "bg-zinc-900 border-zinc-800"
                )}
              >
                <div className="flex items-center gap-3 p-3">
                  <div className="w-9 h-9 rounded-full bg-zinc-800 flex items-center justify-center text-sm font-bold text-zinc-300 flex-shrink-0">
                    {user.name[0]?.toUpperCase() ?? "?"}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="text-white text-sm font-medium truncate">{user.name}</p>
                      {user.isAdmin && (
                        <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded-full border border-primary/30">
                          Admin
                        </span>
                      )}
                      {isSelf && (
                        <span className="text-[10px] bg-zinc-700 text-zinc-400 px-1.5 py-0.5 rounded-full">
                          You
                        </span>
                      )}
                    </div>
                    <p className="text-zinc-500 text-xs truncate">{user.email}</p>
                  </div>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => isEdit ? cancelEdit() : startEdit(user)}
                      className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
                      title={isEdit ? "Cancel" : "Edit account"}
                    >
                      {isEdit ? <X className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                    </button>
                    {!isSelf && (
                      <>
                        <button
                          onClick={() => patchToggle(user, { isAdmin: !user.isAdmin })}
                          className={cn(
                            "p-2 rounded-lg transition-colors",
                            user.isAdmin
                              ? "bg-primary/20 text-primary hover:bg-primary/30"
                              : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white"
                          )}
                          title={user.isAdmin ? "Remove admin" : "Make admin"}
                        >
                          {user.isAdmin ? <Shield className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
                        </button>
                        <button
                          onClick={() => patchToggle(user, { isDisabled: !user.isDisabled })}
                          className={cn(
                            "p-2 rounded-lg transition-colors",
                            user.isDisabled
                              ? "bg-red-900/30 text-red-400 hover:bg-red-900/50"
                              : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white"
                          )}
                          title={user.isDisabled ? "Enable account" : "Disable account"}
                        >
                          {user.isDisabled ? <UserCheck className="w-4 h-4" /> : <UserX className="w-4 h-4" />}
                        </button>
                        <button
                          onClick={() => deleteUser(user)}
                          disabled={deleting === user.id}
                          className="p-2 rounded-lg bg-zinc-800 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50"
                          title="Delete account"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {isEdit && (
                  <div className="border-t border-zinc-800 p-3 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-zinc-400 mb-1 block">Name</label>
                        <input
                          value={editForm.name ?? ""}
                          onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-400 mb-1 block">Email</label>
                        <input
                          value={editForm.email ?? ""}
                          onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-400 mb-1 block">Phone</label>
                        <input
                          value={editForm.phone ?? ""}
                          onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-400 mb-1 block">Position</label>
                        <input
                          value={editForm.position ?? ""}
                          onChange={(e) => setEditForm((f) => ({ ...f, position: e.target.value }))}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-400 mb-1 block">Age</label>
                        <input
                          type="number"
                          value={editForm.age ?? ""}
                          onChange={(e) => setEditForm((f) => ({ ...f, age: e.target.value === "" ? undefined : Number(e.target.value) }))}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-400 mb-1 block">Gender</label>
                        <input
                          value={editForm.gender ?? ""}
                          onChange={(e) => setEditForm((f) => ({ ...f, gender: e.target.value }))}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-zinc-400 mb-1 block">Academy (Live Access)</label>
                      <select
                        value={editForm.academyId ?? ""}
                        onChange={(e) => setEditForm((f) => ({ ...f, academyId: e.target.value === "" ? null : Number(e.target.value) }))}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                      >
                        <option value="">— No academy —</option>
                        {academies.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => saveUser(user)}
                        disabled={saving}
                        className="flex-1 flex items-center justify-center gap-2 bg-primary text-black font-bold py-2.5 rounded-xl text-sm disabled:opacity-50"
                      >
                        <Save className="w-4 h-4" />
                        {saving ? "Saving…" : "Save Changes"}
                      </button>
                      <button onClick={cancelEdit} className="px-4 py-2.5 bg-zinc-800 text-zinc-400 rounded-xl text-sm hover:bg-zinc-700">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Fields Tab ───────────────────────────────────────────────────────────────

function FieldsTab() {
  const [fields, setFields] = useState<AdminField[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<number | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [thumbInput, setThumbInput] = useState("");
  const [weightInput, setWeightInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const queryClient = useQueryClient();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/admin/fields");
      setFields(data ?? []);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const syncFields = async () => {
    setSyncing(true);
    try {
      const data = await apiFetch("/admin/fields/sync", { method: "POST" });
      if (data?.fields) setFields(data.fields);
      queryClient.invalidateQueries({ queryKey: getGetBunnyCollectionsQueryKey() });
    } catch { /* silent */ }
    setSyncing(false);
  };

  const startEdit = (field: AdminField) => {
    setEditing(field.id);
    setNameInput(field.name);
    setThumbInput(field.thumbnailUrl ?? "");
    setWeightInput(String(field.weight));
  };

  const cancelEdit = () => {
    setEditing(null);
    setNameInput("");
    setThumbInput("");
    setWeightInput("");
  };

  const saveField = async (field: AdminField) => {
    setSaving(true);
    try {
      await apiFetch(`/admin/fields/${field.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: nameInput.trim() || field.name,
          thumbnailUrl: thumbInput.trim() || null,
          weight: parseFloat(weightInput) || 1.0,
        }),
      });
      setFields((prev) => prev.map((f) =>
        f.id === field.id
          ? { ...f, name: nameInput.trim() || f.name, thumbnailUrl: thumbInput.trim() || null, weight: parseFloat(weightInput) || 1.0 }
          : f
      ));
      cancelEdit();
      queryClient.invalidateQueries({ queryKey: getGetBunnyCollectionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetFieldQueryKey(field.id) });
      queryClient.invalidateQueries({ queryKey: getGetFieldVideosQueryKey(field.id) });
      queryClient.invalidateQueries({ queryKey: getGetFieldRecordingsQueryKey(field.id) });
    } catch { /* silent */ }
    setSaving(false);
  };

  const toggleHidden = async (field: AdminField) => {
    setToggling(field.id);
    try {
      await apiFetch(`/admin/fields/${field.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isHidden: !field.isHidden }),
      });
      setFields((prev) => prev.map((f) =>
        f.id === field.id ? { ...f, isHidden: !f.isHidden } : f
      ));
      queryClient.invalidateQueries({ queryKey: getGetBunnyCollectionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetFieldQueryKey(field.id) });
      queryClient.invalidateQueries({ queryKey: getGetFieldVideosQueryKey(field.id) });
      queryClient.invalidateQueries({ queryKey: getGetFieldRecordingsQueryKey(field.id) });
    } catch { /* silent */ }
    setToggling(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-zinc-500 text-xs">{fields.length} field{fields.length !== 1 ? "s" : ""}</span>
        <button
          onClick={syncFields}
          disabled={syncing}
          className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 text-zinc-300 rounded-xl text-sm hover:bg-zinc-700 disabled:opacity-50"
        >
          <RefreshCw className={cn("w-4 h-4", syncing && "animate-spin")} />
          {syncing ? "Syncing…" : "Sync from Bunny"}
        </button>
      </div>

      {loading ? (
        <div className="text-center py-16 text-zinc-500">Loading…</div>
      ) : (
        fields.map((field) => (
          <div
            key={field.id}
            className={cn(
              "border rounded-xl overflow-hidden transition-colors",
              field.isHidden ? "bg-zinc-900/50 border-zinc-800/50 opacity-60" : "bg-zinc-900 border-zinc-800"
            )}
          >
            <div className="flex items-center gap-3 p-3">
              <div className="w-14 h-14 rounded-lg overflow-hidden bg-zinc-800 flex-shrink-0">
                {field.thumbnailUrl ? (
                  <img src={field.thumbnailUrl} alt={field.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full field-pattern opacity-50" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-white font-medium text-sm truncate">{field.name}</p>
                  {field.isHidden && (
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded-full">
                      Hidden
                    </span>
                  )}
                </div>
                <p className="text-zinc-500 text-xs truncate">{field.location}</p>
                <p className="text-zinc-600 text-xs">Weight: {field.weight} · {field.courts} court{field.courts !== 1 ? "s" : ""}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => toggleHidden(field)}
                  disabled={toggling === field.id}
                  title={field.isHidden ? "Show field" : "Hide field"}
                  className={cn(
                    "p-2 rounded-lg transition-colors disabled:opacity-50",
                    field.isHidden
                      ? "bg-amber-400/10 text-amber-400 hover:bg-amber-400/20"
                      : "bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700"
                  )}
                >
                  {field.isHidden ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => editing === field.id ? cancelEdit() : startEdit(field)}
                  className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
                >
                  {editing === field.id ? <X className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {editing === field.id && (
              <div className="border-t border-zinc-800 p-3 space-y-3">
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">Field Name</label>
                  <input
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    placeholder="Field name"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">Thumbnail URL</label>
                  <input
                    value={thumbInput}
                    onChange={(e) => setThumbInput(e.target.value)}
                    placeholder="https://example.com/image.jpg"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
                  />
                  {thumbInput && (
                    <img
                      src={thumbInput}
                      alt="preview"
                      className="mt-2 h-24 w-full object-cover rounded-lg bg-zinc-800"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0.3"; }}
                    />
                  )}
                </div>
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">Recommendation Weight</label>
                  <input
                    type="number"
                    value={weightInput}
                    onChange={(e) => setWeightInput(e.target.value)}
                    step="0.1"
                    min="0"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                  />
                </div>
                <button
                  onClick={() => saveField(field)}
                  disabled={saving}
                  className="w-full flex items-center justify-center gap-2 bg-primary text-black font-bold py-2.5 rounded-xl text-sm disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  {saving ? "Saving…" : "Save Changes"}
                </button>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ─── Banners Tab ──────────────────────────────────────────────────────────────

function BannersTab() {
  const [banners, setBanners] = useState<AdminBanner[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ id: "", title: "", upperSubtext: "", lowerSubtext: "", hyperlink: "", imageUrl: "" });
  const [uploadingImage, setUploadingImage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/admin/banners");
      setBanners(data ?? []);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = (banner: AdminBanner) => {
    setEditing(banner.id);
    setShowNew(false);
    setForm({
      id: banner.id,
      title: banner.title,
      upperSubtext: banner.upperSubtext,
      lowerSubtext: banner.lowerSubtext,
      hyperlink: banner.hyperlink ?? "",
      imageUrl: banner.imageUrl ?? "",
    });
  };

  const startNew = () => {
    setEditing(null);
    setShowNew(true);
    setForm({ id: "", title: "", upperSubtext: "", lowerSubtext: "", hyperlink: "", imageUrl: "" });
  };

  const cancel = () => { setEditing(null); setShowNew(false); };

  const saveBanner = async () => {
    setSaving(true);
    try {
      if (showNew) {
        const data = await apiFetch("/admin/banners", {
          method: "POST",
          body: JSON.stringify({
            id: form.id,
            title: form.title,
            upperSubtext: form.upperSubtext,
            lowerSubtext: form.lowerSubtext,
            hyperlink: form.hyperlink || null,
            imageUrl: form.imageUrl.trim() || null,
          }),
        });
        setBanners((prev) => [...prev, data]);
      } else if (editing) {
        const data = await apiFetch(`/admin/banners/${editing}`, {
          method: "PATCH",
          body: JSON.stringify({
            title: form.title,
            upperSubtext: form.upperSubtext,
            lowerSubtext: form.lowerSubtext,
            hyperlink: form.hyperlink || null,
            imageUrl: form.imageUrl.trim() || null,
          }),
        });
        setBanners((prev) => prev.map((b) => b.id === editing ? { ...b, ...data } : b));
      }
      cancel();
      queryClient.invalidateQueries({ queryKey: getListBannersQueryKey() });
    } catch { /* silent */ }
    setSaving(false);
  };

  const deleteBanner = async (id: string) => {
    setDeleting(id);
    try {
      await apiFetch(`/admin/banners/${id}`, { method: "DELETE" });
      setBanners((prev) => prev.filter((b) => b.id !== id));
      queryClient.invalidateQueries({ queryKey: getListBannersQueryKey() });
    } catch { /* silent */ }
    setDeleting(null);
  };

  // A plain render helper, NOT a component.
  //
  // This used to be a `BannerForm` component defined here and rendered as JSX.
  // Defining a component inside the parent's render body gives it a new
  // identity on every render, so each keystroke made React unmount the whole
  // form and mount a fresh one: the input lost focus and every character after
  // the first was dropped. Calling it as a function inlines the elements into
  // this component's tree instead, and the inputs keep their DOM nodes.
  const renderBannerForm = () => {
    const effectiveImageUrl = form.imageUrl.trim() || (showNew ? "" : `/api/banners/${encodeURIComponent(editing ?? form.id)}/image`);

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const bannerId = showNew ? form.id : editing;
      if (!bannerId) return;
      setUploadingImage(true);
      try {
        const fd = new FormData();
        fd.append("image", file);
        const res = await fetch(`${basePath}/api/admin/banners/${bannerId}/image`, {
          method: "POST",
          credentials: "include",
          body: fd,
        });
        if (res.ok) {
          const data = await res.json() as { imageUrl: string };
          setForm((f) => ({ ...f, imageUrl: data.imageUrl }));
        }
      } catch { /* silent */ }
      setUploadingImage(false);
      e.target.value = "";
    };

    return (
      <div className="bg-zinc-900 border border-primary/30 rounded-xl p-4 space-y-3">
        {showNew && (
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Banner ID (slug, no spaces)</label>
            <input
              value={form.id}
              onChange={(e) => setForm((f) => ({ ...f, id: e.target.value.replace(/[^a-zA-Z0-9_-]/g, "") }))}
              placeholder="my-banner"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
            />
          </div>
        )}
        {(["title", "upperSubtext", "lowerSubtext"] as const).map((field) => (
          <div key={field}>
            <label className="text-xs text-zinc-400 mb-1 block capitalize">{field.replace(/([A-Z])/g, " $1")}</label>
            <input
              value={form[field]}
              onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
              placeholder={field}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
            />
          </div>
        ))}
        <div>
          <label className="text-xs text-zinc-400 mb-1 block">Hyperlink (optional)</label>
          <input
            value={form.hyperlink}
            onChange={(e) => setForm((f) => ({ ...f, hyperlink: e.target.value }))}
            placeholder="https://example.com"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
          />
        </div>
        <div>
          <label className="text-xs text-zinc-400 mb-1 block">Image</label>
          <div className="flex gap-2">
            <input
              value={form.imageUrl}
              onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))}
              placeholder="https://example.com/image.jpg or upload below"
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
            />
            <label className="cursor-pointer px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors text-sm flex items-center gap-1.5 flex-shrink-0">
              <Image className="w-4 h-4" />
              <span>Upload</span>
              <input type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
            </label>
          </div>
          {uploadingImage && <p className="text-xs text-zinc-500 mt-1">Uploading image…</p>}
          {effectiveImageUrl && (
            <img
              src={effectiveImageUrl}
              alt="Banner preview"
              className="mt-2 h-24 w-full object-cover rounded-lg bg-zinc-800"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0.3"; }}
            />
          )}
        </div>
        <div className="flex gap-2 pt-1">
          <button
            onClick={saveBanner}
            disabled={saving || uploadingImage || (showNew && !form.id)}
            className="flex-1 flex items-center justify-center gap-2 bg-primary text-black font-bold py-2.5 rounded-xl text-sm disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {saving ? "Saving…" : showNew ? "Create Banner" : "Save Changes"}
          </button>
          <button onClick={cancel} className="px-4 py-2.5 bg-zinc-800 text-zinc-400 rounded-xl text-sm hover:bg-zinc-700">
            Cancel
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-zinc-500 text-xs">{banners.length} banner{banners.length !== 1 ? "s" : ""}</span>
        <button
          onClick={startNew}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-black font-bold rounded-xl text-sm"
        >
          <Plus className="w-4 h-4" />
          New Banner
        </button>
      </div>

      {showNew && renderBannerForm()}

      {loading ? (
        <div className="text-center py-16 text-zinc-500">Loading…</div>
      ) : (
        <div className="space-y-2">
          {banners.map((banner) => (
            <div key={banner.id}>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                <div className="flex items-center gap-3 p-3">
                  <img
                    src={banner.imageUrl}
                    alt={banner.title}
                    className="w-16 h-10 object-cover rounded-lg bg-zinc-800 flex-shrink-0"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0.3"; }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium text-sm truncate">{banner.title}</p>
                    {banner.hyperlink && (
                      <a href={banner.hyperlink} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 text-primary text-xs truncate hover:underline">
                        <ExternalLink className="w-3 h-3" />
                        {banner.hyperlink}
                      </a>
                    )}
                    {!banner.hyperlink && (
                      <p className="text-zinc-600 text-xs">{banner.upperSubtext || "—"}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => editing === banner.id ? cancel() : startEdit(banner)}
                      className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
                    >
                      {editing === banner.id ? <X className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => deleteBanner(banner.id)}
                      disabled={deleting === banner.id}
                      className="p-2 rounded-lg bg-zinc-800 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                {editing === banner.id && (
                  <div className="border-t border-zinc-800 p-3">
                    {renderBannerForm()}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Academies helpers ────────────────────────────────────────────────────────

function secondsToMinStr(secs: number): string {
  if (!secs) return "";
  const m = Math.round(secs / 60);
  return m > 0 ? `${m}min` : `${secs}s`;
}

/**
 * Parse a Bunny video title into court/date/timeSlot for the recordings table.
 * Mirrors parseVideoFilename in field-detail.tsx — keep the two in sync.
 * Supports:
 *   Format A: cam{N}_..._{DDMMYYYY}_{HHMMSS}     e.g. cam1_Field_01_19072026_150000
 *   Format C: cam{N}_{YYYY-MM-DD}_{HH:MM}        e.g. cam1_2026-07-28_11:00 (on-demand recordings)
 *   Format B: cam{N}_{YYYYMMDD}{HH}              e.g. cam1_2026072714
 * Falls back to today's date only if none of these match, which should only
 * happen for a title that was never machine-generated in the first place.
 */
function parseVideoTitle(title: string): { court: string; date: string; timeSlot: string; duration: string } {
  const name = title.replace(/\.\w+$/, "");
  const parts = name.split("_");
  const camMatch = parts[0]?.match(/^cam(\d+)$/i);
  const court = camMatch ? `Camera ${camMatch[1]}` : "Court 1";

  if (parts.length >= 3) {
    const datePart = parts[parts.length - 2];
    const timePart = parts[parts.length - 1];

    // Format A: DDMMYYYY + HHMMSS
    if (/^\d{8}$/.test(datePart) && /^\d{6}$/.test(timePart)) {
      const day = datePart.slice(0, 2), month = datePart.slice(2, 4), year = datePart.slice(4, 8);
      return { court, date: `${year}-${month}-${day}`, timeSlot: `${timePart.slice(0, 2)}:${timePart.slice(2, 4)}`, duration: "" };
    }

    // Format C: YYYY-MM-DD + HH:MM
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart) && /^\d{1,2}:\d{2}$/.test(timePart)) {
      return { court, date: datePart, timeSlot: timePart, duration: "" };
    }
  }

  // Format B: cam{N}_YYYYMMDDHH (10 digits, no separate time segment)
  if (parts.length === 2 && /^\d{10}$/.test(parts[1])) {
    const chunk = parts[1];
    const year = chunk.slice(0, 4), month = chunk.slice(4, 6), day = chunk.slice(6, 8), hh = chunk.slice(8, 10);
    return { court, date: `${year}-${month}-${day}`, timeSlot: `${hh}:00`, duration: "" };
  }

  return { court: "Court 1", date: new Date().toISOString().slice(0, 10), timeSlot: "", duration: "" };
}

// ─── Academies Tab ────────────────────────────────────────────────────────────

const ALL_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_LABELS: Record<string, string> = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
  friday: "Fri", saturday: "Sat", sunday: "Sun",
};

function AcademiesTab() {
  const [academies, setAcademies] = useState<AdminAcademy[]>([]);
  const [fields, setFields] = useState<AdminField[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [form, setForm] = useState({ name: "", fieldId: 0, daysOfWeek: [] as string[], description: "", logoUrl: "", introVideoUrl: null as string | null, cameraIds: [] as string[] });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);

  // Per-academy recording data
  const [recMap, setRecMap] = useState<Record<number, AdminRecording[]>>({});
  const [allRecordings, setAllRecordings] = useState<AdminRecording[]>([]);
  const [recLoading, setRecLoading] = useState<number | null>(null);
  const [addingRec, setAddingRec] = useState<number | null>(null);
  const [removingRec, setRemovingRec] = useState<string | null>(null);

  // Intro video
  const [introUrl, setIntroUrl] = useState<string | null>(null);
  const [introLoading, setIntroLoading] = useState(true);
  const [introUploading, setIntroUploading] = useState(false);

  // Add-recording from field videos
  const [allBunnyVideos, setAllBunnyVideos] = useState<FieldVideo[]>([]);
  const [videosLoading, setVideosLoading] = useState<number | null>(null);
  const [selectedVideoGuid, setSelectedVideoGuid] = useState<string | null>(null);
  const [linkingRec, setLinkingRec] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [acData, fData] = await Promise.all([
        apiFetch("/admin/academies"),
        apiFetch("/admin/fields"),
      ]);
      setAcademies(acData ?? []);
      setFields(fData ?? []);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    apiFetch("/admin/clip-intro")
      .then((data) => setIntroUrl(data?.introVideoUrl ?? null))
      .catch(() => {})
      .finally(() => setIntroLoading(false));
  }, []);

  const uploadIntro = async (file: File) => {
    setIntroUploading(true);
    try {
      const formData = new FormData();
      formData.append("video", file);
      const response = await fetch(`${basePath}/api/admin/clip-intro`, {
        method: "POST", credentials: "include", body: formData,
      });
      if (!response.ok) throw new Error("Upload failed");
      const data = await response.json();
      setIntroUrl(data.introVideoUrl);
    } catch { /* keep current intro */ }
    setIntroUploading(false);
  };

  const removeIntro = async () => {
    await apiFetch("/admin/clip-intro", { method: "DELETE" });
    setIntroUrl(null);
  };

  const linkVideo = async (academy: AdminAcademy) => {
    const video = allBunnyVideos.find((v) => v.guid === selectedVideoGuid);
    if (!video) return;
    setLinkingRec(true);
    try {
      const parsed = parseVideoTitle(video.title);
      const rec: AdminRecording = await apiFetch("/admin/recordings", {
        method: "POST",
        body: JSON.stringify({
          fieldId: academy.fieldId,
          court: parsed.court,
          date: parsed.date,
          timeSlot: parsed.timeSlot,
          duration: parsed.duration || secondsToMinStr(video.duration),
          score: null,
          videoUrl: video.playbackUrl,
        }),
      });
      setAllRecordings((p) => [...p, rec]);
      setSelectedVideoGuid(null);
    } catch { /* silent */ }
    setLinkingRec(false);
  };

  const loadRecordings = useCallback(async (academy: AdminAcademy) => {
    setRecLoading(academy.id);
    setVideosLoading(academy.fieldId);
    try {
      const [acRecs, recordings, videos] = await Promise.all([
        apiFetch(`/academies/${academy.id}/recordings`),
        apiFetch("/admin/recordings"),
        apiFetch("/bunny/all-videos"),
      ]);
      setRecMap((p) => ({ ...p, [academy.id]: acRecs ?? [] }));
      setAllRecordings(recordings ?? []);
      setAllBunnyVideos(videos ?? []);
    } catch { /* silent */ }
    setRecLoading(null);
    setVideosLoading(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleExpand = (academy: AdminAcademy) => {
    if (expandedId === academy.id) {
      setExpandedId(null);
      setSelectedVideoGuid(null);
    } else {
      setExpandedId(academy.id);
      setSelectedVideoGuid(null);
      if (!recMap[academy.id]) loadRecordings(academy);
    }
  };

  const startNew = () => {
    setEditing("new");
    setForm({ name: "", fieldId: fields[0]?.id ?? 0, daysOfWeek: [], description: "", logoUrl: "", introVideoUrl: null, cameraIds: [] });
  };

  const startEdit = (a: AdminAcademy) => {
    setEditing(a.id);
    setForm({ name: a.name, fieldId: a.fieldId, daysOfWeek: a.daysOfWeek, description: a.description ?? "", logoUrl: a.logoUrl ?? "", introVideoUrl: a.introVideoUrl ?? null, cameraIds: a.cameraIds ?? [] });
  };

  const cancelEdit = () => { setEditing(null); };

  const toggleDay = (day: string) => {
    setForm((f) => ({
      ...f,
      daysOfWeek: f.daysOfWeek.includes(day)
        ? f.daysOfWeek.filter((d) => d !== day)
        : [...f.daysOfWeek, day],
    }));
  };

  const saveAcademy = async () => {
    if (!form.name.trim() || !form.fieldId) return;
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        fieldId: form.fieldId,
        daysOfWeek: form.daysOfWeek,
        description: form.description.trim() || null,
        logoUrl: form.logoUrl.trim() || null,
        cameraIds: form.cameraIds,
      };
      if (editing === "new") {
        const created = await apiFetch("/admin/academies", { method: "POST", body: JSON.stringify(body) });
        setAcademies((p) => [...p, created]);
      } else {
        const updated = await apiFetch(`/admin/academies/${editing}`, { method: "PATCH", body: JSON.stringify(body) });
        setAcademies((p) => p.map((a) => a.id === editing ? updated : a));
      }
      cancelEdit();
    } catch { /* silent */ }
    setSaving(false);
  };

  const deleteAcademy = async (id: number, name: string) => {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    setDeleting(id);
    try {
      await apiFetch(`/admin/academies/${id}`, { method: "DELETE" });
      setAcademies((p) => p.filter((a) => a.id !== id));
      if (expandedId === id) setExpandedId(null);
    } catch { /* silent */ }
    setDeleting(null);
  };

  const toggleLiveAccess = async (academy: AdminAcademy) => {
    const next = !academy.liveAccess;
    setAcademies((p) => p.map((a) => a.id === academy.id ? { ...a, liveAccess: next } : a));
    try {
      await apiFetch(`/admin/academies/${academy.id}`, {
        method: "PATCH",
        body: JSON.stringify({ liveAccess: next }),
      });
    } catch {
      // Revert on failure
      setAcademies((p) => p.map((a) => a.id === academy.id ? { ...a, liveAccess: !next } : a));
    }
  };

  const addRecording = async (academy: AdminAcademy, recordingId: number) => {
    setAddingRec(recordingId);
    try {
      await apiFetch(`/admin/academies/${academy.id}/recordings`, {
        method: "POST",
        body: JSON.stringify({ recordingId }),
      });
      await loadRecordings(academy);
      setAcademies((p) => p.map((a) => a.id === academy.id ? { ...a, recordingCount: a.recordingCount + 1 } : a));
    } catch { /* silent */ }
    setAddingRec(null);
  };

  const removeRecording = async (academy: AdminAcademy, recordingId: number) => {
    setRemovingRec(`${academy.id}-${recordingId}`);
    try {
      await apiFetch(`/admin/academies/${academy.id}/recordings/${recordingId}`, { method: "DELETE" });
      setRecMap((p) => ({ ...p, [academy.id]: (p[academy.id] ?? []).filter((r) => r.id !== recordingId) }));
      setAcademies((p) => p.map((a) => a.id === academy.id ? { ...a, recordingCount: Math.max(0, a.recordingCount - 1) } : a));
    } catch { /* silent */ }
    setRemovingRec(null);
  };

  const linkedIds = (academyId: number) => new Set((recMap[academyId] ?? []).map((r) => r.id));

  return (
    <div className="space-y-4">
      {/* Clip intro video */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex items-center gap-2 mb-1">
          <Video className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-white">Clip intro video</h3>
        </div>
        <p className="text-xs text-zinc-500 mb-3">
          This video is prepended to every newly exported player clip.
        </p>
        {introLoading ? (
          <p className="text-xs text-zinc-500">Loading…</p>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <label className="cursor-pointer rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-black hover:bg-primary/90">
              {introUploading ? "Uploading…" : introUrl ? "Replace intro" : "Choose intro video"}
              <input
                type="file"
                accept="video/mp4,video/webm,video/quicktime"
                className="hidden"
                disabled={introUploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadIntro(file);
                  event.target.value = "";
                }}
              />
            </label>
            {introUrl && (
              <button type="button" onClick={() => void removeIntro()} className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-red-400 hover:bg-zinc-700">
                Remove
              </button>
            )}
            <span className="text-xs text-zinc-500">{introUrl ? "✓ Active" : "No intro selected"}</span>
          </div>
        )}
      </div>

      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-zinc-500 text-xs">{academies.length} {academies.length === 1 ? "academy" : "academies"}</span>
        <button
          onClick={startNew}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-black rounded-xl text-sm font-bold hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Academy
        </button>
      </div>

      {/* New academy form */}
      {editing === "new" && (
        <AcademyForm
          form={form}
          fields={fields}
          saving={saving}
          onToggleDay={toggleDay}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          onSave={saveAcademy}
          onCancel={cancelEdit}
          title="New Academy"
        />
      )}

      {loading ? (
        <div className="text-center py-16 text-zinc-500">Loading…</div>
      ) : academies.length === 0 && editing !== "new" ? (
        <div className="text-center py-12 text-zinc-500">
          <GraduationCap className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No academies yet. Create one above.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {academies.map((academy) => {
            const isExpanded = expandedId === academy.id;
            const isEditing = editing === academy.id;
            const linked = linkedIds(academy.id);
            const availableToAdd = allRecordings.filter((r) => !linked.has(r.id));

            return (
              <div key={academy.id} className="border border-zinc-800 rounded-xl overflow-hidden bg-zinc-900">
                {/* Academy header row */}
                <div className="flex items-center gap-3 p-3">
                  <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {academy.logoUrl ? (
                      <img src={academy.logoUrl} alt={academy.name} className="w-full h-full object-cover" />
                    ) : (
                      <GraduationCap className="w-4 h-4 text-primary" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium text-sm truncate">{academy.name}</p>
                    <p className="text-zinc-500 text-xs truncate">{academy.fieldLocation} · {academy.recordingCount} rec.</p>
                    {academy.daysOfWeek.length > 0 && (
                      <div className="flex gap-1 mt-0.5 flex-wrap">
                        {academy.daysOfWeek.map((d) => (
                          <span key={d} className="text-[9px] font-bold uppercase tracking-wide bg-primary/15 text-primary px-1 py-0.5 rounded">
                            {DAY_LABELS[d] ?? d}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => toggleLiveAccess(academy)}
                      className={cn(
                        "p-2 rounded-lg transition-colors",
                        academy.liveAccess
                          ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                          : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
                      )}
                      title={academy.liveAccess ? "Revoke live access" : "Grant live access"}
                    >
                      <Radio className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => toggleExpand(academy)}
                      className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
                      title={isExpanded ? "Collapse" : "Manage recordings"}
                    >
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => isEditing ? cancelEdit() : startEdit(academy)}
                      className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
                      title={isEditing ? "Cancel" : "Edit academy"}
                    >
                      {isEditing ? <X className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => deleteAcademy(academy.id, academy.name)}
                      disabled={deleting === academy.id}
                      className="p-2 rounded-lg bg-zinc-800 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50"
                      title="Delete academy"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Edit form */}
                {isEditing && (
                  <div className="border-t border-zinc-800 p-3">
                    <AcademyForm
                      form={form}
                      fields={fields}
                      saving={saving}
                      academyId={academy.id}
                      onToggleDay={toggleDay}
                      onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
                      onSave={saveAcademy}
                      onCancel={cancelEdit}
                      title="Edit Academy"
                    />
                  </div>
                )}

                {/* Recordings panel */}
                {isExpanded && !isEditing && (
                  <div className="border-t border-zinc-800 p-3 space-y-3">
                    {recLoading === academy.id ? (
                      <div className="text-center py-4 text-zinc-500 text-sm">Loading recordings…</div>
                    ) : (
                      <>
                        {/* All recordings for this field — linked ones highlighted */}
                        <div>
                          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                            Recordings — {academy.fieldName}
                          </p>
                          {(() => {
                            const fieldRecs = [...allRecordings]
                              .filter((r) => r.fieldId === academy.fieldId)
                              .sort((a, b) => b.date.localeCompare(a.date) || b.timeSlot.localeCompare(a.timeSlot));
                            const linked = new Set((recMap[academy.id] ?? []).map((r) => r.id));

                            if (fieldRecs.length === 0) {
                              return (
                                <p className="text-zinc-600 text-xs py-2">
                                  No recordings for this field yet. Use “Import from Bunny” below to register them.
                                </p>
                              );
                            }

                            return (
                              <div className="space-y-1.5 max-h-72 overflow-y-auto no-scrollbar">
                                {fieldRecs.map((rec) => {
                                  const isLinked = linked.has(rec.id);
                                  return (
                                    <div
                                      key={rec.id}
                                      className={cn(
                                        "flex items-center gap-2 p-2 rounded-lg border transition-colors",
                                        isLinked
                                          ? "bg-primary/5 border-primary/20"
                                          : "bg-zinc-800/30 border-zinc-800",
                                      )}
                                    >
                                      <Video className={cn("w-3.5 h-3.5 flex-shrink-0", isLinked ? "text-primary" : "text-zinc-500")} />
                                      <div className="flex-1 min-w-0">
                                        <p className="text-zinc-300 text-xs font-medium truncate">
                                          {rec.date} · {rec.timeSlot}
                                        </p>
                                        <p className="text-zinc-600 text-[11px] truncate">
                                          {rec.court}{rec.duration ? ` · ${rec.duration}` : ""}{rec.score ? ` · ${rec.score}` : ""}
                                        </p>
                                      </div>
                                      {isLinked ? (
                                        <button
                                          onClick={() => removeRecording(academy, rec.id)}
                                          disabled={removingRec === `${academy.id}-${rec.id}`}
                                          className="flex items-center gap-1 px-2 py-1 rounded-lg bg-zinc-700 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50 flex-shrink-0 text-xs font-medium"
                                          title="Remove from academy"
                                        >
                                          {removingRec === `${academy.id}-${rec.id}` ? (
                                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                          ) : (
                                            <X className="w-3 h-3" />
                                          )}
                                        </button>
                                      ) : (
                                        <button
                                          onClick={() => addRecording(academy, rec.id)}
                                          disabled={addingRec === rec.id}
                                          className="flex items-center gap-1 px-2 py-1 rounded-lg bg-primary/20 text-primary hover:bg-primary/30 transition-colors disabled:opacity-50 flex-shrink-0 text-xs font-medium"
                                          title="Link to academy"
                                        >
                                          {addingRec === rec.id ? (
                                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                          ) : (
                                            <><Plus className="w-3 h-3" />Link</>
                                          )}
                                        </button>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </div>

                        {/* Import from Bunny — always visible so the admin can register new videos */}
                        <div className="pt-1 border-t border-zinc-800/60">
                          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                            Import from Bunny
                          </p>
                          {videosLoading === academy.fieldId ? (
                            <p className="text-zinc-600 text-xs py-1">Loading videos…</p>
                          ) : (() => {
                            const unregistered = allBunnyVideos.filter(
                              (v) => !allRecordings.some((r) => r.videoUrl.includes(v.guid))
                            );
                            if (unregistered.length === 0) {
                              return <p className="text-zinc-600 text-xs py-1">No unregistered videos found in Bunny.</p>;
                            }
                            return (
                              <div className="flex gap-2 items-center">
                                <select
                                  value={selectedVideoGuid ?? ""}
                                  onChange={(e) => setSelectedVideoGuid(e.target.value || null)}
                                  className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-white min-w-0"
                                >
                                  <option value="">— choose a video —</option>
                                  {unregistered.map((v) => (
                                    <option key={v.guid} value={v.guid}>
                                      {v.collectionName ? `[${v.collectionName}] ` : ""}{v.title}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  onClick={() => void linkVideo(academy)}
                                  disabled={!selectedVideoGuid || linkingRec}
                                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-black text-xs font-bold hover:bg-primary/90 disabled:opacity-50 transition-colors flex-shrink-0"
                                >
                                  {linkingRec ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                  Import
                                </button>
                              </div>
                            );
                          })()}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AcademyForm({
  form,
  fields,
  saving,
  academyId,
  onToggleDay,
  onChange,
  onSave,
  onCancel,
  title,
}: {
  form: { name: string; fieldId: number; daysOfWeek: string[]; description: string; logoUrl: string; introVideoUrl: string | null; cameraIds: string[] };
  fields: AdminField[];
  saving: boolean;
  academyId?: number;
  onToggleDay: (day: string) => void;
  onChange: (patch: Partial<typeof form>) => void;
  onSave: () => void;
  onCancel: () => void;
  title: string;
}) {
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadingIntro, setUploadingIntro] = useState(false);
  const [removingIntro, setRemovingIntro] = useState(false);
  const introFileRef = useRef<HTMLInputElement>(null);

  const handleIntroUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !academyId) return;
    setUploadingIntro(true);
    try {
      const fd = new FormData();
      fd.append("intro", file);
      const res = await fetch(`${basePath}/api/admin/academies/${academyId}/intro`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (res.ok) {
        const data = await res.json() as { introVideoUrl: string };
        onChange({ introVideoUrl: data.introVideoUrl });
      }
    } catch { /* silent */ }
    setUploadingIntro(false);
    e.target.value = "";
  };

  const handleIntroRemove = async () => {
    if (!academyId) return;
    setRemovingIntro(true);
    try {
      const res = await fetch(`${basePath}/api/admin/academies/${academyId}/intro`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) onChange({ introVideoUrl: null });
    } catch { /* silent */ }
    setRemovingIntro(false);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !academyId) return;
    setUploadingLogo(true);
    try {
      const fd = new FormData();
      fd.append("logo", file);
      const res = await fetch(`${basePath}/api/admin/academies/${academyId}/logo`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (res.ok) {
        const data = await res.json() as { logoUrl: string };
        onChange({ logoUrl: data.logoUrl });
      }
    } catch { /* silent */ }
    setUploadingLogo(false);
    e.target.value = "";
  };

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{title}</p>

      {/* Logo preview */}
      <div>
        <label className="text-xs text-zinc-400 mb-1 block">Logo (optional)</label>
        <div className="flex items-center gap-3">
          <div className="w-14 h-14 rounded-xl bg-zinc-800 border border-zinc-700 flex items-center justify-center flex-shrink-0 overflow-hidden">
            {form.logoUrl ? (
              <img src={form.logoUrl} alt="Logo" className="w-full h-full object-cover" />
            ) : (
              <GraduationCap className="w-6 h-6 text-zinc-600" />
            )}
          </div>
          <div className="flex-1 space-y-1.5">
            <input
              value={form.logoUrl}
              onChange={(e) => onChange({ logoUrl: e.target.value })}
              placeholder="https://example.com/logo.png"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
            />
            {academyId && (
              <>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploadingLogo}
                  className="text-xs text-primary hover:underline disabled:opacity-50"
                >
                  {uploadingLogo ? "Uploading…" : "or upload file"}
                </button>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
              </>
            )}
          </div>
          {form.logoUrl && (
            <button
              type="button"
              onClick={() => onChange({ logoUrl: "" })}
              className="text-zinc-500 hover:text-red-400 transition-colors text-xs"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {/* Intro video — prepended to this academy's clip exports and playback */}
      <div>
        <label className="text-xs text-zinc-400 mb-1 block">Intro Video (optional)</label>
        <p className="text-[11px] text-zinc-600 mb-1.5">Plays before every clip created under this academy, in both playback and exported files.</p>
        {!academyId ? (
          <p className="text-xs text-zinc-600">Save the academy first, then come back to add an intro video.</p>
        ) : (
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-xl bg-zinc-800 border border-zinc-700 flex items-center justify-center flex-shrink-0">
              <Video className="w-6 h-6 text-zinc-600" />
            </div>
            <div className="flex-1 space-y-1">
              {form.introVideoUrl ? (
                <p className="text-xs text-zinc-400 truncate">Intro video set</p>
              ) : (
                <p className="text-xs text-zinc-600">No intro video set</p>
              )}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => introFileRef.current?.click()}
                  disabled={uploadingIntro}
                  className="text-xs text-primary hover:underline disabled:opacity-50"
                >
                  {uploadingIntro ? "Uploading…" : form.introVideoUrl ? "Replace video" : "Upload video"}
                </button>
                {form.introVideoUrl && (
                  <button
                    type="button"
                    onClick={handleIntroRemove}
                    disabled={removingIntro}
                    className="text-xs text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-50"
                  >
                    {removingIntro ? "Removing…" : "Remove"}
                  </button>
                )}
              </div>
              <input ref={introFileRef} type="file" accept="video/*" className="hidden" onChange={handleIntroUpload} />
            </div>
          </div>
        )}
      </div>

      <div>
        <label className="text-xs text-zinc-400 mb-1 block">Academy Name</label>
        <input
          value={form.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="e.g. Elite Youth Academy"
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
        />
      </div>
      <div>
        <label className="text-xs text-zinc-400 mb-1 block">Field</label>
        <select
          value={form.fieldId}
          onChange={(e) => onChange({ fieldId: Number(e.target.value) })}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary appearance-none"
        >
          {fields.map((f) => (
            <option key={f.id} value={f.id}>{f.name} — {f.location}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-xs text-zinc-400 mb-2 block">Days of Week</label>
        <div className="flex flex-wrap gap-1.5">
          {ALL_DAYS.map((day) => {
            const active = form.daysOfWeek.includes(day);
            return (
              <button
                key={day}
                type="button"
                onClick={() => onToggleDay(day)}
                className={cn(
                  "px-2.5 py-1 rounded-lg text-xs font-semibold uppercase tracking-wide transition-colors",
                  active
                    ? "bg-primary text-black"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white"
                )}
              >
                {DAY_LABELS[day]}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <label className="text-xs text-zinc-400 mb-2 block">Cameras (optional)</label>
        <div className="flex gap-2">
          {(["camera1", "camera2"] as const).map((cam) => {
            const label = cam === "camera1" ? "Camera 1" : "Camera 2";
            const active = form.cameraIds.includes(cam);
            return (
              <button
                key={cam}
                type="button"
                onClick={() =>
                  onChange({
                    cameraIds: active
                      ? form.cameraIds.filter((c) => c !== cam)
                      : [...form.cameraIds, cam],
                  })
                }
                className={cn(
                  "flex-1 py-2 rounded-lg text-xs font-semibold transition-colors border",
                  active
                    ? "bg-primary text-black border-primary"
                    : "bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700 hover:text-white"
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <label className="text-xs text-zinc-400 mb-1 block">Description (optional)</label>
        <textarea
          value={form.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Brief description of the academy…"
          rows={2}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary resize-none"
        />
      </div>
      <div className="flex gap-2">
        <button
          onClick={onSave}
          disabled={saving || !form.name.trim()}
          className="flex-1 flex items-center justify-center gap-2 bg-primary text-black font-bold py-2.5 rounded-xl text-sm disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {saving ? "Saving…" : "Save Academy"}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2.5 bg-zinc-800 text-zinc-400 rounded-xl text-sm hover:bg-zinc-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Live Schedules ───────────────────────────────────────────────────────────

const SCHEDULE_DAYS = [
  { key: "monday",    label: "Mo" },
  { key: "tuesday",   label: "Tu" },
  { key: "wednesday", label: "We" },
  { key: "thursday",  label: "Th" },
  { key: "friday",    label: "Fr" },
  { key: "saturday",  label: "Sa" },
  { key: "sunday",    label: "Su" },
] as const;

interface LiveSchedule {
  id: number;
  camera: string;
  startTime: string;
  endTime: string;
  daysOfWeek: string[];
  enabled: boolean;
}

function LiveSchedulesSection({ adminPassword }: { adminPassword: string }) {
  const [schedules, setSchedules] = useState<LiveSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    camera: "camera1" as "camera1" | "camera2",
    startTime: "",
    endTime: "",
    daysOfWeek: [] as string[],
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const apiFetch = useCallback(async (path: string, opts?: RequestInit) => {
    const res = await fetch(`${basePath}/api${path}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Admin-Password": adminPassword, ...(opts?.headers ?? {}) },
      ...opts,
    });
    if (!res.ok && res.status !== 204) throw new Error(`${res.status}`);
    return res.status === 204 ? null : res.json();
  }, [adminPassword]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/admin/live-schedules");
      setSchedules(Array.isArray(data) ? data : []);
    } catch { /* silent */ }
    setLoading(false);
  }, [apiFetch]);

  useEffect(() => { load(); }, [load]);

  const toggleDay = (day: string) =>
    setForm((f) => ({
      ...f,
      daysOfWeek: f.daysOfWeek.includes(day)
        ? f.daysOfWeek.filter((d) => d !== day)
        : [...f.daysOfWeek, day],
    }));

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!form.startTime || !form.endTime) { setFormError("Start and end times are required"); return; }
    setSaving(true);
    try {
      const row = await apiFetch("/admin/live-schedules", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setSchedules((s) => [...s, row as LiveSchedule]);
      setForm({ camera: "camera1", startTime: "", endTime: "", daysOfWeek: [] });
      setAdding(false);
    } catch {
      setFormError("Failed to save schedule");
    }
    setSaving(false);
  };

  const toggleEnabled = async (s: LiveSchedule) => {
    try {
      const updated = await apiFetch(`/admin/live-schedules/${s.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      setSchedules((prev) => prev.map((x) => x.id === s.id ? updated as LiveSchedule : x));
    } catch { /* silent */ }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this schedule?")) return;
    try {
      await apiFetch(`/admin/live-schedules/${id}`, { method: "DELETE" });
      setSchedules((s) => s.filter((x) => x.id !== id));
    } catch { /* silent */ }
  };

  const dayLabel = (d: string) => SCHEDULE_DAYS.find((x) => x.key === d)?.label ?? d;
  const cameraLabel = (c: string) => c === "camera1" ? "Cam 1" : "Cam 2";

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-primary" />
          <h2 className="text-white font-bold text-base">Live Schedules</h2>
        </div>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity"
          >
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        )}
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-3 space-y-3">
        <p className="text-zinc-500 text-xs">
          Schedules fire in <span className="text-zinc-300 font-medium">Asia/Amman</span> time. Empty days = every day.
        </p>

        {/* Add form */}
        {adding && (
          <form onSubmit={handleAdd} className="space-y-3 pb-3 border-b border-zinc-800">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Camera</label>
                <select
                  value={form.camera}
                  onChange={(e) => setForm((f) => ({ ...f, camera: e.target.value as "camera1" | "camera2" }))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2 text-sm text-white outline-none focus:border-primary appearance-none"
                >
                  <option value="camera1">Camera 1</option>
                  <option value="camera2">Camera 2</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-1.5 col-span-1">
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">Start</label>
                  <input
                    type="time"
                    value={form.startTime}
                    onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2 text-sm text-white outline-none focus:border-primary"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">End</label>
                  <input
                    type="time"
                    value={form.endTime}
                    onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2 text-sm text-white outline-none focus:border-primary"
                  />
                </div>
              </div>
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1.5 block">Days (empty = every day)</label>
              <div className="flex gap-1">
                {SCHEDULE_DAYS.map(({ key, label }) => {
                  const active = form.daysOfWeek.includes(key);
                  return (
                    <button
                      key={key} type="button" onClick={() => toggleDay(key)}
                      className={cn(
                        "flex-1 py-1.5 rounded-lg text-[11px] font-semibold transition-colors",
                        active ? "bg-primary text-black" : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700 hover:text-white"
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            {formError && (
              <p className="text-red-400 text-xs flex items-center gap-1">
                <XCircle className="w-3.5 h-3.5" /> {formError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="submit" disabled={saving}
                className="flex-1 flex items-center justify-center gap-1.5 bg-primary text-black font-bold py-2.5 rounded-xl text-xs disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {saving ? "Saving…" : "Save Schedule"}
              </button>
              <button
                type="button" onClick={() => { setAdding(false); setFormError(null); }}
                className="px-4 py-2.5 bg-zinc-800 text-zinc-400 rounded-xl text-xs hover:bg-zinc-700"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* List */}
        {loading ? (
          <div className="text-zinc-600 text-xs text-center py-3">Loading…</div>
        ) : schedules.length === 0 && !adding ? (
          <p className="text-zinc-600 text-xs text-center py-3">No schedules yet. Add one to auto-start and stop streams.</p>
        ) : (
          <div className="space-y-2">
            {schedules.map((s) => (
              <div key={s.id} className={cn(
                "flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors",
                s.enabled ? "border-zinc-700 bg-zinc-800/60" : "border-zinc-800 bg-zinc-900/40 opacity-60"
              )}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-white">{cameraLabel(s.camera)}</span>
                    <span className="text-xs text-zinc-300 font-mono">
                      {s.startTime} → {s.endTime}
                    </span>
                    {s.daysOfWeek.length > 0 ? (
                      <span className="text-[10px] text-zinc-500">
                        {s.daysOfWeek.map(dayLabel).join(" · ")}
                      </span>
                    ) : (
                      <span className="text-[10px] text-zinc-600">Every day</span>
                    )}
                  </div>
                </div>
                {/* Enabled toggle */}
                <button
                  onClick={() => toggleEnabled(s)}
                  title={s.enabled ? "Disable" : "Enable"}
                  className={cn(
                    "w-8 h-5 rounded-full transition-colors flex-shrink-0 relative",
                    s.enabled ? "bg-primary" : "bg-zinc-700"
                  )}
                >
                  <span className={cn(
                    "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform",
                    s.enabled ? "translate-x-3" : "translate-x-0.5"
                  )} />
                </button>
                <button
                  onClick={() => handleDelete(s.id)}
                  className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-900/20 transition-colors flex-shrink-0"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Live Control Tab ─────────────────────────────────────────────────────────

const CAMERAS = ["camera1", "camera2"] as const;
type Camera = typeof CAMERAS[number];

const LIVE_PLAYBACK_BASE = `${basePath}/api/live`;

interface CameraStatus {
  live: boolean;
  startedAt?: string;
  viewers?: number;
  [k: string]: unknown;
}

interface RecordingJob {
  id: string;
  camera: string;
  title: string;
  startTime: string;
  duration: number;
  submittedAt: string;
  status: string;
  jobId?: string;
}

function HlsPlayer({ url, className }: { url: string; className?: string }) {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const hlsRef    = useRef<Hls | null>(null);

  // quality levels discovered from the HLS manifest (height → original index)
  const [levels,      setLevels]      = useState<Array<{ height: number; index: number }>>([]);
  const [activeLevel, setActiveLevel] = useState<number>(-1); // -1 = Auto (ABR)

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return undefined;

    setLevels([]);
    setActiveLevel(-1);

    if (Hls.isSupported()) {
      const hls = new Hls({ liveSyncDurationCount: 3 });
      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(el);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // sort highest → lowest for the quality buttons
        const lvls = hls.levels
          .map((l, i) => ({ height: l.height, index: i }))
          .sort((a, b) => b.height - a.height);
        setLevels(lvls);
        setActiveLevel(-1);
      });
      el.muted = true;
      el.play().catch(() => { /* autoplay blocked */ });
      return () => { hls.destroy(); hlsRef.current = null; };
    } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari / iOS — native HLS, no JS quality switching
      el.src = url;
      el.muted = true;
      el.play().catch(() => { /* autoplay blocked */ });
    }
    return undefined;
  }, [url]);

  const setQuality = (level: number) => {
    if (hlsRef.current) hlsRef.current.currentLevel = level;
    setActiveLevel(level);
  };

  const labelFor = (h: number) => (h >= 2160 ? "4K" : `${h}p`);

  return (
    <div className="space-y-1.5">
      <video
        ref={videoRef}
        className={cn("w-full rounded-xl bg-black", className)}
        playsInline
        muted
        controls
      />
      {levels.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-zinc-500 text-[10px]">Quality:</span>
          <button
            type="button"
            onClick={() => setQuality(-1)}
            className={cn(
              "text-[10px] px-2 py-0.5 rounded-full border transition-colors",
              activeLevel === -1
                ? "border-primary text-primary bg-primary/10"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-500",
            )}
          >
            Auto
          </button>
          {levels.map(({ height, index }) => (
            <button
              key={index}
              type="button"
              onClick={() => setQuality(index)}
              className={cn(
                "text-[10px] px-2 py-0.5 rounded-full border transition-colors",
                activeLevel === index
                  ? "border-primary text-primary bg-primary/10"
                  : "border-zinc-700 text-zinc-400 hover:border-zinc-500",
              )}
            >
              {labelFor(height)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CameraCard({
  camera,
  adminPassword,
}: {
  camera: Camera;
  adminPassword: string;
}) {
  const [status, setStatus] = useState<CameraStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPlayer, setShowPlayer] = useState(false);

  const contaboFetch = useCallback(async (path: string, opts?: RequestInit) => {
    const res = await fetch(`${basePath}/api${path}`, {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Password": adminPassword,
        ...(opts?.headers ?? {}),
      },
      ...opts,
    });
    if (res.status === 401) throw new Error("bad_password");
    if (!res.ok) throw new Error(`${res.status}`);
    if (res.status === 204) return null;
    return res.json();
  }, [adminPassword]);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await contaboFetch(`/admin/contabo/status/${camera}`);
      setStatus(data as CameraStatus);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error";
      setError(msg === "bad_password" ? "Wrong password" : "Could not reach control server");
    } finally {
      setLoading(false);
    }
  }, [camera, contaboFetch]);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 8000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const handleStart = async () => {
    setWorking(true);
    try {
      await contaboFetch(`/admin/contabo/live/start/${camera}`, { method: "POST" });
      await fetchStatus();
    } catch {
      setError("Start failed");
    } finally {
      setWorking(false);
    }
  };

  const handleStop = async () => {
    if (!confirm(`Stop live stream for ${camera}?`)) return;
    setWorking(true);
    try {
      await contaboFetch(`/admin/contabo/live/stop/${camera}`, { method: "POST" });
      setShowPlayer(false);
      await fetchStatus();
    } catch {
      setError("Stop failed");
    } finally {
      setWorking(false);
    }
  };

  const playbackUrl = `${LIVE_PLAYBACK_BASE}/${camera}/index.m3u8`;
  const isLive = status?.live === true;
  const label = camera === "camera1" ? "Camera 1" : "Camera 2";

  return (
    <div className={cn(
      "rounded-2xl border overflow-hidden transition-colors",
      isLive ? "border-red-600/60 bg-zinc-900" : "border-zinc-800 bg-zinc-900/60",
    )}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800/60">
        <div className={cn(
          "w-2.5 h-2.5 rounded-full flex-shrink-0",
          loading ? "bg-zinc-600 animate-pulse" :
          isLive ? "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)] animate-pulse" :
          "bg-zinc-600"
        )} />
        <span className="text-white font-semibold text-sm">{label}</span>
        {isLive && (
          <span className="text-[10px] bg-red-600/20 text-red-400 border border-red-600/40 px-2 py-0.5 rounded-full font-medium tracking-wide ml-auto">
            LIVE
          </span>
        )}
        {!isLive && !loading && (
          <span className="text-[10px] text-zinc-500 ml-auto">Offline</span>
        )}
      </div>

      {/* Status info */}
      <div className="px-4 py-3 space-y-3">
        {error && (
          <div className="flex items-center gap-2 text-amber-400 text-xs bg-amber-900/20 border border-amber-700/40 rounded-xl px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            {error}
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-zinc-500 text-xs">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Checking status…
          </div>
        )}

        {!loading && isLive && status?.startedAt && (
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <Clock className="w-3 h-3" />
            Started {new Date(status.startedAt as string).toLocaleTimeString()}
          </div>
        )}

        {/* Playback link when live */}
        {isLive && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <a
                href={playbackUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors truncate"
              >
                <LinkIcon className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{playbackUrl}</span>
              </a>
            </div>
            <button
              onClick={() => setShowPlayer((p) => !p)}
              className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white transition-colors"
            >
              <Play className="w-3 h-3" />
              {showPlayer ? "Hide preview" : "Preview stream"}
            </button>
            {showPlayer && (
              <HlsPlayer url={playbackUrl} className="max-h-48" />
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 pt-1">
          <button
            onClick={handleStart}
            disabled={working || loading || isLive}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-semibold bg-red-600 text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Radio className="w-3.5 h-3.5" />
            Start Live
          </button>
          <button
            onClick={handleStop}
            disabled={working || loading || !isLive}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-semibold bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Square className="w-3.5 h-3.5" />
            Stop Live
          </button>
          <button
            onClick={fetchStatus}
            disabled={loading}
            className="px-3 py-2.5 rounded-xl bg-zinc-800 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700 transition-colors disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── VAR Review Tab ───────────────────────────────────────────────────────────

interface VarTimeline {
  position: number;
  liveEdge: number;
  programTime?: number;
}

function formatVarProgramTime(timestamp: number): string {
  return `${new Date(timestamp).toISOString().replace("T", " ").replace("Z", "")} UTC`;
}

function VarTab() {
  const [camera, setCamera] = useState<Camera>("camera1");
  const [rate, setRate] = useState(1);
  const [timeline, setTimeline] = useState<VarTimeline | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const handleTimelineChange = useCallback((nextTimeline: VarTimeline) => {
    setTimeline(nextTimeline);
  }, []);

  const seekBy = useCallback((seconds: number, pause = false) => {
    const video = videoRef.current;
    if (!video) return;
    if (pause) video.pause();
    if (video.seekable.length) {
      const start = video.seekable.start(0);
      const end = video.seekable.end(video.seekable.length - 1);
      video.currentTime = Math.min(end, Math.max(start, video.currentTime + seconds));
    } else {
      video.currentTime = Math.max(0, video.currentTime + seconds);
    }
  }, []);

  const changeRate = useCallback((nextRate: number) => {
    setRate(nextRate);
    if (videoRef.current) videoRef.current.playbackRate = nextRate;
  }, []);

  const goLive = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.seekable.length) return;
    video.currentTime = video.seekable.end(video.seekable.length - 1) - 1;
    video.playbackRate = 1;
    setRate(1);
    video.play().catch(() => {});
  }, []);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "SELECT" || target?.isContentEditable) return;
      const key = event.key.toLowerCase();
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekBy(-1 / 20, true);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekBy(1 / 20, true);
      } else if (key === "j") {
        event.preventDefault();
        seekBy(-10);
      } else if (key === "l") {
        event.preventDefault();
        seekBy(10);
      } else if (event.code === "Space") {
        event.preventDefault();
        const video = videoRef.current;
        if (video) {
          if (video.paused) video.play().catch(() => {});
          else video.pause();
        }
      }
    };
    panel.addEventListener("keydown", handleKeyDown);
    return () => panel.removeEventListener("keydown", handleKeyDown);
  }, [seekBy]);

  const positionLabel = timeline?.programTime != null
    ? formatVarProgramTime(timeline.programTime)
    : timeline
      ? `${Math.max(0, timeline.liveEdge - timeline.position).toFixed(1)}s behind live edge (relative)`
      : "Waiting for timeline…";

  return (
    <div
      ref={panelRef}
      tabIndex={0}
      className="space-y-4 outline-none"
      aria-label="VAR review controls"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-white text-lg font-semibold">VAR Review</p>
          <p className="text-zinc-500 text-xs mt-0.5">Review the live DVR window with frame-accurate controls.</p>
        </div>
        <select
          value={camera}
          onChange={(event) => {
            setCamera(event.target.value as Camera);
            setTimeline(null);
            setRate(1);
          }}
          aria-label="VAR camera"
          className="bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-primary"
        >
          <option value="camera1">Camera 1</option>
          <option value="camera2">Camera 2</option>
        </select>
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3">
        <SharedHlsPlayer
          key={camera}
          ref={videoRef}
          url={`${LIVE_PLAYBACK_BASE}/${camera}/index.m3u8`}
          label={`${camera === "camera1" ? "Camera 1" : "Camera 2"} · VAR`}
          windowSeconds={300}
          retryOnNetworkError
          onTimelineChange={handleTimelineChange}
        />
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-primary" />
          <span className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Playback position</span>
          <span className="text-white text-sm font-mono tabular-nums">{positionLabel}</span>
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => seekBy(-30)} className="px-3 py-2 rounded-lg border border-zinc-700 text-xs font-semibold text-zinc-300 hover:border-zinc-500 hover:text-white transition-colors">−30 sec</button>
          <button type="button" onClick={() => seekBy(-10)} className="px-3 py-2 rounded-lg border border-zinc-700 text-xs font-semibold text-zinc-300 hover:border-zinc-500 hover:text-white transition-colors">−10 sec</button>
          <button type="button" onClick={() => seekBy(-1 / 20, true)} className="px-3 py-2 rounded-lg border border-zinc-700 text-xs font-semibold text-zinc-300 hover:border-zinc-500 hover:text-white transition-colors">Frame −</button>
          <button type="button" onClick={() => seekBy(1 / 20, true)} className="px-3 py-2 rounded-lg border border-zinc-700 text-xs font-semibold text-zinc-300 hover:border-zinc-500 hover:text-white transition-colors">Frame +</button>
          <button type="button" onClick={goLive} className="px-3 py-2 rounded-lg border border-red-700/60 text-xs font-semibold text-red-400 hover:bg-red-900/20 transition-colors">Go live</button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-zinc-500">Speed</span>
          {[0.25, 0.5, 1].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => changeRate(value)}
              className={cn(
                "px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors",
                rate === value
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-white",
              )}
            >
              {value}×
            </button>
          ))}
        </div>

        <p className="text-[11px] text-zinc-600">
          Focus this panel for shortcuts: ←/→ frame step · J/L ±10 seconds · Space play/pause
        </p>
      </div>
    </div>
  );
}

function RecordingRequestForm({
  adminPassword,
  onSubmitted,
}: {
  adminPassword: string;
  onSubmitted: () => void;
}) {
  const [camera, setCamera] = useState<Camera>("camera1");
  const [startTime, setStartTime] = useState("");
  const [duration, setDuration] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const contaboPost = async (path: string, body: unknown) => {
    const res = await fetch(`${basePath}/api${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Password": adminPassword,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401) throw new Error("Wrong password");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `Error ${res.status}`);
    return data;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const dur = parseFloat(duration);
    if (!startTime.trim()) { setError("Start time is required"); return; }
    if (isNaN(dur) || dur <= 0) { setError("Duration must be a positive number (seconds)"); return; }
    if (!title.trim()) { setError("Title is required"); return; }

    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await contaboPost(`/admin/contabo/record/${camera}`, {
        startTime: startTime.trim(),
        duration: dur,
        title: title.trim(),
      });
      setSuccess(true);
      setStartTime("");
      setDuration("");
      setTitle("");
      onSubmitted();
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-zinc-400 mb-1.5 block font-medium">Camera</label>
          <select
            value={camera}
            onChange={(e) => setCamera(e.target.value as Camera)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-primary appearance-none"
          >
            <option value="camera1">Camera 1</option>
            <option value="camera2">Camera 2</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-zinc-400 mb-1.5 block font-medium">Duration (seconds)</label>
          <input
            type="number"
            min="1"
            step="1"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            placeholder="e.g. 300"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-primary"
          />
        </div>
      </div>
      <div>
        <label className="text-xs text-zinc-400 mb-1.5 block font-medium">
          Start Time <span className="text-zinc-600 font-normal">(offset in live stream, e.g. "00:02:30" or seconds from start)</span>
        </label>
        <input
          type="text"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          placeholder="e.g. 00:02:30 or 150"
          className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-primary"
        />
      </div>
      <div>
        <label className="text-xs text-zinc-400 mb-1.5 block font-medium">Recording Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Galaxy Field – Morning Session"
          className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-primary"
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 text-red-400 text-xs bg-red-900/20 border border-red-700/40 rounded-xl px-3 py-2">
          <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {error}
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 text-green-400 text-xs bg-green-900/20 border border-green-700/40 rounded-xl px-3 py-2">
          <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
          Recording request submitted — check the list below for status
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full flex items-center justify-center gap-2 bg-primary text-black font-bold py-3 rounded-xl text-sm disabled:opacity-50 hover:opacity-90 transition-opacity"
      >
        {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Video className="w-4 h-4" />}
        {submitting ? "Submitting…" : "Request Recording"}
      </button>
    </form>
  );
}

function RecordingsList({
  adminPassword,
  refreshKey,
}: {
  adminPassword: string;
  refreshKey: number;
}) {
  const [jobs, setJobs] = useState<RecordingJob[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(`${basePath}/api/admin/contabo/recordings`, {
        credentials: "include",
        headers: { "X-Admin-Password": adminPassword },
      });
      if (res.ok) {
        const data = await res.json();
        setJobs(Array.isArray(data) ? data : []);
      }
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, [adminPassword]);

  useEffect(() => { fetchJobs(); }, [fetchJobs, refreshKey]);
  useEffect(() => {
    const id = setInterval(fetchJobs, 10000);
    return () => clearInterval(id);
  }, [fetchJobs]);

  const statusColor = (s: string) => {
    if (s === "done" || s === "completed") return "text-green-400 bg-green-900/20 border-green-700/40";
    if (s === "error" || s === "failed") return "text-red-400 bg-red-900/20 border-red-700/40";
    if (s === "processing") return "text-blue-400 bg-blue-900/20 border-blue-700/40";
    return "text-amber-400 bg-amber-900/20 border-amber-700/40"; // queued / submitted
  };

  const StatusIcon = ({ s }: { s: string }) => {
    if (s === "done" || s === "completed") return <CheckCircle2 className="w-3 h-3" />;
    if (s === "error" || s === "failed") return <XCircle className="w-3 h-3" />;
    if (s === "processing") return <Loader2 className="w-3 h-3 animate-spin" />;
    return <Clock className="w-3 h-3" />;
  };

  if (loading) return <div className="text-center py-8 text-zinc-500 text-sm">Loading…</div>;
  if (!jobs.length) return (
    <div className="text-center py-8 text-zinc-600 text-sm">No recording requests yet</div>
  );

  return (
    <div className="space-y-2">
      {jobs.map((job) => (
        <div key={job.id} className="flex items-start gap-3 p-3 rounded-xl border border-zinc-800 bg-zinc-900">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-white text-sm font-medium truncate">{job.title}</span>
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full border flex items-center gap-1 font-medium",
                statusColor(job.status)
              )}>
                <StatusIcon s={job.status} />
                {job.status}
              </span>
            </div>
            <p className="text-zinc-500 text-xs mt-0.5">
              {job.camera} · start: {job.startTime} · {job.duration}s
            </p>
            <p className="text-zinc-600 text-[10px] mt-0.5">
              {new Date(job.submittedAt).toLocaleString()}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Live Job Card helpers ────────────────────────────────────────────────────

function phaseLabel(phase: JobPhase | undefined): string {
  switch (phase) {
    case "search":   return "Searching the SD card";
    case "download": return "Pulling from camera";
    case "assemble": return "Assembling";
    case "upload":   return "Uploading to Bunny";
    case "encode":   return "Bunny is encoding";
    case "done":     return "Ready";
    case "failed":   return "Failed";
    default:         return phase ?? "Working…";
  }
}

function formatEtaSecs(secs: number): string {
  if (secs < 60) return "under a minute left";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `about ${mins} min left`;
  const hrs  = Math.floor(mins / 60);
  const rem  = mins % 60;
  return rem > 0 ? `about ${hrs} hr ${rem} min left` : `about ${hrs} hr left`;
}

// ─── Live Job Card ────────────────────────────────────────────────────────────

function LiveJobCard({
  cam,
  jobId,
  adminPassword,
  initialJob,
  savedRequest,
  onRetry,
  onRemove,
}: {
  cam: string;
  jobId: string;
  adminPassword: string;
  initialJob?: PlaybackJob;
  savedRequest?: LiveJobRef["savedRequest"];
  onRetry?: (req: NonNullable<LiveJobRef["savedRequest"]>) => void;
  onRemove?: () => void;
}) {
  const [showPlayer, setShowPlayer] = useState(false);

  const { data: job } = useQuery<PlaybackJob>({
    queryKey: ["hq-job", cam, jobId],
    queryFn: async () => {
      const res = await fetch(`${basePath}/api/admin/contabo/hq/${cam}/${jobId}`, {
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-Admin-Password": adminPassword },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error ?? `Error ${res.status}`);
      }
      return res.json() as Promise<PlaybackJob>;
    },
    initialData: initialJob,
    refetchInterval: (query) => {
      const s = (query.state.data as PlaybackJob | undefined)?.status;
      return s === "done" || s === "failed" ? false : 2_000;
    },
    staleTime: 1_000,
  });

  if (!job) return null;

  const isDone   = job.status === "done";
  const isFailed = job.status === "failed";
  const isEncode = job.phase === "encode";
  const percent  = job.percent ?? 0;

  // Normalise segments to the new shape (old shape was a plain number)
  const segments = (job.segments && typeof job.segments === "object" && !Array.isArray(job.segments))
    ? (job.segments as { total: number; done: number; failed: number })
    : null;

  // Normalise bytes (old shape had bytesExpected/bytesDownloaded at top level)
  const bytesTotal = job.bytes?.total ?? job.bytesExpected ?? 0;
  const bytesDone  = job.bytes?.downloaded ?? job.bytesDownloaded ?? 0;

  const playbackUrl = job.playbackUrl ?? job.playback ?? null;

  // Requested time window display
  const reqStart = job.requested?.start ?? job.start ?? null;
  const reqEnd   = job.requested?.end   ?? job.end   ?? null;
  const timeWindow = reqStart && reqEnd
    ? `${reqStart.slice(11, 16)} – ${reqEnd.slice(11, 16)}  ·  ${reqStart.slice(0, 10)}`
    : null;

  return (
    <div className={cn(
      "rounded-xl border p-3.5 space-y-3",
      isDone   ? "border-green-700/40 bg-green-900/10"
      : isFailed ? "border-red-700/40 bg-red-900/10"
      : "border-blue-700/40 bg-blue-900/10",
    )}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isDone
            ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
            : isFailed
              ? <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
              : <Loader2 className="w-3.5 h-3.5 text-blue-400 flex-shrink-0 animate-spin" />}
          <div className="min-w-0">
            <p className="text-white text-sm font-medium truncate">{job.title || "Footage request"}</p>
            <div className="flex items-center gap-2 flex-wrap mt-0.5">
              {timeWindow && (
                <p className="text-zinc-500 text-[10px] font-mono">{timeWindow}</p>
              )}
              {job.engine && (
                <span className="text-[9px] px-1.5 py-0.5 rounded-full border border-zinc-700 text-zinc-500 font-medium">
                  {job.engine === "playback" ? "Playback engine"
                    : job.engine === "download" ? "Direct download"
                    : job.engine}
                </span>
              )}
            </div>
          </div>
        </div>
        {onRemove && (
          <button type="button" onClick={onRemove} className="text-zinc-600 hover:text-zinc-400 transition-colors flex-shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* In-progress */}
      {!isDone && !isFailed && (
        <div className="space-y-2">
          {/* Phase + percent */}
          <div className="flex items-center justify-between text-xs">
            <span className={cn("font-medium", isEncode ? "text-violet-400" : "text-blue-400")}>
              {phaseLabel(job.phase)}
            </span>
            <span className="text-zinc-500 tabular-nums">{percent}%</span>
          </div>

          {/* Progress bar — driven by percent, never computed from bytes */}
          <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
            <div
              className={cn(
                "h-2 rounded-full transition-all duration-700",
                isEncode ? "bg-violet-500" : "bg-primary",
              )}
              style={{ width: `${percent}%` }}
            />
          </div>

          {/* Detail row */}
          <div className="text-[10px] text-zinc-500 flex flex-wrap gap-x-3 gap-y-0.5">
            {segments && (
              <span>
                {segments.done}/{segments.total} segs
                {segments.failed > 0 && <span className="text-red-400"> · {segments.failed} failed</span>}
              </span>
            )}
            {bytesTotal > 0 && (
              <span>{(bytesDone / 1e6).toFixed(0)} / {(bytesTotal / 1e6).toFixed(0)} MB</span>
            )}
            {job.rate != null && job.rate > 0 && (
              <span>{job.rate.toFixed(1)} MB/s</span>
            )}
            {job.workers != null && job.workerCeiling != null && (
              <span>{job.workers} of {job.workerCeiling} streams</span>
            )}
            {job.phase === "download" && job.eta != null && (
              <span className="text-zinc-400">{formatEtaSecs(job.eta)}</span>
            )}
          </div>

          {/* Encode-specific note — eta is null here; Bunny encodes at ~real time */}
          {isEncode && (
            <p className="text-violet-300/80 text-[10px] leading-relaxed">
              Bunny is encoding — this takes about as long as the footage itself.
              An hour of footage takes roughly an hour here.
            </p>
          )}

          {/* Message from engine */}
          {job.message && (
            <p className="text-zinc-400 text-[10px] leading-relaxed">{job.message}</p>
          )}
        </div>
      )}

      {/* Done state */}
      {isDone && (
        <div className="space-y-2">
          <p className="text-green-400 text-xs font-semibold">✓ Footage ready</p>
          {job.message && <p className="text-zinc-400 text-[10px]">{job.message}</p>}
          {playbackUrl && (
            <div className="space-y-1.5">
              <a
                href={`${basePath}/api/hls-proxy/manifest?url=${encodeURIComponent(playbackUrl)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-green-400 hover:text-green-300 transition-colors font-medium"
              >
                <Play className="w-3 h-3" /> Watch footage
              </a>
              <button
                type="button"
                onClick={() => setShowPlayer((p) => !p)}
                className="block text-[10px] text-zinc-500 hover:text-zinc-400 transition-colors"
              >
                {showPlayer ? "Hide inline player" : "Play inline"}
              </button>
              {showPlayer && (
                <HlsPlayer
                  url={`${basePath}/api/hls-proxy/manifest?url=${encodeURIComponent(playbackUrl)}`}
                  className="max-h-64 mt-1"
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* Failed state */}
      {isFailed && (
        <div className="space-y-2">
          <p className="text-red-400 text-xs leading-relaxed font-medium">
            {job.error ?? "Unknown error"}
          </p>
          {savedRequest && onRetry && (
            <button
              type="button"
              onClick={() => onRetry(savedRequest)}
              className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-3 py-1.5 rounded-lg transition-colors"
            >
              <RefreshCw className="w-3 h-3" /> Retry request
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── SD Pull Section ──────────────────────────────────────────────────────────

function SdPullSection({ adminPassword }: { adminPassword: string }) {
  // Today's date in Amman local time (UTC+3) — used to match FTP window
  const todayAmman = () => new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [camera, setCamera]         = useState<Camera>("camera1");
  const [date,   setDate]           = useState(todayAmman);

  // FTP (instant) availability — fetched on camera change, no date required
  const [ftpAvail,   setFtpAvail]   = useState<FtpAvailability | null>(null);
  const [ftpLoading, setFtpLoading] = useState(false);

  // SD (historical) availability for the selected date
  const [availability, setAvailability] = useState<SdAvailability | null>(null);
  const [availLoading, setAvailLoading] = useState(false);
  const [availError,   setAvailError]   = useState<string | null>(null);

  // Hour-range selection
  const [startHour, setStartHour] = useState<number | null>(null);
  const [endHour,   setEndHour]   = useState<number | null>(null);

  // Pull method — user picks; "playback" is the default
  const [pullMethod, setPullMethod] = useState<"playback" | "sd">("playback");
  // Slow-path confirm (reset whenever method or hour selection changes)
  const [confirmed, setConfirmed] = useState(false);

  // Submission
  const [title,       setTitle]       = useState("");
  const [submitting,  setSubmitting]  = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Live job cards — each renders its own TanStack Query poll
  const [liveJobRefs, setLiveJobRefs] = useState<LiveJobRef[]>([]);

  // ─── auth-bearing fetch helper ─────────────────────────────────────────────
  const contaboFetch = useCallback(async (path: string, opts?: RequestInit) => {
    const res = await fetch(`${basePath}/api${path}`, {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Password": adminPassword,
        ...(opts?.headers ?? {}),
      },
      ...opts,
    });
    if (res.status === 401) throw new Error("bad_password");
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error ?? `Error ${res.status}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }, [adminPassword]);

  // ─── effects ───────────────────────────────────────────────────────────────

  // FTP availability (re-fetches when camera changes)
  useEffect(() => {
    setFtpAvail(null);
    setFtpLoading(true);
    contaboFetch(`/admin/contabo/ftp/${camera}/available`)
      .then((data) => setFtpAvail(data as FtpAvailability))
      .catch(() => setFtpAvail(null))
      .finally(() => setFtpLoading(false));
  }, [camera, contaboFetch]);

  // SD availability (re-fetches when camera or date changes)
  useEffect(() => {
    if (!date) { setAvailability(null); return; }
    setAvailability(null);
    setAvailError(null);
    setStartHour(null);
    setEndHour(null);
    setConfirmed(false);
    setAvailLoading(true);
    contaboFetch(`/admin/contabo/sd/${camera}/available?date=${date}`)
      .then((data) => setAvailability(data as SdAvailability))
      .catch((e) => setAvailError(e instanceof Error ? e.message : "Failed to load SD availability"))
      .finally(() => setAvailLoading(false));
  }, [camera, date, contaboFetch]);

  // ─── Job history via TanStack Query (30 s background refresh) ──────────────
  const jobsQuery = useQuery({
    queryKey: ["hq-jobs", adminPassword],
    queryFn: async () => {
      const data = await contaboFetch("/admin/contabo/hq");
      return ((data as { jobs?: PlaybackJob[] }).jobs) ?? ([] as PlaybackJob[]);
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const jobs = jobsQuery.data ?? [];

  // ─── Hydrate live cards from job list on mount / first load ────────────────
  // This lets a page-refresh mid-job re-attach to any in-flight work.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current || !jobs.length) return;
    hydratedRef.current = true;
    const running = jobs.filter(
      (j) => j.status !== "done" && j.status !== "failed",
    );
    if (!running.length) return;
    setLiveJobRefs((prev) => {
      const existingIds = new Set(prev.map((r) => r.jobId));
      const fresh = running
        .filter((j) => !existingIds.has(j.jobId))
        .map((j) => ({
          cam: j.cam ?? j.cameraId ?? "camera1",
          jobId: j.jobId,
          initialJob: j,
        }));
      return fresh.length ? [...fresh, ...prev] : prev;
    });
  }, [jobs]);

  // ─── derived values ────────────────────────────────────────────────────────

  let ftpDate:      string | null = null;
  let ftpHourStart: number | null = null;
  let ftpHourEnd:   number | null = null;
  let ftpTimeLabel: string | null = null;

  if (ftpAvail?.earliest && ftpAvail?.latest) {
    const [ed, et] = ftpAvail.earliest.split(" ");
    const [,   lt] = ftpAvail.latest.split(" ");
    ftpDate      = ed;
    ftpHourStart = parseInt(et.split(":")[0]);
    ftpHourEnd   = parseInt(lt.split(":")[0]);
    const fmtTime = (ts: string) => ts.split(" ")[1].slice(0, 5);
    const isToday = ed === todayAmman();
    ftpTimeLabel  = `${fmtTime(ftpAvail.earliest)} – ${fmtTime(ftpAvail.latest)} ${isToday ? "today" : ed}`;
  }

  const isFtpHour = (h: number) =>
    date === ftpDate && ftpHourStart !== null && ftpHourEnd !== null
    && h >= ftpHourStart && h <= ftpHourEnd;

  const sdHourInfoMap  = new Map(availability?.hours.map((h) => [h.hour, h]) ?? []);
  const sdAvailableSet = new Set(availability?.hours.map((h) => h.hour) ?? []);
  const isHourAvailable = (h: number) => isFtpHour(h) || sdAvailableSet.has(h);

  // All selected hours must be FTP-covered for the instant path (informs the hour-grid colour)
  const isFtpPath: boolean =
    startHour !== null && endHour !== null &&
    Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour! + i).every(isFtpHour);

  const selectionLabel = startHour !== null && endHour !== null
    ? `${String(startHour).padStart(2, "0")}:00 – ${String(endHour + 1).padStart(2, "0")}:00`
    : null;

  // Selected window duration in hours (whole hour blocks)
  const windowHours = startHour !== null && endHour !== null ? endHour - startHour + 1 : 0;

  // Method-aware live duration estimate
  const methodEstimate = (method: "playback" | "sd"): string | null => {
    if (!windowHours) return null;
    const fmtHrs = (h: number) => {
      if (h < 1) return `~${Math.round(h * 60)} min`;
      const hh = Math.floor(h);
      const mm = Math.round((h - hh) * 60);
      return mm > 0 ? `~${hh} hr ${mm} min` : `~${hh} hr`;
    };
    if (method === "playback") return fmtHrs(windowHours / 4);
    /* sd */ return fmtHrs(windowHours * 1.5);
  };

  const formatBytes = (b: number) => {
    if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
    if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`;
    return `${b} B`;
  };

  // Direct-download is painfully slow past ~15 min of footage (~3 hrs pull)
  const showSdWarning = pullMethod === "sd" && windowHours * 60 > 15;

  // ─── interaction handlers ──────────────────────────────────────────────────

  const handleHourClick = (h: number) => {
    setConfirmed(false);
    if (startHour === null) {
      setStartHour(h); setEndHour(h);
    } else if (h === startHour && h === endHour) {
      setStartHour(null); setEndHour(null);
    } else if (h < startHour) {
      setStartHour(h); setEndHour(startHour);
    } else {
      setEndHour(h);
    }
  };

  const handleSubmit = async () => {
    if (startHour === null || endHour === null) { setSubmitError("Select at least one hour block"); return; }
    if (!title.trim()) { setSubmitError("Clip title is required"); return; }
    const start = `${date} ${String(startHour).padStart(2, "0")}:00:00`;
    const end   = `${date} ${String(endHour + 1).padStart(2, "0")}:00:00`;
    setSubmitting(true); setSubmitError(null);
    try {
      const qs = `source=${pullMethod}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&title=${encodeURIComponent(title.trim())}`;
      const data = await contaboFetch(`/admin/contabo/hq/${camera}?${qs}`, { method: "POST" });
      const newJob = data as PlaybackJob;
      const savedRequest = { date, startHour, endHour, title: title.trim(), camera, source: pullMethod };
      setLiveJobRefs((prev) => {
        if (prev.some((r) => r.jobId === newJob.jobId)) return prev;
        return [{ cam: camera, jobId: newJob.jobId, initialJob: newJob, savedRequest }, ...prev];
      });
      setTitle(""); setStartHour(null); setEndHour(null); setConfirmed(false);
      void jobsQuery.refetch();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setSubmitting(false);
    }
  };

  // Retry: re-submits a failed job's saved request using its original source method
  const handleRetry = async (req: NonNullable<LiveJobRef["savedRequest"]>) => {
    const start = `${req.date} ${String(req.startHour).padStart(2, "0")}:00:00`;
    const end   = `${req.date} ${String(req.endHour + 1).padStart(2, "0")}:00:00`;
    try {
      const qs = `source=${req.source}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&title=${encodeURIComponent(req.title)}`;
      const data = await contaboFetch(`/admin/contabo/hq/${req.camera}?${qs}`, { method: "POST" });
      const newJob = data as PlaybackJob;
      setLiveJobRefs((prev) => {
        if (prev.some((r) => r.jobId === newJob.jobId)) return prev;
        return [{ cam: req.camera, jobId: newJob.jobId, initialJob: newJob, savedRequest: req }, ...prev];
      });
      void jobsQuery.refetch();
    } catch { /* surface nothing — the card stays visible */ }
  };

  // ─── render ────────────────────────────────────────────────────────────────

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Download className="w-4 h-4 text-primary" />
        <h2 className="text-white font-bold text-base">Request Footage</h2>
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 space-y-4">

        {/* ── FTP instant-availability banner ─────────────────────────────── */}
        {ftpLoading && (
          <div className="flex items-center gap-2 text-zinc-500 text-xs">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking instant availability…
          </div>
        )}
        {!ftpLoading && ftpTimeLabel && (
          <div className="flex items-center gap-2 text-xs text-green-300 bg-green-900/20 border border-green-700/40 rounded-xl px-3 py-2.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
            <div>
              <span className="font-semibold">⚡ Instant: {ftpTimeLabel}</span>
              <span className="text-green-500/80 ml-2">— assembles in under a minute</span>
            </div>
          </div>
        )}
        {!ftpLoading && !ftpAvail && (
          <div className="flex items-center gap-2 text-xs text-zinc-500 bg-zinc-800/40 border border-zinc-700/40 rounded-xl px-3 py-2.5">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            No instant footage on server — will pull via playback engine.
          </div>
        )}

        {/* ── Camera + Date ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-zinc-400 mb-1.5 block font-medium">Camera</label>
            <select
              value={camera}
              onChange={(e) => {
                setCamera(e.target.value as Camera);
                setStartHour(null); setEndHour(null); setConfirmed(false);
              }}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-primary appearance-none"
            >
              <option value="camera1">Camera 1</option>
              <option value="camera2">Camera 2</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-zinc-400 mb-1.5 block font-medium">Date (Amman time)</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-primary"
            />
          </div>
        </div>

        {/* ── Hour grid ───────────────────────────────────────────────────── */}
        {date && (
          <div>
            <label className="text-xs text-zinc-400 mb-2 block font-medium">
              Select Hours
              {selectionLabel && (
                <span className="ml-2 font-semibold text-zinc-300">
                  {selectionLabel}
                </span>
              )}
            </label>

            {availLoading && (
              <div className="flex items-center gap-2 text-zinc-500 text-xs mb-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking SD card availability…
              </div>
            )}
            {availError && (
              <div className="flex items-center gap-2 text-amber-400 text-xs bg-amber-900/20 border border-amber-700/40 rounded-xl px-3 py-2 mb-1.5">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {availError}
              </div>
            )}

            <div className="flex flex-wrap gap-1.5">
              {Array.from({ length: 24 }, (_, h) => {
                const sdInfo    = sdHourInfoMap.get(h);
                const hasFtp    = isFtpHour(h);
                const available = isHourAvailable(h);
                const inRange   = startHour !== null && endHour !== null && h >= startHour && h <= endHour;
                const inFtpRange = inRange && isFtpPath;

                return (
                  <button
                    key={h}
                    type="button"
                    disabled={!available}
                    onClick={() => handleHourClick(h)}
                    title={
                      hasFtp
                        ? `${String(h).padStart(2, "0")}:00 — instant (on server)`
                        : sdInfo
                          ? `${String(h).padStart(2, "0")}:00 — playback engine, ${formatBytes(sdInfo.bytes)}`
                          : `${String(h).padStart(2, "0")}:00 — no footage`
                    }
                    className={cn(
                      "flex flex-col items-center px-2 py-1.5 rounded-lg border transition-all select-none",
                      !available
                        ? "border-zinc-800 bg-zinc-900/40 text-zinc-700 cursor-not-allowed"
                        : inFtpRange
                          ? "border-green-500 bg-green-900/30 text-green-300 font-bold ring-1 ring-green-500/40"
                          : inRange
                            ? "border-blue-500 bg-blue-900/30 text-blue-300 font-bold ring-1 ring-blue-500/40"
                            : hasFtp
                              ? "border-green-700 bg-green-900/20 text-green-400 hover:border-green-500 cursor-pointer"
                              : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-500 cursor-pointer",
                    )}
                  >
                    <span className="text-[11px] font-mono">{String(h).padStart(2, "0")}</span>
                    <span className="text-[8px] mt-0.5 opacity-70">
                      {hasFtp ? "⚡" : sdInfo ? formatBytes(sdInfo.bytes) : ""}
                    </span>
                  </button>
                );
              })}
            </div>

            {!availLoading && !Array.from({ length: 24 }, (_, h) => isHourAvailable(h)).some(Boolean) && (
              <p className="text-zinc-600 text-xs pt-2">No footage available on this date.</p>
            )}
          </div>
        )}

        {/* ── Title ───────────────────────────────────────────────────────── */}
        <div>
          <label className="text-xs text-zinc-400 mb-1.5 block font-medium">Clip Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Galaxy Field – Morning Session"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-primary"
          />
        </div>

        {submitError && (
          <div className="flex items-center gap-2 text-red-400 text-xs bg-red-900/20 border border-red-700/40 rounded-xl px-3 py-2">
            <XCircle className="w-3.5 h-3.5 flex-shrink-0" /> {submitError}
          </div>
        )}

        {/* ── Pull method picker ───────────────────────────────────────────── */}
        {date && (
          <div>
            <label className="text-xs text-zinc-400 mb-1.5 block font-medium">Pull Method</label>
            <div className="space-y-2">

              {/* Playback (recommended) */}
              {([ 
                {
                  value: "playback" as const,
                  label: "Playback",
                  badge: "recommended",
                  badgeColor: "text-primary border-primary/50",
                  body: "Fastest — starts with 3 parallel streams and can scale to 5 at up to ~4.6 MB/s. Bit-identical picture quality to direct download, verified frame-by-frame.",
                },
                {
                  value: "sd" as const,
                  label: "Direct download",
                  badge: undefined,
                  badgeColor: "",
                  body: "Fallback — uses up to 4 parallel streams at up to ~0.65 MB/s. Same quality. Use only if Playback misbehaves on a particular window.",
                },
              ] as const).map(({ value, label, badge, badgeColor, body }) => {
                const est = methodEstimate(value);
                const isSelected = pullMethod === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => { setPullMethod(value); setConfirmed(false); }}
                    className={cn(
                      "w-full text-left rounded-xl border px-3 py-2.5 transition-all",
                      isSelected
                        ? "border-primary/60 bg-primary/5 ring-1 ring-primary/30"
                        : "border-zinc-700 bg-zinc-800/50 hover:border-zinc-600",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {/* Radio dot */}
                        <span className={cn(
                          "w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 flex items-center justify-center",
                          isSelected ? "border-primary" : "border-zinc-600",
                        )}>
                          {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
                        </span>
                        <span className={cn("text-sm font-semibold", isSelected ? "text-white" : "text-zinc-300")}>
                          {label}
                        </span>
                        {badge && (
                          <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full border font-medium", badgeColor)}>
                            {badge}
                          </span>
                        )}
                      </div>
                      {/* Live estimate — only when hours are selected */}
                      {est && (
                        <span className={cn(
                          "text-[11px] font-semibold tabular-nums flex-shrink-0",
                          value === "sd" ? "text-amber-400"
                            : "text-blue-400",
                        )}>
                          {est}
                          {windowHours > 0 && <span className="font-normal text-zinc-500"> est.</span>}
                        </span>
                      )}
                    </div>
                    <p className={cn("text-[11px] leading-relaxed mt-1 pl-5", isSelected ? "text-zinc-400" : "text-zinc-600")}>
                      {body}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Direct-download slow-path warning ───────────────────────────── */}
        {showSdWarning && startHour !== null && (
          <div className="flex items-start gap-2 text-amber-300 text-xs bg-amber-900/20 border border-amber-700/40 rounded-xl px-3 py-2.5">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-amber-400" />
            <span>
              <strong>Direct download is very slow</strong> — your selection will take roughly{" "}
              {methodEstimate("sd")} to pull, then Bunny encodes on top of that.{" "}
              Consider switching to <button type="button" onClick={() => { setPullMethod("playback"); setConfirmed(false); }} className="underline hover:text-amber-200 transition-colors">Playback</button> instead ({methodEstimate("playback")} for the same window).
            </span>
          </div>
        )}

        {/* ── Submit ──────────────────────────────────────────────────────── */}
        {startHour !== null && (
          <>
            {/* Slow-path confirm step for sd method */}
            {pullMethod === "sd" && !confirmed ? (
              <button
                type="button"
                onClick={() => setConfirmed(true)}
                className="w-full flex items-center justify-center gap-1.5 border border-amber-600/70 text-amber-300 font-medium py-2.5 rounded-xl text-sm hover:bg-amber-900/20 transition-colors"
              >
                I understand it will be slow — show me the submit button
              </button>
            ) : (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleSubmit()}
                className={cn(
                  "w-full flex items-center justify-center gap-2 font-bold py-3 rounded-xl text-sm disabled:opacity-50 hover:opacity-90 transition-opacity",
                  pullMethod === "sd" ? "bg-amber-600 text-white"
                  : "bg-blue-600 text-white",
                )}
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {submitting ? "Requesting…"
                  : pullMethod === "sd" ? "Pull footage (direct download)"
                  : "Pull footage (playback engine)"}
              </button>
            )}
          </>
        )}

        {/* ── No selection hint ───────────────────────────────────────────── */}
        {startHour === null && date && (
          <p className="text-zinc-600 text-xs text-center">
            Select one or more hour blocks above to request footage
          </p>
        )}

        {/* ── Live job cards ──────────────────────────────────────────────── */}
        {liveJobRefs.length > 0 && (
          <div className="space-y-2.5 pt-1">
            <p className="text-zinc-500 text-[10px] font-semibold uppercase tracking-wider">Active pulls</p>
            {liveJobRefs.map((ref) => (
              <LiveJobCard
                key={ref.jobId}
                cam={ref.cam}
                jobId={ref.jobId}
                adminPassword={adminPassword}
                initialJob={ref.initialJob}
                savedRequest={ref.savedRequest}
                onRetry={handleRetry}
                onRemove={() =>
                  setLiveJobRefs((prev) => prev.filter((r) => r.jobId !== ref.jobId))
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Previous requests list ───────────────────────────────────────────── */}
      <div className="mt-4">
        <h3 className="text-zinc-400 text-xs font-semibold uppercase tracking-wider mb-2">Previous Requests</h3>
        {jobsQuery.isLoading ? (
          <div className="text-zinc-600 text-xs py-4 text-center">Loading…</div>
        ) : jobs.length === 0 ? (
          <div className="text-zinc-700 text-xs py-4 text-center">No requests yet</div>
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => {
              const isDone   = job.status === "done";
              const isFailed = job.status === "failed";
              const isRunning = !isDone && !isFailed;
              const playbackUrl = job.playbackUrl ?? job.playback ?? null;
              const jobCam = job.cam ?? job.cameraId ?? "—";
              const reqStart = job.requested?.start ?? job.start ?? null;
              const reqEnd   = job.requested?.end   ?? job.end   ?? null;
              const createdAt = job.startedAt ?? job.createdAt ?? null;

              return (
                <div key={job.jobId} className="flex items-start gap-3 p-3 rounded-xl border border-zinc-800 bg-zinc-900">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-white text-sm font-medium truncate">{job.title || job.jobId}</span>
                      <span className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded-full border flex items-center gap-1 font-medium flex-shrink-0",
                        isDone    ? "text-green-400 bg-green-900/20 border-green-700/40"
                        : isFailed  ? "text-red-400 bg-red-900/20 border-red-700/40"
                        : "text-blue-400 bg-blue-900/20 border-blue-700/40",
                      )}>
                        {isDone   ? <CheckCircle2 className="w-3 h-3" />
                        : isFailed ? <XCircle className="w-3 h-3" />
                        : <Loader2 className="w-3 h-3 animate-spin" />}
                        {isRunning && job.phase ? phaseLabel(job.phase) : job.status}
                      </span>
                      {isRunning && job.percent != null && (
                        <span className="text-[10px] text-zinc-500 tabular-nums">{job.percent}%</span>
                      )}
                    </div>
                    <p className="text-zinc-500 text-xs mt-0.5">
                      {jobCam} · {reqStart ?? "—"} → {reqEnd ?? "—"}
                      {job.source && <span className="text-zinc-600 ml-1">({job.source})</span>}
                    </p>
                    {createdAt && (
                      <p className="text-zinc-600 text-[10px] mt-0.5">
                        {new Date(createdAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                  {isDone && playbackUrl && (
                    <a
                      href={`${basePath}/api/hls-proxy/manifest?url=${encodeURIComponent(playbackUrl)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-shrink-0 flex items-center gap-1 text-xs text-green-400 hover:text-green-300 transition-colors py-1"
                    >
                      <Play className="w-3 h-3" /> Watch
                    </a>
                  )}
                  {isRunning && (
                    <button
                      type="button"
                      onClick={() => {
                        setLiveJobRefs((prev) => {
                          if (prev.some((r) => r.jobId === job.jobId)) return prev;
                          return [{ cam: jobCam, jobId: job.jobId, initialJob: job }, ...prev];
                        });
                      }}
                      className="flex-shrink-0 flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors py-1"
                    >
                      <Loader2 className="w-3 h-3 animate-spin" /> Track
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function LiveTab() {
  const adminPassword = "";
  const [configMissing, setConfigMissing] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    try {
      void fetch(`${basePath}/api/admin/contabo/config`, {
        credentials: "include",
      }).then(async (res) => {
        const data = await res.json() as { missing?: string[] };
        if (!cancelled && data.missing?.length) setConfigMissing(data.missing);
      }).catch(() => {
        // Individual controls surface reachability errors; config discovery is best-effort.
      });
    } catch {
      // fetch can only throw synchronously in unusual browser environments.
    }
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-6">
      {/* Config warning */}
      {configMissing.length > 0 && (
        <div className="rounded-2xl border border-amber-600/40 bg-amber-900/10 px-4 py-4 space-y-2">
          <div className="flex items-center gap-2 text-amber-400 font-semibold text-sm">
            <AlertTriangle className="w-4 h-4" />
            Missing Replit Secrets
          </div>
          <p className="text-zinc-400 text-xs">
            Add these secrets in the Replit Secrets panel, then restart the API server:
          </p>
          <ul className="space-y-1">
            {configMissing.map((k) => (
              <li key={k} className="text-xs font-mono bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-amber-300">
                {k}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Live Control ───────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Radio className="w-4 h-4 text-red-500" />
          <h2 className="text-white font-bold text-base">Live Control</h2>
        </div>
        <div className="grid grid-cols-1 gap-3">
          {CAMERAS.map((cam) => (
            <CameraCard key={cam} camera={cam} adminPassword={adminPassword} />
          ))}
        </div>
      </section>

      {/* ── Live Schedules ────────────────────────────────── */}
      <LiveSchedulesSection adminPassword={adminPassword} />

      {/* ── Request 4K Footage ────────────────────────────── */}
      <SdPullSection adminPassword={adminPassword} />

    </div>
  );
}

// ─── Recordings Tab ──────────────────────────────────────────────────────────

function recMatchesSchedules(rec: AdminRecording, schedules: AdminSchedule[]): boolean {
  if (schedules.length === 0 || !rec.date || !rec.timeSlot) return false;
  const parts = rec.timeSlot.split(":");
  const th = Number(parts[0] ?? 0);
  const tm = Number(parts[1] ?? 0);
  if (isNaN(th) || isNaN(tm)) return false;
  const recMins = th * 60 + tm;
  return schedules.some((s) => {
    const sp = s.startTime.split(":");
    const ep = s.endTime.split(":");
    const startMins = Number(sp[0] ?? 0) * 60 + Number(sp[1] ?? 0);
    const endMins = Number(ep[0] ?? 0) * 60 + Number(ep[1] ?? 0);
    return s.allowedDate === rec.date && recMins >= startMins && recMins < endMins;
  });
}

function formatMonthLabel(month: Date): string {
  return month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function formatIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function CalendarMonth({
  month,
  selectedDate,
  allowedDates,
  recordingDates,
  onSelect,
  onMonthChange,
}: {
  month: Date;
  selectedDate: string;
  allowedDates: Set<string>;
  recordingDates: Set<string>;
  onSelect: (date: string) => void;
  onMonthChange: (delta: number) => void;
}) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstDay = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cells = Array.from({ length: firstDay + daysInMonth }, (_, index) => {
    if (index < firstDay) return null;
    return index - firstDay + 1;
  });

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
      <div className="flex items-center justify-between mb-3">
        <button onClick={() => onMonthChange(-1)} className="p-1.5 text-zinc-500 hover:text-white">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-white text-sm font-semibold">{formatMonthLabel(month)}</span>
        <button onClick={() => onMonthChange(1)} className="p-1.5 text-zinc-500 hover:text-white">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
          <span key={day} className="text-[10px] text-zinc-600 font-semibold py-1">{day}</span>
        ))}
        {cells.map((day, index) => {
          if (day == null) return <span key={`empty-${index}`} />;
          const date = formatIsoDate(year, monthIndex, day);
          const isSelected = date === selectedDate;
          const isAllowed = allowedDates.has(date);
          const hasRecording = recordingDates.has(date);
          return (
            <button
              key={date}
              onClick={() => onSelect(date)}
              className={cn(
                "relative h-9 rounded-lg text-xs transition-colors",
                isSelected ? "bg-primary text-black font-bold" :
                isAllowed ? "bg-primary/20 text-primary font-semibold" :
                "text-zinc-400 hover:bg-zinc-800 hover:text-white"
              )}
            >
              {day}
              {(isAllowed || hasRecording) && (
                <span className={cn(
                  "absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full",
                  isSelected ? "bg-black" : isAllowed ? "bg-primary" : "bg-zinc-500"
                )} />
              )}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3 mt-3 text-[10px] text-zinc-500">
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-primary" /> Whitelisted</span>
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-zinc-500" /> Has recording</span>
      </div>
    </div>
  );
}

function TrackingBundleUpload({ recording }: { recording: AdminRecording }) {
  const [, setLocation] = useLocation();
  const [hasBundle, setHasBundle] = useState(Boolean(recording.hasTrackingBundle));
  const [hasIdentityMap, setHasIdentityMap] = useState(Boolean(recording.hasIdentityMap));
  const [identityMapMatchesBundle, setIdentityMapMatchesBundle] = useState(Boolean(recording.identityMapMatchesBundle));
  const [busy, setBusy] = useState(false);
  const [savingStart, setSavingStart] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [videoStart, setVideoStart] = useState(
    recording.hasTrackingBundle ? String(recording.trackingVideoStartSeconds ?? 0) : "",
  );
  const [verifying, setVerifying] = useState(false);
  const [pitchModel, setPitchModel] = useState(recording.trackingPitchModel ?? null);
  const [pitchBusy, setPitchBusy] = useState(false);
  const [playerMetrics, setPlayerMetrics] = useState<AdminRecordingPlayerMetric[] | null>(null);
  const [loadingPlayerMetrics, setLoadingPlayerMetrics] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pitchInputRef = useRef<HTMLInputElement | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setMessage(null);
    try {
      let result: {
        trackCount: number;
        crossingCount: number;
        segmentCount: number;
        frameCoverage: string;
        videoStartSeconds?: number;
        pitchModel?: NonNullable<AdminRecording["trackingPitchModel"]> | null;
      };
      // Where the tracked window starts inside THIS recording. It belongs to
      // the pairing, not to the bundle: the same tracking can be attached to a
      // differently-trimmed video. Getting it wrong does not fail - it draws
      // every box against footage from elsewhere in the match, which reads as
      // broken tracking rather than a wrong number, so it is asked for here
      // rather than assumed to be zero.
      const startSeconds = videoStart.trim() === "" ? undefined : Number(videoStart);
      if (startSeconds !== undefined && !Number.isFinite(startSeconds)) {
        throw new Error("Video start must be a number of seconds");
      }
      if (file.name.toLowerCase().endsWith(".zip")) {
        const form = new FormData();
        form.append("bundle", file, file.name);
        if (startSeconds !== undefined) form.append("videoStartSeconds", String(startSeconds));
        result = await apiFetch(`/admin/recordings/${recording.id}/tracking-bundle`, {
          method: "PUT",
          body: form,
        }) as typeof result;
      } else {
        const raw = await file.text();
        const payload = JSON.parse(raw);
        if (startSeconds !== undefined) payload.videoStartSeconds = startSeconds;
        result = await apiFetch(`/admin/recordings/${recording.id}/tracking-bundle`, {
          method: "PUT",
          body: JSON.stringify(payload),
        }) as typeof result;
      }
      setHasBundle(true);
      setHasIdentityMap(false);
      setIdentityMapMatchesBundle(false);
      setPitchModel(result.pitchModel ?? null);
      setPlayerMetrics(null);
      setMessage(
        `Ready · ${result.segmentCount} segments · ${result.trackCount} tracks · `
        + `starts ${result.videoStartSeconds ?? 0}s into the video · ${result.frameCoverage}`,
      );
    } catch (error) {
      setMessage(error instanceof SyntaxError
        ? "That file is not valid JSON"
        : error instanceof Error && error.message.startsWith("Video start")
          ? error.message
          : "Upload failed — check manifest, segment ranges, and file names");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const saveVideoStart = async () => {
    const startSeconds = videoStart.trim() === "" ? 0 : Number(videoStart);
    if (!Number.isFinite(startSeconds) || startSeconds < 0) {
      setMessage("Video start must be a non-negative number of seconds");
      return;
    }
    setSavingStart(true);
    setMessage(null);
    try {
      const result = await apiFetch(`/admin/recordings/${recording.id}/tracking-bundle`, {
        method: "PATCH",
        body: JSON.stringify({ videoStartSeconds: startSeconds }),
      }) as { videoStartSeconds: number };
      setVideoStart(String(result.videoStartSeconds));
      setMessage(
        `Ready · ${recording.trackingSegmentCount ?? "—"} segments · ${recording.trackingFrameCoverage ?? "coverage unavailable"} · `
        + `starts ${result.videoStartSeconds}s into the video`,
      );
    } catch {
      setMessage("Could not save the video start time");
    } finally {
      setSavingStart(false);
    }
  };

  const uploadPitchModel = async (file: File) => {
    setPitchBusy(true);
    setMessage(null);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const source = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && ("pitchModel" in parsed || "pitch_model" in parsed)
        ? (parsed as { pitchModel?: unknown; pitch_model?: unknown }).pitchModel
          ?? (parsed as { pitch_model?: unknown }).pitch_model
        : parsed;
      const result = await apiFetch(`/admin/recordings/${recording.id}/tracking-bundle`, {
        method: "PATCH",
        body: JSON.stringify({ pitchModel: source }),
      }) as { pitchModel: NonNullable<AdminRecording["trackingPitchModel"]> | null };
      setPitchModel(result.pitchModel);
      setPlayerMetrics(null);
      setMessage(result.pitchModel
        ? `Pitch model saved · ${calibrationLabel(result.pitchModel)} · ${result.pitchModel.gridRows}×${result.pitchModel.gridColumns} grid · ${result.pitchModel.pitchWidthMetres}×${result.pitchModel.pitchHeightMetres} m`
        : "Pitch model removed · distance unavailable");
    } catch (error) {
      setMessage(error instanceof SyntaxError
        ? "That pitch model file is not valid JSON"
        : "Pitch model upload failed — check dimensions and grid points");
    } finally {
      setPitchBusy(false);
      if (pitchInputRef.current) pitchInputRef.current.value = "";
    }
  };

  const removePitchModel = async () => {
    if (!window.confirm("Remove the pitch model? Distance will become unavailable for this recording.")) return;
    setPitchBusy(true);
    setMessage(null);
    try {
      await apiFetch(`/admin/recordings/${recording.id}/tracking-bundle`, {
        method: "PATCH",
        body: JSON.stringify({ pitchModel: null }),
      });
      setPitchModel(null);
      setPlayerMetrics(null);
      setMessage("Pitch model removed · distance unavailable");
    } catch {
      setMessage("Could not remove the pitch model");
    } finally {
      setPitchBusy(false);
    }
  };

  const loadPlayerMetrics = async () => {
    setLoadingPlayerMetrics(true);
    try {
      const result = await apiFetch(`/admin/recordings/${recording.id}/player-metrics`) as {
        players: AdminRecordingPlayerMetric[];
      };
      setPlayerMetrics(result.players);
    } catch {
      setMessage("Could not load player metrics");
    } finally {
      setLoadingPlayerMetrics(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn(
          "h-2 w-2 rounded-full",
          hasBundle ? "bg-emerald-400" : "bg-zinc-600",
        )} />
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-zinc-200">
            #{recording.id} · {recording.date} · {recording.timeSlot}
          </p>
          <p className="text-[10px] text-zinc-500">
            {message || (hasBundle
              ? `${recording.trackingSegmentCount ?? "—"} segments · ${recording.trackingFrameCoverage ?? "coverage unavailable"}`
              : "No tracking bundle")}
          </p>
           {hasBundle && (
             <p className={cn(
               "mt-0.5 text-[10px]",
               !hasIdentityMap ? "text-zinc-500" : identityMapMatchesBundle ? "text-emerald-400" : "text-amber-400",
             )}>
               {!hasIdentityMap ? "No identity map" : identityMapMatchesBundle ? "Identity map saved" : "Identity map needs review"}
             </p>
           )}
           {hasBundle && (
             <p
               className={cn("mt-0.5 text-[10px]", pitchModel ? "text-emerald-400" : "text-zinc-500")}
               data-testid={`tracking-pitch-model-${recording.id}`}
             >
               {pitchModel
                  ? `${calibrationLabel(pitchModel)} · ${calibrationAspectLabel(pitchModel)} · ${pitchModel.gridRows}×${pitchModel.gridColumns} grid · ${pitchModel.pitchWidthMetres}×${pitchModel.pitchHeightMetres} m${pitchModel.calibrationId && pitchModel.fittedAt && typeof pitchModel.calibratedAspectRatio === "number" ? "" : " · distance unavailable"}`
                  : "No pitch model · distance unavailable"}
             </p>
           )}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".zip,.json,application/zip,application/json"
        className="hidden"
        data-testid={`input-tracking-bundle-${recording.id}`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
       {hasBundle && (
         <input
           ref={pitchInputRef}
           type="file"
           accept=".json,application/json"
           className="hidden"
           data-testid={`input-pitch-model-${recording.id}`}
           onChange={(event) => {
             const file = event.target.files?.[0];
             if (file) void uploadPitchModel(file);
           }}
         />
       )}
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-[10px] text-zinc-500">
          starts
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            placeholder="0"
            value={videoStart}
            onChange={(event) => setVideoStart(event.target.value)}
            className="w-20 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-xs text-zinc-200 focus:border-primary focus:outline-none"
            data-testid={`input-video-start-${recording.id}`}
            title="Seconds into the recording at which the tracked window begins. The 2026-08-24 hour starts 18 minutes in, so 1080."
          />
          s in
          {hasBundle && (
            <button
              type="button"
              className="rounded border border-primary/50 px-2 py-1 text-[10px] font-semibold text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
              disabled={busy || savingStart}
              data-testid={`button-save-video-start-${recording.id}`}
              onClick={() => void saveVideoStart()}
            >
              {savingStart ? "Saving…" : "Save time"}
            </button>
          )}
        </label>
         {hasBundle && (
           <>
             <button
               type="button"
               className="flex items-center gap-1 rounded-lg border border-primary/40 px-2.5 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
               disabled={busy || savingStart || pitchBusy}
               data-testid={`button-upload-pitch-model-${recording.id}`}
               onClick={() => pitchInputRef.current?.click()}
             >
               {pitchBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
               {pitchModel ? "Replace pitch model" : "Upload pitch model"}
             </button>
             {pitchModel && (
               <button
                 type="button"
                 className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-semibold text-zinc-400 transition-colors hover:border-red-400 hover:text-red-300 disabled:opacity-50"
                 disabled={busy || savingStart || pitchBusy}
                 data-testid={`button-remove-pitch-model-${recording.id}`}
                 onClick={() => void removePitchModel()}
               >
                 Remove model
               </button>
             )}
           </>
         )}
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-semibold text-zinc-200 transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
          disabled={busy}
          data-testid={`button-upload-tracking-bundle-${recording.id}`}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {busy ? "Saving…" : hasBundle ? "Replace bundle" : "Upload bundle"}
        </button>
        {hasBundle && (
          <button
            type="button"
            className="flex items-center gap-1 rounded-lg border border-primary/40 px-2.5 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
            data-testid={`button-open-identity-board-${recording.id}`}
            onClick={() => setLocation(`/admin/recordings/${recording.id}/identities`)}
          >
            <LinkIcon className="h-3.5 w-3.5" />
            Identity board
          </button>
        )}
        {hasBundle && (
          <button
            type="button"
            className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-semibold text-zinc-200 transition-colors hover:border-primary hover:text-primary"
            data-testid={`button-verify-tracking-bundle-${recording.id}`}
            onClick={() => setVerifying((value) => !value)}
          >
            {verifying ? "Hide check" : "Check alignment"}
          </button>
        )}
         {hasBundle && (
           <button
             type="button"
             className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-semibold text-zinc-200 transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
             disabled={loadingPlayerMetrics}
             data-testid={`button-load-player-metrics-${recording.id}`}
             onClick={() => void loadPlayerMetrics()}
           >
             {loadingPlayerMetrics ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
             {loadingPlayerMetrics ? "Loading metrics…" : playerMetrics ? "Refresh player metrics" : "Player metrics"}
           </button>
         )}
      </div>
       {playerMetrics && (
         <div className="mt-2 w-full rounded-lg border border-zinc-800 bg-zinc-950/60 p-3" data-testid={`admin-player-metrics-${recording.id}`}>
           <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
             <p className="text-xs font-semibold text-zinc-200">Claimed player metrics</p>
             <p className="text-[10px] text-zinc-500">
               {pitchModel && pitchModel.calibrationId && pitchModel.fittedAt && typeof pitchModel.calibratedAspectRatio === "number"
                 ? `${calibrationLabel(pitchModel)} · ${calibrationAspectLabel(pitchModel)}`
                 : "No valid pitch model · distance and speed unavailable"}
             </p>
           </div>
           {playerMetrics.length === 0 ? (
             <p className="text-[10px] text-zinc-500">No player claims have been recorded for this bundle.</p>
           ) : (
             <div className="grid gap-2 md:grid-cols-2">
               {playerMetrics.map((metric) => (
                 <div key={metric.userId} className="rounded border border-zinc-800 px-2.5 py-2">
                   <p className="truncate text-xs font-medium text-zinc-200">{metric.displayName}</p>
                   <p className="truncate text-[10px] text-zinc-500">{metric.email}</p>
                   <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-zinc-400">
                     <span>Minutes <b className="text-zinc-200">{metric.playerStats.minutesPlayed.toFixed(1)}</b></span>
                     <span>Distance <b className="text-zinc-200">{metric.playerStats.distanceMetres === null ? "Unavailable" : `${metric.playerStats.distanceMetres.toLocaleString()} m`}</b></span>
                     <span>Average speed <b className="text-zinc-200">{metric.playerStats.averageSpeedMetresPerSecond === null ? "Unavailable" : `${metric.playerStats.averageSpeedMetresPerSecond.toFixed(2)} m/s`}</b></span>
                     <span>Top speed <b className="text-amber-300">{metric.topSpeedMetresPerSecond === null ? "Unavailable" : `${metric.topSpeedMetresPerSecond.toFixed(2)} m/s`}</b></span>
                   </div>
                   <p className="mt-1 text-[9px] text-amber-400/80">
                     Top speed unvalidated · usable time {metric.topSpeedUsableTimeFraction === null ? "—" : `${Math.round(metric.topSpeedUsableTimeFraction * 100)}%`}
                   </p>
                 </div>
               ))}
             </div>
           )}
         </div>
       )}
      {verifying && <TrackingAlignmentCheck recordingId={recording.id} />}
    </div>
  );
}

function FieldScheduleSection({
  fieldId, fieldName, recordings, schedules, onSchedulesChange,
}: {
  fieldId: number;
  fieldName: string;
  recordings: AdminRecording[];
  schedules: AdminSchedule[];
  onSchedulesChange: (updated: AdminSchedule[]) => void;
}) {
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [newStart, setNewStart] = useState("18:00");
  const [newEnd, setNewEnd] = useState("22:00");
  const [newLabel, setNewLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);

  const matchedCount = recordings.filter((r) => recMatchesSchedules(r, schedules)).length;
  const selectedSchedules = schedules.filter((s) => s.allowedDate === selectedDate);
  const allowedDates = new Set(
    schedules.map((s) => s.allowedDate).filter((date): date is string => Boolean(date)),
  );
  const recordingDates = new Set(recordings.map((r) => r.date).filter(Boolean));

  const addSchedule = async () => {
    if (!newStart || !newEnd) return;
    setSaving(true);
    try {
      const created = await apiFetch(`/admin/fields/${fieldId}/schedules`, {
        method: "POST",
        body: JSON.stringify({
          allowedDate: selectedDate,
          startTime: newStart,
          endTime: newEnd,
          label: newLabel || null,
        }),
      }) as AdminSchedule;
      onSchedulesChange([...schedules, created]);
      setNewLabel("");
      setNewStart("18:00");
      setNewEnd("22:00");
    } catch { /* silent */ }
    setSaving(false);
  };

  const deleteSchedule = async (id: number) => {
    setDeleting(id);
    try {
      await apiFetch(`/admin/schedules/${id}`, { method: "DELETE" });
      onSchedulesChange(schedules.filter((s) => s.id !== id));
    } catch { /* silent */ }
    setDeleting(null);
  };

  return (
    <div className="rounded-xl border border-zinc-800 overflow-hidden">
      {/* Field header */}
      <div className="px-3 py-2.5 bg-zinc-900/80 border-b border-zinc-800/60 flex items-center justify-between gap-2">
        <div>
          <span className="text-white text-sm font-semibold">{fieldName}</span>
          <span className="text-zinc-500 text-xs ml-2">
            {recordings.length} recording{recordings.length !== 1 ? "s" : ""}
            {schedules.length > 0 && (
              <> · <span className="text-primary">{matchedCount} visible</span></>
            )}
          </span>
        </div>
        <CalendarDays className="w-4 h-4 text-primary" />
      </div>

      <div className="p-3 space-y-3 bg-zinc-950/40">
        <div className="space-y-2">
          <p className="text-zinc-500 text-[11px] uppercase tracking-wider font-semibold">
            Claim Your Match bundles
          </p>
          {recordings.map((recording) => (
            <TrackingBundleUpload key={recording.id} recording={recording} />
          ))}
        </div>
        <p className="text-zinc-500 text-[11px] uppercase tracking-wider font-semibold">
          Whitelisted dates
        </p>
        <CalendarMonth
          month={month}
          selectedDate={selectedDate}
          allowedDates={allowedDates}
          recordingDates={recordingDates}
          onSelect={(date) => {
            setSelectedDate(date);
            const next = new Date(`${date}T12:00:00`);
            setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
          }}
          onMonthChange={(delta) => setMonth((current) =>
            new Date(current.getFullYear(), current.getMonth() + delta, 1)
          )}
        />

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-white text-sm font-semibold">{selectedDate}</p>
              <p className="text-zinc-500 text-xs">Only recordings on this date can be shown</p>
            </div>
            {selectedSchedules.length > 0 && (
              <span className="text-primary text-xs font-semibold">Whitelisted</span>
            )}
          </div>

          {selectedSchedules.map((s) => (
            <div key={s.id} className="flex items-center gap-2 bg-zinc-800/60 rounded-lg px-3 py-2">
              <div className="flex-1 min-w-0">
                <span className="text-white text-sm font-medium">
                  {s.startTime} – {s.endTime}
                </span>
                {s.label && <span className="text-zinc-500 text-xs ml-2">{s.label}</span>}
              </div>
              <button
                onClick={() => deleteSchedule(s.id)}
                disabled={deleting === s.id}
                className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-50"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-zinc-500 text-xs mb-1 block">Start time</label>
              <input
                type="time"
                value={newStart}
                onChange={(e) => setNewStart(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-700 text-white text-sm rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label className="text-zinc-500 text-xs mb-1 block">End time</label>
              <input
                type="time"
                value={newEnd}
                onChange={(e) => setNewEnd(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-700 text-white text-sm rounded-lg px-3 py-2"
              />
            </div>
            <div className="col-span-2">
              <label className="text-zinc-500 text-xs mb-1 block">Label (optional)</label>
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="e.g. Training, Match Day"
                className="w-full bg-zinc-950 border border-zinc-700 text-white text-sm rounded-lg px-3 py-2 placeholder:text-zinc-600"
              />
            </div>
          </div>
          <button
            onClick={addSchedule}
            disabled={saving || !newStart || !newEnd}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-primary text-black text-sm font-semibold rounded-lg disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            {saving ? "Saving…" : `Whitelist ${selectedDate}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function RecordingsTab() {
  const [recordings, setRecordings] = useState<AdminRecording[]>([]);
  const [schedules, setSchedules] = useState<AdminSchedule[]>([]);
  const [fields, setFields] = useState<AdminField[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [recs, scheds, fieldRows] = await Promise.all([
        apiFetch("/admin/recordings") as Promise<AdminRecording[]>,
        apiFetch("/admin/schedules") as Promise<AdminSchedule[]>,
        apiFetch("/admin/fields") as Promise<AdminField[]>,
      ]);
      setRecordings(recs);
      setSchedules(scheds);
      setFields(fieldRows);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const importFromBunny = async () => {
    setImporting(true);
    setImportResult(null);
    try {
      const data = await apiFetch("/admin/recordings/import", { method: "POST" }) as { imported: number };
      setImportResult(`Imported ${data.imported} new recording${data.imported !== 1 ? "s" : ""}`);
      await load();
    } catch {
      setImportResult("Import failed");
    }
    setImporting(false);
  };

  const fieldGroups = useMemo(() => {
    const map = new Map<number, { fieldId: number; fieldName: string; recordings: AdminRecording[] }>(
      fields.map((field) => [
        field.id,
        { fieldId: field.id, fieldName: field.name || `Field ${field.id}`, recordings: [] },
      ]),
    );
    for (const r of recordings) {
      if (!map.has(r.fieldId)) {
        map.set(r.fieldId, { fieldId: r.fieldId, fieldName: r.fieldName ?? `Field ${r.fieldId}`, recordings: [] });
      }
      map.get(r.fieldId)!.recordings.push(r);
    }
    return Array.from(map.values()).sort((a, b) => a.fieldName.localeCompare(b.fieldName));
  }, [fields, recordings]);

  const schedulesByField = useMemo(() => {
    const map = new Map<number, AdminSchedule[]>();
    for (const s of schedules) {
      const arr = map.get(s.fieldId) ?? [];
      arr.push(s);
      map.set(s.fieldId, arr);
    }
    return map;
  }, [schedules]);

  const visibleCount = useMemo(() =>
    recordings.filter((r) => recMatchesSchedules(r, schedulesByField.get(r.fieldId) ?? [])).length,
    [recordings, schedulesByField]
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-white text-sm font-semibold">
            {recordings.length} recording{recordings.length !== 1 ? "s" : ""}
            {recordings.length > 0 && (
              <span className="text-zinc-500 font-normal ml-1.5">
                · {visibleCount} currently visible
              </span>
            )}
          </p>
          <p className="text-zinc-500 text-xs mt-0.5">
            Recordings are shown to users only when they fall within a configured time window
          </p>
        </div>
        <button
          onClick={importFromBunny}
          disabled={importing}
          className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 text-zinc-300 rounded-xl text-sm hover:bg-zinc-700 disabled:opacity-50 whitespace-nowrap flex-shrink-0"
        >
          <RefreshCw className={cn("w-4 h-4", importing && "animate-spin")} />
          {importing ? "Importing…" : "Import from Bunny"}
        </button>
      </div>

      {importResult && (
        <div className={cn(
          "px-3 py-2 rounded-xl text-sm",
          importResult.includes("failed") ? "bg-red-500/10 text-red-400" : "bg-emerald-500/10 text-emerald-400"
        )}>
          {importResult}
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-zinc-500">Loading…</div>
      ) : fieldGroups.length === 0 ? (
        <div className="text-center py-16 space-y-2">
          <p className="text-zinc-400 font-medium">No fields yet</p>
          <p className="text-zinc-600 text-sm">Sync your fields first to manage recording dates</p>
        </div>
      ) : (
        fieldGroups.map(({ fieldId, fieldName, recordings: fieldRecs }) => (
          <FieldScheduleSection
            key={fieldId}
            fieldId={fieldId}
            fieldName={fieldName}
            recordings={fieldRecs}
            schedules={schedulesByField.get(fieldId) ?? []}
            onSchedulesChange={(updated) =>
              setSchedules((prev) => [
                ...prev.filter((s) => s.fieldId !== fieldId),
                ...updated,
              ])
            }
          />
        ))
      )}
    </div>
  );
}

// ─── Matches Tab ──────────────────────────────────────────────────────────────

function MatchesTab() {
  const [matches, setMatches] = useState<AdminMatch[]>([]);
  const [fields, setFields] = useState<AdminField[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [formFieldId, setFormFieldId] = useState<number | "">("");
  const [formTitle, setFormTitle] = useState("");
  const [formStart, setFormStart] = useState("");
  const [formEnd, setFormEnd] = useState("");
  const [formAutoStart, setFormAutoStart] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [matchRows, fieldRows] = await Promise.all([
        apiFetch("/admin/matches") as Promise<AdminMatch[]>,
        apiFetch("/admin/fields") as Promise<AdminField[]>,
      ]);
      setMatches(matchRows);
      // Only camera1 fields can host a match
      setFields(fieldRows.filter((f) => f.cameraId === "camera1"));
    } catch {
      /* silent */
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const cancelMatch = async (match: AdminMatch) => {
    if (!confirm(`Cancel "${match.title}"?`)) return;
    try {
      await apiFetch(`/admin/matches/${match.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "cancel" }),
      });
      setMatches((prev) =>
        prev.map((m) => (m.id === match.id ? { ...m, status: "cancelled" } : m)),
      );
    } catch {
      setError("Failed to cancel match.");
    }
  };

  const createMatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formFieldId || !formTitle || !formStart || !formEnd) {
      setError("All fields are required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const row = await apiFetch("/admin/matches", {
        method: "POST",
        body: JSON.stringify({
          fieldId: Number(formFieldId),
          title: formTitle,
          scheduledStart: new Date(formStart).toISOString(),
          scheduledEnd: new Date(formEnd).toISOString(),
          autoStartLive: formAutoStart,
        }),
      }) as AdminMatch;
      // Reload to get fieldName populated
      await load();
      setSuccess(`Match "${row.title}" created.`);
      setFormFieldId("");
      setFormTitle("");
      setFormStart("");
      setFormEnd("");
      setFormAutoStart(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg === "400" ? "VAR is only available on camera1 fields." : "Failed to create match.");
    }
    setSubmitting(false);
  };

  function statusBadge(status: string) {
    const map: Record<string, string> = {
      scheduled: "bg-zinc-800 text-zinc-300",
      live: "bg-red-900/40 text-red-400 border border-red-800/50",
      ended: "bg-zinc-900 text-zinc-500",
      cancelled: "bg-zinc-900/40 text-zinc-600",
    };
    return (
      <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-semibold", map[status] ?? map["scheduled"])}>
        {status}
      </span>
    );
  }

  function fmtDt(iso: string) {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-white text-sm font-semibold">Matches</p>
        <p className="text-zinc-500 text-xs mt-0.5">
          Schedule matches for camera1 fields. The live stream auto-starts at kickoff and auto-stops at full time.
        </p>
      </div>

      {/* Create form */}
      <form
        onSubmit={createMatch}
        className="bg-zinc-900 border border-zinc-700 rounded-2xl p-4 space-y-3"
      >
        <p className="text-zinc-300 text-sm font-semibold">New Match</p>

        {error && (
          <div className="px-3 py-2 rounded-xl bg-red-500/10 text-red-400 text-sm">{error}</div>
        )}
        {success && (
          <div className="px-3 py-2 rounded-xl bg-emerald-500/10 text-emerald-400 text-sm">{success}</div>
        )}

        <div className="space-y-2">
          <select
            value={formFieldId}
            onChange={(e) => setFormFieldId(e.target.value === "" ? "" : Number(e.target.value))}
            required
            className="w-full bg-zinc-800 border border-zinc-600 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-primary appearance-none"
          >
            <option value="">Select field (camera1 only)…</option>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>

          <input
            type="text"
            value={formTitle}
            onChange={(e) => setFormTitle(e.target.value)}
            placeholder="Match title…"
            required
            className="w-full bg-zinc-800 border border-zinc-600 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-primary"
          />

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-zinc-500 uppercase tracking-wide font-semibold block mb-1">Kickoff</label>
              <input
                type="datetime-local"
                value={formStart}
                onChange={(e) => setFormStart(e.target.value)}
                required
                className="w-full bg-zinc-800 border border-zinc-600 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500 uppercase tracking-wide font-semibold block mb-1">Full time</label>
              <input
                type="datetime-local"
                value={formEnd}
                onChange={(e) => setFormEnd(e.target.value)}
                required
                className="w-full bg-zinc-800 border border-zinc-600 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-primary"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={formAutoStart}
              onChange={(e) => setFormAutoStart(e.target.checked)}
              className="w-4 h-4 accent-primary rounded"
            />
            <span className="text-sm text-zinc-300">Auto-start live stream at kickoff</span>
          </label>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-2.5 rounded-xl bg-primary text-black text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {submitting ? "Creating…" : "Create Match"}
        </button>
      </form>

      {/* Match list */}
      {loading ? (
        <div className="text-center py-8 text-zinc-500">Loading…</div>
      ) : matches.length === 0 ? (
        <div className="text-center py-8 text-zinc-500 text-sm">No matches yet.</div>
      ) : (
        <div className="space-y-2">
          {matches.map((match) => (
            <div
              key={match.id}
              className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex items-start gap-3"
            >
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-white text-sm font-semibold truncate">{match.title}</p>
                  {statusBadge(match.status)}
                </div>
                <p className="text-zinc-400 text-xs">{match.fieldName}</p>
                <p className="text-zinc-500 text-xs tabular-nums">
                  {fmtDt(match.scheduledStart)} → {fmtDt(match.scheduledEnd)}
                </p>
                {match.autoStartLive && (
                  <p className="text-zinc-600 text-[10px]">Auto-start live ✓</p>
                )}
              </div>
              {match.status !== "cancelled" && match.status !== "ended" && (
                <button
                  onClick={() => cancelMatch(match)}
                  className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:bg-red-900/30 hover:text-red-400 transition-colors flex-shrink-0"
                  title="Cancel match"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Admin Console ───────────────────────────────────────────────────────

const TABS: { id: Tab; label: string }[] = [
  { id: "clips", label: "Clips" },
  { id: "accounts", label: "Accounts" },
  { id: "fields", label: "Fields" },
  { id: "banners", label: "Banners" },
  { id: "recordings", label: "Recordings" },
  { id: "live", label: "Live Control" },
  { id: "var", label: "VAR" },
  { id: "matches", label: "Matches" },
  { id: "claim-disputes", label: "Claim Disputes" },
  { id: "settings", label: "Settings" },
];

export default function Admin() {
  const { user, isLoading, isAdmin } = useAuth();
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<Tab>("clips");

  useEffect(() => {
    if (!isLoading && (!user || !isAdmin)) {
      setLocation("/home");
    }
  }, [isLoading, user, isAdmin, setLocation]);

  if (isLoading || !user || !isAdmin) {
    return null;
  }

  return (
    <div className="admin-page flex-1 flex flex-col bg-background min-h-0 overflow-hidden">
      {/* Header */}
      <div className="admin-page-header pt-safe px-4 pt-5 pb-3 bg-zinc-950 border-b border-zinc-800/60 flex-shrink-0">
        <p className="text-zinc-500 text-xs uppercase tracking-widest font-semibold mb-0.5">Admin Console</p>
        <h1 className="font-display font-black text-3xl text-white uppercase tracking-tight">REPLAY</h1>
      </div>

      {/* Tabs */}
      <div className="admin-page-tabs flex border-b border-zinc-800/60 bg-zinc-950 flex-shrink-0 px-2 overflow-x-auto no-scrollbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "px-4 py-3 text-sm font-semibold transition-colors relative whitespace-nowrap flex-shrink-0",
              tab === t.id ? "text-primary" : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            {t.label}
            {tab === t.id && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="admin-page-content flex-1 overflow-y-auto no-scrollbar px-4 py-4 pb-24">
        {tab === "clips" && <ClipsTab />}
        {tab === "accounts" && <AccountsTab />}
        {tab === "fields" && <FieldsTab />}
        {tab === "banners" && <BannersTab />}
        {tab === "academies" && <AcademiesTab />}
        {tab === "recordings" && <RecordingsTab />}
        {tab === "live" && <LiveTab />}
        {tab === "var" && <VarTab />}
        {tab === "matches" && <MatchesTab />}
        {tab === "claim-disputes" && <ClaimDisputesTab />}
        {tab === "settings" && <SettingsTab />}
      </div>
    </div>
  );
}
