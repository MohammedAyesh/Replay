import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { venueCall } from "./venue-api";

/** Instagram autopilot client: routes/venueInstagram.ts. */

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const ig = (venueId: number) => `/academy/console/academies/${venueId}/venue/instagram`;

export type ConsentMode = "ask" | "owner" | "off";
export type IgSlots = {
  storyEveryHours: number; storiesPerSlot: number; reelTimes: string[]; quietFrom: string; quietTo: string;
  nomineesDay: number; nomineesTime: string; votingEndDay: number; votingEndTime: string;
  winnerDay: number; winnerTime: string; winnerGapMinutes: number; minVotes: number;
  weekly: Record<IgWeeklyKind, { day: number; time: string }>;
  openSlotsTime: string; boardTime: string; dayBestTime: string; highlightsPerDay: number; off: IgOptionalKind[];
};
export const IG_WEEKLY_KINDS = ["thanks", "top5", "player_week", "match_week", "versus"] as const;
export type IgWeeklyKind = (typeof IG_WEEKLY_KINDS)[number];
export const IG_OPTIONAL_KINDS = [...IG_WEEKLY_KINDS, "match_highlights", "day_best", "open_slots", "leaderboard", "milestone"] as const;
export type IgOptionalKind = (typeof IG_OPTIONAL_KINDS)[number];
export type ConsentEvent = { id: number; oldMode: ConsentMode | null; newMode: ConsentMode; wording: string | null; by: string | null; at: string };
export type IgItem = {
  id: number;
  kind: "booking_clip" | "award_nominees" | "award_winner" | IgOptionalKind;
  placement: "story" | "reel" | "carousel";
  source: string;
  status: "planned" | "approved" | "rendering" | "ready" | "publishing" | "published" | "skipped" | "failed" | "removed" | "removal_flagged";
  pinned: boolean;
  score: number;
  slotAt: string | null;
  slotLocal: string | null;
  bookingId: number | null;
  reference: string | null;
  bookingStartLocal: string | null;
  awardId: number | null;
  category: string | null;
  error: string | null;
  render: { status: string; error: string | null; kind: string; outputUrl: string | null } | null;
  projectId: number | null;
  igPermalink: string | null;
  publishedAt: string | null;
  consentMode: string | null;
  consentRef: unknown;
  insights: Record<string, number | null> | null;
  thumbnailUrl: string | null;
  /** "Which is nicer?": A and B votes from its comments. */
  votes: { a: number; b: number } | null;
  /** The clips the owner picked, in play order (empty: the autopilot picks). */
  picks?: Array<{ key: string; source: string; label: string; labelAr: string }>;
};
export type IgCandidate = { key: string; source: string; label: string; labelAr: string; bookingId: number; thumbnailUrl: string | null };
export type IgCandidates = { min: number; max: number; picked: string[]; candidates: IgCandidate[]; empty?: "no_games" | "not_allowed" | null };
/** Posts whose clips the owner can pick, and how many (lib/venues/igFieldPosts.ts PICKABLE). */
export const IG_PICKABLE: Record<string, { min: number; max: number }> = {
  booking_clip: { min: 1, max: 1 }, versus: { min: 2, max: 2 }, top5: { min: 5, max: 5 }, match_highlights: { min: 2, max: 5 }, day_best: { min: 2, max: 5 },
};
export type IgNominee = { key: string; label: string; labelAr: string; source: string; value: number | null; bookingId: number; votes: number | null; thumbnailUrl: string | null };
export type IgAward = {
  id: number; weekStart: string; category: string; status: string; votingEndsAt: string | null; winnerKey: string | null;
  decidedBy: string | null; totalVotes: number | null; nominees: IgNominee[]; myVote?: string | null;
};
export type IgLimit = { used: number; total: number; left: number; paused: boolean };
export type InstagramData = {
  settings: {
    consentMode: ConsentMode; consentSince: string | null; consentWording: string | null; consentHistory: ConsentEvent[];
    autopilot: boolean; publishMode: "approve" | "auto"; slots: IgSlots; defaults: IgSlots;
  };
  account: { ok: true; username: string | null; limit: IgLimit; limitFromMeta: boolean; limitError: string | null } | { ok: false; code: string; error: string; limit: IgLimit };
  items: IgItem[];
  slots: Array<{ at: string; kind: "story" | "reel"; capacity: number }>;
  notPosted: Array<{ bookingId: number; reference: string; startLocal: string; reason: string; reasonAr: string }>;
  awards: IgAward[];
  nominations: Array<{ id: number; source: "player" | "shot"; recordingId: number; bookingId: number | null; atSeconds: number; reference: string | null; startLocal: string | null; createdAt: string; thumbnailUrl: string | null }>;
  flaggedRemovals: Array<{ id: number; itemId: number | null; bookingId: number | null; error: string | null; at: string }>;
  /** What the autopilot posts next that isn't on the calendar yet: there is always something. */
  suggestions: IgSuggestion[];
  days: number;
};
export type IgSuggestKind = IgWeeklyKind | "open_slots" | "leaderboard";
/** `at` is Amman local "YYYY-MM-DD HH:MM". */
export type IgSuggestion = { kind: IgSuggestKind; placement: "story" | "reel"; at: string; originKey: string };
export type IgToday = { autopilot: boolean; consentMode: ConsentMode; publishMode: "approve" | "auto"; items: IgItem[]; suggestions: IgSuggestion[] };
export type IgReport = {
  month: string;
  posts: { total: number; byType: Record<"story" | "reel" | "nominees" | "award" | "field", { posts: number; reach: number | null; views: number | null }> };
  insightsAvailable: boolean;
  bookings: { website: number; whatsapp: number; console: number };
  removals: { total: number; deleted: number; flagged: number; withdrawn: number };
};

