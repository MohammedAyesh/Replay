import type { CreativeStyle } from "../../creativeScene";
import { broadcast } from "./broadcast";
import { street } from "./street";
import { editorial } from "./editorial";
import { luxury } from "./luxury";
import { playful } from "./playful";
import { cinematic } from "./cinematic";
import { stadium } from "./stadium";
import { pack_iris } from "./pack-iris";
import { pack_souqar } from "./pack-souqar";
import { pack_barca } from "./pack-barca";
import { pack_juventus } from "./pack-juventus";
import { pack_knights } from "./pack-knights";
import { pack_jufa } from "./pack-jufa";
import type { StyleKit } from "./types";

export const STYLE_KITS: Record<CreativeStyle, StyleKit> = {
  broadcast,
  street,
  editorial,
  luxury,
  playful,
  cinematic,
  stadium,
  iris: pack_iris,
  souqar: pack_souqar,
  barca: pack_barca,
  juventus: pack_juventus,
  knights: pack_knights,
  jufa: pack_jufa,
};
