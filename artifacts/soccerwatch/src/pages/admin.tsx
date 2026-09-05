�─────────────── */}
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
      const isAdminAuthError = error instanceof ApiFetchError
        && (error.status === 401 || error.status === 403);
      const requestMessage = adminRequestErrorMessage(error, "");
      setMessage(error instanceof SyntaxError
        ? "That file is not valid JSON"
        : error instanceof Error && error.message.startsWith("Video start")
          ? error.message
          : isAdminAuthError
            ? requestMessage
            : requestMessage
              ? `Upload failed — ${requestMessage}`
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
    } catch (error) {
      setMessage(adminRequestErrorMessage(error, "Could not save the video start time"));
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

/**
 * One list, not two.
 *
 * The label list and the render switch used to be separate, and Academies fell
 * out of the label list while its `{tab === "academies" && <AcademiesTab />}`
 * line stayed — so the tab existed, rendered correctly, and had no button
 * anywhere that could reach it. Nothing failed; it was simply gone.
 *
 * `Record<Tab, ...>` makes that a compile error: every member of the Tab union
 * must appear here, and anything here must be a member of it. Insertion order
 * is the display order.
 */
const TABS: Record<Tab, { label: string; render: () => ReactNode }> = {
  clips: { label: "Clips", render: () => <ClipsTab /> },
  accounts: { label: "Accounts", render: () => <AccountsTab /> },
  fields: { label: "Fields", render: () => <FieldsTab /> },
  academies: { label: "Academies", render: () => <AcademiesTab /> },
  banners: { label: "Banners", render: () => <BannersTab /> },
  recordings: { label: "Recordings", render: () => <RecordingsTab /> },
  live: { label: "Live Control", render: () => <LiveTab /> },
  var: { label: "VAR", render: () => <VarTab /> },
  matches: { label: "Matches", render: () => <MatchesTab /> },
  "claim-disputes": { label: "Claim Disputes", render: () => <ClaimDisputesTab /> },
  analysis: { label: "Analysis", render: () => <AnalysisTab /> },
  branding: { label: "Branding", render: () => <BrandingTab /> },
  settings: { label: "Settings", render: () => <SettingsTab /> },
};

const TAB_ORDER = Object.keys(TABS) as Tab[];

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
        {TAB_ORDER.map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "px-4 py-3 text-sm font-semibold transition-colors relative whitespace-nowrap flex-shrink-0",
              tab === id ? "text-primary" : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            {TABS[id].label}
            {tab === id && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="admin-page-content flex-1 overflow-y-auto no-scrollbar px-4 py-4 pb-24">
        {TABS[tab].render()}
      </div>
    </div>
  );
}
