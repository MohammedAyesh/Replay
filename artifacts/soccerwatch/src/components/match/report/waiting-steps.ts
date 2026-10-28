import type { MatchRoom } from "@/lib/match-api";

export type WaitingStepKey = "whistle" | "processing" | "footage" | "find" | "stats";
export type WaitingStep = {
  key: WaitingStepKey;
  state: "done" | "current" | "upcoming";
  matchMinutes?: number;
  endedAt?: number;
  minutesAgo?: number;
  clockTime?: boolean;
  progressPercent?: number;
};

export function waitingSteps(room: Pick<MatchRoom, "startMs" | "endMs" | "progress" | "stats">, now: number): WaitingStep[] {
  const minutesSinceEnd = Math.max(0, Math.floor((now - room.endMs) / 60_000));
  const steps: WaitingStep[] = [
    {
      key: "whistle",
      state: "done",
      matchMinutes: Math.max(1, Math.round((room.endMs - room.startMs) / 60_000)),
      endedAt: room.endMs,
      minutesAgo: minutesSinceEnd < 60 ? minutesSinceEnd : undefined,
      clockTime: minutesSinceEnd >= 60,
    },
    {
      key: "processing",
      state: "current",
      progressPercent: room.progress > 0 && room.progress < 100 ? Math.round(room.progress) : undefined,
    },
    { key: "footage", state: "upcoming" },
  ];
  if (room.stats.enabled) steps.push({ key: "find", state: "upcoming" }, { key: "stats", state: "upcoming" });
  return steps;
}
