/**
 * The monthly value report an academy owner sees (and can share): what Replay
 * did for the academy in one Amman calendar month.
 *
 *   footage   match videos, clips made, private clips sent to families
 *   posts     public posts published from Replay (and their reach, when Meta reported it)
 *   messages  WhatsApp messages that left the academy's number
 *   families  share of families who opened their child's clip or a match video
 *   featured  children featured against the owner's target (the squad grid)
 *   people    enquiries, trial sessions and players joined (People stage changes)
 *   ads       Replay-run ad spend and cost per player joined, when ads ran
 *
 * Nothing here ranks children: the featured line is a count, and the share
 * version leaves even the shirt numbers of children not yet featured out.
 */
import { pool } from "@workspace/db";
import { loadSquadGrid } from "./featured/store";
import { ammanMonth, monthBounds } from "./featured/rules";

export type ValueReport = {
  academy: { id: number; name: string; logoUrl: string | null };
  month: string;
  /** The month is still running: figures are "so far". */
  partial: boolean;
  generatedAt: string;
  footage: { matchVideos: number; clipsMade: number; privateClipsSent: number };
  posts: { published: number; reach: number | null };
  messages: { sent: number; read: number };
  families: { total: number; reached: number; opened: number; openedPct: number | null };
  featured: { featured: number; total: number; publicTarget: number; notYet: Array<{ number: number | null }> };
  /**
   * People pipeline. `trackedSince` is when stage changes started being
   * recorded; a month that began before it undercounts trials and players joined.
   */
  people: { enquiries: number; trials: number; joined: number; trackedSince: string | null };
  ads: { ran: boolean; spendJod: number | null; joinedFromAds: number; costPerJoinedJod: number | null };
};

export function isMonth(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/** The month before this one, in Amman: the report an owner usually wants on the 1st. */
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0) || 0;

/**
 * Families: players who share a guardian account or a parent's number are one
 * family (a parent with two children is one family, as in WhatsApp sends).
 */
export function groupFamilies(players: number[], links: Array<{ playerId: number; key: string }>): Map<number, number> {
  const parent = new Map<number, number>(players.map((p) => [p, p]));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const firstByKey = new Map<string, number>();
  for (const l of links) {
    if (!parent.has(l.playerId)) continue;
    const seen = firstByKey.get(l.key);
    if (seen === undefined) firstByKey.set(l.key, l.playerId);
    else {
      const a = find(seen), b = find(l.playerId);
      if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
    }
  }
  return new Map(players.map((p) => [p, find(p)]));
}

