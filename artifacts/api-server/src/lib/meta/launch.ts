import { and, eq, inArray } from "drizzle-orm";
import { academyAdMediaTable, academyAdRequestsTable, db, metaAdCampaignsTable, metaAdsTable, type AcademyAdRequest, type AcademyMetaConnection } from "@workspace/db";
import { logger } from "../logger";
import { metaConfig } from "./config";
import { connectionToken, pageToken } from "./connections";
import { graphDelete, graphPost, MetaGraphError } from "./graph";
import { ensureMetaVideo, imageHash } from "./media";

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

export type AdVariant = { headline: string; primaryText: string };
export type AdQuestion = { label: string; options?: string[] };
export type AdCard = { mediaId: number; headline?: string | null; description?: string | null };
/** One card's assets on Meta: a photo's hash, or a video and its still's hash. */
export type CardAsset = { imageHash: string; videoId?: string; headline?: string | null; description?: string | null };

const WHATSAPP_LINK = "https://api.whatsapp.com/send";
const LEAD_LINK = "http://fb.me/";

function callToAction(goal: string, formId: string | null) {
  return goal === "whatsapp"
    ? { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP", link: WHATSAPP_LINK } }
    : { type: "SIGN_UP", value: { lead_gen_form_id: formId, link: LEAD_LINK } };
}

/**
 * The object_story_spec for one text version: a single photo, a single video, or a carousel
 * (2–10 cards, each a photo or a video, each with its own headline).
 */
export function creativeFor(goal: string, pageId: string, variant: AdVariant, assets: CardAsset[], formId: string | null) {
  if (!assets.length) throw new MetaGraphError("The ad needs a photo or a video", 400);
  const link = goal === "whatsapp" ? WHATSAPP_LINK : LEAD_LINK;
  const cta = callToAction(goal, formId);
  if (assets.length === 1) {
    const [only] = assets;
    if (only.videoId) {
      return {
        page_id: pageId,
        video_data: { video_id: only.videoId, image_hash: only.imageHash, message: variant.primaryText, title: variant.headline, call_to_action: cta },
      };
    }
    return { page_id: pageId, link_data: { image_hash: only.imageHash, message: variant.primaryText, name: variant.headline, link, call_to_action: cta } };
  }
  return {
    page_id: pageId,
    link_data: {
      message: variant.primaryText,
      link,
      multi_share_optimized: true,
      multi_share_end_card: false,
      call_to_action: cta,
      child_attachments: assets.slice(0, 10).map((a) => ({
        link,
        name: (a.headline || variant.headline).slice(0, 40),
        ...(a.description ? { description: a.description.slice(0, 20) } : {}),
        image_hash: a.imageHash,
        ...(a.videoId ? { video_id: a.videoId } : {}),
        call_to_action: cta,
      })),
    },
  };
}

/** The single-photo spec (kept for callers that only have one photo). */
export function creativeSpec(request: Pick<AcademyAdRequest, "goal" | "headline" | "primaryText">, pageId: string, imageHash: string, formId: string | null) {
  return creativeFor(request.goal, pageId, { headline: request.headline, primaryText: request.primaryText }, [{ imageHash }], formId);
}

export function requestVariants(request: Pick<AcademyAdRequest, "variants" | "headline" | "primaryText">): AdVariant[] {
  const list = Array.isArray(request.variants) ? (request.variants as AdVariant[]).filter((v) => v?.headline && v?.primaryText) : [];
  return list.length ? list.slice(0, 3) : [{ headline: request.headline, primaryText: request.primaryText }];
}

export function requestQuestions(request: Pick<AcademyAdRequest, "questions" | "extraQuestion">): AdQuestion[] {
  const list = Array.isArray(request.questions) ? (request.questions as AdQuestion[]).filter((q) => q?.label?.trim()) : [];
  if (list.length) return list.slice(0, 5);
  return request.extraQuestion?.trim() ? [{ label: request.extraQuestion.trim() }] : [];
}

export function leadFormSpec(request: Pick<AcademyAdRequest, "name" | "locale" | "extraQuestion" | "headline" | "questions">, academyName: string) {
  const ar = request.locale === "ar";
  const questions: Array<Record<string, unknown>> = [{ type: "FULL_NAME" }, { type: "PHONE" }];
  requestQuestions(request).forEach((q, i) => {
    const options = (q.options ?? []).map((o) => o.trim()).filter(Boolean).slice(0, 10);
    questions.push({
      type: "CUSTOM",
      key: i === 0 && !request.questions ? "extra" : `q${i + 1}`,
      label: q.label.trim().slice(0, 80),
      ...(options.length >= 2 ? { options: options.map((value, j) => ({ value: value.slice(0, 80), key: `q${i + 1}_${j + 1}` })) } : {}),
    });
  });
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

/** Each card's photo or video on Meta, in the ad account the ad runs from. */
async function cardAssets(request: AcademyAdRequest, ctx: LaunchContext): Promise<CardAsset[]> {
  const cards = Array.isArray(request.cards) ? (request.cards as AdCard[]) : [];
  if (!cards.length) {
    if (!request.imageData) throw new MetaGraphError("The ad needs a photo or a video", 400);
    return [{ imageHash: await imageHash(request.imageData, ctx.adAccountId, ctx.token) }];
  }
  const ids = cards.map((c) => c.mediaId);
  const rows = await db.select().from(academyAdMediaTable)
    .where(and(eq(academyAdMediaTable.academyId, request.academyId), inArray(academyAdMediaTable.id, ids)));
  const assets: CardAsset[] = [];
  for (const card of cards.slice(0, 10)) {
    const media = rows.find((m) => m.id === card.mediaId);
    if (!media) throw new MetaGraphError("A photo or video in this ad was deleted. Edit the ad and pick another.", 400);
    if (!media.imageData) throw new MetaGraphError("A video in this ad has no still image yet. Try again in a minute.", 409);
    const hash = await imageHash(media.imageData, ctx.adAccountId, ctx.token);
    const videoId = media.kind === "video" ? await ensureMetaVideo(media, ctx.adAccountId, ctx.token) : undefined;
    assets.push({ imageHash: hash, videoId, headline: card.headline, description: card.description });
  }
  return assets;
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
    const assets = await cardAssets(request, ctx);
    const variants = requestVariants(request);

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

    // One ad per text version, in the same ad set: Meta shows more of whichever does better.
    const ads: Array<{ adId: string; variant: number }> = [];
    for (const [index, variant] of variants.entries()) {
      const label = variants.length > 1 ? `${request.name} · ${String.fromCharCode(65 + index)}` : request.name;
      const creative = await graphPost<{ id: string }>(`${ctx.adAccountId}/adcreatives`, {
        name: label,
        object_story_spec: JSON.stringify(creativeFor(request.goal, ctx.pageId, variant, assets, formId)),
      }, opt);
      const ad = await graphPost<{ id: string }>(`${ctx.adAccountId}/ads`, {
        name: label,
        adset_id: adset.id,
        creative: JSON.stringify({ creative_id: creative.id }),
        status: "PAUSED",
      }, opt);
      ads.push({ adId: ad.id, variant: index });
    }

    for (const id of [...ads.map((a) => a.adId), adset.id, campaign.id]) await graphPost(id, { status: "ACTIVE" }, opt);

    // So the Ads page shows it before the next sync.
    await db.insert(metaAdCampaignsTable).values({
      id: campaign.id,
      academyId: request.academyId,
      adAccountId: request.mode === "own" ? ctx.adAccountId : null,
      name: request.name,
      status: "ACTIVE",
      objective: request.goal === "whatsapp" ? "OUTCOME_ENGAGEMENT" : "OUTCOME_LEADS",
      startedAt: request.startAt ?? new Date(),
    }).onConflictDoUpdate({ target: metaAdCampaignsTable.id, set: { academyId: request.academyId, status: "ACTIVE" } });
    for (const a of ads) {
      await db.insert(metaAdsTable).values({ id: a.adId, campaignId: campaign.id, name: request.name, status: "ACTIVE", syncedAt: new Date() }).onConflictDoNothing();
    }

    return update({
      status: "active",
      metaCampaignId: campaign.id,
      metaAdsetId: adset.id,
      metaAdId: ads[0]?.adId ?? null,
      metaAds: ads,
      metaFormId: formId,
      pausedReason: null,
      launchedAt: new Date(),
      error: null,
    });
  } catch (error) {
    const message = (error as Error).message?.slice(0, 500) ?? "Failed";
    logger.warn({ requestId: request.id, error: message }, "Launching an academy ad failed");
    if (campaignId) await graphDelete(campaignId, opt).catch(() => undefined);
    return update({ status: "failed", error: message, metaCampaignId: null, metaAdsetId: null, metaAdId: null, metaAds: null });
  }
}

export async function setAdRunning(request: AcademyAdRequest, ctx: Pick<LaunchContext, "token">, running: boolean): Promise<AcademyAdRequest> {
  if (!request.metaCampaignId) throw new MetaGraphError("This ad isn't on Meta yet", 409);
  await graphPost(request.metaCampaignId, { status: running ? "ACTIVE" : "PAUSED" }, { token: ctx.token });
  await db.update(metaAdCampaignsTable).set({ status: running ? "ACTIVE" : "PAUSED" }).where(eq(metaAdCampaignsTable.id, request.metaCampaignId));
  const [row] = await db.update(academyAdRequestsTable).set({ status: running ? "active" : "paused", pausedReason: null, updatedAt: new Date() })
    .where(eq(academyAdRequestsTable.id, request.id)).returning();
  return row;
}
