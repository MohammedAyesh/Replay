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

/**
 * The numbers a player can put on his card, in the order they are offered.
 * "Shots on target" replaced touches (Mohammed, 2026-10-25): it is the
 * detector's `shots`, which only counts a ball seen inside a goal mouth.
 */
export const END_SCREEN_STATS = [
  { key: "goals", metric: "goals", decimals: 0, unit: "", labelAr: "أهداف", labelEn: "Goals", pct: false },
  { key: "shotsOnTarget", metric: "shots", decimals: 0, unit: "", labelAr: "تسديدة على المرمى", labelEn: "Shots on target", pct: false },
  { key: "topSpeed", metric: "topSpeedKmh", decimals: 1, unit: "km/h", labelAr: "أعلى سرعة", labelEn: "Top speed", pct: false },
  { key: "distance", metric: "distanceKm", decimals: 1, unit: "km", labelAr: "مسافة", labelEn: "Distance", pct: true },
  { key: "passes", metric: "passesCompleted", decimals: 0, unit: "", labelAr: "تمريرة صحيحة", labelEn: "Passes completed", pct: false },
  { key: "dribbles", metric: "dribblesWon", decimals: 0, unit: "", labelAr: "مراوغة ناجحة", labelEn: "Dribbles won", pct: false },
] as const;
export type EndScreenStatKey = (typeof END_SCREEN_STATS)[number]["key"];
export const END_SCREEN_STAT_KEYS = END_SCREEN_STATS.map((s) => s.key) as EndScreenStatKey[];
/** Most numbers a card shows: four on a player card, three on an academy card. */
export const MAX_CARD_STATS = 4;

/**
 * What the player chose for a clip's end screen. `card` picks which card
 * (among those the venue has switched on and that have data); `stats` picks
 * and orders the numbers on a player or academy card. Anything unset is
 * decided automatically, as before.
 */
export type EndScreenChoice = {
  card?: "auto" | EndScreenKind;
  stats?: EndScreenStatKey[];
};