export function useInstagram(venueId: number, days: number) {
  return useQuery({ queryKey: ["venue", venueId, "instagram", days], queryFn: () => venueCall<InstagramData>(`${ig(venueId)}?days=${days}`), refetchInterval: 30_000 });
}

function useRefresh(venueId: number) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["venue", venueId, "instagram"] });
}

export function useInstagramSettings(venueId: number) {
  const refresh = useRefresh(venueId);
  return useMutation({
    mutationFn: (body: { autopilot?: boolean; publishMode?: "approve" | "auto"; slots?: Partial<IgSlots> }) => venueCall(`${ig(venueId)}/settings`, { method: "PUT", ...json(body) }),
    onSuccess: refresh,
  });
}

export type IgAction = "approve" | "unapprove" | "skip" | "restore" | "preview" | "now";

export function useInstagramItem(venueId: number) {
  const refresh = useRefresh(venueId);
  return {
    action: useMutation({ mutationFn: ({ id, action }: { id: number; action: IgAction }) => venueCall<{ item: IgItem }>(`${ig(venueId)}/items/${id}/action`, { method: "POST", ...json({ action }) }), onSuccess: refresh }),
    move: useMutation({ mutationFn: ({ id, slotLocal, placement }: { id: number; slotLocal: string; placement?: "story" | "reel" }) => venueCall(`${ig(venueId)}/items/${id}/slot`, { method: "PUT", ...json({ slotLocal, placement }) }), onSuccess: refresh }),
    swap: useMutation({ mutationFn: ({ a, b }: { a: number; b: number }) => venueCall(`${ig(venueId)}/items/swap`, { method: "POST", ...json({ a, b }) }), onSuccess: refresh }),
    winner: useMutation({ mutationFn: ({ awardId, key }: { awardId: number; key: string }) => venueCall(`${ig(venueId)}/awards/${awardId}/winner`, { method: "POST", ...json({ key }) }), onSuccess: refresh }),
    nomination: useMutation({ mutationFn: ({ id, status }: { id: number; status: "approved" | "rejected" }) => venueCall(`${ig(venueId)}/nominations/${id}`, { method: "POST", ...json({ status }) }), onSuccess: refresh }),
    resolved: useMutation({ mutationFn: (id: number) => venueCall(`${ig(venueId)}/removals/${id}/resolved`, { method: "POST" }), onSuccess: refresh }),
  };
}

/** The moments an item's clips can be picked from (loaded when the picker opens). */
export function useItemCandidates(venueId: number, itemId: number | null) {
  return useQuery({
    queryKey: ["venue", venueId, "instagram", "candidates", itemId],
    queryFn: () => venueCall<IgCandidates>(`${ig(venueId)}/items/${itemId}/candidates`),
    enabled: itemId !== null,
    staleTime: 5 * 60_000,
  });
}

