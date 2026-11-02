import type { CreativeStatus } from "@workspace/api-zod";

/**
 * Creative hub → Publish: the pure rules (no database, no network) so they
 * can be tested on their own. Routes live in routes/academyCreativePublish.ts,
 * file handling in lib/creative/publishMedia.ts.
 */

// ─── Where a design can go on Instagram / Facebook ──────────────────────────

export type Placement = "feed" | "reel" | "story";
export type SocialTarget = "instagram" | "facebook";
/** academy_social_posts.format */
export type SocialFormat = "image" | "reel" | "story";

type Shape = { kind: string; format: string };

/**
 * Placements a project can take, default first. A 9:16 still is a story only
 * (the feed crops it); a 4:5 or square video is a reel (Instagram publishes
 * every feed video as one); a 9:16 video can be a story or a reel.
 */
export function allowedPlacements(p: Shape): Placement[] {
  const video = p.kind === "video";
  if (p.format === "story") return video ? ["story", "reel"] : ["story"];
  return video ? ["reel"] : ["feed"];
}

export function defaultPlacement(p: Shape): Placement {
  return allowedPlacements(p)[0];
}

export function socialFormatFor(placement: Placement): SocialFormat {
  return placement === "feed" ? "image" : placement;
}

export type PlacementCheck =
  | { ok: true; placement: Placement; format: SocialFormat; targets: SocialTarget[] }
  | { ok: false; error: string; code: string };

/** Validate the placement and targets for a project. Stories go to Instagram only. */
export function checkPlacement(p: Shape, targets: SocialTarget[], requested?: Placement | null): PlacementCheck {
  const allowed = allowedPlacements(p);
  const placement = requested ?? allowed[0];
  if (!allowed.includes(placement)) {
    return { ok: false, code: "placement", error: `This design can go out as ${allowed.join(" or ")}, not ${placement}.` };
  }
  const unique = [...new Set(targets)];
  if (unique.length === 0) return { ok: false, code: "targets", error: "Pick Instagram, Facebook or both" };
  if (placement === "story" && unique.includes("facebook")) {
    return { ok: false, code: "story_facebook", error: "Stories go to Instagram only. Untick Facebook, or post it as a reel." };
  }
  return { ok: true, placement, format: socialFormatFor(placement), targets: unique };
}

// ─── Amman time ─────────────────────────────────────────────────────────────

export const AMMAN_TZ = "Asia/Amman";
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ZONED = /(Z|[+-]\d{2}:?\d{2})$/i;

const wallFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: AMMAN_TZ, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function wallParts(epoch: number) {
  const parts = Object.fromEntries(wallFormat.formatToParts(new Date(epoch)).map((x) => [x.type, x.value]));
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), mi: Number(parts.minute), s: Number(parts.second) };
}

/** Amman's offset from UTC at an instant, in ms (Jordan is UTC+3 all year since 2022; Intl knows if that changes). */
export function ammanOffsetMs(epoch: number): number {
  const w = wallParts(epoch);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(epoch / 1000) * 1000;
}

/** "2026-11-03T18:30" read as Amman wall-clock time → the instant. Null if it isn't a real Amman time. */
export function ammanLocalToDate(value: string): Date | null {
  const m = NAIVE.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let epoch = guess - ammanOffsetMs(guess);
  // Across an offset change the first guess can be an hour out: correct once with the offset at the result.
  epoch = guess - ammanOffsetMs(epoch);
  const back = wallParts(epoch);
  if (back.y !== y || back.mo !== mo || back.d !== d || back.h !== h || back.mi !== mi) return null;
  return new Date(epoch);
}

