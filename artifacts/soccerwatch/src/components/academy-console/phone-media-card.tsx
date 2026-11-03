import { useRef, useState } from "react";
import { Film, ImageIcon, Loader2, MapPin, Upload, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { usePhoneCopy } from "@/i18n/phone-strings";
import type { LineupPlayer } from "@/lib/academy-matches-api";
import { phoneThumb, usePhoneMedia, useUpdatePhoneMedia, useUploadPhoneMedia, type PhoneItem, type PhonePhase } from "@/lib/phone-media-api";
import { cn } from "@/lib/utils";

const PHASES: PhonePhase[] = ["before", "during", "after"];

/**
 * Matches → a match → phone videos and photos: add files (coaches and owners),
 * see them sorted before / during / after (a "during" video says where it sits
 * in the match video), and tag who is in each (a private appearance for him).
 */
export function PhoneMediaCard({ academyId, sessionId, lineup }: { academyId: number; sessionId: number; lineup: LineupPlayer[] }) {
  const copy = usePhoneCopy();
  const list = usePhoneMedia(academyId, { sessionId });
  const items = list.data ?? [];
  return (
    <section className="rounded-2xl border border-line bg-surface p-5" data-testid="match-phone-media">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-xl font-bold text-text"><Film className="h-5 w-5 text-turf" aria-hidden />{copy.title}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-text">{copy.intro}</p>
        </div>
        <PhoneUploadButton academyId={academyId} />
      </div>
      {list.isLoading ? <div className="h-24 animate-pulse rounded-xl bg-raised" />
        : items.length === 0 ? <p className="text-sm text-muted-text">{copy.empty}</p>
        : (
          <div className="space-y-4">
            {PHASES.map((phase) => {
              const group = items.filter((i) => i.phase === phase);
              if (!group.length) return null;
              return (
                <div key={phase} data-testid={`phone-phase-${phase}`}>
                  <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-text">{copy.phases[phase]} · {group.length}</h3>
                  <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {group.map((item) => <PhoneTile key={item.id} academyId={academyId} item={item} lineup={lineup} />)}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
    </section>
  );
}

export function PhoneUploadButton({ academyId }: { academyId: number }) {
  const copy = usePhoneCopy();
  const input = useRef<HTMLInputElement>(null);
  const upload = useUploadPhoneMedia(academyId);
  const [busy, setBusy] = useState(0);
  const onFiles = async (files: FileList | null) => {
    const list = [...(files ?? [])];
    if (!list.length) return;
    setBusy(list.length);
    let ok = 0;
    for (const f of list) {
      try {
        await upload.mutateAsync(f);
        ok += 1;
      } catch {
        toast({ description: copy.failed(f.name), variant: "destructive" });
      }
      setBusy((n) => n - 1);
    }
    if (ok) toast({ description: copy.added(ok) });
    if (input.current) input.current.value = "";
  };
  return (
    <>
      <input ref={input} type="file" accept="video/*,image/jpeg,image/png" multiple className="hidden" onChange={(e) => void onFiles(e.target.files)} data-testid="phone-upload-input" />
      <Button type="button" size="sm" variant="outline" disabled={busy > 0} onClick={() => input.current?.click()} data-testid="phone-upload">
        {busy > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        {busy > 0 ? copy.uploading(busy) : copy.add}
      </Button>
    </>
  );
}

function PhoneTile({ academyId, item, lineup }: { academyId: number; item: PhoneItem; lineup: LineupPlayer[] }) {
  const copy = usePhoneCopy();
  const update = useUpdatePhoneMedia(academyId);
  const [tagging, setTagging] = useState(false);
  const squad = lineup.filter((p) => p.inSquad);
  const toggle = (id: number) => {
    const next = item.playerIds.includes(id) ? item.playerIds.filter((x) => x !== id) : [...item.playerIds, id];
    update.mutate({ id: item.id, playerIds: next });
  };
  const Icon = item.kind === "video" ? Film : ImageIcon;
  return (
    <li className="overflow-hidden rounded-xl border border-line bg-raised" data-testid={`phone-item-${item.id}`}>
      <div className="relative aspect-video bg-black">
        <img src={phoneThumb(item)} alt="" className="h-full w-full object-cover" loading="lazy" />
        <span className="absolute start-2 top-2 inline-flex items-center gap-1 rounded-full bg-void/80 px-2 py-0.5 text-[11px] font-semibold text-text"><Icon className="h-3 w-3" aria-hidden />{copy.phases[item.phase]}</span>
      </div>
      <div className="space-y-1 p-2.5 text-xs">
        {item.phase === "during" && item.offsetSec !== null && <p className="font-semibold text-turf" data-testid="phone-offset">{copy.at(item.offsetSec)}</p>}
        <p className="flex flex-wrap gap-x-2 text-muted-text">
          {item.capturedAt && <bdi>{new Date(item.capturedAt).toLocaleTimeString(copy.locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Amman" })}</bdi>}
          {copy.venue[item.venue] && <span className="inline-flex items-center gap-0.5"><MapPin className="h-3 w-3" aria-hidden />{copy.venue[item.venue]}</span>}
          {copy.confidence[item.captureConfidence] && <span>{copy.confidence[item.captureConfidence]}</span>}
          {item.uploaderRole === "parent" && <span>{copy.fromParent}</span>}
        </p>
        <button type="button" onClick={() => setTagging((v) => !v)} className="inline-flex items-center gap-1 font-semibold text-turf hover:underline">
          <UserRound className="h-3.5 w-3.5" aria-hidden />{item.playerIds.length ? `${copy.tagged} · ${item.playerIds.length}` : copy.tag}
        </button>
        {tagging && (
          <div className="flex flex-wrap gap-1 pt-1">
            {squad.map((p) => (
              <button key={p.playerId} type="button" onClick={() => toggle(p.playerId)} disabled={update.isPending}
                className={cn("rounded-full px-2 py-0.5 font-semibold tabular-nums", item.playerIds.includes(p.playerId) ? "bg-turf text-void" : "bg-surface text-muted-text")}>
                {p.shirtNumber !== null ? `#${p.shirtNumber}` : p.name.split(/\s+/)[0]}
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
