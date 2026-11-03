import type { Content } from "../content";
import type { Ctx } from "../kit";
import type { VideoSkin } from "../parts";

/** One visual family: a hand-made layout for every archetype plus its video skin. */
export type StyleKit = {
  background: string;
  /**
   * The tinted background plate (artwork "bg/<style>/1", see PLATE_LAYER_ID):
   * how strongly it shows, and optionally the id of a full-canvas layer it sits
   * right above (stadium paints its sky first; the plate replaces it).
   */
  plate: { opacity: number; above?: string };
  score: (c: Ctx, k: Content) => void;
  fixture: (c: Ctx, k: Content) => void;
  hero: (c: Ctx, k: Content) => void;
  list: (c: Ctx, k: Content) => void;
  promo: (c: Ctx, k: Content) => void;
  skin: VideoSkin;
};

/** Hero templates: the big words, and the small tag above them. */
export function heroWords(k: Content): { head: string; tag: string } {
  return k.headline ? { head: k.headline, tag: k.kicker } : { head: k.kicker, tag: k.academy };
}

/** Rows whose first column is a number (line-up, table). */
export const numericLead = (k: Content) => k.key === "lineup" || k.key === "standings";

/** Poll option letters: A / B, أ / ب. */
export const optionKey = (ar: boolean, i: number) => (ar ? ["أ", "ب"] : ["A", "B"])[i] ?? "";
