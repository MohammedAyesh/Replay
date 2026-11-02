import { eq } from "drizzle-orm";
import { academyAdRequestsTable, db, metaAdCampaignsTable, metaAdsTable, type AcademyAdRequest, type AcademyMetaConnection } from "@workspace/db";
import { logger } from "../logger";
import { metaConfig } from "./config";
import { connectionToken, pageToken } from "./connections";
import { graphDelete, graphPost, MetaGraphError } from "./graph";

/**
 * Turn an academy's ad request into Meta objects: (lead form) → campaign → ad set → image →
 * creative → ad. Everything is created PAUSED and switched on at the end, so a failure part-way
 * never spends money; on failure the campaign (and everything under it) is deleted.
 */

/** Meta budgets are in the currency's minor unit; most use cents. */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "CLP", "VND", "ISK", "PYG", "TWD", "HUF", "COP", "IDR"]);
export function currencyOffset(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100;
}

export function targetingFor(request: Pick<AcademyAdRequest, "latitude" | "longitude" | "radiusKm" | "ageMin" | "ageMax">) {
  if (request.latitude === null || request.longitude === null) throw new MetaGraphError("The ad needs a location", 400);
  return {
    geo_locations: {
      custom_locations: [{ latitude: request.latitude, longitude: request.longitude, radius: Math.min(80, Math.max(1, request.radiusKm)), distance_unit: "kilometer" }],
      location_types: ["home", "recent"],
    },
    age_min: Math.max(18, request.ageMin),
    age_max: Math.min(65, request.ageMax),
  };
}

export function creativeSpec(request: Pick<AcademyAdRequest, "goal" | "headline" | "primaryText">, pageId: string, imageHash: string, formId: string | null) {
  const link_data = request.goal === "whatsapp"
    ? {
      image_hash: imageHash,
      message: request.primaryText,
      name: request.headline,
      link: "https://api.whatsapp.com/send",
      call_to_action: { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } },
    }
    : {
      image_hash: imageHash,
      message: request.primaryText,
      name: request.headline,
      link: "http://fb.me/",
      call_to_action: { type: "SIGN_UP", value: { lead_gen_form_id: formId } },
    };
  return { page_id: pageId, link_data };
}

export function leadFormSpec(request: Pick<AcademyAdRequest, "name" | "locale" | "extraQuestion" | "headline">, academyName: string) {
  const ar = request.locale === "ar";
  const questions: Array<Record<string, string>> = [{ type: "FULL_NAME" }, { type: "PHONE" }];
  if (request.extraQuestion?.trim()) questions.push({ type: "CUSTOM", key: "extra", label: request.extraQuestion.trim().slice(0, 80) });
  return {
    name: `${request.name} · ${new Date().toISOString().slice(0, 10)}`.slice(0, 100),
    locale: ar ? "AR_AR" : "EN_GB",
    questions: JSON.stringify(questions),
    privacy_policy: JSON.stringify({ url: "https://replayjo.com/privacy", link_text: ar ? "سياسة الخصوصية" : "Privacy policy" }),
    context_card: JSON.stringify({ title: request.headline.slice(0, 60), style: "PARAGRAPH_STYLE", content: [academyName] }),
    thank_you_page: JSON.stringify({
      title: ar ? "شكراً! رح نتواصل معك قريباً" : "Thanks! We'll be in touch soon",
      body: ar ? `${academyName} رح يتواصل معك على واتساب.` : `${academyName} will message you on WhatsApp.`,
      button_type: "NONE",
    }),
  };
}

type LaunchContext = { token: string | undefined; adAccountId: string; pageId: string; pageToken: () => Promise<string>; academyName: string };

export function launchContext(request: AcademyAdRequest, connection: AcademyMetaConnection | null, academyName: string): LaunchContext {
  if (!connection || connection.status !== "connected" || !connection.pageId) throw new MetaGraphError("Connect the academy's Facebook Page first", 409);
  const adAccountId = request.mode === "own" ? connection.adAccountId : metaConfig().adAccountId;
  if (!adAccountId) throw new MetaGraphError("No ad account to run this ad from", 409);
  return {
    token: request.mode === "own" ? connectionToken(connection) : undefined,
    adAccountId,
    pageId: connection.pageId,
    pageToken: () => pageToken(connection),
    academyName,
  };
}

async function uploadImage(dataUrl: string, ctx: LaunchContext): Promise<string> {
  const match = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
  if (!match) throw new MetaGraphError("The ad needs a JPG or PNG image", 400);
  const res = await graphPost<{ images: Record<string, { hash: string }> }>(`${ctx.adAccountId}/adimages`, { bytes: match[2] }, { token: ctx.token });
  const hash = Object.values(res.images ?? {})[0]?.hash;
  if (!hash) throw new MetaGraphError("Meta didn't accept the image", 502);
  return hash;
}

