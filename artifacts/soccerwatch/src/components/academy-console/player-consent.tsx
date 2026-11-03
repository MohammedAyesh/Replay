import { Lock, Megaphone } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import { useFeaturedCopy } from "@/i18n/featured-strings";
import { usePublicConsent, useSetConsent } from "@/lib/academy-featured-api";

/**
 * A player's public-post consent: off until the owner ticks it. Off means
 * "private only": clips to his own parents, never on the academy's public pages.
 */
export function ConsentSwitch({ academyId, playerId, canEdit }: { academyId: number; playerId: number; canEdit: boolean }) {
  const copy = useFeaturedCopy();
  const consent = usePublicConsent(academyId);
  const set = useSetConsent(academyId);
  const on = consent.data?.get(playerId)?.consent ?? false;
  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted-text" title={copy.consent.label} data-testid={`consent-${playerId}`}>
      <Switch checked={on} disabled={!canEdit || consent.isLoading || set.isPending} aria-label={copy.consent.label}
        onCheckedChange={(v) => set.mutate({ playerId, consent: v }, { onError: () => toast({ description: copy.consent.failed, variant: "destructive" }) })} />
      {on ? <span className="inline-flex items-center gap-1 text-turf"><Megaphone className="h-3.5 w-3.5" aria-hidden />{copy.consent.short}</span>
        : <span className="inline-flex items-center gap-1"><Lock className="h-3.5 w-3.5" aria-hidden />{copy.consent.privateOnly}</span>}
    </label>
  );
}

/** The full wording, for the player form. */
export function ConsentCheckbox({ academyId, playerId, canEdit }: { academyId: number; playerId: number; canEdit: boolean }) {
  const copy = useFeaturedCopy();
  const consent = usePublicConsent(academyId);
  const set = useSetConsent(academyId);
  const on = consent.data?.get(playerId)?.consent ?? false;
  return (
    <label className="flex items-start gap-3 rounded-xl border border-line bg-raised p-3 text-sm text-text" data-testid={`consent-form-${playerId}`}>
      <Checkbox checked={on} disabled={!canEdit || consent.isLoading || set.isPending} className="mt-0.5"
        onCheckedChange={(v) => set.mutate({ playerId, consent: v === true }, {
          onSuccess: () => toast({ description: copy.consent.saved }),
          onError: () => toast({ description: copy.consent.failed, variant: "destructive" }),
        })} />
      <span>{copy.consent.label}</span>
    </label>
  );
}
