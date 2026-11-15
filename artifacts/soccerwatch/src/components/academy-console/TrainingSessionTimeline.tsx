import React, { useMemo } from "react";
import type { MatchesStrings } from "@/i18n/matches-strings";
import type { TrainingGame, TrainingGroup, TrainingSegment } from "@/lib/academy-training";

type Props = {
  segments: TrainingSegment[];
  games: TrainingGame[];
  groups: TrainingGroup[];
  recordingDate?: string | null;
  recordingTimeSlot?: string | null;
  duration?: number | null;
  range?: { from: number; to: number } | null;
  copy: MatchesStrings & { locale: "ar" | "en" };
  onSeek: (seconds: number) => void;
};

function recordingClock(date: string | null | undefined, timeSlot: string | null | undefined, seconds: number, locale: "ar" | "en") {
  const time = timeSlot?.match(/(?:^|\D)(\d{1,2}):(\d{2})(?:\D|$)/);
  if (!date || !time) {
    const safe = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(safe / 3600);
    return `${String(hours).padStart(2, "0")}:${String(Math.floor((safe % 3600) / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
  }
  const start = Number(time[1]) * 3600 + Number(time[2]) * 60;
  const total = start + Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600) % 24;
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const digits = (value: number) => new Intl.NumberFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { minimumIntegerDigits: 2, useGrouping: false }).format(value);
  return `${digits(hours)}:${digits(minutes)}:${digits(secs)}`;
}

function gameTeams(game: TrainingGame | undefined, groups: Map<string, TrainingGroup>) {
  if (!game) return "";
  return game.teams.map((team, index) => game.teamNames[index] || groups.get(team)?.name || team).join(" vs ");
}

function associatedGame(segment: TrainingSegment, games: TrainingGame[], fallbackIndex: number) {
  if (!games.length) return undefined;
  const overlaps = games.map((game) => ({
    game,
    overlap: Math.max(0, Math.min(game.end, segment.end) - Math.max(game.start, segment.start)),
  })).sort((a, b) => b.overlap - a.overlap);
  return overlaps[0]?.overlap ? overlaps[0].game : games[Math.min(fallbackIndex, games.length - 1)];
}

export function TrainingSessionTimeline({
  segments,
  games,
  groups,
  recordingDate,
  recordingTimeSlot,
  duration,
  range,
  copy,
  onSeek,
}: Props) {
  const groupMap = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const gameSegments = useMemo(() => segments.filter((segment) => segment.label === "game"), [segments]);
  const gameOrder = new Map(gameSegments.map((segment, index) => [segment, index]));
  const from = Math.max(0, range?.from ?? 0);
  const maxEnd = Math.max(0, duration ?? 0, ...segments.map((segment) => segment.end));
  const to = Math.max(from + 0.1, range?.to ?? maxEnd, from + 0.1);
  const visible = segments
    .filter((segment) => segment.end > from && segment.start < to)
    .map((segment) => ({ source: segment, start: Math.max(from, segment.start), end: Math.min(to, segment.end) }));
  if (!visible.length) return null;

  const colorFor = (label: TrainingSegment["label"]) => {
    if (label === "adult game" || label === "adults") return "#737780";
    switch (label) {
      case "game": return "#36B89A";
      case "multi-ball drill": return "#3E8BC9";
      case "shooting / queue drill": return "#D4883A";
      case "warm-up": return "#8B78D9";
      case "team talk": return "#607080";
      case "break": return "#65666E";
      case "empty": return "#343943";
      case "drill": return "#CA5B7B";
    }
  };

  return (
    <section className="rounded-xl border border-line bg-raised/50 p-4" data-testid="training-segments-timeline" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
      <h3 className="mb-3 font-display text-base font-bold text-text">{copy.sessionTimeline.title}</h3>
      <div className="relative h-9 overflow-hidden rounded-lg bg-void" dir="ltr" aria-label={copy.sessionTimeline.title}>
        {visible.map(({ source: original, ...segment }, index) => {
          const full = original;
          const segmentIndex = gameOrder.get(full) ?? index;
          const game = full.label === "game" ? associatedGame(full, games, segmentIndex) : undefined;
          const title = full.label === "adult game" || full.label === "adults"
            ? copy.sessionTimeline.labels.adults
            : full.label === "game"
              ? copy.sessionTimeline.gameTitle(Math.max(1, games.indexOf(game!) + 1), gameTeams(game, groupMap))
              : copy.sessionTimeline.labels[full.label];
          const left = ((segment.start - from) / (to - from)) * 100;
          const width = ((segment.end - segment.start) / (to - from)) * 100;
          return (
            <button
              key={`${segment.start}-${segment.end}-${index}`}
              type="button"
              onClick={() => onSeek(segment.start)}
              title={`${recordingClock(recordingDate, recordingTimeSlot, segment.start, copy.locale)} · ${title}`}
              aria-label={`${recordingClock(recordingDate, recordingTimeSlot, segment.start, copy.locale)} · ${title}`}
              data-testid={`training-segment-${index}`}
              className="absolute inset-y-0 overflow-hidden border-e border-void/60 text-[10px] font-bold text-white hover:brightness-110 focus:z-10 focus:outline focus:outline-2 focus:outline-offset-[-2px] focus:outline-white"
              style={{ left: `${left}%`, width: `${Math.max(0.5, width)}%`, background: colorFor(full.label) }}
            >
              {width >= 12 && <span className="block truncate px-1" dir="ltr">{recordingClock(recordingDate, recordingTimeSlot, segment.start, copy.locale)}</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {visible.map(({ source: original, ...segment }, index) => {
          const full = original;
          const segmentIndex = gameOrder.get(full) ?? index;
          const game = full.label === "game" ? associatedGame(full, games, segmentIndex) : undefined;
          const label = full.label === "adult game" || full.label === "adults"
            ? copy.sessionTimeline.labels.adults
            : full.label === "game"
              ? copy.sessionTimeline.gameTitle(Math.max(1, games.indexOf(game!) + 1), gameTeams(game, groupMap))
              : copy.sessionTimeline.labels[full.label];
          return (
            <button key={`label-${segment.start}-${segment.end}-${index}`} type="button" onClick={() => onSeek(segment.start)}
              className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-[11px] font-semibold text-text hover:bg-void"
              data-testid={`training-segment-time-${index}`}>
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: colorFor(full.label) }} />
              <span dir="ltr" className="font-mono tabular-nums">{recordingClock(recordingDate, recordingTimeSlot, segment.start, copy.locale)}</span>
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
