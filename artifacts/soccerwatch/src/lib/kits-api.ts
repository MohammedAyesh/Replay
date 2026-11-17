import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { venueCall } from "@/lib/venue-api";

/** Portable cameras (Labs): client for routes/cameraKits.ts. */

export type KitSetupStatus = "setting_up" | "recording" | "measuring" | "measured" | "needs_look" | "approved" | "failed" | "cancelled";
export type KitSetupKind = "match" | "training" | "session";

export type Kit = {
  id: number;
  name: string;
  cameraId: string;
  academyId: number | null;
  wifiSsid: string | null;
  wifiPassword: string | null;
  localUrl: string | null;
  token?: string;
  role: "manage" | "use" | null;
  latest: { id: number; status: KitSetupStatus; placeName: string | null; pitchId: number | null; createdAt: string; startedAt: string | null; endsAt: string | null } | null;
};

export type Measured = { lengthM: number; widthM: number; setups: number; mastHeightM: number; at: string };

export type KitPlace = { id: number; name: string; nameAr: string | null; size: string; lengthM: number | null; widthM: number | null; measured: Measured | null };

export type KitCalibration = {
  lengthM?: number | null;
  widthM?: number | null;
  mastHeightM?: number | null;
  tiltDeg?: number | null;
  rollDeg?: number | null;
  linesPx?: number | null;
  circleAspectPct?: number | null;
  statureM?: number | null;
  warnings?: string[];
  overlayUrl?: string | null;
};

export type KitSetup = {
  id: number;
  kitId: number;
  kitName: string | null;
  cameraId: string | null;
  academyId: number | null;
  pitchId: number | null;
  pitchName: string | null;
  pitchNameAr: string | null;
  placeSize: string | null;
  knownLengthM: number | null;
  knownWidthM: number | null;
  mastHeightM: number;
  kind: KitSetupKind;
  title: string | null;
  status: KitSetupStatus;
  viewConfirmedAt: string | null;
  startedAt: string | null;
  endsAt: string | null;
  stoppedAt: string | null;
  startLocal: string | null;
  endLocal: string | null;
  footage: { id: number; status: string; progress: number; message: string | null; videoId: string | null } | null;
  calibration: KitCalibration | null;
  measuredLengthM: number | null;
  measuredWidthM: number | null;
  hasModel: boolean;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  wifiSsid: string | null;
  wifiPassword: string | null;
  localUrl: string | null;
};

export type KitStatus = { online: boolean; reason?: "unsupported" | "offline" | "unreachable"; ssid?: string | null; signal?: number | null; battery?: number | null };

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export function kitSnapshotUrl(setupId: number, bust: number): string {
  return `${apiBase}/kits/setups/${setupId}/snapshot?t=${bust}`;
}

export function useKitAccess(enabled = true) {
  return useQuery({
    queryKey: ["kits", "access"],
    queryFn: () => venueCall<{ enabled: boolean; isAdmin: boolean }>("/kits/access"),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useKits(enabled = true) {
  return useQuery({ queryKey: ["kits", "mine"], queryFn: () => venueCall<{ kits: Kit[] }>("/kits"), enabled });
}

export function useKitByToken(token: string | null) {
  return useQuery({
    queryKey: ["kits", "token", token],
    queryFn: () => venueCall<{ kit: Kit }>(`/kits/by-token/${encodeURIComponent(token ?? "")}`),
    enabled: Boolean(token),
    retry: false,
  });
}

export function useKitPlaces(kitId: number | null) {
  return useQuery({
    queryKey: ["kits", kitId, "places"],
    queryFn: () => venueCall<{ venueName: string | null; pitches: KitPlace[] }>(`/kits/${kitId}/places`),
    enabled: kitId != null,
  });
}

export function useKitStatus(kitId: number | null, poll = false) {
  return useQuery({
    queryKey: ["kits", kitId, "status"],
    queryFn: () => venueCall<KitStatus>(`/kits/${kitId}/status`),
    enabled: kitId != null,
    refetchInterval: poll ? 10_000 : false,
  });
}

export function useKitSetup(setupId: number | null, poll = false) {
  return useQuery({
    queryKey: ["kits", "setup", setupId],
    queryFn: () => venueCall<{ setup: KitSetup; role: "manage" | "use" }>(`/kits/setups/${setupId}`),
    enabled: setupId != null,
    refetchInterval: poll ? 15_000 : false,
  });
}

export type NewSetup = { pitchId?: number | null; placeName?: string | null; placeSize?: string | null; knownLengthM?: number | null; knownWidthM?: number | null; mastHeightM: number };

export function useCreateSetup(kitId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewSetup) => venueCall<{ setup: KitSetup }>(`/kits/${kitId}/setups`, { method: "POST", ...json(body) }),
    onSuccess: (r) => { qc.setQueryData(["kits", "setup", r.setup.id], { setup: r.setup, role: "use" }); void qc.invalidateQueries({ queryKey: ["kits", "mine"] }); },
  });
}

