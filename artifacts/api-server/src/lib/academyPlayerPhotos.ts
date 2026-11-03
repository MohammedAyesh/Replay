import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import {
  academyPlayerPhotosTable,
  academyPlayersTable,
  db,
  usersTable,
  type AcademyPlayerPhoto,
} from "@workspace/db";
import {
  BUNNY_STORAGE_API_KEY,
  BUNNY_STORAGE_HOSTNAME,
  BUNNY_STORAGE_ZONE,
  deleteBunnyStoragePath,
  isBunnyStorageConfigured,
  uploadBufferToBunnyStorage,
} from "./bunny";
import { logger } from "./logger";

/**
 * Players' photo galleries (academy_player_photos, 0058).
 *
 * An academy photographs its players (often cut-outs on a transparent
 * background, as Souqar posts them) and uploads them in Players. Each player
 * has a gallery and at most one primary photo; the Creative hub's line-ups use
 * the primary one, player posts the one picked. Without a photo the avatar of
 * the player's linked Replay account stands in.
 *
 * Files: Bunny Storage under academy-players/<academyId>/<playerId>-<uuid>.<ext>
 * (an authenticated origin: only this server reads it), or, without Storage
 * (development, tests), a local folder. Transparency is kept: a picture with
 * real alpha is stored as PNG, an opaque one as WebP; nothing is flattened to
 * JPEG. The longest side is at most PLAYER_PHOTO_MAX_SIDE.
 *
 * Players are mostly children: these pictures are only ever served through the
 * academy console to its own members, and the Creative hub only uses them for
 * an academy that shows players' names (see renderMedia.ts).
 */

export const PLAYER_PHOTO_MAX_SIDE = 1600;
export const PLAYER_PHOTO_MAX_BYTES = 12 * 1024 * 1024;
export const PLAYER_PHOTO_MIN_SIDE = 64;
export const PLAYER_PHOTOS_PER_PLAYER = 40;
export const PLAYER_PHOTO_INPUT_TYPES = new Set(["image/png", "image/webp", "image/jpeg"]);

export class PlayerPhotoError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type ProcessedPhoto = { bytes: Buffer; mime: "image/png" | "image/webp"; width: number; height: number; transparent: boolean };

/**
 * Share of see-through pixels above which a picture counts as a cut-out. A
 * photo with a few soft corners (a phone's rounded export) is not one.
 */
export const CUTOUT_MIN_TRANSPARENT_SHARE = 0.03;

/** Fraction of pixels that are noticeably transparent (alpha < 240), sampled on a grid. */
export function transparentShare(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): number {
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40_000)));
  let seen = 0;
  let clear = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      seen += 1;
      if (rgba[(y * width + x) * 4 + 3] < 240) clear += 1;
    }
  }
  return seen ? clear / seen : 0;
}

/** Decode, scale down to PLAYER_PHOTO_MAX_SIDE, detect transparency and encode (PNG with alpha, else WebP). */
export async function processPlayerPhoto(input: Buffer): Promise<ProcessedPhoto> {
  let img: Image;
  try {
    img = await loadImage(input);
  } catch {
    throw new PlayerPhotoError("That file isn't a picture we can read. Use a PNG, WebP or JPG.");
  }
  if (!img.width || !img.height || Math.min(img.width, img.height) < PLAYER_PHOTO_MIN_SIDE) {
    throw new PlayerPhotoError("That picture is too small. Use one at least 64 pixels wide and tall.");
  }
  const k = Math.min(1, PLAYER_PHOTO_MAX_SIDE / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * k));
  const height = Math.max(1, Math.round(img.height * k));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const share = transparentShare(ctx.getImageData(0, 0, width, height).data, width, height);
  const transparent = share >= CUTOUT_MIN_TRANSPARENT_SHARE;
  const bytes = transparent ? canvas.toBuffer("image/png") : canvas.toBuffer("image/webp", 90);
  return { bytes, mime: transparent ? "image/png" : "image/webp", width, height, transparent };
}

// ── Files ───────────────────────────────────────────────────────────────────

export function localPlayerPhotoDir(): string {
  return process.env.PLAYER_PHOTO_DIR || path.join(os.tmpdir(), "replay-player-photos");
}

const STORAGE_PATH = /^academy-players\/(\d+)\/(\d+)-[0-9a-f-]{36}\.(png|webp)$/;

/** Keep the bytes; returns what academy_player_photos.path stores. */
export async function storePlayerPhotoFile(academyId: number, playerId: number, photo: ProcessedPhoto): Promise<string> {
  const ext = photo.mime === "image/png" ? "png" : "webp";
  const rel = `academy-players/${academyId}/${playerId}-${randomUUID()}.${ext}`;
  if (isBunnyStorageConfigured()) {
    await uploadBufferToBunnyStorage(photo.bytes, rel, photo.mime);
    return rel;
  }
  const file = path.join(localPlayerPhotoDir(), rel);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, photo.bytes);
  return `local:${rel}`;
}