/** The instant as Amman wall-clock "YYYY-MM-DDTHH:mm" (what a datetime-local input shows). */
export function dateToAmmanLocal(date: Date): string {
  const w = wallParts(date.getTime());
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.y}-${p(w.mo)}-${p(w.d)}T${p(w.h)}:${p(w.mi)}`;
}

export const MAX_SCHEDULE_DAYS = 60;

export type ScheduleCheck = { ok: true; at: Date | null } | { ok: false; error: string; code: string };

/**
 * A scheduled time from the console: either a full ISO time with an offset,
 * or a bare "YYYY-MM-DDTHH:mm" that means Amman time whatever the browser's
 * or the server's clock says (vps1 runs on Berlin time). Empty → now.
 */
export function parseScheduledAt(input: unknown, now = new Date()): ScheduleCheck {
  if (input === null || input === undefined || input === "") return { ok: true, at: null };
  if (typeof input !== "string") return { ok: false, code: "schedule", error: "Pick a date and time" };
  const raw = input.trim();
  let at: Date | null = null;
  if (NAIVE.test(raw)) at = ammanLocalToDate(raw);
  else if (ZONED.test(raw) && !Number.isNaN(Date.parse(raw))) at = new Date(raw);
  if (!at) return { ok: false, code: "schedule", error: "That date and time doesn't look right" };
  if (at.getTime() < now.getTime() - 60_000) return { ok: false, code: "schedule_past", error: "Pick a time in the future" };
  if (at.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * 86_400_000) {
    return { ok: false, code: "schedule_far", error: `Schedule within the next ${MAX_SCHEDULE_DAYS} days` };
  }
  // A minute or two ahead is "now": the worker would post it on its next tick anyway.
  if (at.getTime() <= now.getTime() + 2 * 60_000) return { ok: true, at: null };
  return { ok: true, at };
}

// ─── publish_targets bookkeeping ────────────────────────────────────────────

export type PublishChannel = "instagram" | "facebook" | "whatsapp" | "ad" | "download";

/**
 * One entry of academy_creative_projects.publish_targets. `channel`, `ref` and
 * `at` are the shared contract; the rest is Publish's own detail.
 */
export type PublishTarget = {
  channel: PublishChannel;
  /** "post:12", "broadcast:5", "media:9". */
  ref?: string;
  at: string;
  /** Which render went out (outputs are replaced on re-render). */
  renderedAt?: string | null;
  /** The copy in the academy's media library (academy_ad_media) this used. */
  mediaId?: number;
  postId?: number;
  placement?: Placement;
  scheduledAt?: string | null;
  broadcastId?: number;
  recipients?: number;
  audience?: string;
};

export function readTargets(value: unknown): PublishTarget[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is PublishTarget => Boolean(t) && typeof t === "object" && typeof (t as PublishTarget).channel === "string");
}

/** The media-library copy of this exact render, if one was made already. */
export function mediaIdForRender(targets: PublishTarget[], renderedAt: Date | null): number | null {
  const key = renderedAt ? renderedAt.toISOString() : null;
  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const t = targets[i];
    if (t.mediaId && (t.renderedAt ?? null) === key) return t.mediaId;
  }
  return null;
}

/** Drop the entries of a removed social post. */
export function withoutPost(targets: PublishTarget[], postId: number): PublishTarget[] {
  return targets.filter((t) => t.postId !== postId);
}

/** A download is recorded once per render, not once per tap. */
export function addDownload(targets: PublishTarget[], renderedAt: Date | null, now = new Date()): PublishTarget[] {
  const key = renderedAt ? renderedAt.toISOString() : null;
  if (targets.some((t) => t.channel === "download" && (t.renderedAt ?? null) === key)) return targets;
  return [...targets, { channel: "download", at: now.toISOString(), renderedAt: key }];
}

// ─── Status sync with the social posts ──────────────────────────────────────

export type LinkedPost = {
  id: number;
  status: string;
  error: string | null;
  igMediaId: string | null;
  igPermalink: string | null;
  fbPostId: string | null;
  fbPermalink: string | null;
  scheduledFor: Date | null;
  publishedAt: Date | null;
};

export type TargetState = "scheduled" | "publishing" | "published" | "failed" | "removed" | "sent" | "added" | "downloaded";

/** One target's live state, read from the social post it handed off to. */
export function targetState(t: PublishTarget, post: LinkedPost | undefined): { state: TargetState; permalink: string | null; error: string | null } {
  if (t.channel === "whatsapp") return { state: "sent", permalink: null, error: null };
  if (t.channel === "ad") return { state: "added", permalink: null, error: null };
  if (t.channel === "download") return { state: "downloaded", permalink: null, error: null };
  if (!post) return { state: "removed", permalink: null, error: null };
  const ig = t.channel === "instagram";
  const permalink = ig ? post.igPermalink : post.fbPermalink;
  const posted = ig ? Boolean(post.igMediaId) : Boolean(post.fbPostId);
  // The error text names the channel ("Instagram: …"); show each target its own part.
  const ownError = post.error
    ? post.error.split(" · ").filter((e) => !/^(Instagram|Facebook):/.test(e) || e.startsWith(ig ? "Instagram:" : "Facebook:")).join(" · ") || null
    : null;
  switch (post.status) {
    case "published": return { state: "published", permalink, error: null };
    case "partial": return posted ? { state: "published", permalink, error: null } : { state: "failed", permalink: null, error: ownError };
    case "failed": return { state: "failed", permalink: null, error: ownError };
    case "publishing": return { state: "publishing", permalink: null, error: null };
    default: return { state: "scheduled", permalink: null, error: null };
  }
}

/**
 * What the project's status should be given where it went. Sending on
 * WhatsApp or a post going live makes it published; a post still waiting
 * makes it scheduled; when every hand-off failed or was removed it is back
 * to ready. Adding it to ads or downloading it changes nothing.
 */
export function deriveProjectStatus(
  current: CreativeStatus,
  targets: PublishTarget[],
  posts: Map<number, LinkedPost>,
): { status: CreativeStatus; publishedAt: Date | null } {
  let publishedAt: Date | null = null;
  let waiting = false;
  let handedOff = false;
  for (const t of targets) {
    if (t.channel === "whatsapp") {
      handedOff = true;
      const at = new Date(t.at);
      if (!publishedAt || at < publishedAt) publishedAt = at;
      continue;
    }
    if (t.channel !== "instagram" && t.channel !== "facebook") continue;
    handedOff = true;
    const post = t.postId ? posts.get(t.postId) : undefined;
    const s = targetState(t, post).state;
    if (s === "published") {
      const at = post?.publishedAt ?? new Date(t.at);
      if (!publishedAt || at < publishedAt) publishedAt = at;
    } else if (s === "scheduled" || s === "publishing") {
      waiting = true;
    }
  }
  if (!handedOff) return { status: current, publishedAt: null };
  if (publishedAt) return { status: "published", publishedAt };
  if (waiting) return { status: "scheduled", publishedAt: null };
  return { status: current === "skipped" ? "skipped" : "ready", publishedAt: null };
}

/** The earliest time a still-waiting post is due, for project.scheduledAt. */
export function nextScheduledAt(targets: PublishTarget[], posts: Map<number, LinkedPost>): Date | null {
  let next: Date | null = null;
  for (const t of targets) {
    const post = t.postId ? posts.get(t.postId) : undefined;
    if (!post || (post.status !== "scheduled" && post.status !== "draft")) continue;
    const at = post.scheduledFor ?? null;
    if (at && (!next || at < next)) next = at;
  }
  return next;
}

/** Channels asked for again that already went out (or are waiting) with this same render. */
export function alreadyPosted(targets: PublishTarget[], posts: Map<number, LinkedPost>, channels: SocialTarget[], renderedAt: Date | null): SocialTarget[] {
  const key = renderedAt ? renderedAt.toISOString() : null;
  return channels.filter((c) => targets.some((t) => {
    if (t.channel !== c || (t.renderedAt ?? null) !== key) return false;
    const s = targetState(t, t.postId ? posts.get(t.postId) : undefined).state;
    return s === "published" || s === "scheduled" || s === "publishing";
  }));
}

// ─── Hashtag ────────────────────────────────────────────────────────────────

/** "Galaxy Football Academy" → "#GalaxyFootballAcademy". */
export function academyHashtag(name: string | null | undefined): string | null {
  const words = (name ?? "").normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return null;
  const tag = words.map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join("");
  return `#${tag.slice(0, 60)}`;
}
