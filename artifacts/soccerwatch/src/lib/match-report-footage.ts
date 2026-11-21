import type { MatchRoom } from "./match-api";

export type MatchReportFootageNotice = "expired" | "unavailable" | null;

export function matchReportFootageNotice(
  room: Pick<MatchRoom, "phase" | "status">,
): MatchReportFootageNotice {
  if (room.status === "refunded" || room.phase === "cancelled") return "unavailable";
  if (room.phase === "expired") return "expired";
  return null;
}

export function canWatchFullMatch(
  room: Pick<MatchRoom, "phase" | "status" | "footage">,
): boolean {
  return room.status !== "refunded"
    && room.phase !== "expired"
    && room.phase !== "cancelled"
    && room.footage.ready
    && Boolean(room.footage.shareToken);
}
