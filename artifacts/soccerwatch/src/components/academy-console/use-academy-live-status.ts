import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getGetAcademyConsoleSessionLiveStatusQueryOptions,
  getGetAcademyFamilySessionLiveStatusQueryOptions,
} from "@workspace/api-client-react";

const POLL_MS = 15_000;
const WINDOW_MARGIN_MS = 30 * 60_000;
const MAX_TIMEOUT_MS = 2_147_000_000;

export function academySessionWindow(startsAt: string, endsAt: string | null) {
  const start = new Date(startsAt).getTime();
  const end = endsAt ? new Date(endsAt).getTime() : start + 90 * 60_000;
  return {
    start: start - 3 * 60_000,
    end: end + 5 * 60_000,
  };
}

export function formatAmmanClock(value: number, locale: string) {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", {
    timeZone: "Asia/Amman",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(value);
}

export function useAcademyLiveStatus({
  sessionId,
  startsAt,
  endsAt,
  surface,
  academyId,
}: {
  sessionId: number;
  startsAt: string;
  endsAt: string | null;
  surface: "console" | "family";
  academyId?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  const window = academySessionWindow(startsAt, endsAt);
  const pollWindow = Number.isFinite(window.start) && Number.isFinite(window.end)
    && now >= window.start - WINDOW_MARGIN_MS && now <= window.end + WINDOW_MARGIN_MS;

  useEffect(() => {
    const update = () => setNow(Date.now());
    const nextBoundary = window.start - WINDOW_MARGIN_MS;
    const delay = pollWindow
      ? POLL_MS
      : Math.max(1_000, Math.min(MAX_TIMEOUT_MS, nextBoundary - Date.now()));
    const timer = setTimeout(update, delay);
    return () => clearTimeout(timer);
  }, [pollWindow, window.start]);

  const query = useQuery(surface === "console"
    ? getGetAcademyConsoleSessionLiveStatusQueryOptions(academyId ?? 0, sessionId, {
      query: { enabled: Boolean(academyId) && pollWindow, refetchInterval: pollWindow ? POLL_MS : false },
    })
    : getGetAcademyFamilySessionLiveStatusQueryOptions(sessionId, {
      query: { enabled: pollWindow, refetchInterval: pollWindow ? POLL_MS : false },
    }));

  return { status: query.data, polling: pollWindow, liveWindow: window };
}
