import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { academyCreativeProjectsTable, db, type AcademyCreativeProject } from "@workspace/db";
import { sceneForData, sceneSchema, type Scene } from "@workspace/api-zod";
import type { AcademyOwnerAccess } from "../academyOwner";
import { logger } from "../logger";
import { renderScenePng } from "./render";
import { CreativeRenderError, creativeImageResolver, creativeVideoResolver, loadCreativeContext, serverData } from "./renderMedia";
import { resolveSceneMusic } from "./music";
import { deleteOutput, storeOutput } from "./renderStore";
import { renderSceneMp4 } from "./renderVideo";

/**
 * Creative hub engine: render jobs.
 *
 * Stills render in the request. Videos queue: render_status goes queued →
 * rendering → done | failed on the project row, and the console polls the
 * project. One render per project at a time; at most CREATIVE_VIDEO_RENDERS
 * (default 1) ffmpeg passes at once on this server, the rest wait their turn.
 * Scratch files live in one temp directory per job, removed when it ends.
 *
 * The guard is in this process. A row left queued/rendering by a restart is
 * marked failed at start-up (sweepInterruptedRenders) so the console offers
 * "render again" instead of a spinner.
 */

const active = new Set<number>();
const MAX_VIDEO_RENDERS = Math.max(1, Number(process.env.CREATIVE_VIDEO_RENDERS) || 1);
let runningVideos = 0;
const waiting: Array<() => void> = [];

export const isRendering = (projectId: number) => active.has(projectId);

async function setStatus(id: number, set: Partial<typeof academyCreativeProjectsTable.$inferInsert>): Promise<AcademyCreativeProject> {
  const [row] = await db.update(academyCreativeProjectsTable).set(set).where(eq(academyCreativeProjectsTable.id, id)).returning();
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
export async function renderStillNow(access: AcademyOwnerAccess, row: AcademyCreativeProject): Promise<AcademyCreativeProject> {
  active.add(row.id);
  const temps: string[] = [];
  let dir: string | null = null;
  try {
    const scene = sceneOf(row);
    await setStatus(row.id, { renderStatus: "rendering", renderError: null });
    const ctx = await loadCreativeContext(access, temps);
    const data = serverData(access, ctx, row.data);
    const png = await renderScenePng({
      scene: sceneForData(scene, data), brand: ctx.brand, data, images: creativeImageResolver(access.academyId, ctx.look),
    });
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "creative-still-"));
    const file = path.join(dir, "out.png");
    await fs.promises.writeFile(file, png);
    const outputPath = await storeOutput(access.academyId, row.id, file, "png");
    const done = await setStatus(row.id, { outputPath, outputMime: "image/png", renderStatus: "done", renderError: null, renderedAt: new Date() });
    if (row.outputPath && row.outputPath !== outputPath) void deleteOutput(row.outputPath, access.academyId);
    return done;
  } catch (err) {
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

async function runVideo(access: AcademyOwnerAccess, row: AcademyCreativeProject, scene: Scene): Promise<void> {
  const temps: string[] = [];
  let dir: string | null = null;
  try {
    await videoSlot(async () => {
      await setStatus(row.id, { renderStatus: "rendering", renderError: null });
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "creative-video-"));
      const ctx = await loadCreativeContext(access, temps);
      const out = path.join(dir, "out.mp4");
      const started = Date.now();
      const data = serverData(access, ctx, row.data);
      // Replay's tracks or this academy's own, nothing else (resolveSceneMusic checks).
      const music = await resolveSceneMusic(access.academyId, scene.music, temps);
      await renderSceneMp4({
        scene: sceneForData(scene, data), brand: ctx.brand, data,
        images: creativeImageResolver(access.academyId, ctx.look),
        videos: creativeVideoResolver(access.academyId, dir, temps),
        music,
        workDir: dir, out,
      });
      const outputPath = await storeOutput(access.academyId, row.id, out, "mp4");
      await setStatus(row.id, { outputPath, outputMime: "video/mp4", renderStatus: "done", renderError: null, renderedAt: new Date() });
      if (row.outputPath && row.outputPath !== outputPath) void deleteOutput(row.outputPath, access.academyId);
      logger.info({ projectId: row.id, academyId: access.academyId, ms: Date.now() - started, durationMs: scene.durationMs }, "Creative video rendered");
    });
  } catch (err) {
    if (!(err instanceof CreativeRenderError)) logger.error({ err, projectId: row.id, academyId: access.academyId }, "Creative video render failed");
    await setStatus(row.id, { renderStatus: "failed", renderError: readableError(err) }).catch(() => {});
  } finally {
    active.delete(row.id);
    await cleanup(temps, dir);
  }
}

/** Queue a video; returns the row as queued (or failed when the scene can't be read). */
export async function queueVideoRender(access: AcademyOwnerAccess, row: AcademyCreativeProject): Promise<AcademyCreativeProject> {
  let scene: Scene;
  try {
    scene = sceneOf(row);
  } catch (err) {
    return setStatus(row.id, { renderStatus: "failed", renderError: readableError(err) });
  }
  active.add(row.id);
  try {
    const queued = await setStatus(row.id, { renderStatus: "queued", renderError: null });
    void runVideo(access, queued, scene);
    return queued;
  } catch (err) {
    active.delete(row.id);
    throw err;
  }
}

/** Rows a previous process left queued or rendering: nothing is working on them now. */
export async function sweepInterruptedRenders(): Promise<void> {
  try {
    await db.update(academyCreativeProjectsTable)
      .set({ renderStatus: "failed", renderError: "The render was interrupted. Render it again." })
      .where(inArray(academyCreativeProjectsTable.renderStatus, ["queued", "rendering"]));
  } catch (err) {
    logger.warn({ err }, "Creative hub: sweeping interrupted renders failed");
  }
}
