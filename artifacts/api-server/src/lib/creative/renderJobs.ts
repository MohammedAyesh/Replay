import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, lt } from "drizzle-orm";
import { createCanvas } from "@napi-rs/canvas";
import { academyCreativeProjectsTable, db, renderSnapshotsTable, type AcademyCreativeProject, type RenderSnapshotDocument } from "@workspace/db";
import { sceneForData, sceneSchema, type Scene } from "@workspace/api-zod";
import type { AcademyOwnerAccess } from "../academyOwner";
import { logger } from "../logger";
import { renderScenePng, sceneSize } from "./render";
import { CAMERA_4K_AUTOPILOT_PROBE_MS, CreativeRenderError, creativeImageResolver, creativeVideoResolver, loadCreativeContext, serverData } from "./renderMedia";
import { resolveSceneMusic } from "./music";
import { deleteOutput, storeOutput, storeSnapshotAsset } from "./renderStore";
import { renderSceneMp4 } from "./renderVideo";
import { creativeBranding } from "./renderBranding";
import { inspectRenderedPng, inspectRenderedVideo, sha256Buffer, sha256File } from "../renderSnapshots";
import type { CreativeResolvedVideoSource } from "./renderMedia";
import { encodeCard } from "../clipBranding/backup";
import { isBunnyStorageConfigured } from "../bunny";

/**
 * Creative hub engine: render jobs.
 *
 * Stills render in the request. Videos queue: render_status goes queued →
 * rendering → done | failed on the project row, and the console polls the
 * project. One render per project at a time; at most CREATIVE_VIDEO_RENDERS
 * (default 1) ffmpeg passes at once on this server, the rest wait their turn.
 * Scratch files live in one temp directory per job, removed when it ends.
 *
 * The guard is in this process. A stale queued/rendering row is marked failed
 * at start-up; live renders heartbeat their shared row to protect other replicas.
 */

const active = new Set<number>();
const MAX_VIDEO_RENDERS = Math.max(1, Number(process.env.CREATIVE_VIDEO_RENDERS) || 1);
/** A bounded cached probe; not a wait for the 4K upload pipeline. */
export const AUTOPILOT_CAMERA_4K_PROBE_MS = CAMERA_4K_AUTOPILOT_PROBE_MS;
let runningVideos = 0;
const waiting: Array<() => void> = [];

export const isRendering = (projectId: number) => active.has(projectId);

