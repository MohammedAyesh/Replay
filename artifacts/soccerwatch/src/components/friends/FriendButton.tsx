import { Check, Clock3, UserPlus, Users, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { useFriendsCopy } from "@/i18n/friends-strings";
import {
  friendErrorKey,
  friendStatusFor,
  useAcceptFriendRequest,
  useDeclineFriendRequest,
  useFriends,
  useRemoveFriend,
  useSendFriendRequest,
} from "@/lib/friends-api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function FriendButton({ userId, name, compact = false }: { userId: number; name: string; compact?: boolean }) {
  const copy = useFriendsCopy();
  const { user, isGuest } = useAuth();
  const { toast } = useToast();
  const signedIn = Boolean(user) && !isGuest;
  const friends = useFriends(signedIn);
  const status = friendStatusFor(userId, friends.data);
  const send = useSendFriendRequest();
  const accept = useAcceptFriendRequest();
  const decline = useDeclineFriendRequest();
  const remove = useRemoveFriend();
  const busy = send.isPending || accept.isPending || decline.isPending || remove.isPending;

  if (user?.id === userId) return null;

  const showError = (error: unknown) => {
    const key = friendErrorKey(error);
    toast({ title: key ? copy.errors[key as keyof typeof copy.errors] ?? copy.errors.unknown : copy.error, variant: "destructive" });
  };
  const act = async (action: () => Promise<unknown>, success: string) => {
    if (!signedIn) {
      toast({ title: copy.signInToAdd });
      return;
    }
    try {
      await action();
      toast({ title: success });
    } catch (error) {
      showError(error);
    }
  };
  const add = () => act(() => send.mutateAsync(userId), copy.requestSent);
  const cancel = () => act(() => remove.mutateAsync(userId), copy.cancelRequest);
  const acceptIncoming = () => status.requestId
    ? act(() => accept.mutateAsync(status.requestId!), copy.requestAccepted)
    : undefined;
  const declineIncoming = () => status.requestId
    ? act(() => decline.mutateAsync(status.requestId!), copy.requestDeclined)
    : undefined;
  const removeFriend = () => act(() => remove.mutateAsync(userId), copy.removed);
  const buttonClass = cn(
    "flex min-h-11 items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-50",
    compact ? "h-11 w-11 min-w-11 px-0" : "w-full px-3",
  );

  if (status.status === "friends") {
    return (
      <DropdownMenu dir={copy.locale === "ar" ? "rtl" : "ltr"}>
        <DropdownMenuTrigger asChild>
          <button type="button" disabled={busy} className={cn(buttonClass, "w-full border border-turf/40 bg-turf/10 text-turf")} aria-label={copy.removeFriend}>
            <Users className="h-4 w-4 shrink-0" aria-hidden="true" />
            {!compact && copy.tabs.friends}
            {compact && <span className="sr-only">{copy.tabs.friends}</span>}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void removeFriend()} className="min-h-11 text-destructive">
            <X className="h-4 w-4" aria-hidden="true" />{copy.removeFriend}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (status.status === "incoming") {
    return (
      <div className={cn("flex items-center gap-1", !compact && "w-full", compact && "gap-0.5")}>
        <button
          type="button"
          disabled={busy || friends.isLoading}
          onClick={() => void acceptIncoming()}
          aria-label={compact ? copy.accept : undefined}
          className={cn(buttonClass, !compact && "flex-1", "bg-floodlight text-void")}
        >
          <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
          {!compact && copy.accept}
          {compact && <span className="sr-only">{copy.accept}</span>}
        </button>
        <button
          type="button"
          disabled={busy || friends.isLoading}
          onClick={() => void declineIncoming()}
          aria-label={compact ? copy.decline : undefined}
          className={cn(buttonClass, !compact && "flex-1", "border border-line text-muted-text")}
        >
          <X className="h-4 w-4 shrink-0" aria-hidden="true" />
          {!compact && copy.decline}
          {compact && <span className="sr-only">{copy.decline}</span>}
        </button>
      </div>
    );
  }

  if (status.status === "outgoing") {
    return (
      <button
        type="button"
        disabled={busy || friends.isLoading}
        onClick={() => void cancel()}
        aria-label={compact ? copy.cancelRequest : undefined}
        className={cn(buttonClass, "border border-line bg-raised text-muted-text")}
      >
        <Clock3 className="h-4 w-4 shrink-0" aria-hidden="true" />
        {!compact && copy.requested}
        {compact && <span className="sr-only">{copy.requested}</span>}
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={busy || friends.isLoading}
      onClick={() => void add()}
      aria-label={compact ? copy.addFriend : undefined}
      title={name}
      className={cn(buttonClass, "bg-floodlight text-void")}
    >
      <UserPlus className="h-4 w-4 shrink-0" aria-hidden="true" />
      {!compact && copy.addFriend}
      {compact && <span className="sr-only">{copy.addFriend}</span>}
      <span className="sr-only">{name}</span>
    </button>
  );
}