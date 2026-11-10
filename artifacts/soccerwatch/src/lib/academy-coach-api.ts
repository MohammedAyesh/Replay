import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CoachNote, CoachNoteInput, CoachTracks } from "@workspace/api-zod";

/** Coach board: hand-written client for routes/academyCoach.ts. */

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${apiBase}${path}`, { credentials: "include", ...init, headers });
  if (response.status === 204) return undefined as T;
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const error = new Error(typeof (data as { error?: unknown })?.error === "string" ? (data as { error: string }).error : `Request failed (${response.status})`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return data as T;
}

export type CoachVideo = {
  recordingId: number;
  videoUrl: string;
  videoStartSeconds: number;
  width: number;
  height: number;
  fps: number;
  duration: number | null;
  matchWindow: { from: number; to: number } | null;
};

export type CoachPlayer = {
  rosterId: string;
  number: string | null;
  minutes: number;
  playerId: number | null;
  name: string | null;
  shirtNumber: number | null;
};

export type CoachSession = {
  id: number;
  type: "match" | "training";
  squadName: string | null;
  startsAt: string;
  opponent: string | null;
  ownScore?: number | null;
  opponentScore?: number | null;
  location?: string | null;
};

export type CoachMatch = {
  session: CoachSession;
  role: "owner" | "staff";
  video: CoachVideo | null;
  analysed: boolean;
  players: CoachPlayer[];
  lineup: Array<{ playerId: number; name: string; shirtNumber: number | null }>;
  notes: CoachNote[];
};

const coachPath = (academyId: number, sessionId: number, rest = "") =>
  `/academy/console/academies/${academyId}/matches/${sessionId}/coach${rest}`;
export const coachKeys = {
  match: (academyId: number, sessionId: number) => ["academy-coach", academyId, sessionId] as const,
  familyNotes: () => ["academy-family-coach-notes"] as const,
  familyNote: (noteId: number) => ["academy-family-coach-note", noteId] as const,
};

export function useCoachMatch(academyId: number, sessionId: number | null) {
  return useQuery({
    queryKey: coachKeys.match(academyId, sessionId ?? 0),
    enabled: sessionId !== null,
    staleTime: 30_000,
    queryFn: () => call<CoachMatch>(coachPath(academyId, sessionId!)),
  });
}

export const coachTracksLoader = (academyId: number, sessionId: number) =>
  (from: number, to: number) => call<CoachTracks>(coachPath(academyId, sessionId, `/tracks?from=${from.toFixed(1)}&to=${to.toFixed(1)}`));

export function useSaveCoachNote(academyId: number, sessionId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: number; input: Partial<CoachNoteInput> }) => id
      ? call<{ note: CoachNote }>(coachPath(academyId, sessionId, `/notes/${id}`), { method: "PATCH", body: JSON.stringify(input) }).then((r) => r.note)
      : call<{ note: CoachNote }>(coachPath(academyId, sessionId, "/notes"), { method: "POST", body: JSON.stringify(input) }).then((r) => r.note),
    onSuccess: (note) => {
      qc.setQueryData<CoachMatch>(coachKeys.match(academyId, sessionId), (old) => old && ({
        ...old,
        notes: [...old.notes.filter((n) => n.id !== note.id), note].sort((a, b) => a.atMs - b.atMs || a.id - b.id),
      }));
    },
  });
}

export function useDeleteCoachNote(academyId: number, sessionId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => call<void>(coachPath(academyId, sessionId, `/notes/${id}`), { method: "DELETE" }).then(() => id),
    onSuccess: (id) => {
      qc.setQueryData<CoachMatch>(coachKeys.match(academyId, sessionId), (old) => old && ({ ...old, notes: old.notes.filter((n) => n.id !== id) }));
    },
  });
}

// ─── Families ────────────────────────────────────────────────────────────────

export type FamilyCoachNote = CoachNote & {
  sessionId: number;
  academyName: string;
  session: { startsAt: string; opponent: string | null; type: "match" | "training"; squadName: string | null };
  players: Array<{ playerId: number; name: string }>;
};

export function useFamilyCoachNotes(enabled = true) {
  return useQuery({
    queryKey: coachKeys.familyNotes(),
    enabled,
    staleTime: 60_000,
    queryFn: () => call<{ notes: FamilyCoachNote[] }>("/academy/family/coach-notes").then((r) => r.notes),
  });
}

export type FamilyCoachNoteDetail = {
  note: CoachNote;
  session: CoachSession;
  video: CoachVideo | null;
  players: CoachPlayer[];
};

export function useFamilyCoachNote(noteId: number | null) {
  return useQuery({
    queryKey: coachKeys.familyNote(noteId ?? 0),
    enabled: noteId !== null,
    staleTime: 60_000,
    queryFn: () => call<FamilyCoachNoteDetail>(`/academy/family/coach-notes/${noteId}`),
  });
}

export const familyTracksLoader = (noteId: number) =>
  (from: number, to: number) => call<CoachTracks>(`/academy/family/coach-notes/${noteId}/tracks?from=${from.toFixed(1)}&to=${to.toFixed(1)}`);
