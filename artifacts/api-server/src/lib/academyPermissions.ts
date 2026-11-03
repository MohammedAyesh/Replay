import { eq } from "drizzle-orm";
import { academyAccessSettingsTable, db } from "@workspace/db";
import { academyRolesForUser, type AcademyConsoleRole } from "./academyAccess";

/**
 * Who sees what in an academy. The owner sees and does everything and sets the rest
 * (Academy console → Team):
 *   - manager: every console section by default, with the owner's powers in each one he can
 *     see, except Team (members, invites and these settings), which stays the owner's;
 *   - coach: the coaching sections by default; a section the owner opens to coaches that is
 *     normally owner-only (fees, ads, branding, studio) is opened with full control;
 *   - parent / player: the screens of the family page.
 * Delegated actions (e.g. "chats.manage": archive, block, mute, mark personal) are separate.
 */

export const CONSOLE_SECTIONS = [
  "dashboard", "squads", "players", "registrations", "attendance", "schedule", "recordings", "matches",
  "fees", "announcements", "chats", "people", "whatsapp", "social", "ads", "profile", "branding", "studio",
  // Field console (venues) only.
  "bookings", "pitches", "payments", "agent", "website",
] as const;
export type ConsoleSectionList = readonly ConsoleSection[];

/** Sections that belong to an academy, and to a field business (venue). */
export const ACADEMY_ONLY_SECTIONS: readonly string[] = ["squads", "players", "registrations", "attendance", "schedule", "matches", "fees", "announcements"];
export const VENUE_ONLY_SECTIONS: readonly string[] = ["bookings", "pitches", "payments", "agent", "website"];
export function sectionsForKind(kind: string | null | undefined): ConsoleSection[] {
  const drop = kind === "venue" ? ACADEMY_ONLY_SECTIONS : VENUE_ONLY_SECTIONS;
  return CONSOLE_SECTIONS.filter((s) => !drop.includes(s));
}
export type ConsoleSection = (typeof CONSOLE_SECTIONS)[number];

/** Sections coaches don't see unless the owner opens them (and then with full control). */
export const OWNER_SECTIONS: ConsoleSection[] = ["fees", "social", "ads", "branding", "studio", "pitches", "payments", "agent", "website"];

export const FAMILY_SCREENS = ["schedule", "footage", "matches", "attendance", "news", "fees", "payments"] as const;
export type FamilyScreen = (typeof FAMILY_SCREENS)[number];

