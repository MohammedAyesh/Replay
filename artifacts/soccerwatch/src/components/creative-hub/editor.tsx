import type { SectionProps } from "./types";

/** Creative hub → section placeholder; replaced by the section's own build. */
export function CreativeEditor(_props: SectionProps & { projectId: number | null }) {
  return <div className="rounded-2xl border border-dashed border-line p-8 text-sm text-muted-text" data-testid="creative-editor">…</div>;
}
