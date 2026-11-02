import { useState } from "react";
import { Download, ExternalLink, Facebook, Image as ImageIcon, Instagram, Megaphone, MessageCircle, Video } from "lucide-react";
import { useCreativePublishCopy } from "@/i18n/creative-publish-strings";
import { apiUrl } from "@/lib/academy-studio-api";
import { useCancelSocialPost, usePublishHistory, type HistoryItem, type PublishTargetView } from "@/lib/creative-hub-publish-api";
import { cn } from "@/lib/utils";
import { formatAmman } from "./amman";
import type { HubNav } from "../types";

const CHANNEL_ICON = { instagram: Instagram, facebook: Facebook, whatsapp: MessageCircle, ad: Megaphone, download: Download } as const;

function stateTone(state: PublishTargetView["state"]) {
  return state === "published" || state === "sent" ? "bg-turf/15 text-turf"
    : state === "failed" ? "bg-live/15 text-live"
      : state === "scheduled" || state === "publishing" ? "bg-floodlight/15 text-floodlight"
        : "bg-raised text-muted-text";
}

function TargetRow({ academyId, projectId, target }: { academyId: number; projectId: number; target: PublishTargetView }) {
  const copy = useCreativePublishCopy();
  const cancel = useCancelSocialPost(academyId);
  const [sure, setSure] = useState(false);
  const Icon = CHANNEL_ICON[target.channel] ?? ImageIcon;
  const when = target.state === "scheduled" && target.scheduledAt ? target.scheduledAt : target.publishedAt ?? target.at;
  return (
    <li className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid={`publish-target-${target.channel}-${target.state}`}>
      <Icon className="h-3.5 w-3.5 text-muted-text" aria-label={copy.history.channels[target.channel]} />
      <span className={cn("rounded-full px-2 py-0.5 font-semibold", stateTone(target.state))}>{copy.history.states[target.state]}</span>
      {when && <span className="text-muted-text">{formatAmman(when, copy.locale)}</span>}
      {target.channel === "whatsapp" && typeof target.recipients === "number" && <span className="text-muted-text">· {copy.whatsapp.numbers(target.recipients)}</span>}
      {target.permalink && (
        <a href={target.permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-semibold text-turf hover:underline">
          {copy.history.view}<ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      )}
      {target.postId && (target.state === "scheduled" || target.state === "failed") && (
        sure ? (
          <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate({ id: projectId, postId: target.postId! })} className="font-semibold text-live">
            {copy.history.cancel} ✓
          </button>
        ) : (
          <button type="button" onClick={() => setSure(true)} className="text-muted-text hover:text-live">{copy.history.cancel}</button>
        )
      )}
      {target.error && <span className="basis-full text-live" dir="auto">{target.error}</span>}
    </li>
  );
}

function HistoryRow({ academyId, item, nav, current }: { academyId: number; item: HistoryItem; nav: HubNav; current: boolean }) {
  const copy = useCreativePublishCopy();
  const p = item.project;
  const thumb = item.thumbUrl ? apiUrl(item.thumbUrl) : null;
  const shown = item.targets.filter((t) => t.state !== "removed");
  return (
    <li className={cn("flex gap-3 rounded-2xl border bg-surface p-3", current ? "border-turf" : "border-line")} data-testid={`publish-history-${p.id}`}>
      <button type="button" onClick={() => nav.openInPublish(p.id)} className="h-20 w-16 shrink-0 overflow-hidden rounded-xl bg-raised" aria-label={`${copy.history.open}: ${p.title || copy.untitled}`}>
        {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
          : <span className="grid h-full w-full place-items-center text-muted-text">{p.kind === "video" ? <Video className="h-5 w-5" aria-hidden="true" /> : <ImageIcon className="h-5 w-5" aria-hidden="true" />}</span>}
      </button>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-sm font-semibold text-text" dir="auto">{p.title || copy.untitled}</p>
          <span className="shrink-0 text-[11px] text-muted-text">{copy.formats[p.format]} · {copy.status[p.status]}</span>
        </div>
        <ul className="space-y-1">
          {shown.map((t, i) => <TargetRow key={`${t.channel}-${t.ref ?? i}-${i}`} academyId={academyId} projectId={p.id} target={t} />)}
        </ul>
      </div>
    </li>
  );
}

export function PublishHistory({ academyId, nav, currentId }: { academyId: number; nav: HubNav; currentId?: number | null }) {
  const copy = useCreativePublishCopy();
  const history = usePublishHistory(academyId);
  return (
    <section className="space-y-3" data-testid="publish-history">
      <h2 className="text-lg font-bold text-text">{copy.history.title}</h2>
      {history.isLoading ? <div className="h-28 animate-pulse rounded-2xl bg-raised" />
        : history.isError ? <p className="text-sm text-live" role="alert">{(history.error as Error).message}</p>
          : (history.data ?? []).length === 0 ? <p className="rounded-2xl border border-line bg-surface p-6 text-center text-sm text-muted-text">{copy.history.empty}</p>
            : (
              <ul className="grid gap-3 lg:grid-cols-2">
                {history.data!.map((item) => <HistoryRow key={item.project.id} academyId={academyId} item={item} nav={nav} current={item.project.id === currentId} />)}
              </ul>
            )}
    </section>
  );
}
