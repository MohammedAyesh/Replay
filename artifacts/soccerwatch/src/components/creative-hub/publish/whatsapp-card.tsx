import { useState } from "react";
import { MessageCircle, Phone, Users } from "lucide-react";
import { fill, useCreativePublishCopy } from "@/i18n/creative-publish-strings";
import { Textarea } from "@/components/ui/textarea";
import type { CreativeProject } from "@/lib/creative-hub-api";
import { PublishError, useSendOnWhatsapp, useWhatsappReach, type Audience, type AudienceRole, type PublishChannels } from "@/lib/creative-hub-publish-api";
import { Chip, ConfirmSheet, Notice, PrimaryButton, PublishCard } from "./ui";

export function WhatsappCard({ academyId, project, channels, ready, academyName, thumb }: {
  academyId: number; project: CreativeProject; channels: PublishChannels | undefined; ready: boolean; academyName: string; thumb: React.ReactNode;
}) {
  const copy = useCreativePublishCopy();
  const wa = channels?.whatsapp;
  const send = useSendOnWhatsapp(academyId);
  const [roles, setRoles] = useState<AudienceRole[]>(["parents"]);
  const [squadIds, setSquadIds] = useState<number[] | null>(null);
  const [message, setMessage] = useState(() => fill(copy.whatsapp.messageDefault, { academy: academyName }));
  const [open, setOpen] = useState(false);
  const [again, setAgain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const audience: Audience = { roles, squadIds };
  const reach = useWhatsappReach(academyId, wa?.available ? audience : null);

  if (!wa?.available) {
    return (
      <PublishCard icon={<MessageCircle className="h-5 w-5 text-turf" aria-hidden="true" />} title={copy.whatsapp.title} testId="publish-whatsapp">
        <Notice>{copy.whatsapp.off} {copy.whatsapp.offHint}</Notice>
      </PublishCard>
    );
  }

  const toggleRole = (r: AudienceRole) => setRoles((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));
  const toggleSquad = (id: number) => setSquadIds((cur) => {
    const list = cur ?? [];
    const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    return next.length === 0 ? null : next;
  });
  const count = reach.data?.count ?? 0;
  const from = wa.sender === "own" ? fill(copy.whatsapp.fromOwn, { phone: wa.phone ?? "" }) : copy.whatsapp.fromReplay;
  const squadNames = squadIds ? wa.squads.filter((s) => squadIds.includes(s.id)).map((s) => s.name) : [copy.whatsapp.allSquads];
  const who = `${roles.map((r) => copy.whatsapp.roles[r]).join(copy.locale === "ar" ? " و" : " & ")} · ${squadNames.join(copy.locale === "ar" ? "، " : ", ")}`;
  const valid = ready && roles.length > 0 && message.trim().length > 0 && count > 0 && !reach.isFetching;

  const submit = () => {
    setError(null);
    send.mutate({ id: project.id, audience, message: message.trim(), again }, {
      onSuccess: (r) => { setOpen(false); setAgain(false); setDone(fill(copy.done.sent, { count: copy.whatsapp.numbers(r.queued) })); },
      onError: (e) => {
        if (e instanceof PublishError && e.code === "already_sent") { setAgain(true); return; }
        setError((e as Error).message || copy.error);
      },
    });
  };

  return (
    <PublishCard icon={<MessageCircle className="h-5 w-5 text-turf" aria-hidden="true" />} title={copy.whatsapp.title} testId="publish-whatsapp">
      <p className="flex items-center gap-1.5 text-xs text-muted-text"><Phone className="h-3.5 w-3.5" aria-hidden="true" />{copy.whatsapp.from}: {from}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-14 text-xs font-semibold text-muted-text">{copy.whatsapp.to}</span>
        {wa.roles.map((r) => <Chip key={r} active={roles.includes(r)} onClick={() => toggleRole(r)} testId={`publish-wa-role-${r}`}>{copy.whatsapp.roles[r]}</Chip>)}
      </div>
      {wa.squads.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Chip active={squadIds === null} onClick={() => setSquadIds(null)} testId="publish-wa-squad-all">{copy.whatsapp.allSquads}</Chip>
          {wa.squads.map((s) => (
            <Chip key={s.id} active={Boolean(squadIds?.includes(s.id))} onClick={() => toggleSquad(s.id)} testId={`publish-wa-squad-${s.id}`}>{s.name}</Chip>
          ))}
        </div>
      )}
      <p className="flex items-center gap-1.5 text-sm font-semibold text-text" data-testid="publish-wa-reach">
        <Users className="h-4 w-4 text-turf" aria-hidden="true" />
        {roles.length === 0 ? "—" : reach.isFetching ? copy.whatsapp.counting : count === 0 ? copy.whatsapp.nobody : copy.whatsapp.numbers(count)}
      </p>
      <div>
        <label htmlFor={`wa-${project.id}`} className="mb-1 block text-xs font-semibold text-muted-text">{copy.whatsapp.message}</label>
        <Textarea id={`wa-${project.id}`} value={message} onChange={(e) => setMessage(e.target.value)} rows={3} maxLength={3500} dir="auto" data-testid="publish-wa-message" />
        <p className="mt-1 text-[11px] text-muted-text">{copy.whatsapp.placeholders} {copy.whatsapp.linkNote}</p>
      </div>
      {done && <Notice tone="ok">{done}</Notice>}
      {error && !open && <Notice tone="error">{error}</Notice>}
      <PrimaryButton disabled={!valid} onClick={() => { setError(null); setDone(null); setAgain(false); setOpen(true); }} data-testid="button-review-whatsapp">
        {copy.whatsapp.review}
      </PrimaryButton>
      <ConfirmSheet
        open={open}
        onOpenChange={setOpen}
        title={copy.confirm.title}
        lines={[{ icon: <MessageCircle className="h-4 w-4" aria-hidden="true" />, text: fill(copy.confirm.whatsapp, { who, count: copy.whatsapp.numbers(count), from }) }]}
        preview={thumb}
        quoteLabel={copy.confirm.message}
        quote={`${message.trim()}\n\n🔗 …`}
        warning={again ? copy.confirm.alreadySent : null}
        confirmLabel={again ? copy.confirm.sendAgain : copy.confirm.send}
        cancelLabel={copy.confirm.cancel}
        pending={send.isPending}
        error={open ? error : null}
        onConfirm={submit}
        dir={copy.locale === "ar" ? "rtl" : "ltr"}
        testId="confirm-whatsapp"
      />
    </PublishCard>
  );
}