function creativeSnapshotDocument(input: {
  row: AcademyCreativeProject;
  scene: Scene;
  effectiveScene: Scene;
  data: unknown;
  ctx: Awaited<ReturnType<typeof loadCreativeContext>>;
  output: { mimeType: string; width: number; height: number; durationMs: number | null };
  branding?: Awaited<ReturnType<typeof creativeBranding>>;
  resolvedVideoSources?: CreativeResolvedVideoSource[];
  snapshotAssets?: RenderSnapshotDocument["assets"];
  replayable?: boolean;
  music?: { requested: unknown; durationMs: number | null; loudnessLufs: number | null; sha256: string | null };
}): RenderSnapshotDocument {
  const look = {
    nameEn: input.ctx.look.nameEn,
    nameAr: input.ctx.look.nameAr,
    taglineAr: input.ctx.look.taglineAr,
    primaryColor: input.ctx.look.primaryColor,
    accentColor: input.ctx.look.accentColor,
    bookingPhone: input.ctx.look.bookingPhone,
    instagram: input.ctx.look.instagram,
    isAcademy: input.ctx.look.isAcademy,
    crestPresent: !!input.ctx.look.crest,
  };
  const mediaSources = input.effectiveScene.layers.flatMap((layer) => {
    const raw = layer as unknown as Record<string, unknown>;
    const source = raw.source ?? raw.src;
    return source ? [{ layerId: layer.id, kind: layer.kind, source }] : [];
  });
  const framing = input.effectiveScene.layers.flatMap((layer) =>
    layer.kind === "video" && layer.framing ? [{ layerId: layer.id, source: layer.src, framing: layer.framing }] : [],
  );
  const overlay = input.branding?.overlayPath ? { generated: true } : null;
  const endCard = input.branding?.endScreen
    ? {
      kind: input.branding.endScreen.spec.kind,
      spec: input.branding.endScreen.spec,
      seconds: input.branding.endScreen.seconds,
      blur: input.branding.endScreen.blur,
      dim: input.branding.endScreen.dim,
    }
    : null;
  const music = input.music ?? {
    requested: input.effectiveScene.music ?? null,
    durationMs: null,
    loudnessLufs: null,
    sha256: null,
  };
  const sourceAssets = mediaSources.map((entry) => {
    const source = entry.source as Record<string, unknown>;
    const type = typeof source?.type === "string" ? source.type : "scene-source";
    const id = source?.clipId ?? source?.recordingId ?? source?.mediaId ?? source?.key ?? source?.type;
    return { kind: type, locator: id == null ? null : `${type}:${String(id)}`, sha256: null };
  }).filter((asset) => asset.locator !== null);
  const assets = [...sourceAssets, ...(input.snapshotAssets ?? [])];
  if (music.sha256) {
    const requested = music.requested as Record<string, unknown> | null;
    const locator = requested?.trackId != null
      ? `music-track:${String(requested.trackId)}`
      : typeof requested?.trackKey === "string" ? `music-key:${requested.trackKey}` : null;
    assets.push({ kind: "music", locator, sha256: music.sha256 });
  }
  for (const resolved of input.resolvedVideoSources ?? []) {
    assets.push({
      kind: `video-source:${resolved.selectedKind}`,
      locator: resolved.locator,
      sha256: null,
    });
  }
  const replayable = (input.replayable ?? true)
    && sourceAssets.every((asset) => !!asset.sha256)
    && assets.every((asset) => !!asset.locator && !!asset.sha256);
  return {
    schemaVersion: 1,
    renderKind: "creative_project",
    renderer: { name: input.row.kind === "video" ? "creative-scene-mp4" : "creative-scene-png", version: "creative-scene-v1" },
    renderedAt: new Date().toISOString(),
    source: {
      selectionPolicy: {
        clip: ["camera-original-4k", "saved-export", "playable-stream"],
        recording: ["camera-original-4k", "playable-stream"],
        upload: ["academy-storage"],
      },
      mediaSources,
      framing,
      resolvedVideoSources: input.resolvedVideoSources ?? [],
    },
    timeWindow: {
      durationMs: input.effectiveScene.durationMs ?? null,
      frameRate: input.row.kind === "video" ? 30 : null,
      music: music.requested,
    },
    crop: framing,
    output: input.output,
    text: input.effectiveScene.layers.filter((layer) => layer.kind === "text"),
    branding: {
      requested: input.effectiveScene.branding ?? null,
      brand: input.ctx.brand,
      look,
      overlay,
      logoAsset: input.snapshotAssets?.find((asset) => asset.kind === "logo") ?? null,
      overlayAsset: input.snapshotAssets?.find((asset) => asset.kind === "overlay") ?? null,
    },
    endCard: {
      templateVersion: "creative-sign-off-v1",
      settings: input.effectiveScene.branding ?? null,
      rendered: endCard,
      asset: input.snapshotAssets?.find((asset) => asset.kind === "end_card") ?? null,
    },
    music,
    template: { id: input.row.templateKey, version: input.row.style ?? "creative-scene-v1" },
    content: {
      scene: input.scene,
      effectiveScene: input.effectiveScene,
      data: input.data,
      brand: input.ctx.brand,
      look,
      templateKey: input.row.templateKey,
      style: input.row.style,
      format: input.row.format,
      origin: input.row.origin,
      originKey: input.row.originKey,
    },
    assets,
    replayable,
    replayabilityReason: replayable ? null : "A source or render input asset was not durably captured with a checksum.",
  };
}

async function storeSnapshotBytes(
  academyId: number,
  projectId: number,
  dir: string,
  temps: string[],
  kind: string,
  bytes: Buffer,
  ext: string,
  mime: string,
): Promise<RenderSnapshotDocument["assets"][number]> {
  const sha256 = sha256Buffer(bytes);
  const file = path.join(dir, `snapshot-${kind}-${sha256}.${ext}`);
  await fs.promises.writeFile(file, bytes);
  temps.push(file);
  try {
    return {
      kind,
      locator: await storeSnapshotAsset(academyId, projectId, file, sha256, ext),
      sha256,
    };
  } catch (err) {
    logger.warn({ err, projectId, academyId, kind }, "Creative render snapshot input could not be stored");
    return { kind, locator: null, sha256 };
  }
}

