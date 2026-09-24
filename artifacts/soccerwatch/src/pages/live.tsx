import { useEffect, useRef, useState } from "react";
import { Radio } from "lucide-react";
import { HlsPlayer } from "@/components/HlsPlayer";
import { fetchLiveSource, nextPollMs, type LiveSource } from "@/lib/liveSource";

const CAMERAS = [
  { id: "camera1", label: "Camera 1" },
  { id: "camera2", label: "Camera 2" },
];

/**
 * One camera. Prefer the live GPU-panned feed, then fall back to regular HLS.
 *
 * The url comes from the server rather than being built here, because the
 * server is also the only thing that knows whether there is anything at the
 * other end of it. When no camera is pushing, the origin keeps serving the
 * playlist it last wrote — so the player attaches happily to a frame that is
 * days old and the viewer gets a spinner with no explanation. Asking for the
 * source and thestatus together is what turns that into a sentence.
 */
function LiveCamera({ id, label }: { id: string; label: string }) {
  const [source, setSource] = useState<LiveSource | null>(null);
  const [panSource, setPanSource] = useState<LiveSource | null>(null);
  const [panAvailable, setPanAvailable] = useState(false);
  const [view, setView] = useState<"pan" | "hls">(() => {
    try {
      return sessionStorage.getItem(`live-view:${id}`) === "hls" ? "hls" : "pan";
    } catch {
      return "pan";
    }
  });
  const viewRef = useRef(view);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      let pan: LiveSource | null = null;
      try {
        // Pan is queried first; a missing or stale pan feed is not an error.
        pan = await fetchLiveSource(id, "pan");
      } catch {
        // Keep the ordinary HLS feed available if the pan endpoint is offline.
      }
      if (cancelled) return;

      setPanSource(pan);
      const isPanLive = pan?.status.live === true;
      setPanAvailable(isPanLive);

      let hls: LiveSource | null = null;
      if (!isPanLive || viewRef.current === "hls") {
        try {
          hls = await fetchLiveSource(id, "hls");
        } catch (err) {
          if (cancelled) return;
          setError((err as Error).message);
          timer = setTimeout(poll, nextPollMs(pan?.status ?? null));
          return;
        }
      }
      if (cancelled) return;

      // Read the preference again after network calls: a viewer may have
      // changed modes while this poll was in flight.
      if (isPanLive && viewRef.current === "pan") {
        setSource(pan);
      } else if (hls) {
        setSource(hls);
      } else {
        try {
          const fullView = await fetchLiveSource(id, "hls");
          if (cancelled) return;
          setSource(fullView);
        } catch (err) {
          if (cancelled) return;
          setError((err as Error).message);
          timer = setTimeout(poll, nextPollMs(pan?.status ?? null));
          return;
        }
      }

      setError(null);
      timer = setTimeout(poll, nextPollMs(pan?.status ?? null));
    };

    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [id]);

  const chooseView = async (next: "pan" | "hls") => {
    viewRef.current = next;
    setView(next);
    try {
      sessionStorage.setItem(`live-view:${id}`, next);
    } catch {
      // The preference still applies for this page if storage is unavailable.
    }

    if (next === "pan") {
      if (panSource?.status.live) {
        setSource(panSource);
        setError(null);
      }
      return;
    }

    try {
      const fullView = await fetchLiveSource(id, "hls");
      if (viewRef.current === "hls") {
        setSource(fullView);
        setError(null);
      }
    } catch (err) {
      if (viewRef.current === "hls") setError((err as Error).message);
    }
  };

  const viewToggle = panAvailable && (
    <div role="group" aria-label="Live camera view" className="flex gap-2">
      <button
        type="button"
        aria-pressed={view === "pan"}
        onClick={() => void chooseView("pan")}
        className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
          view === "pan" ? "border-primary bg-primary/15 text-primary" : "border-zinc-700 text-zinc-400 hover:text-white"
        }`}
      >
        Follow the ball / تتبّع الكرة
      </button>
      <button
        type="button"
        aria-pressed={view === "hls"}
        onClick={() => void chooseView("hls")}
        className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
          view === "hls" ? "border-primary bg-primary/15 text-primary" : "border-zinc-700 text-zinc-400 hover:text-white"
        }`}
      >
        Full view / عرض كامل
      </button>
    </div>
  );

  if (error) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
        {viewToggle}
        <div>
          <p className="text-white text-sm font-semibold">{label}</p>
          <p className="text-zinc-500 text-xs mt-1">{error}</p>
        </div>
      </div>
    );
  }

  if (!source) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
        {viewToggle}
        <div>
          <p className="text-white text-sm font-semibold">{label}</p>
          <p className="text-zinc-500 text-xs mt-1">Checking…</p>
        </div>
      </div>
    );
  }

  if (!source.status.live) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
        {viewToggle}
        <div>
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
            <p className="text-white text-sm font-semibold">{label}</p>
          </div>
          <p className="text-zinc-400 text-xs mt-1.5">{source.message ?? "No live feed."}</p>
          <p className="text-zinc-600 text-xs mt-1">Checking again every 15 seconds.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {viewToggle}
      <HlsPlayer
        key={`${source.variant}:${source.url}`}
        url={source.url}
        label={label}
        retryOnNetworkError
        liveEdgeToleranceSeconds={source.variant === "pan" ? 30 : undefined}
      />
    </div>
  );
}

export default function Live() {
  return (
    <div className="flex-1 overflow-y-auto no-scrollbar bg-background">
      <div className="px-4 pt-6 pb-4 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Radio className="replay-live-indicator h-5 w-5 text-live" />
          <h1 className="text-white text-xl font-bold">Live</h1>
        </div>
      </div>

      <div className="px-4 pb-8 space-y-4">
        {CAMERAS.map((cam) => (
          <LiveCamera key={cam.id} id={cam.id} label={cam.label} />
        ))}
      </div>
    </div>
  );
}
