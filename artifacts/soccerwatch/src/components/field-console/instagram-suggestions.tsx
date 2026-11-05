import { useState } from "react";
import { CalendarDays, Film, Plus, Sparkles, Trophy, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInstagramCopy } from "@/i18n/instagram-strings";
import { cn } from "@/lib/utils";
import { ammanToday, clock, dayName } from "@/lib/venue-api";
import { useAddSuggestion, type IgSuggestion, type IgSuggestKind } from "@/lib/instagram-api";
import { ErrorText } from "./shared";

const ICON: Record<IgSuggestKind, typeof Film> = {
  thanks: Sparkles, top5: Film, match_week: Trophy, player_week: Users, versus: Film, open_slots: CalendarDays, leaderboard: Trophy,
};

/**
 * The autopilot's next posts that aren't on the calendar yet (routes/venueInstagram.ts →
 * suggestions). "Add now" pins one at its own time, waiting for the owner's OK; the autopilot
 * would have added it by itself a few hours before.
 */
export function SuggestionList({ venueId, suggestions, disabled, compact }: { venueId: number; suggestions: IgSuggestion[]; disabled?: boolean; compact?: boolean }) {
  const copy = useInstagramCopy();
  const add = useAddSuggestion(venueId);
  const [busy, setBusy] = useState<string | null>(null);
  const today = ammanToday();
  if (!suggestions.length) return <p className="text-sm text-muted-text">{copy.suggestions.empty}</p>;
  const when = (at: string) => {
    const day = at.slice(0, 10);
    return copy.suggestions.when(day === today ? copy.suggestions.today : dayName(day, copy.locale), clock(at, copy.locale));
  };
  return (
    <>
      <ul className={cn("grid gap-2", !compact && "md:grid-cols-2 2xl:grid-cols-3")} data-testid="ig-suggestions">
        {suggestions.map((s) => {
          const Icon = ICON[s.kind] ?? Film;
          return (
            <li key={s.originKey} className="flex items-center gap-3 rounded-xl border border-dashed border-line bg-raised/40 p-3" data-testid={`ig-suggestion-${s.kind}`}>
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-turf/10 text-turf"><Icon className="h-4 w-4" aria-hidden="true" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-text">{copy.calendar.kinds[s.kind] ?? s.kind}</span>
                <span className="block text-xs text-muted-text">{when(s.at)} · {s.placement === "reel" ? copy.calendar.reel : copy.calendar.story}</span>
              </span>
              <Button
                type="button" size="sm" variant="outline" className="shrink-0"
                disabled={disabled || add.isPending}
                onClick={() => { setBusy(s.originKey); add.mutate({ kind: s.kind, at: s.at }, { onSettled: () => setBusy(null) }); }}
                data-testid={`ig-suggestion-add-${s.kind}`}
              >
                <Plus className="me-1 h-3.5 w-3.5" aria-hidden="true" />{busy === s.originKey ? copy.suggestions.adding : copy.suggestions.add}
              </Button>
            </li>
          );
        })}
      </ul>
      <ErrorText error={add.error} />
    </>
  );
}
