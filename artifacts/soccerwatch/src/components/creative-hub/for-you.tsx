import type { SectionProps, TemplateSeed } from "./types";

/** Creative hub → section placeholder; replaced by the section's own build. */
export function CreativeForYou(_props: SectionProps & { seed?: TemplateSeed | null }) {
  return <div className="rounded-2xl border border-dashed border-line p-8 text-sm text-muted-text" data-testid="creative-for-you">…</div>;
}