/** Save the picked clips: the post is edited again from them and rendered now. */
export function useSavePicks(venueId: number) {
  const refresh = useRefresh(venueId);
  return useMutation({ mutationFn: ({ id, keys }: { id: number; keys: string[] }) => venueCall<{ item: IgItem }>(`${ig(venueId)}/items/${id}/picks`, { method: "PUT", ...json({ keys }) }), onSuccess: refresh });
}

export function useInstagramToday(venueId: number, enabled = true) {
  return useQuery({ queryKey: ["venue", venueId, "instagram", "today"], queryFn: () => venueCall<IgToday>(`${ig(venueId)}/today`), enabled, refetchInterval: 60_000 });
}

/** Put a suggestion on the calendar now, at its own time. */
export function useAddSuggestion(venueId: number) {
  const refresh = useRefresh(venueId);
  return useMutation({ mutationFn: (s: Pick<IgSuggestion, "kind" | "at">) => venueCall<{ ok: true; originKey: string }>(`${ig(venueId)}/suggestions`, { method: "POST", ...json(s) }), onSuccess: refresh });
}

export function useInstagramReport(venueId: number, month: string) {
  return useQuery({ queryKey: ["venue", venueId, "instagram", "report", month], queryFn: () => venueCall<IgReport>(`${ig(venueId)}/report?month=${month}`) });
}

// ─── Admin ───────────────────────────────────────────────────────────────────

export type AdminConsent = { mode: ConsentMode; since: string | null; wording: string | null; history: ConsentEvent[] };

export function useAdminConsent(venueId: number) {
  return useQuery({ queryKey: ["admin-venues", venueId, "instagram-consent"], queryFn: () => venueCall<AdminConsent>(`/admin/venues/${venueId}/instagram-consent`) });
}

export function useSaveAdminConsent(venueId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { mode: ConsentMode; wording?: string | null }) => venueCall<AdminConsent>(`/admin/venues/${venueId}/instagram-consent`, { method: "PUT", ...json(body) }),
    onSuccess: (data) => qc.setQueryData(["admin-venues", venueId, "instagram-consent"], data),
  });
}

// ─── Match page ──────────────────────────────────────────────────────────────

export type MatchInstagram = {
  enabled: boolean;
  field?: { name: string; nameAr: string | null } | null;
  mode?: ConsentMode;
  posts?: Array<{ id: number; placement: "story" | "reel"; status: string; permalink: string | null; publishedAt: string | null }>;
  removed?: boolean;
  optedOut?: boolean;
  canRemove?: boolean;
  saveCandidates?: Array<{ recordingId: number; atSeconds: number; thumbnailUrl: string | null; nominated: boolean }>;
  awardsUrl?: string | null;
};

export function useMatchInstagram(code: string) {
  return useQuery({ queryKey: ["match-instagram", code], queryFn: () => venueCall<MatchInstagram>(`/m/${encodeURIComponent(code)}/instagram`), enabled: Boolean(code), staleTime: 30_000 });
}

export function useMatchInstagramActions(code: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["match-instagram", code] });
  return {
    remove: useMutation({ mutationFn: () => venueCall<{ outcomes: Array<{ outcome: "deleted" | "flagged" | "withdrawn"; error: string | null }> }>(`/m/${encodeURIComponent(code)}/instagram/remove`, { method: "POST" }), onSuccess: refresh }),
    nominate: useMutation({ mutationFn: (body: { recordingId: number; atSeconds: number }) => venueCall(`/m/${encodeURIComponent(code)}/instagram/nominate-save`, { method: "POST", ...json(body) }), onSuccess: refresh }),
  };
}

// ─── Awards vote ─────────────────────────────────────────────────────────────

export type AwardsPage = { field: { name: string; nameAr: string | null; logoUrl: string | null; slug: string }; signedIn: boolean; awards: IgAward[] };

export function useAwardsPage(slug: string) {
  return useQuery({ queryKey: ["venue-awards", slug], queryFn: () => venueCall<AwardsPage>(`/venue-awards/${encodeURIComponent(slug)}`), enabled: Boolean(slug) });
}

export function useAwardVote(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ awardId, key }: { awardId: number; key: string }) => venueCall(`/venue-awards/${encodeURIComponent(slug)}/${awardId}/vote`, { method: "POST", ...json({ key }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["venue-awards", slug] }),
  });
}
