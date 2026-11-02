import { and, eq, isNull, sql } from "drizzle-orm";
import { academyContactsTable, db, metaAdCampaignsTable, metaAdLeadsTable, metaAdsTable } from "@workspace/db";
import { logger } from "../logger";
import { upsertContact } from "../whatsapp/contacts";
import { normalizePhone } from "../whatsapp/phone";
import { metaAdsConfigured } from "./config";
import { graphGet } from "./graph";
import { tokenForPage } from "./connections";
import { academyMetaConnectionsTable } from "@workspace/db";

export const AD_TAG = "Meta ad";

/** The campaign (and its academy) an ad belongs to; asks Meta for ads newer than the last sync. */
export async function campaignForAd(adId: string | null): Promise<{ campaignId: string; academyId: number | null } | null> {
  if (!adId) return null;
  const [known] = await db
    .select({ campaignId: metaAdsTable.campaignId, academyId: metaAdCampaignsTable.academyId })
    .from(metaAdsTable)
    .innerJoin(metaAdCampaignsTable, eq(metaAdCampaignsTable.id, metaAdsTable.campaignId))
    .where(eq(metaAdsTable.id, adId));
  if (known) return known;
  if (!metaAdsConfigured()) return null;
  try {
    const ad = await graphGet<{ id: string; name?: string; effective_status?: string; campaign?: { id: string; name?: string } }>(
      adId, { fields: "id,name,effective_status,campaign{id,name}" },
    );
    if (!ad.campaign?.id) return null;
    await db.insert(metaAdCampaignsTable).values({ id: ad.campaign.id, name: ad.campaign.name ?? ad.campaign.id }).onConflictDoNothing();
    await db.insert(metaAdsTable).values({ id: ad.id, campaignId: ad.campaign.id, name: ad.name ?? null, status: ad.effective_status ?? null, syncedAt: new Date() })
      .onConflictDoNothing();
    const [campaign] = await db.select({ academyId: metaAdCampaignsTable.academyId }).from(metaAdCampaignsTable).where(eq(metaAdCampaignsTable.id, ad.campaign.id));
    return { campaignId: ad.campaign.id, academyId: campaign?.academyId ?? null };
  } catch (error) {
    logger.warn({ adId, error: (error as Error).message }, "Meta ad lookup failed");
    return null;
  }
}

async function campaignAcademy(campaignId: string | null): Promise<number | null> {
  if (!campaignId) return null;
  const [row] = await db.select({ academyId: metaAdCampaignsTable.academyId }).from(metaAdCampaignsTable).where(eq(metaAdCampaignsTable.id, campaignId));
  return row?.academyId ?? null;
}

/** Make the lead a contact in the academy's People: a lead at stage "new", tagged as from an ad. */
async function fileContact(academyId: number, phone: string, name: string | null): Promise<number> {
  const contact = await upsertContact(academyId, phone, { kind: "lead", source: "meta_ad", name });
  await db.update(academyContactsTable).set({
    tags: sql`case when ${academyContactsTable.tags} @> ${JSON.stringify([AD_TAG])}::jsonb then ${academyContactsTable.tags} else ${academyContactsTable.tags} || ${JSON.stringify([AD_TAG])}::jsonb end`,
    // A number that only messaged in before is now known to be a lead from an ad.
    ...(contact.kind === "lead" && !contact.stage ? { stage: "new" } : {}),
    ...(contact.source === "whatsapp" || contact.source === "manual" ? { source: "meta_ad" } : {}),
    updatedAt: new Date(),
  }).where(eq(academyContactsTable.id, contact.id));
  return contact.id;
}

export type AdLeadInput = {
  source: "lead_form" | "whatsapp";
  externalId: string;
  /** Known academy (the chat arrived on the academy's own number); otherwise the campaign's. */
  academyId?: number | null;
  campaignId?: string | null;
  adId?: string | null;
  formId?: string | null;
  pageId?: string | null;
  phone?: string | null;
  name?: string | null;
  email?: string | null;
  ctwaClid?: string | null;
  headline?: string | null;
  answers?: unknown;
  createdAt?: Date;
};

