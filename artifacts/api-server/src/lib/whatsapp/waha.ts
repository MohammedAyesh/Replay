import { createHmac } from "node:crypto";

/**
 * WAHA (WhatsApp HTTP API) client. WAHA runs as a Docker container on vps1.
 *
 * Configuration needs no new deployment secrets: by default the API is the
 * control-API host on port 3000, and the WAHA key is the control key (vps1 stores
 * only its SHA-512). WAHA_URL / WAHA_API_KEY / WAHA_WEBHOOK_SECRET override.
 */

export type WahaSessionStatus =
  | "STOPPED"
  | "STARTING"
  | "SCAN_QR_CODE"
  | "PASSKEY_REQUIRED"
  | "PASSKEY_CONFIRMATION_REQUIRED"
  | "WORKING"
  | "FAILED";

export type WahaSession = {
  name: string;
  status: WahaSessionStatus | string;
  me: { id: string; pushName?: string | null } | null;
};

export class WahaError extends Error {
  status: number;
  transient: boolean;
  constructor(status: number, message: string, transient: boolean) {
    super(message);
    this.status = status;
    this.transient = transient;
  }
}

export function wahaBaseUrl(): string {
  const explicit = process.env.WAHA_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  let control = process.env.CONTABO_CONTROL_URL?.trim() ?? "";
  if (!control) return "";
  if (!/^https?:\/\//i.test(control)) control = `http://${control}`;
  try {
    const url = new URL(control);
    url.port = process.env.WAHA_PORT?.trim() || "3000";
    url.pathname = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function wahaApiKey(): string {
  return process.env.WAHA_API_KEY?.trim() || process.env.CONTABO_CONTROL_KEY?.trim() || "";
}

export function wahaConfigured(): boolean {
  return Boolean(wahaBaseUrl() && wahaApiKey());
}

/** HMAC key WAHA signs webhooks with. Derived from the API key unless set explicitly. */
export function wahaWebhookSecret(): string {
  const explicit = process.env.WAHA_WEBHOOK_SECRET?.trim();
  if (explicit) return explicit;
  const key = wahaApiKey();
  if (!key) return "";
  return createHmac("sha256", key).update("replay-whatsapp-webhook-v1").digest("hex");
}

/** Shared key vps1's cron presents to /api/whatsapp/tick. */
export function whatsappTickKey(): string {
  return process.env.WHATSAPP_TICK_KEY?.trim() || process.env.CONTABO_CONTROL_KEY?.trim() || "";
}

export function publicBaseUrl(): string {
  return (process.env.PUBLIC_SHARE_BASE_URL || process.env.PUBLIC_BASE_URL || "https://replayjo.com").replace(/\/+$/, "");
}

export function webhookUrl(): string {
  return `${publicBaseUrl()}/api/whatsapp/webhook`;
}

export const REPLAY_SESSION = "replay";

export function academySessionName(academyId: number): string {
  return `academy-${academyId}`;
}

export function academyIdFromSessionName(name: string | null | undefined): number | null {
  const match = /^academy-(\d+)$/.exec(name ?? "");
  return match ? Number(match[1]) : null;
}

async function wahaRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  options: { timeoutMs?: number; accept?: string } = {},
): Promise<T> {
  const base = wahaBaseUrl();
  const key = wahaApiKey();
  if (!base || !key) throw new WahaError(503, "WhatsApp service is not configured", false);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "x-api-key": key,
        accept: options.accept ?? "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = (error as { name?: string })?.name === "AbortError";
    throw new WahaError(504, aborted ? "WhatsApp service timed out" : "WhatsApp service unreachable", true);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const message = typeof data === "object" && data !== null
      ? String((data as { message?: unknown; error?: unknown }).message ?? (data as { error?: unknown }).error ?? response.statusText)
      : typeof data === "string" && data ? data.slice(0, 300) : response.statusText;
    throw new WahaError(response.status, message, response.status >= 500 || response.status === 429);
  }
  return data as T;
}

function toSession(raw: unknown): WahaSession | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { name?: unknown; status?: unknown; me?: unknown };
  const me = r.me && typeof r.me === "object"
    ? { id: String((r.me as { id?: unknown }).id ?? ""), pushName: ((r.me as { pushName?: unknown }).pushName as string | null) ?? null }
    : null;
  return { name: String(r.name ?? ""), status: String(r.status ?? "STOPPED"), me: me?.id ? me : null };
}

