import { useEffect, useRef } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { ArrowLeft, ArrowRight, Loader2, Share2, UserPlus } from "lucide-react";
import { PlayerAvatar } from "@/components/match/bits";
import { useToast } from "@/hooks/use-toast";
import { useFriendsCopy } from "@/i18n/friends-strings";
import { useAuth } from "@/lib/auth";
import {
  friendErrorKey,
  friendStatusFor,
  FriendsApiError,
  useAcceptFriendLink,
  useFriendLink,
  useFriends,
  usePublicFriendLink,
} from "@/lib/friends-api";
import { clearPendingFriendLink, readPendingFriendLink, writePendingFriendLink } from "@/lib/friend-link-pending";
import { shareOrCopy } from "@/lib/match-api";

const appBasePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function FriendLinkPage() {
  const [, params] = useRoute("/f/:code");
  const code = (params?.code ?? "").toUpperCase();
  const copy = useFriendsCopy();
  const { user, isGuest, isLoading: authLoading } = useAuth();
  const signedIn = Boolean(user) && !isGuest;
  const target = usePublicFriendLink(code);
  const friends = useFriends(signedIn);
  const myLink = useFriendLink(signedIn);
  const accept = useAcceptFriendLink(code);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const autoAcceptedCode = useRef<string | null>(null);

  const showError = (error: unknown) => {
    const key = friendErrorKey(error);
    toast({
      title: key ? copy.errors[key as keyof typeof copy.errors] ?? copy.errors.unknown : copy.error,
      variant: "destructive",
    });
  };

  const finishAccept = async () => {
    try {
      await accept.mutateAsync();
      clearPendingFriendLink();
      toast({ title: copy.friendAdded });
      setLocation("/friends");
    } catch (error) {
      showError(error);
    }
  };

  useEffect(() => {
    if (authLoading || !signedIn || target.isLoading || !target.data || friends.isLoading) return;
    if (readPendingFriendLink(code) !== code || autoAcceptedCode.current === code) return;
    autoAcceptedCode.current = code;
    const status = friendStatusFor(target.data.userId, friends.data);
    if (target.data.userId === user?.id || status.status === "friends") {
      clearPendingFriendLink();
      return;
    }
    void finishAccept();
    // The code ref prevents a mutation rerender from accepting twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, code, friends.data, friends.isLoading, signedIn, target.data, target.isLoading, user?.id]);

  const handleSignUp = () => {
    writePendingFriendLink(code);
    setLocation(`/sign-up?redirect_url=${encodeURIComponent(`/f/${code}`)}`);
  };

  const shareOwnLink = async () => {
    const url = myLink.data?.url ?? `${window.location.origin}${appBasePath}/f/${code}`;
    const result = await shareOrCopy({ title: copy.shareTitle, text: copy.sharePrefix, url });
    if (result === "cancelled") return;
    if (result === "copied") toast({ title: copy.linkCopied });
    else if (result === "shared") toast({ title: copy.linkShared });
    else toast({ title: copy.shareFailed, variant: "destructive" });
  };

  const notFound = target.isError && target.error instanceof FriendsApiError && target.error.status === 404;
  if (target.isLoading) {
    return (
      <main dir={copy.locale === "ar" ? "rtl" : "ltr"} className="flex flex-1 items-center justify-center bg-void text-muted-text">
        <Loader2 className="h-5 w-5 animate-spin" aria-label={copy.linkLoading} />
      </main>
    );
  }
  if (notFound || !target.data) {
    return (
      <main dir={copy.locale === "ar" ? "rtl" : "ltr"} className="flex flex-1 flex-col items-center justify-center bg-void px-5 text-center text-text">
        <p role="alert" className="rounded-3xl border border-line bg-surface px-6 py-8 font-display text-xl font-bold">{notFound ? copy.linkUnknown : copy.error}</p>
        {target.isError && !notFound ? (
          <button type="button" onClick={() => void target.refetch()} className="mt-4 inline-flex min-h-11 items-center rounded-full border border-line px-5 text-sm font-semibold">{copy.retry}</button>
        ) : (
          <Link href="/home" className="mt-4 inline-flex min-h-11 items-center rounded-full border border-line px-5 text-sm font-semibold">{copy.back}</Link>
        )}
      </main>
    );
  }

  const person = target.data;
  const ownLink = signedIn && person.userId === user?.id;
  const alreadyFriends = friendStatusFor(person.userId, friends.data).status === "friends";
  const statusLoading = signedIn && friends.isLoading;

  return (
    <main dir={copy.locale === "ar" ? "rtl" : "ltr"} className="flex flex-1 flex-col items-center justify-center bg-void px-5 py-8 text-text">
      <section className="w-full max-w-sm rounded-3xl border border-line bg-surface p-6 text-center">
        <div className="mb-5 flex items-center justify-start">
          <button
            type="button"
            onClick={() => setLocation("/home")}
            aria-label={copy.back}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-line"
          >
            {copy.locale === "ar" ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
          </button>
        </div>
        <PlayerAvatar name={person.name} avatarUrl={person.avatarUrl} size={84} />
        <h1 className="mt-4 font-display text-2xl font-bold">{person.name}</h1>
        {person.position && <p className="mt-1 text-sm text-muted-text">{person.position}</p>}
        <p className="mt-4 text-sm text-muted-text">{copy.wantsToBeFriends(person.name)}</p>

        {ownLink ? (
          <>
            <p className="mt-5 rounded-xl border border-turf/30 bg-turf/10 p-3 text-sm font-semibold text-turf">{copy.ownFriendLink}</p>
            <button type="button" onClick={() => void shareOwnLink()} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-floodlight px-4 text-sm font-bold text-void">
              <Share2 className="h-4 w-4" />{copy.shareMyLink}
            </button>
          </>
        ) : alreadyFriends ? (
          <p className="mt-5 rounded-xl border border-turf/30 bg-turf/10 p-3 text-sm font-semibold text-turf">{copy.alreadyFriends}</p>
        ) : signedIn ? (
          <button
            type="button"
            disabled={accept.isPending || statusLoading}
            onClick={() => void finishAccept()}
            className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-floodlight px-4 text-sm font-bold text-void disabled:opacity-50"
          >
            {accept.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            {copy.addFromLink}
          </button>
        ) : (
          <button type="button" onClick={handleSignUp} className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-floodlight px-4 text-sm font-bold text-void">
            <UserPlus className="h-4 w-4" />{copy.signUpToAdd(person.name)}
          </button>
        )}
      </section>
    </main>
  );
}