/** Create and switch on the ad. Updates the request row as it goes. */
export async function launchAdRequest(request: AcademyAdRequest, ctx: LaunchContext): Promise<AcademyAdRequest> {
  const update = async (patch: Partial<AcademyAdRequest>) => {
    const [row] = await db.update(academyAdRequestsTable).set({ ...patch, updatedAt: new Date() }).where(eq(academyAdRequestsTable.id, request.id)).returning();
    return row;
  };
  await update({ status: "launching", error: null });
  const opt = { token: ctx.token };
  let campaignId: string | null = null;
  try {
    if (!request.imageData) throw new MetaGraphError("The ad needs an image", 400);
    const imageHash = await uploadImage(request.imageData, ctx);

    let formId: string | null = null;
    if (request.goal === "lead_form") {
      const form = await graphPost<{ id: string }>(`${ctx.pageId}/leadgen_forms`, leadFormSpec(request, ctx.academyName), { token: await ctx.pageToken() });
      formId = form.id;
    }

    const campaign = await graphPost<{ id: string }>(`${ctx.adAccountId}/campaigns`, {
      name: request.name,
      objective: request.goal === "whatsapp" ? "OUTCOME_ENGAGEMENT" : "OUTCOME_LEADS",
      status: "PAUSED",
      special_ad_categories: "[]",
      is_adset_budget_sharing_enabled: "false",
    }, opt);
    campaignId = campaign.id;

    const adset = await graphPost<{ id: string }>(`${ctx.adAccountId}/adsets`, {
      name: request.name,
      campaign_id: campaign.id,
      daily_budget: String(request.dailyBudget),
      billing_event: "IMPRESSIONS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      optimization_goal: request.goal === "whatsapp" ? "CONVERSATIONS" : "LEAD_GENERATION",
      destination_type: request.goal === "whatsapp" ? "WHATSAPP" : "ON_AD",
      promoted_object: JSON.stringify({ page_id: ctx.pageId }),
      targeting: JSON.stringify(targetingFor(request)),
      ...(request.startAt ? { start_time: request.startAt.toISOString() } : {}),
      ...(request.endAt ? { end_time: request.endAt.toISOString() } : {}),
      status: "PAUSED",
    }, opt);

    const creative = await graphPost<{ id: string }>(`${ctx.adAccountId}/adcreatives`, {
      name: request.name,
      object_story_spec: JSON.stringify(creativeSpec(request, ctx.pageId, imageHash, formId)),
    }, opt);

    const ad = await graphPost<{ id: string }>(`${ctx.adAccountId}/ads`, {
      name: request.name,
      adset_id: adset.id,
      creative: JSON.stringify({ creative_id: creative.id }),
      status: "PAUSED",
    }, opt);

    for (const id of [ad.id, adset.id, campaign.id]) await graphPost(id, { status: "ACTIVE" }, opt);

    // So the Ads page shows it before the next hourly sync.
    await db.insert(metaAdCampaignsTable).values({
      id: campaign.id,
      academyId: request.academyId,
      adAccountId: request.mode === "own" ? ctx.adAccountId : null,
      name: request.name,
      status: "ACTIVE",
      objective: request.goal === "whatsapp" ? "OUTCOME_ENGAGEMENT" : "OUTCOME_LEADS",
      startedAt: request.startAt ?? new Date(),
    }).onConflictDoUpdate({ target: metaAdCampaignsTable.id, set: { academyId: request.academyId, status: "ACTIVE" } });
    await db.insert(metaAdsTable).values({ id: ad.id, campaignId: campaign.id, name: request.name, status: "ACTIVE", syncedAt: new Date() }).onConflictDoNothing();

    return update({
      status: "active",
      metaCampaignId: campaign.id,
      metaAdsetId: adset.id,
      metaAdId: ad.id,
      metaFormId: formId,
      launchedAt: new Date(),
      error: null,
    });
  } catch (error) {
    const message = (error as Error).message?.slice(0, 500) ?? "Failed";
    logger.warn({ requestId: request.id, error: message }, "Launching an academy ad failed");
    if (campaignId) await graphDelete(campaignId, opt).catch(() => undefined);
    return update({ status: "failed", error: message, metaCampaignId: null, metaAdsetId: null, metaAdId: null });
  }
}

export async function setAdRunning(request: AcademyAdRequest, ctx: Pick<LaunchContext, "token">, running: boolean): Promise<AcademyAdRequest> {
  if (!request.metaCampaignId) throw new MetaGraphError("This ad isn't on Meta yet", 409);
  await graphPost(request.metaCampaignId, { status: running ? "ACTIVE" : "PAUSED" }, { token: ctx.token });
  await db.update(metaAdCampaignsTable).set({ status: running ? "ACTIVE" : "PAUSED" }).where(eq(metaAdCampaignsTable.id, request.metaCampaignId));
  const [row] = await db.update(academyAdRequestsTable).set({ status: running ? "active" : "paused", updatedAt: new Date() })
    .where(eq(academyAdRequestsTable.id, request.id)).returning();
  return row;
}
