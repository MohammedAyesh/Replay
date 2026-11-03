import { useMemo, useState } from "react";
import { CalendarClock, Clock, Facebook, Film, Instagram, Music2, Sparkles } from "lucide-react";
import { hasMusic, type CreativeData } from "@workspace/api-zod";
import { fill, useCreativePublishCopy } from "@/i18n/creative-publish-strings";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { CreativeProject } from "@/lib/creative-hub-api";
import { PublishError, usePublishToSocial, type Placement, type PublishChannels, type SocialTarget } from "@/lib/creative-hub-publish-api";
import { ammanLocal, defaultScheduleLocal, formatAmman, formatAmmanLocal } from "./amman";
import { suggestCaption } from "./caption";
import { isPhotoWithMusic, isVideoProject, placementsFor } from "./placements";
import { Chip, ConfirmSheet, Notice, PrimaryButton, PublishCard } from "./ui";

export { placementsFor };

export function SocialCard({ academyId, project, channels, ready, thumb }: {
  academyId: number; project: CreativeProject; channels: PublishChannels | undefined; ready: boolean; thumb: React.ReactNode;
}) {
  const copy = useCreativePublishCopy();
  const publish = usePublishToSocial(academyId);
  const social = channels?.social;
  const ig = social?.instagram ?? null;
  const fb = social?.facebook ?? null;
  const connected = social?.status === "connected" && (ig || fb);
  const placements = placementsFor(project);
  const [placement, setPlacement] = useState<Placement>(placements[0]);
  const [targets, setTargets] = useState<SocialTarget[]>(() => [ig ? "instagram" : null, fb && placements[0] !== "story" ? "facebook" : null].filter(Boolean) as SocialTarget[]);
  const suggested = useMemo(() => suggestCaption(project.data as CreativeData | null, channels?.hashtag ?? null, project.scene.locale === "en" ? "en" : "ar"), [project.data, project.scene.locale, channels?.hashtag]);
  const [caption, setCaption] = useState<string | null>(null);
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState(() => defaultScheduleLocal());
  const [open, setOpen] = useState(false);
  const [again, setAgain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!connected) {
    return (
      <PublishCard icon={<Instagram className="h-5 w-5 text-pink-400" aria-hidden="true" />} title={copy.social.title} testId="publish-social">
        <Notice>{copy.social.notConnected} {copy.social.connectHint}</Notice>
      </PublishCard>
    );
  }

  const story = placement === "story";
  const effective = story ? targets.filter((t) => t === "instagram") : targets;
  const text = caption ?? suggested;
  const minLocal = ammanLocal(new Date(Date.now() + 5 * 60_000));
  const valid = ready && effective.length > 0 && (!later || (when.length >= 16 && when >= minLocal));
  const placementName = copy.social.placements[placement];
  const toggle = (t: SocialTarget) => setTargets((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  const lines = [
    ...(effective.includes("instagram") ? [{ icon: <Instagram className="h-4 w-4" aria-hidden="true" />, text: fill(copy.confirm.instagram, { placement: placementName, handle: ig?.username ?? "" }) }] : []),
    ...(effective.includes("facebook") ? [{ icon: <Facebook className="h-4 w-4" aria-hidden="true" />, text: fill(copy.confirm.facebook, { placement: placementName, page: fb?.pageName ?? "" }) }] : []),
    { icon: <Clock className="h-4 w-4" aria-hidden="true" />, text: later ? fill(copy.confirm.whenAt, { when: formatAmmanLocal(when, copy.locale) }) : copy.confirm.whenNow },
  ];

  const submit = () => {
    setError(null);
    publish.mutate({ id: project.id, targets: effective, caption: story ? "" : text, placement, scheduledAt: later ? when : null, again }, {
      onSuccess: (r) => {
        setOpen(false);
        setAgain(false);
        if (r.post.status === "failed") { setError(fill(copy.done.failed, { error: r.post.error ?? "" })); return; }
        setDone(r.post.status === "scheduled"
          ? later && r.post.scheduledFor ? fill(copy.done.scheduled, { when: formatAmman(r.post.scheduledFor, copy.locale) }) : copy.done.queuedVideo
          : copy.done.posted);
      },
      onError: (e) => {
        if (e instanceof PublishError && e.code === "already_posted") { setAgain(true); return; }
        setError((e as Error).message || copy.error);
      },
    });
  };

  return (
    <PublishCard icon={<Instagram className="h-5 w-5 text-pink-400" aria-hidden="true" />} title={copy.social.title} testId="publish-social">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-14 text-xs font-semibold text-muted-text">{copy.social.where}</span>
        {ig ? (
          <Chip active={targets.includes("instagram")} onClick={() => toggle("instagram")} testId="publish-target-instagram">
            <Instagram className="h-3.5 w-3.5" aria-hidden="true" />@{ig.username}
          </Chip>
        ) : <span className="text-xs text-muted-text">{copy.social.noInstagram}</span>}
        {fb && (
          <Chip active={targets.includes("facebook") && !story} disabled={story} onClick={() => toggle("facebook")} testId="publish-target-facebook">
            <Facebook className="h-3.5 w-3.5" aria-hidden="true" />{fb.pageName ?? "Facebook"}
          </Chip>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-14 text-xs font-semibold text-muted-text">{copy.social.as}</span>
        {(["feed", "reel", "story"] as const).filter((p) => placements.includes(p)).map((p) => (
          <Chip key={p} active={placement === p} onClick={() => setPlacement(p)} testId={`publish-placement-${p}`}>{copy.social.placements[p]}</Chip>
        ))}
      </div>
      {story && <p className="text-xs text-muted-text">{copy.social.storyIgOnly} {copy.social.storyNoCaption}</p>}
      {!story && (
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label htmlFor={`caption-${project.id}`} className="text-xs font-semibold text-muted-text">{copy.social.caption}</label>
            <button type="button" onClick={() => setCaption(suggested)} className="inline-flex items-center gap-1 text-xs font-semibold text-violet">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />{copy.social.suggest}
            </button>
          </div>
          <Textarea id={`caption-${project.id}`} value={text} onChange={(e) => setCaption(e.target.value)} rows={5} maxLength={2200} dir="auto"
            placeholder={copy.social.captionPlaceholder} data-testid="publish-caption" />
          <p className="mt-1 text-end text-[11px] text-muted-text">{text.length}/2200</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-14 text-xs font-semibold text-muted-text">{copy.social.when}</span>
        <Chip active={!later} onClick={() => setLater(false)} testId="publish-when-now">{copy.social.now}</Chip>
        <Chip active={later} onClick={() => setLater(true)} testId="publish-when-later"><CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />{copy.social.later}</Chip>
      </div>
      {later && (
        <label className="block">
          <span className="sr-only">{copy.social.pickTime}</span>
          <Input type="datetime-local" value={when} min={minLocal} onChange={(e) => setWhen(e.target.value)} className="w-auto" dir="ltr" data-testid="publish-when-input" />
          <span className="mt-1 block text-xs text-muted-text">{copy.social.ammanTime}{when ? ` · ${formatAmmanLocal(when, copy.locale)}` : ""}</span>
        </label>
      )}
      {isPhotoWithMusic(project) && (
        <p className="flex items-start gap-1.5 text-xs text-muted-text" data-testid="publish-photo-video-note">
          <Film className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{copy.social.photoVideoNote}
        </p>
      )}
      {!later && isVideoProject(project) && <p className="text-xs text-muted-text">{copy.social.videoQueued}</p>}
      {isVideoProject(project) && hasMusic(project.scene.music) && (
        <p className="flex items-start gap-1.5 text-xs text-muted-text" data-testid="publish-music-note">
          <Music2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{copy.social.musicNote}
        </p>
      )}
      {done && <Notice tone="ok">{done}</Notice>}
      {error && !open && <Notice tone="error">{error}</Notice>}
      <PrimaryButton disabled={!valid} onClick={() => { setError(null); setDone(null); setAgain(false); setOpen(true); }} data-testid="button-review-social">
        {later ? copy.social.reviewSchedule : copy.social.review}
      </PrimaryButton>
      <ConfirmSheet
        open={open}
        onOpenChange={setOpen}
        title={copy.confirm.title}
        lines={lines}
        preview={thumb}
        quoteLabel={story ? undefined : copy.confirm.caption}
        quote={text || copy.confirm.noCaption}
        warning={again ? copy.confirm.already : null}
        confirmLabel={again ? copy.confirm.again : later ? copy.confirm.schedule : copy.confirm.post}
        cancelLabel={copy.confirm.cancel}
        pending={publish.isPending}
        error={open ? error : null}
        onConfirm={submit}
        dir={copy.locale === "ar" ? "rtl" : "ltr"}
        testId="confirm-social"
      />
    </PublishCard>
  );
}
