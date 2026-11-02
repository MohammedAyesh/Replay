import { and, eq, inArray } from "drizzle-orm";
import {
  academyMembersTable,
  academyPlayerGuardiansTable,
  academyPlayersTable,
  academySquadsTable,
  db,
  usersTable,
} from "@workspace/db";
import { normalizePhone } from "./phone";
import type { AudienceRole } from "./templates";

export type Recipient = {
  phone: string;
  name: string | null;
  role: "parent" | "player" | "coach";
  playerId: number | null;
  playerName: string | null;
  squadId: number | null;
  squadName: string | null;
};

export type MissingContact = { playerId: number; playerName: string; role: "parent" | "player" };

export type AudienceScope = {
  roles: AudienceRole[];
  /** null = every squad, including unassigned players. */
  squadIds: number[] | null;
  /** null = every player in scope. */
  playerIds: number[] | null;
};

export type ResolvedAudience = { recipients: Recipient[]; missing: MissingContact[]; playerCount: number };

/**
 * Everyone an academy message can reach, one entry per (phone, player, role).
 * Inactive players and their families are never included.
 */
export async function resolveAudience(academyId: number, scope: AudienceScope): Promise<ResolvedAudience> {
  const roles = new Set(scope.roles);
  const recipients: Recipient[] = [];
  const missing: MissingContact[] = [];

  const conditions = [eq(academyPlayersTable.academyId, academyId), eq(academyPlayersTable.isActive, true)];
  if (scope.squadIds) {
    if (scope.squadIds.length === 0) return { recipients: [], missing: [], playerCount: 0 };
    conditions.push(inArray(academyPlayersTable.squadId, scope.squadIds));
  }
  if (scope.playerIds) {
    if (scope.playerIds.length === 0) return { recipients: [], missing: [], playerCount: 0 };
    conditions.push(inArray(academyPlayersTable.id, scope.playerIds));
  }

  const needPlayers = roles.has("parents") || roles.has("players");
  const players = needPlayers || scope.playerIds
    ? await db
      .select({
        id: academyPlayersTable.id,
        name: academyPlayersTable.name,
        squadId: academyPlayersTable.squadId,
        squadName: academySquadsTable.name,
        guardianPhone: academyPlayersTable.guardianPhone,
        userId: academyPlayersTable.userId,
        userPhone: usersTable.phone,
        userName: usersTable.name,
      })
      .from(academyPlayersTable)
      .leftJoin(academySquadsTable, eq(academySquadsTable.id, academyPlayersTable.squadId))
      .leftJoin(usersTable, eq(usersTable.id, academyPlayersTable.userId))
      .where(and(...conditions))
    : [];

  const guardianRows = roles.has("parents") && players.length > 0
    ? await db
      .select({
        playerId: academyPlayerGuardiansTable.playerId,
        phone: usersTable.phone,
        name: usersTable.name,
        disabled: usersTable.isDisabled,
      })
      .from(academyPlayerGuardiansTable)
      .innerJoin(usersTable, eq(usersTable.id, academyPlayerGuardiansTable.userId))
      .where(inArray(academyPlayerGuardiansTable.playerId, players.map((p) => p.id)))
    : [];
  const guardiansByPlayer = new Map<number, typeof guardianRows>();
  for (const row of guardianRows) {
    if (row.disabled) continue;
    const list = guardiansByPlayer.get(row.playerId) ?? [];
    list.push(row);
    guardiansByPlayer.set(row.playerId, list);
  }

  for (const player of players) {
    const base = {
      playerId: player.id,
      playerName: player.name,
      squadId: player.squadId,
      squadName: player.squadName ?? null,
    };
    if (roles.has("parents")) {
      const phones = new Set<string>();
      const guardianPhone = normalizePhone(player.guardianPhone);
      for (const guardian of guardiansByPlayer.get(player.id) ?? []) {
        const phone = normalizePhone(guardian.phone);
        if (!phone || phones.has(phone)) continue;
        phones.add(phone);
        recipients.push({ ...base, phone, name: guardian.name, role: "parent" });
      }
      if (guardianPhone && !phones.has(guardianPhone)) {
        phones.add(guardianPhone);
        recipients.push({ ...base, phone: guardianPhone, name: null, role: "parent" });
      }
      if (phones.size === 0) missing.push({ playerId: player.id, playerName: player.name, role: "parent" });
    }
    if (roles.has("players")) {
      const phone = player.userId ? normalizePhone(player.userPhone) : null;
      if (phone) recipients.push({ ...base, phone, name: player.userName ?? player.name, role: "player" });
      else missing.push({ playerId: player.id, playerName: player.name, role: "player" });
    }
  }

  if (roles.has("coaches")) {
    const coaches = await db
      .select({ phone: usersTable.phone, name: usersTable.name, disabled: usersTable.isDisabled })
      .from(academyMembersTable)
      .innerJoin(usersTable, eq(usersTable.id, academyMembersTable.userId))
      .where(and(eq(academyMembersTable.academyId, academyId), eq(academyMembersTable.role, "coach")));
    const seen = new Set<string>();
    for (const coach of coaches) {
      const phone = normalizePhone(coach.phone);
      if (!phone || coach.disabled || seen.has(phone)) continue;
      seen.add(phone);
      recipients.push({ phone, name: coach.name, role: "coach", playerId: null, playerName: null, squadId: null, squadName: null });
    }
  }

  return { recipients, missing, playerCount: players.length };
}

export type MergedRecipient = {
  phone: string;
  name: string | null;
  role: Recipient["role"];
  playerIds: number[];
  playerNames: string[];
  squadNames: string[];
};

/**
 * One entry per phone, for broadcasts: a parent with two children gets one
 * message naming both. A phone that is both a coach and a parent counts as parent.
 */
export function mergeByPhone(recipients: Recipient[]): MergedRecipient[] {
  const rank = { parent: 0, player: 1, coach: 2 } as const;
  const map = new Map<string, MergedRecipient>();
  for (const r of recipients) {
    const current = map.get(r.phone);
    if (!current) {
      map.set(r.phone, {
        phone: r.phone,
        name: r.name,
        role: r.role,
        playerIds: r.playerId ? [r.playerId] : [],
        playerNames: r.playerName ? [r.playerName] : [],
        squadNames: r.squadName ? [r.squadName] : [],
      });
      continue;
    }
    if (rank[r.role] < rank[current.role]) current.role = r.role;
    if (!current.name && r.name) current.name = r.name;
    if (r.playerId && !current.playerIds.includes(r.playerId)) {
      current.playerIds.push(r.playerId);
      if (r.playerName) current.playerNames.push(r.playerName);
    }
    if (r.squadName && !current.squadNames.includes(r.squadName)) current.squadNames.push(r.squadName);
  }
  return [...map.values()];
}

/** One entry per (phone, player): per-player automations name the right child. */
export function dedupePerPlayer(recipients: Recipient[]): Recipient[] {
  const seen = new Set<string>();
  return recipients.filter((r) => {
    const key = `${r.phone}:${r.playerId ?? "-"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function joinNames(names: string[], locale: "ar" | "en"): string {
  if (names.length <= 1) return names[0] ?? "";
  const last = names[names.length - 1];
  const rest = names.slice(0, -1);
  return locale === "ar" ? `${rest.join("، ")} و${last}` : `${rest.join(", ")} and ${last}`;
}
