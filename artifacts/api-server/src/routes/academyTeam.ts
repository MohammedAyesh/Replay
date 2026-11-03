import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { academiesTable, academyMembersTable, academyStaffInvitesTable, db, usersTable } from "@workspace/db";
import { academyRolesForUser, requireAcademyConsoleUser, type AcademyConsoleUser } from "../lib/academyAccess";
import {
  CONSOLE_SECTIONS,
  FAMILY_SCREENS,
  OWNER_SECTIONS,
  PERMISSIONS,
  loadAccess,
  primaryRole,
  saveAccess,
  sectionsForKind,
  staffAccess,
} from "../lib/academyPermissions";
import { publicBaseUrl } from "../lib/whatsapp/waha";

/**
 * Academy console → Team (owner only): managers and coaches, invite links, and what each role
 * (manager, coach, parent, player) sees and may do. A manager never manages the team.
 */
const router: IRouter = Router();
const INVITE_DAYS = 7;

function intParam(value: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function member(req: Request, res: Response): Promise<{ user: AcademyConsoleUser; academyId: number; roles: string[] } | null> {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return null;
  const academyId = intParam(req.params.academyId);
  if (!academyId) { res.status(400).json({ error: "Invalid academy id" }); return null; }
  // The real roles: being given the owner's controls in a section never reaches the team.
  const roles = await academyRolesForUser(user.id, academyId);
  if (!roles.length) { res.status(403).json({ error: "Academy membership required" }); return null; }
  return { user, academyId, roles };
}

async function owner(req: Request, res: Response) {
  const m = await member(req, res);
  if (!m) return null;
  if (!m.roles.includes("owner")) { res.status(403).json({ error: "Only the academy owner can manage the team" }); return null; }
  return m;
}

const inviteUrl = (token: string) => `${publicBaseUrl()}/academy/invite/${token}`;

/** What the signed-in member may see and do here; the console builds its menu from it. */
router.get("/academy/console/academies/:academyId/access", async (req, res): Promise<void> => {
  const m = await member(req, res);
  if (!m) return;
  const role = primaryRole(m.roles as never)!;
  res.json(staffAccess(role, await loadAccess(m.academyId)));
});

router.get("/academy/console/academies/:academyId/team", async (req, res): Promise<void> => {
  const m = await owner(req, res);
  if (!m) return;
  const [members, invites, access] = await Promise.all([
    db.select({ userId: academyMembersTable.userId, role: academyMembersTable.role, name: usersTable.name, email: usersTable.email, since: academyMembersTable.createdAt })
      .from(academyMembersTable).innerJoin(usersTable, eq(usersTable.id, academyMembersTable.userId))
      .where(eq(academyMembersTable.academyId, m.academyId)),
    db.select().from(academyStaffInvitesTable).where(and(
      eq(academyStaffInvitesTable.academyId, m.academyId),
      isNull(academyStaffInvitesTable.acceptedAt),
      isNull(academyStaffInvitesTable.revokedAt),
      gt(academyStaffInvitesTable.expiresAt, new Date()),
    )).orderBy(desc(academyStaffInvitesTable.createdAt)),
    loadAccess(m.academyId),
  ]);
  const [kindRow] = await db.select({ kind: academiesTable.kind }).from(academiesTable).where(eq(academiesTable.id, m.academyId));
  const sections = sectionsForKind(kindRow?.kind);
  // One row per person, at his highest role.
  const people = new Map<number, { userId: number; name: string | null; email: string | null; role: string; since: Date; isMe: boolean }>();
  for (const row of members) {
    const prev = people.get(row.userId);
    const rank = (r: string) => ["owner", "manager", "coach"].indexOf(r);
    if (!prev || rank(row.role) < rank(prev.role)) people.set(row.userId, { ...row, isMe: row.userId === m.user.id });
  }
  res.json({
    members: [...people.values()].sort((a, b) => ["owner", "manager", "coach"].indexOf(a.role) - ["owner", "manager", "coach"].indexOf(b.role)),
    invites: invites.map((i) => ({ id: i.id, role: i.role, label: i.label, url: inviteUrl(i.token), expiresAt: i.expiresAt, createdAt: i.createdAt })),
    access,
    catalog: { sections, ownerSections: OWNER_SECTIONS.filter((x) => sections.includes(x)), familyScreens: kindRow?.kind === "venue" ? [] : FAMILY_SCREENS, permissions: PERMISSIONS },
  });
});

router.post("/academy/console/academies/:academyId/team/invites", async (req, res): Promise<void> => {
  const m = await owner(req, res);
  if (!m) return;
  const body = z.object({ role: z.enum(["manager", "coach"]), label: z.string().trim().max(60).optional() }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Pick manager or coach" }); return; }
  const token = randomBytes(18).toString("base64url");
  const [row] = await db.insert(academyStaffInvitesTable).values({
    academyId: m.academyId,
    role: body.data.role,
    label: body.data.label || null,
    token,
    createdBy: m.user.id,
    expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
  }).returning();
  res.status(201).json({ id: row.id, role: row.role, label: row.label, url: inviteUrl(token), expiresAt: row.expiresAt, createdAt: row.createdAt });
});

router.delete("/academy/console/academies/:academyId/team/invites/:id", async (req, res): Promise<void> => {
  const m = await owner(req, res);
  if (!m) return;
  const id = intParam(req.params.id);
  const [row] = id ? await db.update(academyStaffInvitesTable).set({ revokedAt: new Date() })
    .where(and(eq(academyStaffInvitesTable.id, id), eq(academyStaffInvitesTable.academyId, m.academyId), isNull(academyStaffInvitesTable.acceptedAt))).returning() : [];
  if (!row) { res.status(404).json({ error: "Invite not found" }); return; }
  res.status(204).send();
});

async function staffRows(academyId: number, userId: number) {
  return db.select().from(academyMembersTable).where(and(eq(academyMembersTable.academyId, academyId), eq(academyMembersTable.userId, userId)));
}

router.put("/academy/console/academies/:academyId/team/members/:userId", async (req, res): Promise<void> => {
  const m = await owner(req, res);
  if (!m) return;
  const userId = intParam(req.params.userId);
  const body = z.object({ role: z.enum(["manager", "coach"]) }).safeParse(req.body ?? {});
  if (!userId || !body.success) { res.status(400).json({ error: "Pick manager or coach" }); return; }
  const rows = await staffRows(m.academyId, userId);
  if (!rows.length) { res.status(404).json({ error: "Not a member of this academy" }); return; }
  if (rows.some((r) => r.role === "owner")) { res.status(409).json({ error: "The owner's role can't be changed here" }); return; }
  await db.transaction(async (tx) => {
    await tx.delete(academyMembersTable).where(and(eq(academyMembersTable.academyId, m.academyId), eq(academyMembersTable.userId, userId), inArray(academyMembersTable.role, ["manager", "coach"])));
    await tx.insert(academyMembersTable).values({ academyId: m.academyId, userId, role: body.data.role });
  });
  res.json({ userId, role: body.data.role });
});

router.delete("/academy/console/academies/:academyId/team/members/:userId", async (req, res): Promise<void> => {
  const m = await owner(req, res);
  if (!m) return;
  const userId = intParam(req.params.userId);
  if (!userId) { res.status(400).json({ error: "Invalid user" }); return; }
  const rows = await staffRows(m.academyId, userId);
  if (rows.some((r) => r.role === "owner")) { res.status(409).json({ error: "The owner can't be removed here" }); return; }
  const removed = await db.delete(academyMembersTable).where(and(eq(academyMembersTable.academyId, m.academyId), eq(academyMembersTable.userId, userId), inArray(academyMembersTable.role, ["manager", "coach"]))).returning();
  if (!removed.length) { res.status(404).json({ error: "Not a member of this academy" }); return; }
  res.status(204).send();
});

const SectionsBody = z.object({
  sections: z.object({
    manager: z.array(z.enum(CONSOLE_SECTIONS)).optional(),
    coach: z.array(z.enum(CONSOLE_SECTIONS)).optional(),
    parent: z.array(z.enum(FAMILY_SCREENS)).optional(),
    player: z.array(z.enum(FAMILY_SCREENS)).optional(),
  }).optional(),
  permissions: z.object({
    manager: z.array(z.enum(PERMISSIONS)).optional(),
    coach: z.array(z.enum(PERMISSIONS)).optional(),
  }).optional(),
});

router.put("/academy/console/academies/:academyId/access", async (req, res): Promise<void> => {
  const m = await owner(req, res);
  if (!m) return;
  const body = SectionsBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Unknown section, screen or permission" }); return; }
  res.json(await saveAccess(m.academyId, m.user.id, body.data));
});

// ─── Accepting an invite (any signed-in account) ─────────────────────────────

async function openInvite(token: string) {
  const [row] = await db.select({ invite: academyStaffInvitesTable, academyName: academiesTable.name, kind: academiesTable.kind })
    .from(academyStaffInvitesTable).innerJoin(academiesTable, eq(academiesTable.id, academyStaffInvitesTable.academyId))
    .where(eq(academyStaffInvitesTable.token, token));
  if (!row) return { state: "missing" as const };
  const i = row.invite;
  if (i.revokedAt) return { state: "revoked" as const, row };
  if (i.acceptedAt) return { state: "used" as const, row };
  if (i.expiresAt.getTime() < Date.now()) return { state: "expired" as const, row };
  return { state: "open" as const, row };
}

router.get("/academy/invites/:token", async (req, res): Promise<void> => {
  const found = await openInvite(String(req.params.token ?? ""));
  if (found.state === "missing") { res.status(404).json({ error: "This invite link isn't valid" }); return; }
  res.json({ state: found.state, role: found.row.invite.role, academyName: found.row.academyName, academyId: found.row.invite.academyId, kind: found.row.kind });
});

router.post("/academy/invites/:token/accept", async (req, res): Promise<void> => {
  const user = await requireAcademyConsoleUser(req, res);
  if (!user) return;
  const found = await openInvite(String(req.params.token ?? ""));
  if (found.state !== "open") {
    res.status(found.state === "missing" ? 404 : 410).json({ error: "This invite link has expired or was already used. Ask the academy for a new one.", state: found.state });
    return;
  }
  const { invite } = found.row;
  const roles = await academyRolesForUser(user.id, invite.academyId);
  if (!roles.includes(invite.role as never) && !roles.includes("owner")) {
    await db.transaction(async (tx) => {
      // One staff role per person: a coach invited as manager becomes a manager.
      await tx.delete(academyMembersTable).where(and(eq(academyMembersTable.academyId, invite.academyId), eq(academyMembersTable.userId, user.id), inArray(academyMembersTable.role, ["manager", "coach"])));
      await tx.insert(academyMembersTable).values({ academyId: invite.academyId, userId: user.id, role: invite.role as "manager" | "coach" }).onConflictDoNothing();
    });
  }
  await db.update(academyStaffInvitesTable).set({ acceptedBy: user.id, acceptedAt: new Date() }).where(eq(academyStaffInvitesTable.id, invite.id));
  res.json({ academyId: invite.academyId, academyName: found.row.academyName, role: roles.includes("owner") ? "owner" : invite.role });
});

export default router;
