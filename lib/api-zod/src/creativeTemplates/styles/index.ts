import type { CreativeStyle } from "../../creativeScene";
import { broadcast } from "./broadcast";
import { street } from "./street";
import { editorial } from "./editorial";
import { luxury } from "./luxury";
import { playful } from "./playful";
import { cinematic } from "./cinematic";
import { stadium } from "./stadium";
import type { StyleKit } from "./types";

export const STYLE_KITS: Record<CreativeStyle, StyleKit> = {
  broadcast,
  street,
  editorial,
  luxury,
  playful,
  cinematic,
  stadium,
};
