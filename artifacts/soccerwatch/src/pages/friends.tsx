import { useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, ArrowRight, Loader2, MoreHorizontal, Search, Share2, Users } from "lucide-react";
import { PlayerAvatar } from "@/components/match/bits";
import { FriendButton } from "@/components/friends/FriendButton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useFriendsCopy, type FriendsCopy } from "@/i18n/friends-strings";
import { useAuth } from "@/lib/auth";
import {
  friendErrorKey,
  useAcceptFriendRequest,
  useDeclineFriendRequest,
  useFriendLink,
  useFriends,
  useFriendSuggestions,
  useRemoveFriend,
  useResetFriendLink,
  type FriendUser,
} from "@/lib/friends-api";
import { shareOrCopy } from "@/lib/match-api";
import { cn } from "@/lib/utils";

type Tab = "friends" | "requests" | "suggestions";

export default function FriendsPage() {
  const copy = useFriendsCopy();
  const { user, isGuest, isLoading: authLoading } = useAuth();
  const signedIn = Boolean(user) && !isGuest;
  const friendsQuery = useFriends(signedIn);
  const suggestionsQuery = useFriendSuggestions(signedIn);
  const friendLink = useFriendLink(signedIn);
  const resetLink = useResetFriendLink();
  const accept = useAcceptFriendRequest();
  const decline = useDeclineFriendRequest();
  const remove = useRemoveFriend();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<Tab>("friends");
  const [search, setSearch] = useState("");

  const data = friendsQuery.data ?? { friends: [], incoming: [], outgoing: [] };
  const requestCount = data.incoming.length + data.outgoing.length;
  const normalizedSearch = search.trim().toLocaleLowerCase(copy.locale);
  const filteredFriends = useMemo(() => data.friends.filter((friend) => (
    !normalizedSearch
    || friend.name.toLocaleLowerCase(copy.locale).includes(normalizedSearch)
    || (friend.position ?? "").toLocaleLowerCase(copy.locale).includes(normalizedSearch)
  )), [copy.locale, data.friends, normalizedSearch]);

  const showError = (error: unknown) => {
    const key = friendErrorKey(error);
    toast({
      title: key ? copy.errors[key as keyof typeof copy.errors] ?? copy.errors.unknown : copy.error,
      variant: "destructive",
    });
  };

  const shareMyLink = async () => {
    if (!friendLink.data?.url) return;
    const result = await shareOrCopy({
      title: copy.shareTitle,
      text: copy.sharePrefix,
      url: friendLink.data.url,
    });
    if (result === "copied") toast({ title: copy.linkCopied });
    else if (result === "shared") toast({ title: copy.linkShared });
    else toast({ title: copy.shareFailed, variant: "destructive" });
  };

  const resetMyLink = async () => {
    if (!window.confirm(copy.confirmReset)) return;
    try {
      await resetLink.mutateAsync();
      toast({ title: copy.resetDone });
    } catch (error) {
      showError(error);
    }
  };

  const runRequestAction = async (
    action: () => Promise<unknown>,
    success: string,
  ) => {
    try {
      await action();
      toast({ title: success });
    } catch (error) {
      showError(error);
    }
  };

  if (authLoading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-void text-muted-text" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
        <Loader2 className="h-5 w-5 animate-spin" aria-label={copy.title} />
      </div>
    );
  }

  if (!signedIn) {
    return (
      <main dir={copy.locale === "ar" ? "rtl" : "ltr"} className="flex min-h-0 flex-1 items-center justify-center bg-void px-4 pb-24 pt-4 text-text">
        <section className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 text-center">
          <Users className="mx-auto h-8 w-8 text-turf" aria-hidden="true" />
          <h1 className="mt-3 font-display text-lg font-bold">{copy.signInToAdd}</h1>
          <Link
            href={`/sign-in?redirect_url=${encodeURIComponent("/friends")}`}
            className="mt-5 flex min-h-11 w-full items-center justify-center rounded-full bg-floodlight px-4 text-sm font-bold text-void"
          >
            {copy.signIn}
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main dir={copy.locale === "ar" ? "rtl" : "ltr"} className="min-h-0 flex-1 overflow-y-auto bg-void px-4 pb-28 pt-3 text-text no-scrollbar">
      <header className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setLocation("/home")}
          aria-label={copy.back}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-text"
        >
          {copy.locale === "ar" ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
        </button>
        <h1 className="min-w-0 flex-1 font-display text-2xl font-bold">{copy.title}</h1>
        <button
          type="button"
          disabled={!friendLink.data?.url || friendLink.isLoading}
          onClick={() => void shareMyLink()}
          className="flex min-h-11 items-center gap-2 rounded-full bg-floodlight px-3 text-xs font-bold text-void disabled:opacity-50"
        >
          <Share2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">{copy.shareMyLink}</span>
          <span className="sm:hidden">{copy.share}</span>
        </button>
      </header>

      <div className="mb-4 flex items-center justify-between gap-2 rounded-2xl border border-line bg-surface px-3">
        <p className="min-w-0 truncate py-3 text-xs text-muted-text">{friendLink.isError ? copy.error : copy.friendLinkShareHelp}</p>
        <button
          type="button"
          disabled={resetLink.isPending || friendLink.isLoading}
          onClick={() => void resetMyLink()}
          className="min-h-11 shrink-0 rounded-full px-2 text-xs font-semibold text-muted-text underline underline-offset-2 disabled:opacity-50"
        >
          {copy.resetLink}
        </button>
      </div>

      <div role="tablist" aria-label={copy.title} className="mb-4 grid grid-cols-3 gap-1 rounded-2xl border border-line bg-surface p-1">
        {([
          ["friends", copy.tabs.friends, data.friends.length],
          ["requests", copy.tabs.requests, requestCount],
          ["suggestions", copy.tabs.suggestions, 0],
        ] as const).map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              "flex min-h-11 items-center justify-center gap-1 rounded-xl px-2 text-xs font-bold",
              tab === value ? "bg-turf/15 text-turf" : "text-muted-text",
            )}
          >
            {label}
            {count > 0 && <span className="rounded-full bg-raised px-1.5 py-0.5 text-[10px] tabular-nums">{count}</span>}
          </button>
        ))}
      </div>

      {tab === "friends" && (
        <section role="tabpanel" className="flex flex-col gap-3">
          {data.friends.length > 0 && (
            <label className="relative block">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={copy.searchFriends}
                className="min-h-11 w-full rounded-xl border border-line bg-surface ps-10 pe-3 text-sm outline-none focus:border-turf"
              />
            </label>
          )}
          {friendsQuery.isLoading ? (
            <LoadingRow label={copy.title} />
          ) : friendsQuery.isError ? (
            <ErrorState message={copy.error} retryLabel={copy.retry} onRetry={() => void friendsQuery.refetch()} />
          ) : filteredFriends.length ? (
            <div className="flex flex-col gap-2">
              {filteredFriends.map((friend) => (
                <FriendRow
                  key={friend.userId}
                  friend={friend}
                  copy={copy}
                  onRemove={() => void runRequestAction(() => remove.mutateAsync(friend.userId), copy.removed)}
                  removing={remove.isPending}
                />
              ))}
            </div>
          ) : data.friends.length ? (
            <EmptyState title={copy.noSearchResults} detail="" />
          ) : (
            <EmptyState title={copy.emptyFriendsTitle} detail={copy.emptyFriendsDesc}>
              <Link href="/matches" className="inline-flex min-h-11 items-center justify-center rounded-full border border-line px-4 text-sm font-semibold text-turf">{copy.findFriends}</Link>
            </EmptyState>
          )}
        </section>
      )}

      {tab === "requests" && (
        <section role="tabpanel" className="flex flex-col gap-3">
          {friendsQuery.isLoading ? <LoadingRow label={copy.title} /> : friendsQuery.isError ? (
            <ErrorState message={copy.error} retryLabel={copy.retry} onRetry={() => void friendsQuery.refetch()} />
          ) : requestCount === 0 ? (
            <EmptyState title={copy.emptyRequestsTitle} detail={copy.emptyRequestsDesc} />
          ) : (
            <div className="flex flex-col gap-2">
              {data.incoming.map((request) => (
                <FriendRequestRow key={`in-${request.userId}`} friend={request} copy={copy}>
                  <button
                    type="button"
                    disabled={accept.isPending || decline.isPending}
                    onClick={() => request.requestId && void runRequestAction(() => accept.mutateAsync(request.requestId!), copy.requestAccepted)}
                    className="min-h-11 rounded-full bg-floodlight px-3 text-xs font-bold text-void disabled:opacity-50"
                  >
                    {copy.accept}
                  </button>
                  <button
                    type="button"
                    disabled={accept.isPending || decline.isPending}
                    onClick={() => request.requestId && void runRequestAction(() => decline.mutateAsync(request.requestId!), copy.requestDeclined)}
                    className="min-h-11 rounded-full border border-line px-3 text-xs font-semibold text-muted-text disabled:opacity-50"
                  >
                    {copy.decline}
                  </button>
                </FriendRequestRow>
              ))}
              {data.outgoing.map((request) => (
                <FriendRequestRow key={`out-${request.userId}`} friend={request} copy={copy}>
                  <button
                    type="button"
                    disabled={remove.isPending}
                    onClick={() => void runRequestAction(() => remove.mutateAsync(request.userId), copy.cancelRequest)}
                    className="min-h-11 rounded-full border border-line px-3 text-xs font-semibold text-muted-text disabled:opacity-50"
                  >
                    {copy.cancelRequest}
                  </button>
                </FriendRequestRow>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "suggestions" && (
        <section role="tabpanel" className="flex flex-col gap-3">
          {suggestionsQuery.isLoading ? <LoadingRow label={copy.tabs.suggestions} /> : suggestionsQuery.isError ? (
            <ErrorState message={copy.error} retryLabel={copy.retry} onRetry={() => void suggestionsQuery.refetch()} />
          ) : suggestionsQuery.data?.length ? (
            suggestionsQuery.data.map((suggestion) => (
              <div key={suggestion.userId} className="flex min-h-[68px] items-center gap-3 rounded-2xl border border-line bg-surface p-3">
                <PlayerAvatar name={suggestion.name} avatarUrl={suggestion.avatarUrl} size={44} />
                <Link href={`/players/${suggestion.userId}`} className="min-w-0 flex-1 py-1">
                  <span className="block truncate text-sm font-bold">{suggestion.name}</span>
                  <span className="block truncate text-xs text-muted-text">{suggestion.position || copy.positionUnknown}</span>
                  <span className="block truncate text-[11px] text-turf">{copy.playedTogether(suggestion.matchesTogether)}</span>
                </Link>
                <FriendButton userId={suggestion.userId} name={suggestion.name} compact />
              </div>
            ))
          ) : (
            <EmptyState title={copy.emptySuggestionsTitle} detail={copy.emptySuggestionsDesc}>
              <Link href="/matches" className="inline-flex min-h-11 items-center justify-center rounded-full border border-line px-4 text-sm font-semibold text-turf">{copy.findFriends}</Link>
            </EmptyState>
          )}
        </section>
      )}
    </main>
  );
}

function LoadingRow({ label }: { label: string }) {
  return <div className="flex min-h-28 items-center justify-center text-muted-text"><Loader2 className="h-5 w-5 animate-spin" aria-label={label} /></div>;
}

function EmptyState({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-surface/70 px-5 py-8 text-center">
      <Users className="mx-auto h-8 w-8 text-turf" aria-hidden="true" />
      <h2 className="mt-3 font-display text-lg font-bold">{title}</h2>
      {detail && <p className="mx-auto mt-1 max-w-xs text-sm text-muted-text">{detail}</p>}
      {children && <div className="mt-4 flex justify-center gap-2">{children}</div>}
    </div>
  );
}

function ErrorState({ message, retryLabel, onRetry }: { message: string; retryLabel: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-2xl border border-line bg-surface px-5 py-6 text-center">
      <p className="text-sm text-muted-text">{message}</p>
      <button type="button" onClick={onRetry} className="mt-3 min-h-11 rounded-full border border-line px-4 text-sm font-semibold text-turf">{retryLabel}</button>
    </div>
  );
}

function FriendRow({ friend, copy, onRemove, removing }: {
  friend: FriendUser; copy: FriendsCopy; onRemove: () => void; removing: boolean;
}) {
  return (
    <div className="flex min-h-[68px] items-center gap-3 rounded-2xl border border-line bg-surface p-3">
      <Link href={`/players/${friend.userId}`} aria-label={friend.name} className="flex min-h-11 min-w-0 flex-1 items-center gap-3">
        <PlayerAvatar name={friend.name} avatarUrl={friend.avatarUrl} size={44} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-bold">{friend.name}</span>
          <span className="block truncate text-xs text-muted-text">{friend.position || copy.positionUnknown}</span>
        </span>
      </Link>
      <DropdownMenu dir={copy.locale === "ar" ? "rtl" : "ltr"}>
        <DropdownMenuTrigger asChild>
          <button type="button" disabled={removing} aria-label={copy.moreActions} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line text-muted-text">
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onRemove} className="min-h-11 text-destructive">{copy.removeFriend}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function FriendRequestRow({ friend, copy, children }: {
  friend: FriendUser; copy: FriendsCopy; children: ReactNode;
}) {
  return (
    <div className="flex min-h-[68px] items-center gap-3 rounded-2xl border border-line bg-surface p-3">
      <PlayerAvatar name={friend.name} avatarUrl={friend.avatarUrl} size={44} />
      <Link href={`/players/${friend.userId}`} className="min-w-0 flex-1 py-1">
        <span className="block truncate text-sm font-bold">{friend.name}</span>
        <span className="block truncate text-xs text-muted-text">{friend.position || copy.positionUnknown}</span>
      </Link>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}