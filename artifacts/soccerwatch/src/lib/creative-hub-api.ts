import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreativeStatus, CreativeStyle, Scene } from "@workspace/api-zod";
import { call } from "@/lib/academy-studio-api";

/**
 * Academy console → Creative hub. Hand-written client for
 * routes/academyCreative*.ts (owner only). Each section adds its own calls in
 * its own file next to this one (creative-hub-<section>-api.ts) so parallel
 * work does not collide here.
 */

export const creativePath = (academyId: number, rest = "") => `/academy/console/academies/${academyId}/creative${rest}`;

export type CreativeProject = {
  id: number;
  kind: "image" | "video";
  format: Scene["format"];
  title: string;
  templateKey: string | null;
  style: CreativeStyle | null;
  status: CreativeStatus;
  origin: "auto" | "manual";
  sourceSessionId: number | null;
  scene: Scene;
  data: Record<string, unknown> | null;
  renderStatus: "none" | "queued" | "rendering" | "done" | "failed";
  renderError: string | null;
  outputUrl: string | null;
  outputMime: string | null;
  renderedAt: string | null;
  publishTargets: Array<{ channel: string; ref?: string; at?: string }>;
  scheduledAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const creativeKeys = {
  all: (academyId: number) => ["creative", academyId] as const,
  projects: (academyId: number, filter = "") => ["creative", academyId, "projects", filter] as const,
  project: (academyId: number, id: number) => ["creative", academyId, "project", id] as const,
};

export function useCreativeProjects(academyId: number, filter: { status?: CreativeStatus[]; origin?: "auto" | "manual" } = {}) {
  const qs = new URLSearchParams();
  if (filter.status?.length) qs.set("status", filter.status.join(","));
  if (filter.origin) qs.set("origin", filter.origin);
  const q = qs.toString();
  return useQuery({
    queryKey: creativeKeys.projects(academyId, q),
    queryFn: () => call<{ projects: CreativeProject[] }>(creativePath(academyId, `/projects${q ? `?${q}` : ""}`)).then((r) => r.projects),
  });
}

export function useCreativeProject(academyId: number, id: number | null) {
  return useQuery({
    queryKey: creativeKeys.project(academyId, id ?? 0),
    enabled: id !== null,
    queryFn: () => call<{ project: CreativeProject }>(creativePath(academyId, `/projects/${id}`)).then((r) => r.project),
  });
}

export type NewCreativeProject = {
  title?: string;
  templateKey?: string | null;
  style?: CreativeStyle | null;
  scene: Scene;
  data?: Record<string, unknown> | null;
  sourceSessionId?: number | null;
};

export function useCreateCreativeProject(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewCreativeProject) =>
      call<{ project: CreativeProject }>(creativePath(academyId, "/projects"), { method: "POST", body: JSON.stringify(body) }).then((r) => r.project),
    onSuccess: () => qc.invalidateQueries({ queryKey: creativeKeys.all(academyId) }),
  });
}

export type CreativeProjectChange = Partial<Pick<CreativeProject, "title" | "templateKey" | "style" | "scene" | "data" | "status">>;

export function useUpdateCreativeProject(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...change }: CreativeProjectChange & { id: number }) =>
      call<{ project: CreativeProject }>(creativePath(academyId, `/projects/${id}`), { method: "PATCH", body: JSON.stringify(change) }).then((r) => r.project),
    onSuccess: (project) => {
      qc.setQueryData(creativeKeys.project(academyId, project.id), project);
      void qc.invalidateQueries({ queryKey: ["creative", academyId, "projects"] });
    },
  });
}

export function useDuplicateCreativeProject(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => call<{ project: CreativeProject }>(creativePath(academyId, `/projects/${id}/duplicate`), { method: "POST" }).then((r) => r.project),
    onSuccess: () => qc.invalidateQueries({ queryKey: creativeKeys.all(academyId) }),
  });
}

export function useDeleteCreativeProject(academyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => call<null>(creativePath(academyId, `/projects/${id}`), { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: creativeKeys.all(academyId) }),
  });
}