/** The path is one of ours and belongs to this academy (never read an arbitrary path from a row). */
function ownPath(stored: string, academyId: number): { local: boolean; rel: string } | null {
  const local = stored.startsWith("local:");
  const rel = local ? stored.slice("local:".length) : stored;
  const m = STORAGE_PATH.exec(rel);
  if (!m || Number(m[1]) !== academyId) return null;
  return { local, rel };
}

const cache = new Map<string, Buffer>();
const CACHE_ENTRIES = 48;

/** The stored bytes, or null when the file is gone. */
export async function readPlayerPhotoFile(row: Pick<AcademyPlayerPhoto, "path" | "academyId">): Promise<Buffer | null> {
  const own = ownPath(row.path, row.academyId);
  if (!own) return null;
  const hit = cache.get(row.path);
  if (hit) return hit;
  let bytes: Buffer | null = null;
  try {
    if (own.local) {
      bytes = await fs.promises.readFile(path.join(localPlayerPhotoDir(), own.rel));
    } else if (isBunnyStorageConfigured()) {
      const response = await fetch(`https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${own.rel}`, {
        headers: { AccessKey: BUNNY_STORAGE_API_KEY }, signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) bytes = Buffer.from(await response.arrayBuffer());
    }
  } catch (err) {
    logger.warn({ err, academyId: row.academyId }, "Player photo: file unavailable");
    bytes = null;
  }
  if (bytes) {
    cache.set(row.path, bytes);
    if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  return bytes;
}

/** Best effort: the file of a deleted photo goes. */
export async function deletePlayerPhotoFile(row: Pick<AcademyPlayerPhoto, "path" | "academyId">): Promise<void> {
  const own = ownPath(row.path, row.academyId);
  cache.delete(row.path);
  if (!own) return;
  try {
    if (own.local) await fs.promises.rm(path.join(localPlayerPhotoDir(), own.rel), { force: true });
    else if (isBunnyStorageConfigured()) await deleteBunnyStoragePath(own.rel);
  } catch (err) {
    logger.warn({ err, academyId: row.academyId }, "Player photo: deleting the file failed");
  }
}

// ── Rows ────────────────────────────────────────────────────────────────────

export async function academyPlayer(academyId: number, playerId: number) {
  const [row] = await db.select().from(academyPlayersTable)
    .where(and(eq(academyPlayersTable.id, playerId), eq(academyPlayersTable.academyId, academyId)));
  return row ?? null;
}

/** One photo, only if it is this academy's. */
export async function academyPlayerPhoto(academyId: number, photoId: number): Promise<AcademyPlayerPhoto | null> {
  const [row] = await db.select().from(academyPlayerPhotosTable)
    .where(and(eq(academyPlayerPhotosTable.id, photoId), eq(academyPlayerPhotosTable.academyId, academyId)));
  return row ?? null;
}

/** A player's gallery, primary first, then newest. */
export async function playerGallery(academyId: number, playerId: number): Promise<AcademyPlayerPhoto[]> {
  return db.select().from(academyPlayerPhotosTable)
    .where(and(eq(academyPlayerPhotosTable.academyId, academyId), eq(academyPlayerPhotosTable.playerId, playerId)))
    .orderBy(desc(academyPlayerPhotosTable.isPrimary), desc(academyPlayerPhotosTable.createdAt), desc(academyPlayerPhotosTable.id));
}

/** Add a processed photo to a player's gallery; the first one becomes primary. */
export async function addPlayerPhoto(input: {
  academyId: number; playerId: number; photo: ProcessedPhoto; label?: string | null; createdBy: number | null; makePrimary?: boolean;
}): Promise<AcademyPlayerPhoto> {
  const existing = await db.select({ id: academyPlayerPhotosTable.id, isPrimary: academyPlayerPhotosTable.isPrimary })
    .from(academyPlayerPhotosTable)
    .where(and(eq(academyPlayerPhotosTable.academyId, input.academyId), eq(academyPlayerPhotosTable.playerId, input.playerId)));
  if (existing.length >= PLAYER_PHOTOS_PER_PLAYER) {
    throw new PlayerPhotoError(`A player can have at most ${PLAYER_PHOTOS_PER_PLAYER} photos. Delete some first.`, 409);
  }
  const path = await storePlayerPhotoFile(input.academyId, input.playerId, input.photo);
  const primary = input.makePrimary === true || !existing.some((p) => p.isPrimary);
  return db.transaction(async (tx) => {
    if (primary) {
      await tx.update(academyPlayerPhotosTable).set({ isPrimary: false })
        .where(and(eq(academyPlayerPhotosTable.playerId, input.playerId), eq(academyPlayerPhotosTable.isPrimary, true)));
    }
    const [row] = await tx.insert(academyPlayerPhotosTable).values({
      academyId: input.academyId,
      playerId: input.playerId,
      path,
      mime: input.photo.mime,
      width: input.photo.width,
      height: input.photo.height,
      transparent: input.photo.transparent,
      label: cleanLabel(input.label),
      isPrimary: primary,
      createdBy: input.createdBy,
    }).returning();
    return row;
  });
}

export function cleanLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const t = label.replace(/\s+/g, " ").trim().slice(0, 40);
  return t || null;
}

export async function setPrimaryPhoto(academyId: number, photo: AcademyPlayerPhoto): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(academyPlayerPhotosTable).set({ isPrimary: false })
      .where(and(eq(academyPlayerPhotosTable.academyId, academyId), eq(academyPlayerPhotosTable.playerId, photo.playerId), eq(academyPlayerPhotosTable.isPrimary, true)));
    await tx.update(academyPlayerPhotosTable).set({ isPrimary: true }).where(eq(academyPlayerPhotosTable.id, photo.id));
  });
}

