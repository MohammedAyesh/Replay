import { useEffect, useState } from "react";
import { Check, Instagram, Loader2 } from "lucide-react";
import { completeInstagramLogin, type InstagramAssetChoice, type InstagramLoginResult, useSelectInstagramAsset } from "@/lib/academy-social-api";
import { Button } from "@/components/ui/button";

type CallbackMessage = {
  type: "replay-instagram-oauth";
  code?: string;
  state: string;
  error?: string;
  errorDescription?: string;
};

const messageType = "replay-instagram-oauth";

export default function InstagramCallbackPage() {
  const [status, setStatus] = useState("Finishing Instagram sign-in…");
  const [error, setError] = useState<string | null>(null);
  const [academyId, setAcademyId] = useState<number | null>(null);
  const [accounts, setAccounts] = useState<InstagramAssetChoice[]>([]);
  const [connectedName, setConnectedName] = useState<string | null>(null);
  const selection = useSelectInstagramAsset(academyId ?? 0);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthState = params.get("state") ?? "";
    const code = params.get("code") ?? undefined;
    const oauthError = params.get("error") ?? undefined;
    const errorDescription = params.get("error_description") ?? undefined;
    window.history.replaceState(null, "", window.location.pathname);
    if (!oauthState) {
      setError("Instagram sign-in did not include a secure state. Start again from Social.");
      setStatus("Instagram wasn't connected.");
      return;
    }
    const message: CallbackMessage = { type: messageType, code, state: oauthState, error: oauthError, errorDescription };
    if (window.opener && window.opener !== window) {
      window.opener.postMessage(message, window.location.origin);
      setStatus("Instagram sign-in returned. This window will close after Replay confirms it.");
      return;
    }
    void completeInstagramLogin(message).then((result) => applyResult(result)).catch((e: unknown) => {
      setError((e as Error).message || "Instagram sign-in failed.");
      setStatus("Instagram wasn't connected.");
    });
    // Only process the OAuth response once, on page entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyResult = (result: InstagramLoginResult) => {
    setAcademyId(result.academyId);
    if (result.status === "pending") {
      setAccounts(result.accounts ?? []);
      setStatus("Choose which Instagram account to connect.");
    } else {
      setConnectedName(result.igUsername ?? null);
      setStatus("Instagram connected.");
    }
  };

  const choose = (id: string) => {
    setError(null);
    selection.mutate(id, {
      onSuccess: (result) => {
        setAccounts([]);
        setConnectedName(result.igUsername);
        setStatus("Instagram connected.");
      },
      onError: (e) => setError((e as Error).message),
    });
  };

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-void px-5 py-10 text-text">
      <section className="w-full max-w-lg rounded-3xl border border-line bg-surface p-6 sm:p-8" aria-live="polite" data-testid="instagram-callback-status">
        <div className="flex items-center gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-turf/15 text-turf"><Instagram className="h-6 w-6" /></span>
          <div>
            <h1 className="font-display text-2xl font-bold">Instagram connection</h1>
            <p className="mt-1 text-sm text-muted-text">{status}</p>
          </div>
        </div>
        {connectedName !== null && <p className="mt-5 flex items-center gap-2 rounded-xl bg-turf/10 p-3 text-sm font-semibold text-turf"><Check className="h-4 w-4" />Connected with Instagram @{connectedName}</p>}
        {accounts.length > 1 && (
          <div className="mt-5 space-y-2">
            {accounts.map((account) => (
              <Button key={account.id} type="button" variant="outline" disabled={selection.isPending} onClick={() => choose(account.id)} className="min-h-12 w-full justify-start">
                <Instagram className="me-2 h-4 w-4 text-pink-400" />{account.username ? `@${account.username}` : `Instagram account ${account.id}`}
              </Button>
            ))}
          </div>
        )}
        {selection.isPending && <p className="mt-4 flex items-center gap-2 text-sm text-muted-text"><Loader2 className="h-4 w-4 animate-spin" />Connecting account…</p>}
        {error && <p className="mt-5 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-300" role="alert">{error}</p>}
        <div className="mt-6 flex flex-wrap gap-3 text-sm">
          <a href="/field/social" className="font-semibold text-turf underline-offset-2 hover:underline">Back to field Social</a>
          <a href="/academy" className="font-semibold text-turf underline-offset-2 hover:underline">Back to academy Social</a>
        </div>
      </section>
    </main>
  );
}