/** Store a lead from an ad (once) and file it into its academy's People when the academy is known. */
export async function recordAdLead(input: AdLeadInput): Promise<{ academyId: number | null; contactId: number | null; created: boolean }> {
  let campaignId = input.campaignId ?? null;
  let academyId = input.academyId ?? null;
  if (!campaignId && input.adId) {
    const found = await campaignForAd(input.adId);
    campaignId = found?.campaignId ?? null;
    academyId ??= found?.academyId ?? null;
  }
  academyId ??= await campaignAcademy(campaignId);
  const phone = normalizePhone(input.phone ?? null);

  const [row] = await db.insert(metaAdLeadsTable).values({
    source: input.source,
    externalId: input.externalId,
    academyId,
    campaignId,
    adId: input.adId ?? null,
    formId: input.formId ?? null,
    pageId: input.pageId ?? null,
    phone,
    name: input.name?.trim() || null,
    email: input.email?.trim() || null,
    ctwaClid: input.ctwaClid ?? null,
    headline: input.headline ?? null,
    answers: (input.answers ?? null) as never,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  }).onConflictDoNothing().returning({ id: metaAdLeadsTable.id });
  if (!row) return { academyId, contactId: null, created: false };

  let contactId: number | null = null;
  if (academyId !== null && phone) {
    contactId = await fileContact(academyId, phone, input.name?.trim() || null);
    await db.update(metaAdLeadsTable).set({ contactId }).where(eq(metaAdLeadsTable.id, row.id));
  }
  return { academyId, contactId, created: true };
}

/** After a campaign is given an academy: file the leads that arrived before it had one. */
export async function fileUnassignedLeads(campaignId: string, academyId: number): Promise<number> {
  const waiting = await db.select().from(metaAdLeadsTable)
    .where(and(eq(metaAdLeadsTable.campaignId, campaignId), isNull(metaAdLeadsTable.academyId)));
  let filed = 0;
  for (const lead of waiting) {
    const contactId = lead.phone ? await fileContact(academyId, lead.phone, lead.name) : null;
    await db.update(metaAdLeadsTable).set({ academyId, contactId }).where(eq(metaAdLeadsTable.id, lead.id));
    filed += 1;
  }
  return filed;
}

type FieldData = Array<{ name?: string; values?: string[] }>;

/** Name, phone and email out of an instant form's answers, whatever the form called them. */
export function readLeadFields(fieldData: FieldData | undefined): { name: string | null; phone: string | null; email: string | null; answers: Record<string, string> } {
  const answers: Record<string, string> = {};
  for (const field of fieldData ?? []) {
    if (field.name) answers[field.name] = (field.values ?? []).join(", ");
  }
  const pick = (...names: string[]) => {
    for (const n of names) {
      const hit = Object.entries(answers).find(([k]) => k.toLowerCase() === n);
      if (hit?.[1]) return hit[1];
    }
    return null;
  };
  const first = pick("first_name");
  const last = pick("last_name");
  return {
    name: pick("full_name", "name") ?? ([first, last].filter(Boolean).join(" ") || null),
    phone: pick("phone_number", "phone", "mobile", "whatsapp_number"),
    email: pick("email"),
    answers,
  };
}

/** A "leadgen" webhook change: fetch the lead from Meta and record it. */
export async function handleLeadgen(value: { leadgen_id?: string | number; page_id?: string | number; form_id?: string | number; ad_id?: string | number }) {
  const leadgenId = value.leadgen_id ? String(value.leadgen_id) : null;
  if (!leadgenId) return null;
  const pageId = value.page_id ? String(value.page_id) : null;
  // A Page connected with the academy's own business is read with its token.
  const token = await tokenForPage(pageId);
  const lead = await graphGet<{ id: string; created_time?: string; field_data?: FieldData; ad_id?: string; campaign_id?: string; form_id?: string }>(
    leadgenId, { fields: "id,created_time,field_data,ad_id,campaign_id,form_id" }, { token },
  );
  const fields = readLeadFields(lead.field_data);
  return recordAdLead({
    source: "lead_form",
    externalId: `lead:${lead.id}`,
    campaignId: lead.campaign_id ?? null,
    adId: lead.ad_id ?? (value.ad_id ? String(value.ad_id) : null),
    formId: lead.form_id ?? (value.form_id ? String(value.form_id) : null),
    pageId,
    // A form on an academy's own Page belongs to that academy even before its campaign syncs.
    academyId: await academyForPage(pageId),
    phone: fields.phone,
    name: fields.name,
    email: fields.email,
    answers: fields.answers,
    createdAt: lead.created_time ? new Date(lead.created_time) : undefined,
  });
}

async function academyForPage(pageId: string | null): Promise<number | null> {
  if (!pageId) return null;
  const rows = await db.select({ academyId: academyMetaConnectionsTable.academyId }).from(academyMetaConnectionsTable)
    .where(eq(academyMetaConnectionsTable.pageId, pageId));
  // Only when exactly one academy uses this Page.
  return rows.length === 1 ? rows[0].academyId : null;
}
