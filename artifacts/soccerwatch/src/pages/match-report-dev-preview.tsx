import { useEffect } from "react";
import { useSearch } from "wouter";
import { MatchReport } from "@/components/match/report/MatchReport";
import { useMatchCopy } from "@/i18n/match-strings";
import { useLocale } from "@/i18n";
import type { MatchReplay, MatchRoom } from "@/lib/match-api";

const startMs = Date.now() - 105 * 60_000;
const endMs = Date.now() - 15 * 60_000;
const fixture = (ready: boolean): MatchRoom => ({
  code: "W5DEMO", url: "/m/W5DEMO", serverNow: new Date().toISOString(),
  phase: ready ? "ready" : "processing", status: ready ? "ready" : "processing", progress: ready ? 100 : 42,
  startLocal: "", endLocal: "", startsAt: null, endsAt: null, varOpensAt: null, varClosesAt: null, voteClosesAt: null,
  startMs, endMs, field: { id: 5, name: "ملعب المدينة", location: "عمّان", imageUrl: null, cameraId: null }, title: "ماتش الأربعاء",
  playersPerSide: 6, substitutesPerTeam: null, teamCount: 2,
  teams: { A: { name: "الأخضر", color: "#2FD8C4", shirtsHaveNumbers: "yes" }, B: { name: "الأزرق", color: "#7B5CFF", shirtsHaveNumbers: "yes" } },
  score: null, standings: null, leader: null, captain: { userId: 12, name: "الكابتن", avatarUrl: null },
  isCaptain: true, isOwner: true, canManage: true, isMember: true, signedIn: false,
  players: [
    { id: 12, name: "سامر", initials: "س", avatarUrl: null, userId: 12, signedUp: true, rsvp: "in", team: "A", shirtNumber: 10, slotX: 32, slotY: 65, invitedBy: null, isMe: false },
    { id: 13, name: "ليث", initials: "ل", avatarUrl: null, userId: 13, signedUp: true, rsvp: "in", team: "B", shirtNumber: 7, slotX: 65, slotY: 38, invitedBy: null, isMe: false },
    { id: 14, name: "عمر", initials: "ع", avatarUrl: null, userId: null, signedUp: false, rsvp: "maybe", team: null, shirtNumber: null, slotX: null, slotY: null, invitedBy: null, isMe: false },
  ],
  counts: { in: 8, maybe: 1, invited: 0, out: 0, needed: 12 }, me: null, invitedBy: null, personalInvite: null, myInviteUrl: null, captainUrl: null,
  var: { active: false, requestId: null, state: null }, marks: [],
  footage: ready
    ? { ready: true, readyAt: new Date().toISOString(), shareUrl: null, shareToken: "preview-token", expiresAt: new Date(Date.now() + 86400000).toISOString() }
    : { ready: false, readyAt: null, shareUrl: null, shareToken: null, expiresAt: null },
  games: [], vote: { open: true, closed: false, closesAt: null, myVote: null, votesCast: 5, eligibleVoters: 8, tallies: [], winners: [] },
  stats: { unlocked: true, pending: null, enabled: true, paywall: false, teamPack: false, monthly: false, prices: { matchFils: 0, monthlyFils: 0, teamFils: 0 }, cliqAlias: "" },
  clips: { mine: 0, match: 0 }, prices: { bookingFils: 0 }, booking: null,
});

/** ?goals=1: three chances nobody has decided, so "Was it a goal?" and its reel show */
const chance = (key: number, atSeconds: number, source: "goal" | "shot" | "event"): MatchReplay["goals"][number] => ({
  atSeconds, side: key % 2 ? "A" : "B", scorer: null, recordingId: 1, gameIndex: null, t: atSeconds - 30,
  status: "open", source, key, ownGoal: false, confirmedBy: [], rejectedBy: [], myVote: null,
});
const goalsReplay: MatchReplay = {
  recordings: [1], findRecordingId: null, goals: [], shots: null, suggested: null, canVoteGoals: true,
  review: [chance(1, 612, "goal"), chance(2, 1480, "shot"), chance(3, 2290, "event")],
};

export default function MatchReportDevPreview() {
  const search = new URLSearchParams(useSearch());
  const { locale, setLocale } = useLocale();
  const copy = useMatchCopy();
  const ready = search.get("state") === "ready";
  useEffect(() => {
    const requested = search.get("lang");
    if ((requested === "ar" || requested === "en") && requested !== locale) setLocale(requested);
  }, [locale, search, setLocale]);
  return (
    <main dir={locale === "ar" ? "rtl" : "ltr"} className="min-h-0 flex-1 overflow-y-auto bg-void text-text">
      {!import.meta.env.DEV ? <p>Not found</p> : (
        <MatchReport
          room={fixture(ready)} copy={copy} now={Date.now()} colors={{ A: "#2FD8C4", B: "#7B5CFF", C: "#2FD8C4" }}
          names={{ A: copy.teamA, B: copy.teamB, C: copy.teamC }}
          replay={search.get("goals") === "1" ? goalsReplay : { recordings: [], findRecordingId: null, goals: [], shots: null, suggested: null }}
          onShare={() => {}} inviteText="Replay match: https://example.test/m/W5DEMO"
          slots={{ rsvp: null, booking: null, lockedStats: null, teams: null, invite: null, captainTools: null }}
        />
      )}
    </main>
  );
}