async function storeSnapshotFile(
  academyId: number,
  projectId: number,
  file: string,
  kind: string,
  ext: string,
): Promise<RenderSnapshotDocument["assets"][number]> {
  const sha256 = await sha256File(file);
  try {
    return {
      kind,
      locator: await storeSnapshotAsset(academyId, projectId, file, sha256, ext),
      sha256,
    };
  } catch (err) {
    logger.warn({ err, projectId, academyId, kind }, "Creative render snapshot input could not be stored");
    return { kind, locator: null, sha256 };
  }
}

function crestSnapshotPng(look: Awaited<ReturnType<typeof loadCreativeContext>>["look"]): Buffer | null {
  if (!look.crest) return null;
  const canvas = createCanvas(512, 512);
  const ctx = canvas.getContext("2d");
  const scale = Math.min(512 / look.crest.width, 512 / look.crest.height);
  ctx.drawImage(look.crest, (512 - look.crest.width * scale) / 2, (512 - look.crest.height * scale) / 2, look.crest.width * scale, look.crest.height * scale);
  return canvas.toBuffer("image/png");
}

async function setStatus(id: number, set: Partial<typeof academyCreativeProjectsTable.$inferInsert>): Promise<AcademyCreativeProject> {
  const [row] = await db.update(academyCreativeProjectsTable).set({ ...set, updatedAt: new Date() }).where(eq(academyCreativeProjectsTable.id, id)).returning();
  return row;
}

function sceneOf(row: AcademyCreativeProject): Scene {
  const parsed = sceneSchema.safeParse(row.scene);
  if (!parsed.success) throw new CreativeRenderError("This design can't be read. Open it in the editor and save it again.");
  return parsed.data;
}

function readableError(err: unknown): string {
  if (err instanceof CreativeRenderError) return err.message;
  return "Couldn't make this one. Try again.";
}

async function cleanup(temps: string[], dir: string | null): Promise<void> {
  await Promise.all(temps.map((t) => fs.promises.rm(t, { force: true }).catch(() => {})));
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Render a still now; returns the updated row (done or failed). */
export async function renderStillNow(
  access: AcademyOwnerAccess,
  row: AcademyCreativeProject,
  options: { sourceWaitMs?: number } = {},
): Promise<AcademyCreativeProject> {
  active.add(row.id);
  const temps: string[] = [];
  let dir: string | null = null;
  let uncommittedOutput: string | null = null;
  try {
    const scene = sceneOf(row);
    await setStatus(row.id, { renderStatus: "rendering", renderError: null });
    const ctx = await loadCreativeContext(access, temps);
    const data = serverData(access, ctx, row.data);
    const effectiveScene = sceneForData(scene, data);
    const png = await renderScenePng({
      scene: effectiveScene, brand: ctx.brand, data,
      images: creativeImageResolver(access.academyId, ctx.look, options.sourceWaitMs, temps),
    });
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "creative-still-"));
    const file = path.join(dir, "out.png");
    await fs.promises.writeFile(file, png);
    const outputPath = await storeOutput(access.academyId, row.id, file, "png");
    uncommittedOutput = outputPath;
    const facts = inspectRenderedPng(png);
    const size = sceneSize(effectiveScene);
    const snapshotAssets: RenderSnapshotDocument["assets"] = [];
    const logoBytes = crestSnapshotPng(ctx.look);
    if (logoBytes) {
      snapshotAssets.push(await storeSnapshotBytes(access.academyId, row.id, dir, temps, "logo", logoBytes, "png", "image/png"));
    }
    const replayable = snapshotAssets.every((asset) => !!asset.locator && !!asset.sha256)
      && (isBunnyStorageConfigured() || snapshotAssets.length === 0);
    const snapshot = creativeSnapshotDocument({
      row,
      scene,
      effectiveScene,
      data,
      ctx,
      output: { mimeType: "image/png", width: facts.width || size.w, height: facts.height || size.h, durationMs: null },
      snapshotAssets,
      replayable,
    });
    const renderedAt = new Date();
    const [done] = await db.transaction(async (tx) => {
      const rows = await tx.update(academyCreativeProjectsTable)
        .set({ outputPath, outputMime: "image/png", renderStatus: "done", renderError: null, renderedAt, updatedAt: renderedAt })
        .where(eq(academyCreativeProjectsTable.id, row.id))
        .returning();
      if (rows.length) {
        await tx.insert(renderSnapshotsTable).values({
          artifactKey: `creative_project:${row.id}`,
          outputLocator: outputPath,
          outputSha256: facts.sha256,
          snapshot,
        }).onConflictDoUpdate({
          target: [renderSnapshotsTable.artifactKey, renderSnapshotsTable.outputLocator],
          set: { outputSha256: facts.sha256, snapshot, createdAt: renderedAt },
        });
      }
      return rows;
    });
    if (!done) throw new Error("Creative project disappeared before its render snapshot was saved.");
    uncommittedOutput = null;
    if (row.outputPath && row.outputPath !== outputPath) void deleteOutput(row.outputPath, access.academyId);
    return done;
  } catch (err) {
    if (uncommittedOutput) await deleteOutput(uncommittedOutput, access.academyId);
    if (!(err instanceof CreativeRenderError)) logger.error({ err, projectId: row.id, academyId: access.academyId }, "Creative still render failed");
    return setStatus(row.id, { renderStatus: "failed", renderError: readableError(err) });
  } finally {
    active.delete(row.id);
    await cleanup(temps, dir);
  }
}