/** Delete a photo; when it was the primary one, the newest remaining photo becomes primary. */
export async function removePlayerPhoto(academyId: number, photo: AcademyPlayerPhoto): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(academyPlayerPhotosTable).where(and(eq(academyPlayerPhotosTable.id, photo.id), eq(academyPlayerPhotosTable.academyId, academyId)));
    if (!photo.isPrimary) return;
    const [next] = await tx.select({ id: academyPlayerPhotosTable.id }).from(academyPlayerPhotosTable)
      .where(eq(academyPlayerPhotosTable.playerId, photo.playerId))
      .orderBy(desc(academyPlayerPhotosTable.createdAt), desc(academyPlayerPhotosTable.id)).limit(1);
    if (next) await tx.update(academyPlayerPhotosTable).set({ isPrimary: true }).where(eq(academyPlayerPhotosTable.id, next.id));
  });
  await deletePlayerPhotoFile(photo);
}

// ── What a player looks like in a design ────────────────────────────────────

/**
 * The picture standing for a player: his primary photo, else (no photo at all)
 * his linked account's avatar, else nothing. Precedence is the academy's own
 * photo first: the academy chose it.
 */
export type PlayerPicture =
  | { kind: "photo"; photo: AcademyPlayerPhoto }
  | { kind: "avatar"; userId: number; avatarPath: string }
  | null;

export function pickPlayerPicture(
  photos: AcademyPlayerPhoto[],
  avatar: { userId: number | null; avatarPath: string | null } | null,
): PlayerPicture {
  const primary = photos.find((p) => p.isPrimary) ?? [...photos].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)[0];
  if (primary) return { kind: "photo", photo: primary };
  if (avatar?.userId && avatar.avatarPath) return { kind: "avatar", userId: avatar.userId, avatarPath: avatar.avatarPath };
  return null;
}

/** The pictures of many players of one academy (players of another academy are left out). */
export async function playerPictures(academyId: number, playerIds: number[]): Promise<Map<number, NonNullable<PlayerPicture>>> {
  const out = new Map<number, NonNullable<PlayerPicture>>();
  const ids = [...new Set(playerIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) return out;
  const [players, photos] = await Promise.all([
    db.select({ id: academyPlayersTable.id, userId: academyPlayersTable.userId, avatarPath: usersTable.avatarPath })
      .from(academyPlayersTable)
      .leftJoin(usersTable, eq(usersTable.id, academyPlayersTable.userId))
      .where(and(eq(academyPlayersTable.academyId, academyId), inArray(academyPlayersTable.id, ids))),
    db.select().from(academyPlayerPhotosTable)
      .where(and(eq(academyPlayerPhotosTable.academyId, academyId), inArray(academyPlayerPhotosTable.playerId, ids)))
      .orderBy(asc(academyPlayerPhotosTable.id)),
  ]);
  const byPlayer = new Map<number, AcademyPlayerPhoto[]>();
  for (const p of photos) byPlayer.set(p.playerId, [...(byPlayer.get(p.playerId) ?? []), p]);
  for (const p of players) {
    const pic = pickPlayerPicture(byPlayer.get(p.id) ?? [], { userId: p.userId, avatarPath: p.avatarPath ?? null });
    if (pic) out.set(p.id, pic);
  }
  return out;
}

/** Read an avatar the way /users/:id/avatar does (Bunny Storage), or null. */
export async function readAvatarFile(avatarPath: string): Promise<Buffer | null> {
  if (!isBunnyStorageConfigured() || !/^avatars\/u\d+-[A-Za-z0-9_-]+\.(jpg|png|webp)$/.test(avatarPath)) return null;
  const hit = cache.get(avatarPath);
  if (hit) return hit;
  try {
    const response = await fetch(`https://${BUNNY_STORAGE_HOSTNAME}/${BUNNY_STORAGE_ZONE}/${avatarPath}`, {
      headers: { AccessKey: BUNNY_STORAGE_API_KEY }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    cache.set(avatarPath, bytes);
    if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    return bytes;
  } catch {
    return null;
  }
}

/** A photo as the console lists it (never the storage path). */
export function photoView(p: AcademyPlayerPhoto) {
  return {
    photoId: p.id,
    playerId: p.playerId,
    width: p.width,
    height: p.height,
    transparent: p.transparent,
    label: p.label,
    isPrimary: p.isPrimary,
    createdAt: p.createdAt.toISOString(),
    url: `/api/academy/console/academies/${p.academyId}/players/${p.playerId}/photos/${p.id}/file?v=${p.id}`,
  };
}

// ── Bulk shoot upload: file name → shirt number (shared with the console) ──

export { matchShootFiles, shirtNumberFromFileName } from "@workspace/api-zod";
