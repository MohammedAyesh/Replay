import { templateSampleData, type CreativeData, type MediaSource } from "@workspace/api-zod";
import type { TemplateSeed } from "../types";

/**
 * What a new project's bindings start as, and what the gallery previews show.
 *
 * Facts come from the real world when there is one (the seed's match, the
 * academy's brand kit); free text (headlines, prices, line-up rows) starts as
 * the template's sample so the design never opens half-empty. A sample never
 * stands in for a real fact that could be published by mistake:
 *   - the phone and Instagram are the academy's own or blank;
 *   - a player's name appears only when the academy shows names, and never a
 *     sample name on a real match;
 *   - the picture is the seed, then the match's own footage, then the latest
 *     frame of the academy's footage, then Replay's sample artwork.
 */

export type StartingInput = {
  key: string;
  /** The post's language (not necessarily the console's). */
  locale: "en" | "ar";
  academy: { nameEn: string; nameAr: string | null; phone: string | null; instagram: string | null; showPlayerNames: boolean };
  seed: TemplateSeed | null;
  /** CreativeData of the seed's session, once loaded. */
  session?: CreativeData | null;
  /** Recent stills of the academy's own footage, newest first. */
  stills?: MediaSource[];
};

/** The MediaSource a media seed stands for (a session seed has none). */
export function seedMedia(seed: TemplateSeed | null): MediaSource | null {
  if (!seed) return null;
  switch (seed.type) {
    case "clip": return { type: "clip", clipId: seed.clipId };
    case "recording": return { type: "recording", recordingId: seed.recordingId, fromMs: seed.fromMs, toMs: seed.toMs };
    case "upload": return { type: "upload", mediaId: seed.mediaId };
    case "frame": return { type: "frame", recordingId: seed.recordingId, atMs: seed.atMs };
    case "session": return null;
  }
}

/** Does the seed look like footage (videos first) or a still (posts first)? */
export function seedKind(seed: TemplateSeed | null): "video" | "image" | null {
  if (!seed) return null;
  if (seed.type === "clip" || seed.type === "recording") return "video";
  if (seed.type === "frame") return "image";
  return null;
}

const clean = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;

export function startingData(input: StartingInput): CreativeData {
  const { key, locale, academy, seed, session } = input;
  const sample = templateSampleData(key, locale);
  const real = seed?.type === "session" && !!session;
  const stills = input.stills ?? [];
  const name = locale === "ar" ? academy.nameAr || academy.nameEn : academy.nameEn;

  const data: CreativeData = {
    academy: { name, nameAr: academy.nameAr, phone: academy.phone ?? "", instagram: academy.instagram ?? "" },
    match: real ? { ...(session!.match ?? {}) } : sample.match ? { ...sample.match, ownName: name || sample.match.ownName } : undefined,
    stats: real && session!.stats ? session!.stats : sample.stats,
    custom: { ...(sample.custom ?? {}), ...(real ? session!.custom ?? {} : {}) },
  };

  if (real && session!.player) {
    data.player = { ...session!.player, name: academy.showPlayerNames ? session!.player.name ?? null : null };
  } else if (sample.player) {
    data.player = { ...sample.player, name: academy.showPlayerNames && !real ? sample.player.name ?? null : null };
  }

  const own = (i: number) => stills[i];
  data.media = seedMedia(seed) ?? (real ? session!.media : undefined) ?? own(0) ?? sample.media;
  if (sample.more) data.more = sample.more.map((m, i) => (real ? session!.more?.[i] : undefined) ?? own(i) ?? m);
  if (data.match) data.match = clean(data.match);
  return clean(data);
}

/** A project title: the template's name and, for a match, the opponent. */
export function projectTitle(templateTitle: string, data: CreativeData, seed: TemplateSeed | null): string {
  const vs = seed?.type === "session" ? data.match?.opponent : undefined;
  return (vs ? `${templateTitle} · ${vs}` : templateTitle).slice(0, 120);
}