async function videoSlot<T>(work: () => Promise<T>): Promise<T> {
  if (runningVideos >= MAX_VIDEO_RENDERS) await new Promise<void>((go) => waiting.push(go));
  runningVideos++;
  try {
    return await work();
  } finally {
    runningVideos--;
    waiting.shift()?.();
  }
}

async function runVideo(
  access: AcademyOwnerAccess,
  row: AcademyCreativeProject,
  scene: Scene,
  options: { sourceWaitMs?: number } = {},
): Promise<void> {
  const temps: string[] = [];
  let dir: string | null = null;
  let uncommittedOutput: string | null = null;
  const heartbeat = setInterval(() => {
    void db.update(academyCreativeProjectsTable)
      .set({ updatedAt: new Date() })
      .where(and(
        eq(academyCreativeProjectsTable.id, row.id),
        inArray(academyCreativeProjectsTable.renderStatus, ["queued", "rendering"]),
      ))
      .catch((err) => logger.warn({ err, projectId: row.id }, "Creative render heartbeat failed"));
  }, 60_000);
  heartbeat.unref();
  try {
    await videoSlot(async () => {
      await setStatus(row.id, { renderStatus: "rendering", renderError: null });
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "creative-video-"));
      const ctx = await loadCreativeContext(access, temps);
      const out = path.join(dir, "out.mp4");
      const started = Date.now();
      const data = serverData(access, ctx, row.data);
      const effectiveScene = sceneForData(scene, data);
      // Replay's tracks or this academy's own, nothing else (resolveSceneMusic checks).
      const music = await resolveSceneMusic(access.academyId, scene.music, temps);
      const branding = await creativeBranding(access.academyId, scene, sceneSize(scene), temps);
      const resolvedVideoSources: CreativeResolvedVideoSource[] = [];
      const renderResult = await renderSceneMp4({
        branding,
        scene: effectiveScene, brand: ctx.brand, data,
        images: creativeImageResolver(access.academyId, ctx.look, options.sourceWaitMs, temps),
        videos: creativeVideoResolver(
          access.academyId,
          dir,
          temps,
          options.sourceWaitMs,
          (resolved) => { resolvedVideoSources.push(resolved); },
        ),
        music,
        workDir: dir, out,
      });
      const outputPath = await storeOutput(access.academyId, row.id, out, "mp4");
      uncommittedOutput = outputPath;
      const facts = await inspectRenderedVideo(out);
      const musicSha = music ? await sha256File(music.path).catch(() => null) : null;
      const size = sceneSize(effectiveScene);
      const snapshotAssets: RenderSnapshotDocument["assets"] = [];
      const logoBytes = crestSnapshotPng(ctx.look);
      if (logoBytes) {
        snapshotAssets.push(await storeSnapshotBytes(access.academyId, row.id, dir, temps, "logo", logoBytes, "png", "image/png"));
      }
      if (branding.overlayPath) {
        snapshotAssets.push(await storeSnapshotFile(access.academyId, row.id, branding.overlayPath, "overlay", "png"));
      }
      if (branding.endScreen) {
        try {
          const card = await encodeCard(branding.endScreen, size);
          snapshotAssets.push(await storeSnapshotBytes(
            access.academyId, row.id, dir, temps, "end_card", card.buffer, card.ext,
            card.ext === "webm" ? "video/webm" : "video/quicktime",
          ));
        } catch (err) {
          logger.warn({ err, projectId: row.id }, "Creative end-card snapshot could not be encoded");
        }
      }
      if (music) snapshotAssets.push(await storeSnapshotFile(access.academyId, row.id, music.path, "music", path.extname(music.path).slice(1) || "m4a"));
      const replayable = snapshotAssets.every((asset) => !!asset.locator && !!asset.sha256)
        && (isBunnyStorageConfigured() || snapshotAssets.length === 0);
      const snapshot = creativeSnapshotDocument({
        row,
        scene,
        effectiveScene,
        data,
        ctx,
        branding,
        resolvedVideoSources,
        snapshotAssets,
        replayable,
        music: {
          requested: scene.music ?? null,
          durationMs: music?.durationMs ?? null,
          loudnessLufs: music?.loudnessLufs ?? null,
          sha256: musicSha,
        },
        output: {
          mimeType: "video/mp4",
          width: facts.width || size.w,
          height: facts.height || size.h,
          durationMs: facts.durationMs ?? renderResult.durationMs,
        },
      });
      const renderedAt = new Date();
      const [done] = await db.transaction(async (tx) => {
        const rows = await tx.update(academyCreativeProjectsTable)
          .set({ outputPath, outputMime: "video/mp4", renderStatus: "done", renderError: null, renderedAt, updatedAt: renderedAt })
          .where(eq(academyCreativeProjectsTable.id, row.id))
          .returning();
        if (rows.length) {
          await tx.insert(renderSnapshotsTable).values({
            artifactKey: `creative_project:${row.id}`,
            outputLocator: outputPath,
            outputSha256: facts.sha256,
            snapshot,
          }).onConflictDoUpdate({
            target: [renderSnapshotsTable.artifactKey, renderSnapshotsTable.outputLocator],
            set: { outputSha256: facts.sha256, snapshot, createdAt: renderedAt },
          });
        }
        return rows;
      });
      if (!done) throw new Error("Creative project disappeared before its render snapshot was saved.");
      uncommittedOutput = null;
      if (row.outputPath && row.outputPath !== outputPath) void deleteOutput(row.outputPath, access.academyId);
      logger.info({ projectId: row.id, academyId: access.academyId, ms: Date.now() - started, durationMs: renderResult.durationMs }, "Creative video rendered");
    });
  } catch (err) {
    if (uncommittedOutput) await deleteOutput(uncommittedOutput, access.academyId);
    if (!(err instanceof CreativeRenderError)) logger.error({ err, projectId: row.id, academyId: access.academyId }, "Creative video render failed");
    await setStatus(row.id, { renderStatus: "failed", renderError: readableError(err) }).catch(() => {});
  } finally {
    clearInterval(heartbeat);
    active.delete(row.id);
    await cleanup(temps, dir);
  }
}

