import { ArrowLeft, ArrowRight, Image as ImageIcon, LayoutTemplate, PenTool, Send, Video } from "lucide-react";
import { useCreativePublishCopy } from "@/i18n/creative-publish-strings";
import { apiUrl } from "@/lib/academy-studio-api";
import { useCreativeBrand, useCreativeProject, useCreativeProjects, type CreativeProject } from "@/lib/creative-hub-api";
import { usePublishChannels } from "@/lib/creative-hub-publish-api";
import { PublishHistory } from "./publish/history";
import { isRendered, isVideoProject, PublishPreview, RenderPanel } from "./publish/preview";
import { AdsCard, DownloadCard } from "./publish/simple-cards";
import { SocialCard } from "./publish/social-card";
import { WhatsappCard } from "./publish/whatsapp-card";
import { Notice } from "./publish/ui";
import type { SectionProps } from "./types";

/**
 * Creative hub → Publish. With no project: the history and the drafts to pick
 * from. With one: preview, render, then Download / Instagram & Facebook /
 * WhatsApp / Ads, each ending on a confirm sheet that says where it goes.
 */
export function CreativePublish({ academyId, nav, projectId }: SectionProps & { projectId: number | null }) {
  const copy = useCreativePublishCopy();
  return (
    <div className="space-y-6" dir={copy.locale === "ar" ? "rtl" : "ltr"} data-testid="creative-publish">
      {projectId === null ? <PickDraft academyId={academyId} nav={nav} /> : <ProjectPublish academyId={academyId} nav={nav} projectId={projectId} />}
      <PublishHistory academyId={academyId} nav={nav} currentId={projectId} />
    </div>
  );
}

function PickDraft({ academyId, nav }: SectionProps) {
  const copy = useCreativePublishCopy();
  const drafts = useCreativeProjects(academyId, { status: ["draft", "ready"] });
  return (
    <section className="space-y-4 rounded-2xl border border-line bg-surface p-5" data-testid="publish-pick">
      <div>
        <h2 className="text-lg font-bold text-text">{copy.noProject.title}</h2>
        <p className="mt-1 text-sm text-muted-text">{copy.noProject.body}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => nav.openTemplates()} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line px-4 text-sm font-semibold text-text hover:border-turf">
          <LayoutTemplate className="h-4 w-4" aria-hidden="true" />{copy.noProject.templates}
        </button>
      </div>
      <div>
        <p className="mb-2 text-xs font-semibold text-muted-text">{copy.noProject.drafts}</p>
        {drafts.isLoading ? <div className="h-20 animate-pulse rounded-xl bg-raised" />
          : (drafts.data ?? []).length === 0 ? <p className="text-sm text-muted-text">{copy.noProject.noDrafts}</p>
            : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {drafts.data!.slice(0, 12).map((p) => <DraftRow key={p.id} project={p} nav={nav} />)}
              </ul>
            )}
      </div>
    </section>
  );
}

function DraftRow({ project, nav }: { project: CreativeProject; nav: SectionProps["nav"] }) {
  const copy = useCreativePublishCopy();
  const thumb = isRendered(project) && !isVideoProject(project) && project.outputUrl ? apiUrl(project.outputUrl) : null;
  return (
    <li className="flex items-center gap-3 rounded-xl bg-raised p-2" data-testid={`publish-draft-${project.id}`}>
      <span className="grid h-14 w-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-surface text-muted-text">
        {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
          : project.kind === "video" ? <Video className="h-4 w-4" aria-hidden="true" /> : <ImageIcon className="h-4 w-4" aria-hidden="true" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-text" dir="auto">{project.title || copy.untitled}</span>
        <span className="block text-[11px] text-muted-text">{copy.formats[project.format]} · {copy.kinds[project.kind]} · {copy.status[project.status]}</span>
      </span>
      <button type="button" onClick={() => nav.openInEditor(project.id)} className="min-h-9 rounded-full px-3 text-xs font-semibold text-muted-text hover:text-text">{copy.noProject.edit}</button>
      <button type="button" onClick={() => nav.openInPublish(project.id)} className="min-h-9 rounded-full bg-turf/15 px-3 text-xs font-semibold text-turf">{copy.noProject.publishThis}</button>
    </li>
  );
}

function ProjectPublish({ academyId, nav, projectId }: SectionProps & { projectId: number }) {
  const copy = useCreativePublishCopy();
  const project = useCreativeProject(academyId, projectId);
  const brand = useCreativeBrand(academyId);
  const channels = usePublishChannels(academyId);
  const Back = copy.locale === "ar" ? ArrowRight : ArrowLeft;

  if (project.isLoading) return <div className="h-96 animate-pulse rounded-2xl bg-raised" />;
  if (project.isError || !project.data) return <Notice tone="error">{(project.error as Error | null)?.message ?? copy.error}</Notice>;
  const p = project.data;
  const ready = isRendered(p);
  const thumbSrc = ready && p.outputUrl && !isVideoProject(p) ? apiUrl(p.outputUrl) : null;
  const thumb = thumbSrc ? <img src={thumbSrc} alt="" className="w-full object-cover" /> : null;
  const academyName = (copy.locale === "ar" ? brand.data?.brand.nameAr : null) || brand.data?.brand.nameEn || "";

  return (
    <div className="space-y-5" data-testid={`publish-project-${p.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={() => nav.openInEditor(p.id)} className="inline-flex min-h-10 items-center gap-1.5 text-sm font-semibold text-muted-text hover:text-text" data-testid="publish-back-editor">
          <Back className="h-4 w-4" aria-hidden="true" /><PenTool className="h-4 w-4" aria-hidden="true" />{copy.backToEditor}
        </button>
        <p className="min-w-0 truncate text-sm font-semibold text-text" dir="auto">
          <Send className="me-1.5 inline h-4 w-4 text-turf" aria-hidden="true" />{p.title || copy.untitled}
          <span className="ms-2 text-xs font-normal text-muted-text">{copy.formats[p.format]} · {copy.kinds[p.kind]}</span>
        </p>
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <PublishPreview academyId={academyId} project={p} brand={brand.data?.brand} />
          <RenderPanel academyId={academyId} project={p} />
        </div>
        {channels.isLoading ? <div className="h-96 animate-pulse rounded-2xl bg-raised" /> : (
          <div className="space-y-4">
            {channels.isError && <Notice tone="error">{(channels.error as Error).message}</Notice>}
            <DownloadCard academyId={academyId} project={p} ready={ready} />
            <SocialCard key={`s-${p.id}`} academyId={academyId} project={p} channels={channels.data} ready={ready} thumb={thumb} />
            <WhatsappCard key={`w-${p.id}`} academyId={academyId} project={p} channels={channels.data} ready={ready} academyName={academyName} thumb={thumb} />
            <AdsCard academyId={academyId} project={p} channels={channels.data} ready={ready} />
          </div>
        )}
      </div>
    </div>
  );
}