export async function wahaVersion(): Promise<Record<string, unknown>> {
  return wahaRequest("GET", "/api/server/version", undefined, { timeoutMs: 6_000 });
}

export async function listSessions(): Promise<WahaSession[]> {
  const raw = await wahaRequest<unknown[]>("GET", "/api/sessions?all=true", undefined, { timeoutMs: 8_000 });
  return (Array.isArray(raw) ? raw : []).map(toSession).filter((s): s is WahaSession => s !== null);
}

export async function getSession(name: string): Promise<WahaSession | null> {
  try {
    return toSession(await wahaRequest("GET", `/api/sessions/${encodeURIComponent(name)}`, undefined, { timeoutMs: 5_000 }));
  } catch (error) {
    if (error instanceof WahaError && error.status === 404) return null;
    throw error;
  }
}

/** Every event Replay handles. A session created before one was added is refreshed by refreshWebhookEvents. */
export const WEBHOOK_EVENTS = ["message.any", "message.ack", "session.status", "poll.vote"] as const;

function sessionConfig(metadata: Record<string, string>) {
  const secret = wahaWebhookSecret();
  return {
    metadata,
    webhooks: [
      {
        url: webhookUrl(),
        events: [...WEBHOOK_EVENTS],
        ...(secret ? { hmac: { key: secret } } : {}),
        retries: { policy: "constant", delaySeconds: 5, attempts: 6 },
      },
    ],
  };
}

/** Create the session if missing (or refresh its webhook config) and start it. */
export async function ensureSessionStarted(name: string, metadata: Record<string, string>): Promise<WahaSession> {
  const existing = await getSession(name);
  const config = sessionConfig(metadata);
  if (!existing) {
    const created = await wahaRequest("POST", "/api/sessions", { name, start: true, config });
    return toSession(created) ?? { name, status: "STARTING", me: null };
  }
  await wahaRequest("PUT", `/api/sessions/${encodeURIComponent(name)}`, { name, config });
  if (existing.status === "STOPPED" || existing.status === "FAILED") {
    if (existing.status === "FAILED") {
      await wahaRequest("POST", `/api/sessions/${encodeURIComponent(name)}/restart`).catch(() => undefined);
    } else {
      await wahaRequest("POST", `/api/sessions/${encodeURIComponent(name)}/start`);
    }
  }
  return (await getSession(name)) ?? existing;
}

/** Unlink the phone and stop the session. The session record stays so the owner can relink. */
export async function logoutSession(name: string): Promise<void> {
  await wahaRequest("POST", `/api/sessions/${encodeURIComponent(name)}/logout`).catch((error) => {
    if (!(error instanceof WahaError) || error.status !== 404) throw error;
  });
  await wahaRequest("POST", `/api/sessions/${encodeURIComponent(name)}/stop`).catch(() => undefined);
}

/** QR code as a data URL, or null when WAHA has none (not in SCAN_QR_CODE). */
export async function getQrDataUrl(name: string): Promise<string | null> {
  try {
    const raw = await wahaRequest<{ mimetype?: string; data?: string }>(
      "GET",
      `/api/${encodeURIComponent(name)}/auth/qr?format=image`,
      undefined,
      { accept: "application/json", timeoutMs: 10_000 },
    );
    if (raw && typeof raw.data === "string" && raw.data) return `data:${raw.mimetype || "image/png"};base64,${raw.data}`;
    return null;
  } catch (error) {
    if (error instanceof WahaError && (error.status === 404 || error.status === 422 || error.status === 400)) return null;
    throw error;
  }
}

/** 8-character code the owner types into WhatsApp → Linked devices → Link with phone number. */
export async function requestPairingCode(name: string, phone: string): Promise<string> {
  const raw = await wahaRequest<{ code?: string }>(
    "POST",
    `/api/${encodeURIComponent(name)}/auth/request-code`,
    { phoneNumber: phone },
    { timeoutMs: 20_000 },
  );
  if (!raw?.code) throw new WahaError(502, "WhatsApp did not return a pairing code", true);
  return raw.code;
}

const lidCache = new Map<string, string>();

/**
 * The phone number behind a linked id ("…@lid"), from the session's own mapping. Null when
 * WhatsApp hasn't shared it with this number.
 */
