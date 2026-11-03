import { hasMusic, isPhotoVideo, isVideoScene } from "@workspace/api-zod";
import type { CreativeProject } from "@/lib/creative-hub-api";
import type { Placement } from "@/lib/creative-hub-publish-api";

/**
 * Creative hub → Publish: how a design goes out, as pure rules (the API's
 * lib/creative/publish.ts allowedPlacements says the same).
 *
 * A design with a duration is a video: that includes a still the manager put
 * music on (a "photo video"), because Instagram and Facebook take music only
 * inside a video. A still without music stays a photo.
 */

type Shape = Pick<CreativeProject, "kind" | "format"> & { scene?: CreativeProject["scene"] };

/** Is the design a video? The scene says (the API keeps `kind` in step on every save); `kind` when there is no scene. */
export const publishesAsVideo = (p: Shape) => (p.scene ? isVideoScene(p.scene) : p.kind === "video");

/** Placements a design can take, default first: a 9:16 still is a story; a 4:5 or square video a Reel; a 9:16 video a story or a Reel. */
export function placementsFor(p: Shape): Placement[] {
  const video = publishesAsVideo(p);
  if (p.format === "story") return video ? ["story", "reel"] : ["story"];
  return video ? ["reel"] : ["feed"];
}

/** A photo that goes out as a short video because it has music. */
export const isPhotoWithMusic = (p: Pick<CreativeProject, "scene">) => isPhotoVideo(p.scene) && hasMusic(p.scene.music);

/**
 * Is what Publish shows and hands out an MP4? A finished render says by its
 * type; before that (or after an edit made it stale) the design does.
 */
export function isVideoProject(p: Pick<CreativeProject, "kind" | "outputMime"> & Partial<Pick<CreativeProject, "renderStatus" | "scene">>): boolean {
  if (p.outputMime && (p.renderStatus === undefined || p.renderStatus === "done")) return p.outputMime.startsWith("video/");
  return p.scene ? isVideoScene(p.scene) : p.kind === "video";
}
