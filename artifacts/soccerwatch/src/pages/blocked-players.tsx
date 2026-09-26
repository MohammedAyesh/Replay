import { useEffect } from "react";
import { ArrowLeft, Ban, Loader2 } from "lucide-react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useSafetyCopy } from "@/i18n/safety-strings";
import { useMyBlocks, useUnblockUser, type BlockedPlayer } from "@/lib/safety-api";

function initials(name: string): string {
  return name.trim().split(/\s+/).map((part) => part[0]).join("").toUpperCase().slice(0, 2);
}

export default function BlockedPlayersPage() {
  const { user, isGuest, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const copy = useSafetyCopy();
  const { toast } = useToast();
  const list = useMyBlocks(!authLoading && Boolean(user) && !isGuest);
  const unblock = useUnblockUser();

  useEffect(() => {
    if (!authLoading && (!user || isGuest)) setLocation("/account");
  }, [authLoading, isGuest, setLocation, user]);

  const goBack = () => {
    if (window.history.length > 1) window.history.back();
    else setLocation("/account");
  };

  const onUnblock = async (player: BlockedPlayer) => {
    try {
      await unblock.mutateAsync(player.userId);
      toast({ title: copy.unblocked });
    } catch {
      toast({ title: copy.unblockFailed, variant: "destructive" });
    }
  };

  if (authLoading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-void text-text" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
        <Loader2 className="h-5 w-5 animate-spin text-muted-text" aria-label="Loading" />
      </div>
    );
  }
  if (isGuest || !user) return null;

  const formatter = new Intl.DateTimeFormat(copy.locale === "ar" ? "ar-JO" : "en-GB", {
    dateStyle: "medium",
  });

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-void text-text" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
      <div className="mx-auto w-full max-w-2xl px-4 pb-24 pt-4 sm:px-6">
        <button
          type="button"
          onClick={goBack}
          data-testid="button-blocked-back"
          className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-text"
        >
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
          <span>{copy.back}</span>
        </button>

        <header className="mb-4 rounded-2xl border border-line bg-surface p-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-turf/10 text-turf">
              <Ban className="h-5 w-5" aria-hidden="true" />
            </span>
            <h1 data-testid="text-blocked-title" className="font-display text-2xl font-bold">{copy.blockedPlayers}</h1>
          </div>
        </header>

        {list.isLoading ? (
          <div className="flex min-h-32 items-center justify-center rounded-2xl border border-line bg-surface">
            <Loader2 className="h-5 w-5 animate-spin text-muted-text" aria-label="Loading blocked players" />
          </div>
        ) : list.isError ? (
          <div role="alert" className="rounded-2xl border border-line bg-surface p-5 text-sm text-muted-text">
            <p>{copy.genericError}</p>
            <button type="button" onClick={() => void list.refetch()} className="mt-3 min-h-11 rounded-xl border border-line px-4 font-semibold text-text">
              {copy.retry}
            </button>
          </div>
        ) : (list.data ?? []).length === 0 ? (
          <div data-testid="status-no-blocked-players" className="rounded-2xl border border-dashed border-line bg-surface p-8 text-center">
            <Ban className="mx-auto h-8 w-8 text-muted-text" aria-hidden="true" />
            <p className="mt-3 text-sm font-semibold text-muted-text">{copy.noBlockedPlayers}</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {(list.data ?? []).map((player) => (
              <li key={player.userId} data-testid={`row-blocked-player-${player.userId}`} className="flex min-h-[76px] items-center gap-3 rounded-2xl border border-line bg-surface p-3">
                <div className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-raised font-semibold text-muted-text">
                  <span aria-hidden="true">{initials(player.name)}</span>
                  {player.avatarUrl && (
                    <img
                      src={player.avatarUrl}
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover"
                      onError={(event) => { event.currentTarget.style.display = "none"; }}
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p data-testid={`text-blocked-name-${player.userId}`} className="truncate text-sm font-semibold">{player.name}</p>
                  <time className="text-xs text-muted-text" dateTime={player.blockedAt}>
                    {formatter.format(new Date(player.blockedAt))}
                  </time>
                </div>
                <button
                  type="button"
                  disabled={unblock.isPending}
                  data-testid={`button-unblock-${player.userId}`}
                  onClick={() => void onUnblock(player)}
                  className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-line px-4 text-sm font-semibold text-text transition-colors hover:bg-raised disabled:opacity-50"
                >
                  {copy.unblock}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}