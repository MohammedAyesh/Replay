import { useState } from "react";
import { Check, Copy, Link2, Loader2, MessageCircle, Trash2, UserPlus } from "lucide-react";
import { useTeamCopy } from "@/i18n/team-strings";
import { useCreateInvite, useMemberRole, useRevokeInvite, useSaveAccess, useTeam, type Team } from "@/lib/academy-team-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

function CopyLink({ url, label, done }: { url: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button type="button" size="sm" variant="ghost" className="border border-line" onClick={() => { void navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
      {copied ? <Check className="me-1 h-3.5 w-3.5 text-turf" aria-hidden="true" /> : <Copy className="me-1 h-3.5 w-3.5" aria-hidden="true" />}{copied ? done : label}
    </Button>
  );
}

/** Academy console → Team (owner only): members, invite links, and what each role sees and may do. */
export function AcademyTeamSection({ academyId }: { academyId: number }) {
  const copy = useTeamCopy();
  const team = useTeam(academyId);
  const dir = copy.locale === "ar" ? "rtl" : "ltr";
  if (team.isLoading) return <div className="h-64 animate-pulse rounded-2xl bg-raised" />;
  if (team.isError || !team.data) return <p className="text-sm text-red-400" role="alert">{(team.error as Error | null)?.message}</p>;
  return (
    <section className="space-y-6" dir={dir} data-testid="academy-team">
      <header>
        <h1 className="font-display text-4xl font-bold tracking-tight text-text">{copy.team.title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-text">{copy.team.description}</p>
      </header>
      <Members academyId={academyId} team={team.data} />
      <Visibility academyId={academyId} team={team.data} />
    </section>
  );
}

function Members({ academyId, team }: { academyId: number; team: Team }) {
  const copy = useTeamCopy();
  const invite = useCreateInvite(academyId);
  const revoke = useRevokeInvite(academyId);
  const role = useMemberRole(academyId);
  const [label, setLabel] = useState("");
  const dateFmt = new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { day: "numeric", month: "short", timeZone: "Asia/Amman" });
  const whatsappShare = (url: string, r: string) =>
    `https://wa.me/?text=${encodeURIComponent(`${copy.team.roles[r]}: ${url}`)}`;
  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <h2 className="font-display text-xl font-bold text-text">{copy.team.members}</h2>
      <ul className="mt-3 divide-y divide-line">
        {team.members.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center gap-2 py-3" data-testid={`team-member-${m.userId}`}>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-text" dir="auto">{m.name || m.email}{m.isMe ? ` · ${copy.team.you}` : ""}</span>
              <span className="text-xs text-muted-text" dir="ltr">{m.email}</span>
            </span>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", m.role === "owner" ? "bg-floodlight/15 text-floodlight" : m.role === "manager" ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>{copy.team.roles[m.role]}</span>
            {m.role !== "owner" && (
              <>
                <Button type="button" size="sm" variant="ghost" disabled={role.isPending} onClick={() => role.mutate({ userId: m.userId, role: m.role === "manager" ? "coach" : "manager" })}>
                  {m.role === "manager" ? copy.team.makeCoach : copy.team.makeManager}
                </Button>
                <Button type="button" size="sm" variant="ghost" className="text-red-400" disabled={role.isPending} onClick={() => role.mutate({ userId: m.userId, role: null })} aria-label={copy.team.remove}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {role.isError && <p className="mt-2 text-sm text-red-400" role="alert">{(role.error as Error).message}</p>}

      <div className="mt-4 rounded-xl border border-line p-4">
        <p className="flex items-center gap-2 font-semibold text-text"><UserPlus className="h-4 w-4 text-turf" aria-hidden="true" />{copy.team.invite}</p>
        <p className="mt-1 text-xs text-muted-text">{copy.team.inviteHint}</p>
        <p className="mt-1 text-xs text-muted-text">{copy.team.managerNote}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={copy.team.labelPlaceholder} maxLength={60} className="min-w-48 flex-1" dir="auto" />
          {(["manager", "coach"] as const).map((r) => (
            <Button key={r} type="button" disabled={invite.isPending} onClick={() => invite.mutate({ role: r, label: label.trim() || undefined }, { onSuccess: () => setLabel("") })}
              className={cn("rounded-xl font-bold", r === "manager" ? "bg-floodlight text-void" : "bg-turf text-void")} data-testid={`button-invite-${r}`}>
              {invite.isPending ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : <Link2 className="me-1.5 h-4 w-4" aria-hidden="true" />}
              {r === "manager" ? copy.team.inviteManager : copy.team.inviteCoach}
            </Button>
          ))}
        </div>
        {invite.isError && <p className="mt-2 text-sm text-red-400" role="alert">{(invite.error as Error).message}</p>}
        {team.invites.length > 0 && (
          <ul className="mt-3 space-y-2">
            {team.invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-raised/60 p-2 text-sm" data-testid={`team-invite-${i.id}`}>
                <span className="font-semibold text-text">{copy.team.roles[i.role]}</span>
                {i.label && <span className="text-muted-text" dir="auto">· {i.label}</span>}
                <span className="text-xs text-muted-text">{copy.team.pending} · {copy.team.expires(dateFmt.format(new Date(i.expiresAt)))}</span>
                <span className="ms-auto flex flex-wrap gap-1">
                  <CopyLink url={i.url} label={copy.team.copy} done={copy.team.copied} />
                  <a href={whatsappShare(i.url, i.role)} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-md border border-line px-2 text-xs text-text hover:bg-raised">
                    <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />{copy.team.share}
                  </a>
                  <Button type="button" size="sm" variant="ghost" className="text-muted-text" onClick={() => revoke.mutate(i.id)}>{copy.team.revoke}</Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

type Role = "manager" | "coach" | "parent" | "player";

function Visibility({ academyId, team }: { academyId: number; team: Team }) {
  const copy = useTeamCopy();
  const save = useSaveAccess(academyId);
  const { access, catalog } = team;
  const lists: Record<Role, string[]> = { manager: access.sections.manager, coach: access.sections.coach, parent: access.family.parent, player: access.family.player };
  const toggle = (role: Role, key: string, on: boolean) => {
    const current = lists[role];
    const next = on ? [...new Set([...current, key])] : current.filter((k) => k !== key);
    save.mutate({ sections: { [role]: next } });
  };
  const togglePermission = (role: "manager" | "coach", key: string, on: boolean) => {
    const current = access.permissions[role];
    save.mutate({ permissions: { [role]: on ? [...new Set([...current, key])] : current.filter((k) => k !== key) } });
  };
  const head = (roles: Role[]) => (
    <thead><tr className="text-xs text-muted-text"><th className="py-2 text-start font-medium" />{roles.map((r) => <th key={r} className="w-24 py-2 text-center font-medium">{copy.team.roles[r]}</th>)}</tr></thead>
  );
  return (
    <section className="rounded-2xl border border-line bg-surface p-5" data-testid="team-visibility">
      <h2 className="font-display text-xl font-bold text-text">{copy.team.whatTitle}</h2>
      <p className="mt-1 text-sm text-muted-text">{copy.team.whatHint}</p>
      {save.isError && <p className="mt-2 text-sm text-red-400" role="alert">{(save.error as Error).message}</p>}

      <h3 className="mt-5 text-sm font-bold text-text">{copy.team.console}</h3>
      <table className="mt-1 w-full text-sm">
        {head(["manager", "coach"])}
        <tbody className="divide-y divide-line">
          {catalog.sections.map((section) => (
            <tr key={section}>
              <td className="py-2 text-text">
                {copy.team.sections[section] ?? section}
                {catalog.ownerSections.includes(section) && <span className="ms-2 rounded-full bg-raised px-1.5 py-0.5 text-[10px] text-muted-text">{copy.team.roles.owner}</span>}
              </td>
              {(["manager", "coach"] as const).map((r) => (
                <td key={r} className="text-center">
                  <Switch checked={lists[r].includes(section)} disabled={save.isPending} onCheckedChange={(on) => toggle(r, section, on)} aria-label={`${copy.team.roles[r]} · ${copy.team.sections[section] ?? section}`} data-testid={`switch-${r}-${section}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="mt-6 text-sm font-bold text-text">{copy.team.allowed}</h3>
      <table className="mt-1 w-full text-sm">
        {head(["manager", "coach"])}
        <tbody>
          {catalog.permissions.map((p) => (
            <tr key={p}>
              <td className="py-2 text-text">{p === "chats.manage" ? copy.team.chatsManage : p}</td>
              {(["manager", "coach"] as const).map((r) => (
                <td key={r} className="text-center">
                  <Switch checked={access.permissions[r].includes(p)} disabled={save.isPending} onCheckedChange={(on) => togglePermission(r, p, on)} data-testid={`switch-perm-${r}-${p}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="mt-6 text-sm font-bold text-text">{copy.team.family}</h3>
      <table className="mt-1 w-full text-sm">
        {head(["parent", "player"])}
        <tbody className="divide-y divide-line">
          {catalog.familyScreens.map((screen) => (
            <tr key={screen}>
              <td className="py-2 text-text">{copy.team.screens[screen] ?? screen}</td>
              {(["parent", "player"] as const).map((r) => (
                <td key={r} className="text-center">
                  <Switch checked={lists[r].includes(screen)} disabled={save.isPending} onCheckedChange={(on) => toggle(r, screen, on)} data-testid={`switch-${r}-${screen}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
