import { Router, type IRouter } from "express";

export function getStorageConfig(): { base: string; zone: string; key: string } | null {
  // Dedicated banner key takes priority over shared storage key
  const accessKey = process.env.BANNER_STORAGE_API_KEY ?? process.env.STORAGE_ACCESS_KEY ?? "";
  const zoneRegion = process.env.STORAGE_ZONE_REGION ?? "";

  if (!accessKey && !zoneRegion) return null;

  let zone = "playwatchbanners";
  let base = "https://storage.bunnycdn.com";

  if (zoneRegion.startsWith("http")) {
    try {
      const url = new URL(zoneRegion);
      base = `${url.protocol}//${url.host}`;
      zone = url.pathname.replace(/^\//, "").split("/")[0] || zone;
    } catch {
      // fall through to defaults
    }
  } else if (zoneRegion) {
    zone = zoneRegion;
  }

  const key = accessKey.startsWith("http")
    ? zoneRegion.startsWith("http") ? "" : zoneRegion
    : accessKey;

  if (!key) return null;
  return { base, zone, key };
}

interface BunnyStorageItem {
  Guid: string;
  StorageZoneName: string;
  Path: string;
  ObjectName: string;
  Length: number;
  IsDirectory: boolean;
  ContentType?: string;
}

export interface BannerJson {
  upperSubtext?: string;
  title?: string;
  lowerSubtext?: string;
  hyperlink?: string | null;
  imageUrl?: string | null;
}

export interface BannerItem {
  id: string;
  upperSubtext: string;
  title: string;
  lowerSubtext: string;
  imageUrl: string;
  hyperlink: string | null;
}

const cfg = getStorageConfig();

async function listBunnyDirectory(path: string): Promise<BunnyStorageItem[]> {
  if (!cfg) throw new Error("Bunny storage not configured");
  // Cache-bust so Bunny Storage (and any intermediate proxy) always returns
  // the live directory listing — critical so newly-created banners appear
  // immediately for every user, including brand-new accounts.
  const bust = Date.now();
  const url = `${cfg.base}/${cfg.zone}/${path}?_=${bust}`;
  const res = await fetch(url, {
    headers: { AccessKey: cfg.key },
  });
  if (!res.ok) {
    throw new Error(`Bunny storage error: ${res.status}`);
  }
  return (await res.json()) as BunnyStorageItem[];
}

async function fetchBannerJson(folder: string): Promise<BannerJson> {
  if (!cfg) return { upperSubtext: "", title: folder, lowerSubtext: "" };
  const bust = Date.now();
  const url = `${cfg.base}/${cfg.zone}/${folder}/banner.json?_=${bust}`;
  const res = await fetch(url, {
    headers: { AccessKey: cfg.key },
  });
  if (!res.ok) {
    return { upperSubtext: "", title: folder, lowerSubtext: "" };
  }
  return (await res.json()) as BannerJson;
}

const router: IRouter = Router();

router.get("/banners", async (_req, res): Promise<void> => {
  if (!cfg) {
    res.json([]);
    return;
  }

  try {
    const items = await listBunnyDirectory("");
    const folders = items.filter((i) => i.IsDirectory);

    const banners: BannerItem[] = [];
    for (const folder of folders) {
      const json = await fetchBannerJson(folder.ObjectName);
      banners.push({
        id: folder.ObjectName,
        upperSubtext: json.upperSubtext ?? "",
        title: json.title ?? folder.ObjectName,
        lowerSubtext: json.lowerSubtext ?? "",
        imageUrl: json.imageUrl ?? `/api/banners/${encodeURIComponent(folder.ObjectName)}/image`,
        hyperlink: json.hyperlink ?? null,
      });
    }

    res.setHeader("Cache-Control", "no-store");
    res.json(banners);
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch banners" });
  }
});

router.get("/banners/:folder/image", async (req, res): Promise<void> => {
  if (!cfg) {
    res.status(503).json({ error: "Bunny storage not configured" });
    return;
  }

  const folder = req.params.folder;
  const bust = Date.now();
  const url = `${cfg.base}/${cfg.zone}/${folder}/banner.png?_=${bust}`;

  try {
    const bunnyRes = await fetch(url, {
      headers: { AccessKey: cfg.key },
    });
    if (!bunnyRes.ok) {
      res.status(bunnyRes.status).json({ error: "Image not found" });
      return;
    }

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    const buffer = Buffer.from(await bunnyRes.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch image" });
  }
});

export default router;
