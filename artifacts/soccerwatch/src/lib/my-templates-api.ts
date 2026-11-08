import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreativeData, CreativeFormat, CreativeStyle, Scene } from "@workspace/api-zod";
import { call } from "@/lib/academy-studio-api";
import { creativeKeys, creativePath } from "@/lib/creative-hub-api";

/** Creative hub → My templates: routes/academyCreativeTemplates.ts (owner only). */

export type MyTemplate = {
  id: number;
  baseKey: string;
  style: CreativeStyle | null;
  format: CreativeFormat;
  kind: "image" | "video";
  title: string;
  scene: Scene;
  sampleData: CreativeData | null;
  /** Stands in for its catalogue template everywhere, the autopilots included. */
  replacesBase: boolean;
  createdAt: string;
  updatedAt: string;
};

const key = (academyId: number) => [...creativeKeys.all(academyId), "my-templates"] as const;

export function useMyTemplates(academyId: number) {
  return useQuery({
    queryKey: key(academyId),
    queryFn: () => call<{ templates: MyTemplate[] }>(creativePath(academyId, "/my-templates")).then((r) => r.templates),
    staleTime: 30_000,
  });
}

export function useMyTemplateActions(academyId: number) {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: key(academyId) });
  return {
    save: useMutation({
      mutationFn: (body: { projectId: number; title: string; replacesBase?: boolean }) =>
        call<{ template: MyTemplate }>(creativePath(academyId, "/my-templates"), { method: "POST", body: JSON.stringify(body) }).then((r) => r.template),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: number; title?: string; replacesBase?: boolean; projectId?: number }) =>
        call<{ template: MyTemplate }>(creativePath(academyId, `/my-templates/${id}`), { method: "PATCH", body: JSON.stringify(body) }).then((r) => r.template),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: number) => call<void>(creativePath(academyId, `/my-templates/${id}`), { method: "DELETE" }),
      onSuccess: done,
    }),
  };
}

/**
 * Template library: templates Replay uploaded for every field or academy (Admin → Template library).
 * Read-only here; opened like My templates. routes/creativeTemplateLibrary.ts.
 */
export type LibraryTemplate = {
  id: number;
  key: string;
  title: { en: string; ar: string };
  description: string | null;
  baseKey: string | null;
  replacesBase: boolean;
  clips: number | null;
  format: CreativeFormat;
  kind: "image" | "video";
  scene: Scene;
  sampleData: { custom?: Record<string, string> } | null;
};

export function useLibraryTemplates(academyId: number) {
  return useQuery({
    queryKey: [...creativeKeys.all(academyId), "library-templates"] as const,
    queryFn: () => call<{ templates: LibraryTemplate[] }>(creativePath(academyId, "/library-templates")).then((r) => r.templates),
    staleTime: 60_000,
  });
}
