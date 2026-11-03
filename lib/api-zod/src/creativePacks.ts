import type { PackStyle, PublicStyleBase } from "./creativePacksTypes";

/**
 * Brand packs: one Creative-hub style per academy, built from that academy's
 * brand deck (see the "<Academy> — brand deck" Slides artifacts). A pack is a
 * full style (styles/pack-<key>.ts) plus the defaults below. Only an academy
 * whose academies.creative_pack equals the key is offered the pack.
 *
 * Colours here are the deck's palette. Templates still use @primary/@accent
 * tokens, so an academy's own Branding colours win; these are the defaults an
 * admin applies when assigning the pack.
 */
export type CreativePack = {
  key: PackStyle;
  name: string;
  /** Closest house style, used as the fallback and for restyle matching. */
  base: PublicStyleBase;
  palette: { primary: string; accent: string; ink: string; paper: string; extra: Record<string, string> };
  /** Font library families (creativeFonts.ts). */
  fonts: { display: string; body: string; arabic: string; accent?: string };
  /** Background plates by phase: artwork keys "bg/<style>/<n>". */
  plates: { cover: string; pre: string; live: string; post: string; tunnel?: string };
  /** Franchise packs: head-office rules first, academy sign-off required. */
  franchise?: boolean;
  deckUrl?: string;
};

export const CREATIVE_PACKS: Record<PackStyle, CreativePack> = {
  iris: {
    key: "iris", name: "IRIS International Sports", base: "stadium",
    palette: { primary: "#1E50C8", accent: "#C9A54C", ink: "#0B1F4D", paper: "#F6F7FB", extra: { jordanRed: "#CE1126", jordanGreen: "#007A3D" } },
    fonts: { display: "Bebas Neue", body: "Inter", arabic: "Cairo", accent: "Kaushan Script" },
    plates: { cover: "bg/stadium/1", pre: "bg/stadium/3", live: "bg/broadcast/4", post: "bg/stadium/5", tunnel: "bg/cinematic/6" },
    deckUrl: "https://claude.ai/artifact/NntTN2pcRzKQv6sSh2fwoV",
  },
  souqar: {
    key: "souqar", name: "Sports iN Souqar", base: "stadium",
    palette: { primary: "#0B4FD9", accent: "#D4FF4F", ink: "#071A4A", paper: "#F3F6FF", extra: { silver: "#C9CED6" } },
    fonts: { display: "Montserrat", body: "Inter", arabic: "Cairo" },
    plates: { cover: "bg/stadium/2", pre: "bg/stadium/3", live: "bg/stadium/7", post: "bg/stadium/8", tunnel: "bg/stadium/6" },
    deckUrl: "https://claude.ai/artifact/Vk5nAgF6VncVEneTf1hynz",
  },
  barca: {
    key: "barca", name: "Barça Academy Jordan", base: "broadcast", franchise: true,
    palette: { primary: "#A50044", accent: "#EDBB00", ink: "#0A1A3F", paper: "#FFF8E7", extra: { blue: "#004D98" } },
    fonts: { display: "Barlow Condensed", body: "Barlow", arabic: "Tajawal" },
    plates: { cover: "bg/broadcast/1", pre: "bg/broadcast/3", live: "bg/broadcast/4", post: "bg/broadcast/5", tunnel: "bg/cinematic/6" },
    deckUrl: "https://claude.ai/artifact/6tZZ2NtNbLCYh2cmdzv5Sd",
  },
  juventus: {
    key: "juventus", name: "Juventus Academy Amman", base: "editorial", franchise: true,
    palette: { primary: "#0E0E10", accent: "#F5C400", ink: "#0E0E10", paper: "#F7F7F5", extra: { blue: "#1E4BD2", pink: "#F28BB5" } },
    fonts: { display: "Archivo Black", body: "Inter", arabic: "IBM Plex Sans Arabic", accent: "Archivo Narrow" },
    plates: { cover: "bg/luxury/1", pre: "bg/editorial/3", live: "bg/luxury/4", post: "bg/luxury/5", tunnel: "bg/cinematic/6" },
    deckUrl: "https://claude.ai/artifact/41jM41tUPcYNci67jeY2dc",
  },
  knights: {
    key: "knights", name: "Jordan Knights", base: "cinematic",
    palette: { primary: "#C8102E", accent: "#B9BEC6", ink: "#0B0B0D", paper: "#FFF4F0", extra: { crimson: "#6E0B14" } },
    fonts: { display: "Barlow Condensed", body: "Inter", arabic: "Cairo", accent: "Permanent Marker" },
    plates: { cover: "bg/cinematic/1", pre: "bg/cinematic/3", live: "bg/cinematic/7", post: "bg/cinematic/8", tunnel: "bg/cinematic/6" },
    deckUrl: "https://claude.ai/artifact/7vQrvJ5cJzX78nQGw6Ft9H",
  },
  jufa: {
    key: "jufa", name: "JUFA Academy", base: "playful",
    palette: { primary: "#1F4FBF", accent: "#E8F000", ink: "#0D1F5C", paper: "#FFFFFF", extra: { sky: "#DCE7FF" } },
    fonts: { display: "Baloo 2", body: "Inter", arabic: "Baloo Bhaijaan 2" },
    plates: { cover: "bg/playful/3", pre: "bg/stadium/6", live: "bg/stadium/7", post: "bg/stadium/8", tunnel: "bg/stadium/3" },
    deckUrl: "https://claude.ai/artifact/BYcs9PNbZkMvrbTCJ9x1fE",
  },
};

/** Own keys only: `"toString" in CREATIVE_PACKS` is true too. */
export const isPackStyle = (s: string): s is PackStyle => Object.prototype.hasOwnProperty.call(CREATIVE_PACKS, s);
