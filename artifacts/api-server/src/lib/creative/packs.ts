import { CREATIVE_PACKS, PUBLIC_STYLES, isPackStyle, type CreativePack, type CreativeStyle, type PackStyle } from "@workspace/api-zod";

/**
 * Brand packs on the server. An academy is offered the seven house styles plus
 * its own pack (academies.creative_pack, set by an admin), never another
 * academy's: the brand deck behind a pack belongs to that academy.
 */

/** The academy's pack, or null (none set, or a key this build doesn't know). */
export function academyPack(academy: { creativePack: string | null }): CreativePack | null {
  const key = academy.creativePack;
  return key && isPackStyle(key) ? CREATIVE_PACKS[key] : null;
}

/** The styles this academy may use: its pack first, then the house styles. */
export function allowedStyles(academy: { creativePack: string | null }): CreativeStyle[] {
  const pack = academyPack(academy);
  return pack ? [pack.key, ...PUBLIC_STYLES] : [...PUBLIC_STYLES];
}

/** May the academy save a project with this style (null/undefined = no style)? */
export function styleAllowedFor(academy: { creativePack: string | null }, style: string | null | undefined): boolean {
  if (style === null || style === undefined) return true;
  if ((PUBLIC_STYLES as readonly string[]).includes(style)) return true;
  return isPackStyle(style) && academy.creativePack === style;
}

/** What the console reads about the pack (GET …/creative/brand). */
export function publicPack(pack: CreativePack | null): { key: PackStyle; name: string; franchise: boolean } | null {
  return pack ? { key: pack.key, name: pack.name, franchise: !!pack.franchise } : null;
}
