import type { TrackingManifest } from "@workspace/api-client-react";

/**
 * The people a claimant is offered, and the photographs of them.
 *
 * This is the gallery flow ("which one is you?"), not the chain. It is built
 * entirely from things the server already serves:
 *
 *   manifest.identities        the identity board's grouping: pieces of tracks
 *                              that are one person. When it exists, a row here
 *                              IS a person.
 *   .../claim-match/sprites/N  crop strips, {trackId: [{f, j}]}, j being a
 *                              base64 JPEG. The identity board already renders
 *                              these; the gallery shows six of them per person.
 *                              The strips also name every track that HAS
 *                              pictures, which is the only track list this
 *                              screen can honestly offer -- so the ungrouped
 *                              fallback is built from them rather than from a
 *                              segment payload. No boxes are ever downloaded:
 *                              the gallery does not draw any.
 *
 * WHEN THE BOARD HAS NOT RUN there is no grouping, and the honest fallback is
 * one row per track that lasted long enough to be worth offering. That is a
 * weaker offer -- one player who was tracked three times appears three times --
 * so the screen says so rather than pretending the rows are people. It is
 * still far better than nothing: picking three of your own rows costs three
 * taps, where the chain costs about 150 questions.
 */

export type ClaimPersonPart = {
  trackId: string;
  fromFrame: number;
  toFrame: number;
};

export type ClaimPerson = {
  id: string;
  /** set when someone has already claimed this person */
  name: string | null;
  parts: ClaimPersonPart[];
  firstFrame: number;
  lastFrame: number;
  onCameraSeconds: number;
};

export type ClaimCrop = {
  trackId: string;
  frame: number;
  /** base64 JPEG, as the sprite strips store it */
  jpeg: string;
};

/** {trackId: [{f: frame, j: base64 jpeg}]}, one object per segment. */
export type SpriteStrips = Record<string, Array<{ f: number; j: string }>>;

export type GallerySource = "identities" | "tracks";

export type ClaimGallery = {
  source: GallerySource;
  people: ClaimPerson[];
  frameRate: number;
};

/**
 * A track shorter than this is a fragment, not an offer. Twenty seconds is the
 * shortest stretch a player can recognise themselves in from six stills; below
 * it the row is noise that pushes the real one off the screen.
 */
export const MIN_PERSON_SECONDS = 20;

/** More rows than this and the screen stops being a gallery. */
export const MAX_UNGROUPED_PEOPLE = 60;

function frameRateOf(manifest: Pick<TrackingManifest, "frameRate">): number {
  return manifest.frameRate > 0 ? manifest.frameRate : 25;
}

function secondsOfParts(parts: ClaimPersonPart[], frameRate: number): number {
  return parts.reduce((total, part) => total + Math.max(0, part.toFrame - part.fromFrame), 0) / frameRate;
}

export function buildGallery(
  manifest: TrackingManifest,
  sprites: SpriteStrips = {},
): ClaimGallery {
  const frameRate = frameRateOf(manifest);

  if (manifest.identities?.length) {
    const people = manifest.identities
      .map((identity): ClaimPerson => {
        const parts = identity.parts.map((part) => ({
          trackId: part.trackId,
          fromFrame: part.fromFrame,
          toFrame: part.toFrame,
        }));
        return {
          id: identity.id,
          name: identity.name ?? null,
          parts,
          firstFrame: Math.min(...parts.map((part) => part.fromFrame)),
          lastFrame: Math.max(...parts.map((part) => part.toFrame)),
          onCameraSeconds: secondsOfParts(parts, frameRate),
        };
      })
      .filter((person) => person.parts.length > 0)
      .sort((a, b) => b.onCameraSeconds - a.onCameraSeconds);
    return { source: "identities", people, frameRate };
  }

  const people = Object.entries(sprites)
    .map(([trackId, strips]): ClaimPerson | null => {
      const frames = strips.filter((strip) => strip.j).map((strip) => strip.f);
      if (frames.length === 0) return null;
      const fromFrame = Math.min(...frames);
      const toFrame = Math.max(...frames);
      const parts = [{ trackId, fromFrame, toFrame }];
      return {
        id: trackId,
        name: null,
        parts,
        firstFrame: fromFrame,
        lastFrame: toFrame,
        onCameraSeconds: secondsOfParts(parts, frameRate),
      };
    })
    .filter((person): person is ClaimPerson => person !== null)
    .filter((person) => person.onCameraSeconds >= MIN_PERSON_SECONDS)
    .sort((a, b) => b.onCameraSeconds - a.onCameraSeconds)
    .slice(0, MAX_UNGROUPED_PEOPLE);

  return { source: "tracks", people, frameRate };
}

/**
 * Evenly spaced picks from a list, endpoints included.
 *
 * Six crops spread across a person's whole time on camera say far more than
 * six consecutive frames, which are one moment photographed six times.
 */
export function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items.slice();
  if (count <= 0) return [];
  if (count === 1) return [items[Math.floor(items.length / 2)]];
  const picked: T[] = [];
  for (let index = 0; index < count; index++) {
    picked.push(items[Math.round((index * (items.length - 1)) / (count - 1))]);
  }
  return picked;
}

/** Every crop belonging to a person, in time order. */
export function cropsForPerson(person: ClaimPerson, sprites: SpriteStrips): ClaimCrop[] {
  const crops: ClaimCrop[] = [];
  for (const part of person.parts) {
    for (const sprite of sprites[part.trackId] ?? []) {
      if (sprite.f < part.fromFrame || sprite.f > part.toFrame) continue;
      if (!sprite.j) continue;
      crops.push({ trackId: part.trackId, frame: sprite.f, jpeg: sprite.j });
    }
  }
  return crops.sort((a, b) => a.frame - b.frame);
}

export function galleryCrops(
  person: ClaimPerson,
  sprites: SpriteStrips,
  count = 6,
): ClaimCrop[] {
  return spread(cropsForPerson(person, sprites), count);
}

/** Merge the per-segment sprite objects into one lookup. */
export function mergeSprites(parts: SpriteStrips[]): SpriteStrips {
  const merged: SpriteStrips = {};
  for (const part of parts) {
    for (const [trackId, strips] of Object.entries(part)) {
      merged[trackId] = merged[trackId] ? [...merged[trackId], ...strips] : strips;
    }
  }
  for (const trackId of Object.keys(merged)) {
    merged[trackId] = merged[trackId].sort((a, b) => a.f - b.f);
  }
  return merged;
}

/**
 * Tracking frame to the clock the claimant reads.
 *
 * Display time, never video time: the chain's comment about three clocks
 * applies here too, and this one must never be handed to a seek.
 */
export function displaySecondsForFrame(
  frame: number,
  manifest: Pick<TrackingManifest, "frameRate" | "matchOffset">,
): number {
  return Math.max(0, frame / frameRateOf(manifest) + (manifest.matchOffset || 0));
}

export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** "4 min 20 s" style, for time on camera. Short and readable at 390px. */
export function formatDuration(seconds: number, unit: { minutes: string; seconds: string }): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  if (minutes === 0) return `${rest} ${unit.seconds}`;
  if (rest === 0) return `${minutes} ${unit.minutes}`;
  return `${minutes} ${unit.minutes} ${rest} ${unit.seconds}`;
}