export async function phoneForLid(session: string, lid: string): Promise<string | null> {
  const key = `${session}|${lid}`;
  const cached = lidCache.get(key);
  if (cached) return cached;
  try {
    const raw = await wahaRequest<{ lid?: string; pn?: string | null }>(
      "GET",
      `/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(lid)}`,
      undefined,
      { timeoutMs: 6_000 },
    );
    const pn = typeof raw?.pn === "string" ? raw.pn : null;
    const local = pn?.split("@")[0]?.split(":")[0] ?? "";
    if (!/^\d{8,15}$/.test(local)) return null;
    if (lidCache.size > 5000) lidCache.clear();
    lidCache.set(key, local);
    return local;
  } catch (error) {
    if (error instanceof WahaError && (error.status === 404 || error.status === 400)) return null;
    throw error;
  }
}

/** WhatsApp chat id for a number, or null when the number has no WhatsApp account. */
export async function checkNumber(session: string, phone: string): Promise<string | null> {
  const raw = await wahaRequest<{ numberExists?: boolean; chatId?: string }>(
    "GET",
    `/api/contacts/check-exists?phone=${encodeURIComponent(phone)}&session=${encodeURIComponent(session)}`,
    undefined,
    { timeoutMs: 15_000 },
  );
  if (!raw?.numberExists) return null;
  return raw.chatId || `${phone}@c.us`;
}

function messageIdFrom(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { id?: unknown; key?: { id?: unknown } };
  if (typeof r.id === "string") return r.id;
  if (r.id && typeof r.id === "object") {
    const serialized = (r.id as { _serialized?: unknown; id?: unknown })._serialized ?? (r.id as { id?: unknown }).id;
    if (typeof serialized === "string") return serialized;
  }
  if (r.key && typeof r.key.id === "string") return r.key.id;
  return null;
}

export async function sendText(session: string, chatId: string, text: string): Promise<string | null> {
  const raw = await wahaRequest("POST", "/api/sendText", { session, chatId, text, linkPreview: true }, { timeoutMs: 30_000 });
  return messageIdFrom(raw);
}

/** Bare message id for matching acks: WEBJS ids look like "true_9627…@c.us_ABC", GOWS ids are bare. */
export function bareMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const parts = id.split("_");
  return parts.length >= 3 ? parts.slice(2).join("_") : id;
}

/**
 * Make an existing session's webhook ask for every event in WEBHOOK_EVENTS (votes on polls
 * arrive as "poll.vote"). WAHA restarts a running session to apply a config change, so this
 * only writes when something is missing. Returns true when it updated the session.
 */
export async function refreshWebhookEvents(name: string): Promise<boolean> {
  const raw = await wahaRequest<{ config?: { metadata?: Record<string, string>; webhooks?: Array<{ url?: string; events?: string[] }> } }>(
    "GET", `/api/sessions/${encodeURIComponent(name)}`, undefined, { timeoutMs: 6_000 },
  );
  const hook = raw?.config?.webhooks?.find((w) => w.url === webhookUrl()) ?? raw?.config?.webhooks?.[0];
  const events = new Set(hook?.events ?? []);
  if (WEBHOOK_EVENTS.every((e) => events.has(e) || events.has("*"))) return false;
  await wahaRequest("PUT", `/api/sessions/${encodeURIComponent(name)}`, { name, config: sessionConfig(raw?.config?.metadata ?? {}) });
  return true;
}

// ─── Media, locations, polls, groups ─────────────────────────────────────────

/** A file WAHA downloads from a public URL (Replay's media sits on the Bunny pull zone). */
export type WahaFile = { url: string; mimetype: string; filename?: string };

async function send(path: string, body: Record<string, unknown>): Promise<string | null> {
  // Media sends wait while WAHA downloads (and maybe converts) the file.
  return messageIdFrom(await wahaRequest("POST", path, body, { timeoutMs: 90_000 }));
}

export function sendImage(session: string, chatId: string, file: WahaFile, caption?: string) {
  return send("/api/sendImage", { session, chatId, file, ...(caption ? { caption } : {}) });
}

/** A video; with `gif` WhatsApp shows it as a looping, silent GIF. */
export function sendVideo(session: string, chatId: string, file: WahaFile, caption?: string, gif = false) {
  // GOWS turns on gifPlayback when the file is labelled image/gif; the bytes are an MP4.
  const labelled = gif ? { ...file, mimetype: "image/gif" } : file;
  return send("/api/sendVideo", { session, chatId, file: labelled, convert: true, caption: caption ?? "" });
}

