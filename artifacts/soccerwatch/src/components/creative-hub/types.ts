import type { Framing, SceneBranding } from "@workspace/api-zod";

/**
 * The contract between the Creative hub shell (hub.tsx) and its five sections.
 * Each section owns its own file and its own strings; it moves between tabs only
 * through these callbacks.
 */
export type HubNav = {
  /** Open a project in the Editor tab. */
  openInEditor: (projectId: number) => void;
  /** Open a project in the Publish tab. */
  openInPublish: (projectId: number) => void;
  /** Go to the Templates tab (optionally to start a project from a library item). */
  openTemplates: (seed?: TemplateSeed) => void;
};

/** Something picked in the Library that a new project should start from. */
export type TemplateSeed =
  | ({ type: "clip"; clipId: number } & SeedCamera)
  | ({ type: "recording"; recordingId: number; fromMs: number; toMs: number } & SeedCamera)
  | { type: "upload"; mediaId: number }
  | { type: "frame"; recordingId: number; atMs: number }
  | { type: "session"; sessionId: number };

/** Footage picked through the clip framer brings its camera and branding along. */
export type SeedCamera = { framing?: Framing | null; branding?: SceneBranding };

export type SectionProps = { academyId: number; nav: HubNav };