function useSetupMutation<T>(setupId: number | null, path: string, method = "POST") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: T) => venueCall<{ setup: KitSetup }>(`/kits/setups/${setupId}${path}`, { method, ...json(body) }),
    onSuccess: (r) => {
      qc.setQueryData(["kits", "setup", r.setup.id], (old: { setup: KitSetup; role: "manage" | "use" } | undefined) => ({ setup: r.setup, role: old?.role ?? "use" }));
      void qc.invalidateQueries({ queryKey: ["kits", "mine"] });
      void qc.invalidateQueries({ queryKey: ["kits", "manage"] });
    },
  });
}

export const usePatchSetup = (id: number | null) => useSetupMutation<{ mastHeightM?: number; viewConfirmed?: boolean; kind?: KitSetupKind; title?: string | null }>(id, "", "PATCH");
export const useStartSetup = (id: number | null) => useSetupMutation<{ minutes: number; kind: KitSetupKind; title?: string | null }>(id, "/start");
export const useStopSetup = (id: number | null) => useSetupMutation<Record<string, never>>(id, "/stop");
export const useCancelSetup = (id: number | null) => useSetupMutation<Record<string, never>>(id, "/cancel");
export const useReviewSetup = (id: number | null) => useSetupMutation<{ action: "approve" | "use_saved" | "remeasure" }>(id, "/review");

export function useManageKits(academyId: number | null, enabled = true) {
  return useQuery({
    queryKey: ["kits", "manage", academyId],
    queryFn: () => venueCall<{ kits: Kit[]; setups: KitSetup[]; canAdd: boolean }>(`/kits/manage${academyId ? `?academyId=${academyId}` : ""}`),
    enabled,
  });
}

export function useAddKit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { academyId: number | null; name: string; cameraId: string; wifiSsid?: string | null; wifiPassword?: string | null; localUrl?: string | null }) =>
      venueCall<{ kit: Kit }>("/kits/manage", { method: "POST", ...json(body) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["kits"] }),
  });
}

export function useUpdateKit(kitId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<{ name: string; wifiSsid: string | null; wifiPassword: string | null; localUrl: string | null; archived: boolean }>) =>
      venueCall<{ kit: Kit }>(`/kits/manage/${kitId}`, { method: "PATCH", ...json(body) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["kits"] }),
  });
}

export function useKitWifi(kitId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ssid: string; password: string }) => venueCall<{ kit: Kit }>(`/kits/manage/${kitId}/wifi`, { method: "POST", ...json(body) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["kits"] }),
  });
}

// ─── Watch on the pitch: the kit relay on the MiFi (ops/kit-relay) ───────────

export type LocalRecording = { start: string; end: string; main: { name: string; size: number } | null; sub: { name: string; size: number } | null };

/**
 * The relay answers over HTTPS on a name that points at the MiFi's own address, so the
 * browser treats it as a normal secure site; Chrome asks once to allow local network access.
 */
export async function localRecordings(localUrl: string, date: string): Promise<LocalRecording[]> {
  const init: RequestInit & { targetAddressSpace?: string } = { targetAddressSpace: "local", signal: AbortSignal.timeout(8000) };
  const response = await fetch(`${localUrl.replace(/\/$/, "")}/api/recordings?date=${encodeURIComponent(date)}`, init);
  if (!response.ok) throw new Error(`The camera answered ${response.status}`);
  const body = await response.json() as { recordings?: LocalRecording[] };
  return body.recordings ?? [];
}

export function localFileUrl(localUrl: string, name: string): string {
  return `${localUrl.replace(/\/$/, "")}/api/file?name=${encodeURIComponent(name)}`;
}
