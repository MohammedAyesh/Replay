import type { Image } from "@napi-rs/canvas";

/** How a venue looks, ready to draw: the profile row plus its crest, loaded. */
export type BrandLook = {
  nameEn: string;
  nameAr: string | null;
  taglineAr: string | null;
  primaryColor: string;
  accentColor: string | null;
  bookingPhone: string | null;
  instagram: string | null;
  /** Null draws an initials crest in the venue colour, so no venue goes out unbranded. */
  crest: Image | null;
  isAcademy: boolean;
};

export const OVERLAY_STYLES = ["uploaded", "cornerCrest", "broadcastBar", "academyFrame"] as const;
export type OverlayStyle = (typeof OVERLAY_STYLES)[number];

export const END_SCREEN_KINDS = ["player", "match", "academy", "signOff"] as const;
export type EndScreenKind = (typeof END_SCREEN_KINDS)[number];

export type StatLine = {
  value: number;
  decimals: number;
  unit: string;
  labelAr: string;
  /** The player's best ever on this metric: drawn in the venue colour. */
  best: boolean;
  /** Academy screens: against the player's last five sessions. */
  delta?: { text: string; up: boolean } | null;
};

type Common = {
  look: BrandLook;
  /** "SAT 24 OCT · 22:00", already in Amman time. */
  dateLabel: string | null;
  /** What the QR code opens. */
  link: string;
};

export type EndScreen =
  | (Common & { kind: "signOff" })
  | (Common & {
      kind: "player";
      player: { big: string; sub: string | null; awardAr: string | null };
      stats: StatLine[];
    })
  | (Common & {
      kind: "match";
      score: {
        a: number;
        b: number;
        aName: string;
        bName: string;
        aColor: string;
        bColor: string;
        /** Minutes, only when every goal on that side is accounted for. */
        aGoals: number[] | null;
        bGoals: number[] | null;
      };
      motm: string | null;
    })
  | (Common & {
      kind: "academy";
      player: { big: string; sub: string | null };
      ageGroup: string | null;
      stats: StatLine[];
    });

export type Dims = { w: number; h: number };