export const PERMISSIONS = ["chats.manage"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type StaffRole = "manager" | "coach";
export type FamilyRole = "parent" | "player";
export type AccessRole = "owner" | StaffRole | FamilyRole;

type Stored = {
  sections: Partial<Record<StaffRole | FamilyRole, string[]>>;
  permissions: Partial<Record<StaffRole, string[]>>;
};

export const DEFAULT_SECTIONS: Record<StaffRole, ConsoleSection[]> = {
  manager: [...CONSOLE_SECTIONS],
  coach: CONSOLE_SECTIONS.filter((s) => !OWNER_SECTIONS.includes(s)),
};
export const DEFAULT_PERMISSIONS: Record<StaffRole, Permission[]> = { manager: ["chats.manage"], coach: [] };

export type ResolvedAccess = {
  sections: Record<StaffRole, ConsoleSection[]>;
  family: Record<FamilyRole, FamilyScreen[]>;
  permissions: Record<StaffRole, Permission[]>;
};

const cache = new Map<number, { at: number; value: ResolvedAccess }>();

function only<T extends string>(list: unknown, allowed: readonly T[]): T[] | null {
  if (!Array.isArray(list)) return null;
  return [...new Set(list.filter((x): x is T => typeof x === "string" && (allowed as readonly string[]).includes(x)))];
}

export function resolveAccess(stored: Stored | null): ResolvedAccess {
  const s = stored?.sections ?? {};
  const p = stored?.permissions ?? {};
  return {
    sections: {
      manager: only(s.manager, CONSOLE_SECTIONS) ?? DEFAULT_SECTIONS.manager,
      coach: only(s.coach, CONSOLE_SECTIONS) ?? DEFAULT_SECTIONS.coach,
    },
    family: {
      parent: only(s.parent, FAMILY_SCREENS) ?? [...FAMILY_SCREENS],
      player: only(s.player, FAMILY_SCREENS) ?? [...FAMILY_SCREENS],
    },
    permissions: {
      manager: only(p.manager, PERMISSIONS) ?? DEFAULT_PERMISSIONS.manager,
      coach: only(p.coach, PERMISSIONS) ?? DEFAULT_PERMISSIONS.coach,
    },
  };
}

export async function loadAccess(academyId: number): Promise<ResolvedAccess> {
  const hit = cache.get(academyId);
  if (hit && Date.now() - hit.at < 15_000) return hit.value;
  let stored: Stored | null = null;
  try {
    const [row] = await db.select().from(academyAccessSettingsTable).where(eq(academyAccessSettingsTable.academyId, academyId));
    stored = row ? { sections: row.sections as Stored["sections"], permissions: row.permissions as Stored["permissions"] } : null;
  } catch {
    // A database without the table yet: defaults.
  }
  const value = resolveAccess(stored);
  cache.set(academyId, { at: Date.now(), value });
  return value;
}

export function forgetAccess(academyId: number) {
  cache.delete(academyId);
}

export async function saveAccess(academyId: number, userId: number, next: { sections?: Stored["sections"]; permissions?: Stored["permissions"] }): Promise<ResolvedAccess> {
  const [row] = await db.select().from(academyAccessSettingsTable).where(eq(academyAccessSettingsTable.academyId, academyId));
  const sections = { ...((row?.sections ?? {}) as Stored["sections"]), ...(next.sections ?? {}) };
  const permissions = { ...((row?.permissions ?? {}) as Stored["permissions"]), ...(next.permissions ?? {}) };
  await db.insert(academyAccessSettingsTable).values({ academyId, sections, permissions, updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: academyAccessSettingsTable.academyId, set: { sections, permissions, updatedBy: userId, updatedAt: new Date() } });
  forgetAccess(academyId);
  return loadAccess(academyId);
}

/** The highest staff role among a user's roles in an academy. */
export function primaryRole(roles: AcademyConsoleRole[]): "owner" | StaffRole | null {
  if (roles.includes("owner")) return "owner";
  if (roles.includes("manager")) return "manager";
  if (roles.includes("coach")) return "coach";
  return null;
}

export type StaffAccess = {
  role: "owner" | StaffRole;
  /** Sections this person sees. */
  sections: ConsoleSection[];
  /** Sections where this person has the owner's controls. */
  manages: ConsoleSection[];
  permissions: Permission[];
};

export function staffAccess(role: "owner" | StaffRole, access: ResolvedAccess): StaffAccess {
  if (role === "owner") return { role, sections: [...CONSOLE_SECTIONS], manages: [...CONSOLE_SECTIONS], permissions: [...PERMISSIONS] };
  const sections = access.sections[role];
  const manages = role === "manager" ? sections : sections.filter((s) => OWNER_SECTIONS.includes(s));
  return { role, sections, manages, permissions: access.permissions[role] };
}

export async function staffAccessFor(userId: number, academyId: number): Promise<StaffAccess | null> {
  const role = primaryRole(await academyRolesForUser(userId, academyId));
  if (!role) return null;
  return staffAccess(role, await loadAccess(academyId));
}

/** Which section an academy console API path belongs to ("/academy/console/academies/3/finance/fees" → fees). */
export function sectionForPath(path: string): { academyId: number; section: ConsoleSection | "team" | null } | null {
  const match = /^\/academy\/console\/academies\/(\d+)\/([a-z-]+)(?:\/([a-z-]+))?/.exec(path);
  if (!match) return null;
  const academyId = Number(match[1]);
  const [, , first, second] = match;
  const map: Record<string, ConsoleSection | "team"> = {
    dashboard: "dashboard",
    squads: "squads",
    players: "players",
    "player-stats": "players",
    registrations: "registrations",
    "join-link": "registrations",
    sessions: "schedule",
    recordings: "recordings",
    matches: "matches",
    finance: "fees",
    announcements: "announcements",
    contacts: "people",
    ads: "ads",
    profile: "profile",
    branding: "branding",
    studio: "studio",
    team: "team",
    access: "team",
  };
  // Chats, and what a chat needs (files, GIFs, groups, who to hand it to), are the chats section.
  const chatParts = new Set(["chats", "media", "gifs", "groups", "assignees", "check", "saved-replies"]);
  if (first === "whatsapp") return { academyId, section: chatParts.has(second ?? "") ? "chats" : "whatsapp" };
  // Instagram / Messenger conversations live in Chats; connecting, comments and posts in Social.
  if (first === "social") return { academyId, section: second?.startsWith("threads") ? "chats" : "social" };
  // Field console: /venue/<section>/…
  if (first === "venue") {
    const venueMap: Record<string, ConsoleSection> = {
      dashboard: "dashboard", bookings: "bookings", availability: "bookings", customers: "people",
      pitches: "pitches", payments: "payments", agent: "agent", website: "website",
    };
    return { academyId, section: venueMap[second ?? ""] ?? null };
  }
  return { academyId, section: map[first] ?? null };
}

/** Reading these exposes private data, so a role that can't see the section can't read it either. */
export const PRIVATE_SECTIONS: ConsoleSection[] = ["fees", "ads", "chats", "people", "whatsapp", "social", "branding", "studio", "bookings", "payments", "agent", "website", "pitches"];

/** The family-page screens a parent or a player of this academy sees. */
export async function familyScreensFor(academyId: number, role: FamilyRole): Promise<FamilyScreen[]> {
  return (await loadAccess(academyId)).family[role];
}
