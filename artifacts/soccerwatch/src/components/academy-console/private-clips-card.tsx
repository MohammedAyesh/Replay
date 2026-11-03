import { Eye, Film, Loader2, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { useFeaturedCopy } from "@/i18n/featured-strings";
import { usePrepareClips, usePrivateClips, useSendClips, type PrivateClip } from "@/lib/academy-featured-api";
import { cn } from "@/lib/utils";

/**
 * Matches → a match → "Each child's clip": every child's best moment of the
 * match, prepared on its own once the match is analysed. The owner checks the
 * list and sends: one WhatsApp per family (brothers' clips go together).
 */
export function PrivateClipsCard({ academyId, sessionId, isOwner, analysed }: { academyId: number; sessionId: number; isOwner: boolean; analysed: boolean }) {
  const copy = useFeaturedCopy();
  const t = copy.clips;
  const clips = usePrivateClips(academyId, sessionId);
  const prepare = usePrepareClips(academyId, sessionId);
  const send = useSendClips(academyId, sessionId);
  const list = clips.data ?? [];
  const ready = list.filter((c) => c.status === "prepared");

  const onPrepare = () => prepare.mutate(undefined, {
    onSuccess: (r) => { if (r.reason) toast({ description: t.reasons[r.reason] ?? r.reason }); },
    onError: (e) => toast({ description: (e as Error).message, variant: "destructive" }),
  });
  const onSend = () => send.mutate(undefined, {
    onSuccess: (r) => {
      toast({ description: t.sent(r.messages, r.children) });
      if (r.unreachable.length) toast({ description: t.unreachable(r.unreachable.map((u) => (u.number !== null ? `#${u.number}` : u.name)).join(", ")), variant: "destructive" });
    },
    onError: (e) => {
      // 409 is the one refusal here: WhatsApp is off.
      toast({ description: (e as { status?: number }).status === 409 ? t.whatsappOff : (e as Error).message, variant: "destructive" });
    },
  });

  return (
    <section className="rounded-2xl border border-line bg-surface p-5" data-testid="match-private-clips">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-xl font-bold text-text"><Film className="h-5 w-5 text-turf" aria-hidden />{t.title}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-text">{t.intro}</p>
        </div>
        {isOwner && (
          <div className="flex flex-wrap gap-2">
            {analysed && (
              <Button type="button" variant="outline" size="sm" onClick={onPrepare} disabled={prepare.isPending} data-testid="clips-prepare">
                {prepare.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {prepare.isPending ? t.preparing : t.prepare}
              </Button>
            )}
            {ready.length > 0 && (
              <Button type="button" size="sm" onClick={onSend} disabled={send.isPending} data-testid="clips-send">
                {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {send.isPending ? t.sending : t.send(ready.length)}
              </Button>
            )}
          </div>
        )}
      </div>
      {clips.isLoading ? <div className="h-24 animate-pulse rounded-xl bg-raised" />
        : list.length === 0 ? <p className="text-sm text-muted-text">{analysed ? t.none : t.reasons.not_analysed}</p>
        : (
          <ul className="divide-y divide-line">
            {list.map((c) => <ClipRow key={c.id} clip={c} />)}
          </ul>
        )}
    </section>
  );
}

function ClipRow({ clip: c }: { clip: PrivateClip }) {
  const copy = useFeaturedCopy();
  const t = copy.clips;
  const note = t.note(c.note);
  const rendering = c.status !== "no_moment" && c.exportStatus !== "done";
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5" data-testid={`private-clip-${c.playerId}`}>
      <span className="w-12 shrink-0 font-display text-lg font-bold tabular-nums text-text" dir="ltr">{c.number !== null ? `#${c.number}` : "–"}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-text"><bdi>{c.playerName}</bdi></p>
        <p className="text-xs text-muted-text">{c.status === "no_moment" ? t.status.no_moment : `${t.moment(c.momentKind)}${note ? ` — ${note}` : ""}`}</p>
      </div>
      <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold",
        c.status === "sent" ? "bg-emerald-500/15 text-emerald-300" : c.status === "prepared" ? "bg-turf/15 text-turf" : "bg-raised text-muted-text")}>
        {c.status === "prepared" && rendering ? t.rendering : t.status[c.status]}
      </span>
      {c.openedAt && <span className="inline-flex items-center gap-1 text-xs text-emerald-300"><Eye className="h-3.5 w-3.5" aria-hidden />{t.opened}</span>}
      {c.status !== "no_moment" && !rendering && (
        <a href={c.url} target="_blank" rel="noreferrer" className="text-xs font-semibold text-turf hover:underline">{t.open}</a>
      )}
    </li>
  );
}
