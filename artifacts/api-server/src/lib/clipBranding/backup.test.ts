import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareBackupBrandingAssets } from "./backup";

describe("backup renderer branding assets", () => {
  let overlayPath: string | undefined;

  afterEach(async () => {
    if (overlayPath) await fs.promises.unlink(overlayPath).catch(() => {});
    overlayPath = undefined;
  });

  it("keeps the drawn overlay when a slow end-card encode fails", async () => {
    overlayPath = path.join(os.tmpdir(), `backup-branding-${process.pid}-${Date.now()}.png`);
    await fs.promises.writeFile(overlayPath, Buffer.from("overlay-png"));
    const encodeCard = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("end-card encode timed out");
    });

    const result = await prepareBackupBrandingAssets(
      914,
      false,
      null,
      {
        overlayPath,
        endScreen: {
          spec: { kind: "signOff" },
          seconds: 3,
          blur: 22,
          dim: 0.5,
        },
        temps: [overlayPath],
      } as never,
      {
        encodeCard: encodeCard as never,
        uploadAsset: async (_buffer, folder) => `https://storage.test/branding/${folder}/overlay.png`,
      },
    );

    expect(result).toMatchObject({
      overlayUrl: "https://storage.test/branding/drawn/overlay.png",
      endScreen: null,
    });
    expect(encodeCard).toHaveBeenCalledTimes(1);
  });
});
