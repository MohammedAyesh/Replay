/**
 * "Show me what claiming looks like" -- the entry point that does not need a
 * recording in mind.
 *
 * The server picks the newest recording that actually has a tracking bundle,
 * because a claim page for a recording with nothing to claim is a worse
 * introduction than no page at all.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function ClaimDemo() {
  const [, setLocation] = useLocation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${basePath}/api/claim/demo`, { credentials: "include" });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body?.error ?? "No match is ready to claim yet");
        }
        const body = await response.json() as { recordingId: number };
        if (!cancelled) setLocation(`/claim/${body.recordingId}`, { replace: true });
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not open a match");
      }
    })();
    return () => { cancelled = true; };
  }, [setLocation]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center px-6 text-center">
      <p className="text-sm text-zinc-400">{error ?? "Finding a match to claim…"}</p>
    </div>
  );
}
