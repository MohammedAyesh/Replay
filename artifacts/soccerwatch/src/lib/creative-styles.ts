import { PUBLIC_STYLES, isPackStyle, type CreativeStyle, type PackStyle } from "@workspace/api-zod";

/** The academy's brand pack as GET …/creative/brand reports it (null: house styles only). */
export type CreativePackInfo = { key: PackStyle; name: string; franchise: boolean };

/**
 * The styles an academy is offered in the Creative hub: its own brand pack
 * first (when an admin gave it one), then the seven house styles. Another
 * academy's pack is never offered (the API refuses it too).
 */
export function offeredStyles(pack: CreativePackInfo | null | undefined): CreativeStyle[] {
  return pack && isPackStyle(pack.key) ? [pack.key, ...PUBLIC_STYLES] : [...PUBLIC_STYLES];
}