export function sendVoice(session: string, chatId: string, file: WahaFile) {
  return send("/api/sendVoice", { session, chatId, file, convert: true });
}

export function sendFile(session: string, chatId: string, file: WahaFile, caption?: string) {
  return send("/api/sendFile", { session, chatId, file, ...(caption ? { caption } : {}) });
}

export function sendSticker(session: string, chatId: string, file: WahaFile) {
  return send("/api/sendSticker", { session, chatId, file });
}

export function sendLocation(session: string, chatId: string, latitude: number, longitude: number, title?: string) {
  return send("/api/sendLocation", { session, chatId, latitude, longitude, title: title ?? "" });
}

export function sendPoll(session: string, chatId: string, poll: { name: string; options: string[]; multipleAnswers: boolean }) {
  return send("/api/sendPoll", { session, chatId, poll });
}

export type WahaGroup = { id: string; subject: string; participants: number | null };

function toGroup(raw: unknown): WahaGroup | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rawId = r.JID ?? r.id ?? (r.id as { _serialized?: unknown } | undefined)?._serialized ?? r.gid;
  const id = typeof rawId === "string" ? rawId
    : typeof (rawId as { _serialized?: unknown } | undefined)?._serialized === "string" ? String((rawId as { _serialized: string })._serialized) : "";
  if (!id.endsWith("@g.us")) return null;
  const subject = String(r.Name ?? r.subject ?? r.name ?? "").trim();
  const list = r.Participants ?? r.participants;
  return { id: id.slice(0, -"@g.us".length), subject: subject || "Group", participants: Array.isArray(list) ? list.length : null };
}

/** Groups the session's number is in. */
export async function listGroups(session: string): Promise<WahaGroup[]> {
  const raw = await wahaRequest<unknown>("GET", `/api/${encodeURIComponent(session)}/groups?limit=500`, undefined, { timeoutMs: 30_000 });
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw as Record<string, unknown>) : [];
  return list.map(toGroup).filter((g): g is WahaGroup => g !== null);
}

export async function getGroup(session: string, groupId: string): Promise<WahaGroup | null> {
  try {
    return toGroup(await wahaRequest("GET", `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(`${groupId}@g.us`)}`, undefined, { timeoutMs: 10_000 }));
  } catch (error) {
    if (error instanceof WahaError && (error.status === 404 || error.status === 400)) return null;
    throw error;
  }
}

/** Create a group with the given members (chat ids like 9627…@c.us). Returns its id without "@g.us". */
export async function createGroup(session: string, subject: string, participantChatIds: string[]): Promise<WahaGroup> {
  const raw = await wahaRequest("POST", `/api/${encodeURIComponent(session)}/groups`, {
    name: subject,
    participants: participantChatIds.map((id) => ({ id })),
  }, { timeoutMs: 60_000 });
  const group = toGroup(raw);
  if (!group) throw new WahaError(502, "WhatsApp did not return the new group", true);
  return { ...group, subject: group.subject === "Group" ? subject : group.subject };
}

export async function addGroupParticipants(session: string, groupId: string, participantChatIds: string[]): Promise<void> {
  await wahaRequest("POST", `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(`${groupId}@g.us`)}/participants/add`, {
    participants: participantChatIds.map((id) => ({ id })),
  }, { timeoutMs: 30_000 });
}

/**
 * Download a file WAHA saved for an incoming message. Its URL names WAHA's own host, which
 * need not be reachable from here, so only the path is kept and fetched from wahaBaseUrl().
 */
export async function downloadWahaFile(mediaUrl: string, maxBytes: number): Promise<{ buffer: Buffer; mimetype: string } | null> {
  const base = wahaBaseUrl();
  const key = wahaApiKey();
  if (!base || !key) return null;
  let path: string;
  try {
    const parsed = new URL(mediaUrl, base);
    path = parsed.pathname;
  } catch {
    return null;
  }
  if (!path.startsWith("/api/files/")) return null;
  const response = await fetch(`${base}${path}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) return null;
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBytes) return null;
    chunks.push(Buffer.from(chunk));
  }
  return { buffer: Buffer.concat(chunks), mimetype: response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream" };
}