/** Queue a video; returns the row as queued (or failed when the scene can't be read). */
export async function queueVideoRender(
  access: AcademyOwnerAccess,
  row: AcademyCreativeProject,
  options: { sourceWaitMs?: number } = {},
): Promise<AcademyCreativeProject> {
  let scene: Scene;
  try {
    scene = sceneOf(row);
  } catch (err) {
    return setStatus(row.id, { renderStatus: "failed", renderError: readableError(err) });
  }
  active.add(row.id);
  try {
    const queued = await setStatus(row.id, { renderStatus: "queued", renderError: null });
    void runVideo(access, queued, scene, options);
    return queued;
  } catch (err) {
    active.delete(row.id);
    throw err;
  }
}

/** Rows a previous process left queued or rendering without a recent heartbeat. */
export async function sweepInterruptedRenders(): Promise<void> {
  try {
    const staleBefore = new Date(Date.now() - 15 * 60_000);
    await db.update(academyCreativeProjectsTable)
      .set({ renderStatus: "failed", renderError: "The render was interrupted. Render it again." })
      .where(and(
        inArray(academyCreativeProjectsTable.renderStatus, ["queued", "rendering"]),
        lt(academyCreativeProjectsTable.updatedAt, staleBefore),
      ));
  } catch (err) {
    logger.warn({ err }, "Creative hub: sweeping interrupted renders failed");
  }
}