export async function buildValueReport(academyId: number, month: string, now = new Date()): Promise<ValueReport | null> {
  const { from, to } = monthBounds(month);
  const q = async (text: string, params: unknown[] = [academyId, from, to]) => (await pool.query(text, params)).rows as Row[];
  const [academy] = await q(`SELECT id, name, logo_url FROM academies WHERE id = $1`, [academyId]);
  if (!academy) return null;

  const [
    [videos], [clips], [privateSent], [posts], [messages], players, guardianLinks, contactLinks,
    openedClips, viewedRecordings, events, [trackedSince], [spend], adJoined,
  ] = await Promise.all([
    // A match video belongs to the month its session started in; one with no session, to when it was linked.
    q(`SELECT count(DISTINCT ar.recording_id) AS n FROM academy_recordings ar
       LEFT JOIN academy_sessions s ON s.id = ar.session_id
       WHERE ar.academy_id = $1 AND COALESCE(s.starts_at, ar.created_at) >= $2 AND COALESCE(s.starts_at, ar.created_at) < $3`),
    q(`SELECT count(*) AS n FROM user_clips WHERE academy_id = $1 AND created_at >= $2 AND created_at < $3`),
    q(`SELECT count(*) AS n FROM academy_player_clips WHERE academy_id = $1 AND status = 'sent' AND sent_at >= $2 AND sent_at < $3`),
    q(`SELECT count(*) AS n,
         sum(NULLIF(COALESCE((insights->'instagram'->>'reach')::numeric, 0) + COALESCE((insights->'facebook'->>'reach')::numeric, 0), 0)) AS reach
       FROM academy_social_posts WHERE academy_id = $1 AND source = 'replay' AND status IN ('published', 'partial')
         AND published_at >= $2 AND published_at < $3`),
    q(`SELECT count(*) AS sent, count(read_at) AS read FROM academy_whatsapp_messages
       WHERE academy_id = $1 AND direction = 'out' AND status IN ('sent', 'delivered', 'read') AND sent_at >= $2 AND sent_at < $3`),
    q(`SELECT id FROM academy_players WHERE academy_id = $1 AND is_active`, [academyId]),
    q(`SELECT g.player_id, g.user_id FROM academy_player_guardians g JOIN academy_players p ON p.id = g.player_id
       WHERE p.academy_id = $1 AND p.is_active`, [academyId]),
    q(`SELECT cp.player_id, cp.contact_id FROM academy_contact_players cp JOIN academy_contacts c ON c.id = cp.contact_id
       WHERE c.academy_id = $1 AND cp.relationship <> 'self' AND c.kind <> 'coach'`, [academyId]),
    // Clips sent this month and whether the family opened them (ever: a clip sent on the 30th opened on the 2nd counts).
    q(`SELECT player_id, opened_at IS NOT NULL AS opened FROM academy_player_clips
       WHERE academy_id = $1 AND status = 'sent' AND sent_at >= $2 AND sent_at < $3`),
    // A guardian who watched one of the academy's match videos this month.
    q(`SELECT DISTINCT g.player_id FROM recording_views v
       JOIN academy_recordings ar ON ar.recording_id = v.recording_id AND ar.academy_id = $1
       JOIN academy_player_guardians g ON g.user_id = v.viewer_user_id
       JOIN academy_players p ON p.id = g.player_id AND p.academy_id = $1
       WHERE v.last_viewed_at >= $2 AND v.first_viewed_at < $3`),
    q(`SELECT contact_id, from_stage, to_stage, from_kind, to_kind FROM academy_contact_stage_events
       WHERE academy_id = $1 AND at >= $2 AND at < $3`),
    q(`SELECT min(at) AS at FROM academy_contact_stage_events`, []),
    q(`SELECT count(*) AS n, -sum(amount_fils) AS fils FROM academy_ad_wallet_entries
       WHERE academy_id = $1 AND kind = 'spend' AND status = 'confirmed' AND created_at >= $2 AND created_at < $3`),
    q(`SELECT DISTINCT contact_id FROM meta_ad_leads WHERE academy_id = $1 AND contact_id IS NOT NULL`, [academyId]),
  ]);

  // People: count each contact once per kind of step.
  const enquiries = new Set<number>(), trials = new Set<number>(), joined = new Set<number>();
  for (const e of events) {
    const c = n(e.contact_id);
    if (e.to_kind === "lead" && e.from_kind !== "lead") enquiries.add(c);
    if (e.to_stage === "trial" && e.from_stage !== "trial") trials.add(c);
    const becameJoined = e.to_stage === "joined" && e.from_stage !== "joined";
    const leadBecameFamily = e.from_kind === "lead" && (e.to_kind === "parent" || e.to_kind === "player");
    if (becameJoined || leadBecameFamily) joined.add(c);
  }

  // Families.
  const playerIds = players.map((p) => n(p.id));
  const family = groupFamilies(playerIds, [
    ...guardianLinks.map((g) => ({ playerId: n(g.player_id), key: `u${n(g.user_id)}` })),
    ...contactLinks.map((c) => ({ playerId: n(c.player_id), key: `c${n(c.contact_id)}` })),
  ]);
  const familyOf = (p: number) => family.get(p);
  const total = new Set(family.values()).size;
  const reached = new Set<number>(), opened = new Set<number>();
  for (const c of openedClips) {
    const f = familyOf(n(c.player_id));
    if (f === undefined) continue;
    reached.add(f);
    if (c.opened) opened.add(f);
  }
  for (const v of viewedRecordings) {
    const f = familyOf(n(v.player_id));
    if (f === undefined) continue;
    reached.add(f);
    opened.add(f);
  }

  const grid = await loadSquadGrid(academyId, { now: to < now ? new Date(to.getTime() - 1) : now, month });

  const adContacts = new Set(adJoined.map((r) => n(r.contact_id)));
  const joinedFromAds = [...joined].filter((c) => adContacts.has(c)).length;
  const spendFils = n(spend?.fils);
  const ran = n(spend?.n) > 0;
  const spendJod = ran ? Math.round(spendFils) / 1000 : null;

  return {
    academy: { id: n(academy.id), name: String(academy.name), logoUrl: (academy.logo_url as string | null) ?? null },
    month,
    partial: to > now,
    generatedAt: now.toISOString(),
    footage: { matchVideos: n(videos?.n), clipsMade: n(clips?.n), privateClipsSent: n(privateSent?.n) },
    posts: { published: n(posts?.n), reach: posts?.reach == null ? null : n(posts.reach) },
    messages: { sent: n(messages?.sent), read: n(messages?.read) },
    families: { total, reached: reached.size, opened: opened.size, openedPct: total ? Math.round((opened.size / total) * 100) : null },
    featured: {
      featured: grid.summary.featured,
      total: grid.summary.total,
      publicTarget: grid.targets.publicPostsPerMonth,
      notYet: grid.summary.notYet.map((p) => ({ number: p.number })),
    },
    people: {
      enquiries: enquiries.size,
      trials: trials.size,
      joined: joined.size,
      trackedSince: trackedSince?.at ? new Date(trackedSince.at as string).toISOString() : null,
    },
    ads: {
      ran,
      spendJod,
      joinedFromAds,
      costPerJoinedJod: ran && joinedFromAds > 0 && spendJod !== null ? Math.round((spendJod / joinedFromAds) * 100) / 100 : null,
    },
  };
}

/** The share version: counts only. No child is named or numbered on a page anyone with the link can open. */
export function shareView(report: ValueReport): ValueReport {
  return { ...report, featured: { ...report.featured, notYet: [] } };
}

export { ammanMonth };
