import { useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import { Loader2, ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useTeamCopy } from "@/i18n/team-strings";
import { acceptInvite, peekInvite } from "@/lib/academy-team-api";

type Peek = Awaited<ReturnType<typeof peekInvite>>;

/** /academy/invite/:token — a manager or coach invite sent by the academy owner. */
export default function AcademyInvitePage() {
  const { token = "" } = useParams<{ token?: string }>();
  const [, setLocation] = useLocation();
  const { user, isLoading: authLoading, isGuest } = useAuth();
  const copy = useTeamCopy();
  const [peek, setPeek] = useState<Peek | null>(null);
  const [peekFailed, setPeekFailed] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    peekInvite(token).then((p) => { if (alive) setPeek(p); }).catch(() => { if (alive) setPeekFailed(true); });
    return () => { alive = false; };
  }, [token]);

  const invitePath = `/academy/invite/${encodeURIComponent(token)}`;
  const signedIn = Boolean(user) && !isGuest;
  const open = peek?.state === "open";
  const roleLabel = peek ? copy.team.roles[peek.role] : "";

  const accept = async () => {
    setAccepting(true);
    setError(null);
    try {
      await acceptInvite(token);
      setDone(true);
      setTimeout(() => setLocation("/academy"), 900);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAccepting(false);
    }
  };

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-void px-5 py-10" dir={copy.locale === "ar" ? "rtl" : "ltr"}>
      <section className="w-full max-w-md rounded-3xl border border-line bg-surface p-7 text-center" data-testid="academy-invite">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-turf/15 text-turf"><ShieldCheck size={26} aria-hidden="true" /></div>
        {!peek && !peekFailed && <Loader2 className="mx-auto mt-6 h-6 w-6 animate-spin text-muted-text" aria-label="…" />}
        {peekFailed && <p className="mt-6 text-sm text-muted-text" data-testid="invite-missing">{copy.invite.missing}</p>}
        {peek && !open && <p className="mt-6 text-sm text-muted-text" data-testid="invite-gone">{copy.invite.gone}</p>}
        {peek && open && (
          <>
            <h1 className="mt-5 font-display text-2xl font-bold tracking-tight text-text" dir="auto" data-testid="invite-title">{copy.invite.title(peek.academyName, roleLabel)}</h1>
            <p className="mt-3 text-sm leading-6 text-muted-text">{copy.invite.body}</p>
            {done ? (
              <p className="mt-6 text-sm font-semibold text-turf" role="status">{copy.invite.done}</p>
            ) : authLoading ? (
              <Loader2 className="mx-auto mt-6 h-5 w-5 animate-spin text-muted-text" />
            ) : signedIn ? (
              <button type="button" disabled={accepting} onClick={() => void accept()} className="mt-7 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-floodlight px-5 font-bold text-void disabled:opacity-60" data-testid="button-accept-invite">
                {accepting && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}{copy.invite.accept}
              </button>
            ) : (
              <button type="button" onClick={() => setLocation(`/sign-in?redirect_url=${encodeURIComponent(invitePath)}`)} className="mt-7 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-floodlight px-5 font-bold text-void" data-testid="link-invite-sign-in">
                {copy.invite.signIn}
              </button>
            )}
            {error && <p className="mt-3 text-sm text-red-400" role="alert">{error}</p>}
          </>
        )}
      </section>
    </main>
  );
}
