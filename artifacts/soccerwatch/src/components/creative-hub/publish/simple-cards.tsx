import { Download, Megaphone } from "lucide-react";
import { useLocation } from "wouter";
import { fill, useCreativePublishCopy } from "@/i18n/creative-publish-strings";
import { apiUrl } from "@/lib/academy-studio-api";
import type { CreativeProject } from "@/lib/creative-hub-api";
import { markDownloaded, useAddToAds, type PublishChannels } from "@/lib/creative-hub-publish-api";
import { isVideoProject } from "./preview";
import { Notice, PrimaryButton, PublishCard } from "./ui";

export function DownloadCard({ academyId, project, ready }: { academyId: number; project: CreativeProject; ready: boolean }) {
  const copy = useCreativePublishCopy();
  const video = isVideoProject(project);
  const href = ready && project.outputUrl ? `${apiUrl(project.outputUrl)}?download=1` : undefined;
  return (
    <PublishCard icon={<Download className="h-5 w-5 text-floodlight" aria-hidden="true" />} title={copy.download.title} testId="publish-download">
      <p className="text-sm text-muted-text">{copy.download.body}</p>
      <a
        href={href}
        aria-disabled={!href}
        onClick={(e) => { if (!href) { e.preventDefault(); return; } markDownloaded(academyId, project.id); }}
        className={`inline-flex min-h-11 items-center rounded-xl px-5 text-sm font-bold ${href ? "bg-raised text-text hover:bg-raised/80" : "pointer-events-none bg-raised/50 text-muted-text"}`}
        data-testid="button-download"
      >
        <Download className="me-2 h-4 w-4" aria-hidden="true" />{video ? copy.download.mp4 : copy.download.png}
      </a>
    </PublishCard>
  );
}

export function AdsCard({ academyId, project, channels, ready }: { academyId: number; project: CreativeProject; channels: PublishChannels | undefined; ready: boolean }) {
  const copy = useCreativePublishCopy();
  const add = useAddToAds(academyId);
  const [, setLocation] = useLocation();
  const ads = channels?.ads;
  const inAds = add.isSuccess || project.publishTargets.some((t) => t.channel === "ad" && (t as { renderedAt?: string | null }).renderedAt === project.renderedAt);
  return (
    <PublishCard icon={<Megaphone className="h-5 w-5 text-violet" aria-hidden="true" />} title={copy.ads.title} testId="publish-ads">
      {!ads?.available ? <Notice>{copy.ads.unavailable}</Notice> : (
        <>
          <p className="text-sm text-muted-text">{copy.ads.body}</p>
          {ads.mode === "replay" && <p className="text-xs text-muted-text">{fill(copy.ads.wallet, { amount: (ads.walletFils / 1000).toFixed(2) })}</p>}
          {add.isError && <Notice tone="error">{(add.error as Error).message}</Notice>}
          {inAds ? (
            <div className="flex flex-wrap items-center gap-2">
              <Notice tone="ok">{copy.ads.added}</Notice>
              <PrimaryButton onClick={() => setLocation("/academy/ads")} data-testid="button-open-ads">{copy.ads.open}</PrimaryButton>
            </div>
          ) : (
            <PrimaryButton disabled={!ready} pending={add.isPending} onClick={() => add.mutate(project.id)} data-testid="button-to-ads">{copy.ads.add}</PrimaryButton>
          )}
        </>
      )}
    </PublishCard>
  );
}
