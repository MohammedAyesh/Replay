import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  academyContactPlayersTable,
  academyContactsTable,
  academyMembersTable,
  academyPlayerGuardiansTable,
  academyPlayersTable,
  academyRegistrationsTable,
  academySquadsTable,
  db,
  usersTable,
  type AcademyContact,
} from "@workspace/db";
import { normalizePhone } from "./phone";

export type ContactKind = "unknown" | "lead" | "parent" | "player" | "coach" | "staff" | "other";
export type LeadStage = "new" | "contacted" | "trial" | "joined" | "lost";
export type Relationship = "father" | "mother" | "guardian" | "sibling" | "relative" | "self" | "other";

/** How sure we are of a kind: a known role never gets downgraded by a weaker guess. */
const KIND_RANK: Record<string, number> = { unknown: 0, other: 1, lead: 2, parent: 3, player: 3, coach: 4, staff: 4 };

type Upsert = { name?: string | null; kind?: ContactKind; stage?: LeadStage | null; source?: string; notes?: string | null };

/**
 * Create the contact for a phone, or fill in what it is missing. Never overwrites
 * a name or kind the owner already set with a weaker one.
 */
export async function upsertContact(academyId: number, phone: string, data: Upsert = {}): Promise<AcademyContact> {
  const [existing] = await db
    .select()
    .from(academyContactsTable)
    .where(and(eq(academyContactsTable.academyId, academyId), eq(academyContactsTable.phone, phone)));
  if (!existing) {
    const [created] = await db
      .insert(academyContactsTable)
      .values({
        academyId,
        phone,
        name: data.name?.trim() || null,
        kind: data.kind ?? "unknown",
        stage: data.stage ?? (data.kind === "lead" ? "new" : null),
        source: data.source ?? "manual",
        notes: data.notes ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    return upsertContact(academyId, phone, data);
  }
  const patch: Partial<AcademyContact> = {};
  if (!existing.name && data.name?.trim()) patch.name = data.name.trim();
  if (data.kind && (KIND_RANK[data.kind] ?? 0) > (KIND_RANK[existing.kind] ?? 0)) {
    patch.kind = data.kind;
    // A lead who becomes a parent or player has joined.
    if (existing.kind === "lead" && data.kind !== "lead") patch.stage = "joined";
  }
  if (Object.keys(patch).length === 0) return existing;
  const [updated] = await db
    .update(academyContactsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(academyContactsTable.id, existing.id))
    .returning();
  return updated;
}

export async function linkContactToPlayer(contactId: number, playerId: number, relationship: Relationship, replace = false) {
  if (replace) {
    await db
      .insert(academyContactPlayersTable)
      .values({ contactId, playerId, relationship })
      .onConflictDoUpdate({
        target: [academyContactPlayersTable.contactId, academyContactPlayersTable.playerId],
        set: { relationship },
      });
  } else {
    await db.insert(academyContactPlayersTable).values({ contactId, playerId, relationship }).onConflictDoNothing();
  }
}

/**
 * Bring every number the academy already has on file into People: guardian
 * numbers typed on players, guardian accounts, players' own accounts, coaches and
 * pending registrations. Idempotent; cheap at academy scale.
 */
export async function syncAcademyContacts(academyId: number): Promise<void> {
  const players = await db
    .select({
      id: academyPlayersTable.id,
      name: academyPlayersTable.name,
      guardianPhone: academyPlayersTable.guardianPhone,
      userPhone: usersTable.phone,
      userName: usersTable.name,
    })
    .from(academyPlayersTable)
    .leftJoin(usersTable, eq(usersTable.id, academyPlayersTable.userId))
    .where(eq(academyPlayersTable.academyId, academyId));

  for (const player of players) {
    const guardianPhone = normalizePhone(player.guardianPhone);
    if (guardianPhone) {
      const contact = await upsertContact(academyId, guardianPhone, { kind: "parent", source: "player" });
      await linkContactToPlayer(contact.id, player.id, "guardian");
    }
    const own = normalizePhone(player.userPhone);
    if (own) {
      const contact = await upsertContact(academyId, own, { kind: "player", name: player.userName ?? player.name, source: "account" });
      await linkContactToPlayer(contact.id, player.id, "self");
    }
  }

  if (players.length > 0) {
    const guardians = await db
      .select({ playerId: academyPlayerGuardiansTable.playerId, phone: usersTable.phone, name: usersTable.name })
      .from(academyPlayerGuardiansTable)
      .innerJoin(usersTable, eq(usersTable.id, academyPlayerGuardiansTable.userId))
      .where(inArray(academyPlayerGuardiansTable.playerId, players.map((p) => p.id)));
    for (const guardian of guardians) {
      const phone = normalizePhone(guardian.phone);
      if (!phone) continue;
      const contact = await upsertContact(academyId, phone, { kind: "parent", name: guardian.name, source: "account" });
      await linkContactToPlayer(contact.id, guardian.playerId, "guardian");
    }
  }

  const coaches = await db
    .select({ phone: usersTable.phone, name: usersTable.name })
    .from(academyMembersTable)
    .innerJoin(usersTable, eq(usersTable.id, academyMembersTable.userId))
    .where(and(eq(academyMembersTable.academyId, academyId), eq(academyMembersTable.role, "coach")));
  for (const coach of coaches) {
    const phone = normalizePhone(coach.phone);
    if (phone) await upsertContact(academyId, phone, { kind: "coach", name: coach.name, source: "account" });
  }

  const registrations = await db
    .select({
      guardianPhone: academyRegistrationsTable.guardianPhone,
      guardianName: academyRegistrationsTable.guardianName,
      playerName: academyRegistrationsTable.playerName,
    })
    .from(academyRegistrationsTable)
    .where(and(eq(academyRegistrationsTable.academyId, academyId), eq(academyRegistrationsTable.status, "pending")));
  for (const registration of registrations) {
    const phone = normalizePhone(registration.guardianPhone);
    if (!phone) continue;
    await upsertContact(academyId, phone, {
      kind: "lead",
      name: registration.guardianName,
      source: "registration",
      notes: `Registration: ${registration.playerName}`,
    });
  }
}

export type ContactLink = { playerId: number; playerName: string; squadName: string | null; relationship: Relationship; isActive: boolean };

export async function linksForContacts(contactIds: number[]): Promise<Map<number, ContactLink[]>> {
  const map = new Map<number, ContactLink[]>();
  if (contactIds.length === 0) return map;
  const rows = await db
    .select({
      contactId: academyContactPlayersTable.contactId,
      playerId: academyContactPlayersTable.playerId,
      relationship: academyContactPlayersTable.relationship,
      playerName: academyPlayersTable.name,
      squadName: academySquadsTable.name,
      isActive: academyPlayersTable.isActive,
    })
    .from(academyContactPlayersTable)
    .innerJoin(academyPlayersTable, eq(academyPlayersTable.id, academyContactPlayersTable.playerId))
    .leftJoin(academySquadsTable, eq(academySquadsTable.id, academyPlayersTable.squadId))
    .where(inArray(academyContactPlayersTable.contactId, contactIds));
  for (const row of rows) {
    const list = map.get(row.contactId) ?? [];
    list.push({
      playerId: row.playerId,
      playerName: row.playerName,
      squadName: row.squadName ?? null,
      relationship: row.relationship as Relationship,
      isActive: row.isActive,
    });
    map.set(row.contactId, list);
  }
  return map;
}

export async function listContacts(academyId: number) {
  const contacts = await db
    .select()
    .from(academyContactsTable)
    .where(eq(academyContactsTable.academyId, academyId))
    .orderBy(desc(academyContactsTable.updatedAt));
  const links = await linksForContacts(contacts.map((c) => c.id));
  const activity = await db.execute(sql`
    select phone, max(created_at) as "lastMessageAt"
    from academy_whatsapp_messages where academy_id = ${academyId}
    group by phone
  `);
  const lastByPhone = new Map(
    ((activity as unknown as { rows: Array<{ phone: string; lastMessageAt: string }> }).rows ?? []).map((r) => [r.phone, r.lastMessageAt]),
  );
  return contacts.map((c) => ({
    ...c,
    tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
    players: links.get(c.id) ?? [],
    lastMessageAt: lastByPhone.get(c.phone) ?? null,
  }));
}

/** Phones linked to players through People, for audiences: parents (any relationship but self) and players (self). */
export async function contactPhonesForPlayers(playerIds: number[]) {
  if (playerIds.length === 0) return [];
  return db
    .select({
      playerId: academyContactPlayersTable.playerId,
      relationship: academyContactPlayersTable.relationship,
      phone: academyContactsTable.phone,
      name: academyContactsTable.name,
    })
    .from(academyContactPlayersTable)
    .innerJoin(academyContactsTable, eq(academyContactsTable.id, academyContactPlayersTable.contactId))
    .where(inArray(academyContactPlayersTable.playerId, playerIds));
}
