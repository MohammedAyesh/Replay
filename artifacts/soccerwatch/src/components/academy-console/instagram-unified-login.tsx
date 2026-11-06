import { useEffect, useRef, useState } from "react";
import { Check, Instagram, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSocialCopy } from "@/i18n/social-strings";
import { completeInstagramLogin, useInstagramLoginStart, usePendingInstagramAssets, useSelectInstagramAsset } from "@/lib/academy-social-api";
import { useQueryClient } from "@tanstack/react-query";

type InstagramOAuthMessage = {
  type: "replay-instagram-oauth";
  code?: string;
  state: string;
  error?: string;
  errorDescription?: string;
};

export function InstagramUnifiedLogin({ academyId, pending = false, reconnect = false, disabled = false }: {
  academyId: number;
  pending?: boolean;
  reconnect?: boolean;
  disabled?: boolean;
}) {
  const copy = useSocialCopy();
  const start = useInstagramLoginStart(academyId);
  const select = useSelectInstagramAsset(academyId);
  const queryClient = useQueryClient();
  const popup = useRef<Window | null>(null);
  const [working, setWorking] = useState(false);
  const [selecting, setSelecting] = useState(pending);
  const [error, setError] = useState<string | null>(null);
  const assets = usePendingInstagramAssets(academyId, selecting || pending);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["academy-social", academyId] }),
      queryClient.invalidateQueries({ queryKey: ["venue", academyId, "instagram"] }),
      queryClient.invalidateQueries({ queryKey: ["academy-social", academyId, "instagram-assets"] }),
    ]);
  };

  useEffect(() => {
    const receive = async (event: MessageEvent<InstagramOAuthMessage>) => {
      if (event.origin !== window.location.origin || event.source !== popup.current) return;
      const message = event.data;
      if (!message || message.type !== "replay-instagram-oauth" || !message.state) return;
      popup.current?.close();
      popup.current = null;
      setWorking(true);
      setError(null);
      try {
        const result = await completeInstagramLogin(message);
        if (result.status === "pending") {
          setSelecting(true);
          await refresh();
        } else {
          setSelecting(false);
          await refresh();
        }
      } catch (e) {
        setError((e as Error).message || "Instagram sign-in failed.");
      } finally {
        setWorking(false);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [academyId, queryClient]);

  const connect = async () => {
    setError(null);
    setWorking(true);
    // Open synchronously while the button click still counts as a user gesture.
    const opened = window.open("about:blank", `replay-instagram-${academyId}`, "popup,width=620,height=760");
    if (!opened) {
      setWorking(false);
      setError("Allow pop-ups for Replay, then try again.");
      return;
    }
    popup.current = opened;
    try {
      const result = await start.mutateAsync();
      opened.location.href = result.url;
    } catch (e) {
      opened.close();
      popup.current = null;
      setWorking(false);
      setError((e as Error).message || "Couldn't start Instagram sign-in.");
    }
  };

  const choose = (id: string) => {
    setError(null);
    select.mutate(id, {
      onSuccess: () => {
        setSelecting(false);
        void refresh();
      },
      onError: (e) => setError((e as Error).message),
    });
  };

  return (
    <div className="space-y-3" data-testid="instagram-unified-login">
      <Button type="button" disabled={disabled || working || select.isPending} onClick={() => void connect()}
        className="min-h-11 rounded-xl border border-pink-400/30 bg-pink-500/10 font-bold text-pink-100 hover:bg-pink-500/20"
        data-testid="button-continue-instagram">
        {working ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Instagram className="me-2 h-4 w-4" aria-hidden="true" />}
        {working ? copy.connect.instagramWorking : reconnect ? copy.connect.reconnectInstagram : copy.connect.instagramButton}
      </Button>
      <p className="max-w-xl text-xs leading-5 text-muted-text">{copy.connect.instagramLoginHint}</p>
      {(pending || selecting) && (
        <div className="space-y-2" data-testid="instagram-account-picker">
          <p className="text-sm font-semibold text-text">{copy.connect.instagramPickAccount}</p>
          {assets.isLoading ? <p className="text-sm text-muted-text">Loading Instagram accounts…</p>
            : (assets.data ?? []).map((asset) => (
              <Button key={asset.id} type="button" variant="outline" disabled={select.isPending} onClick={() => choose(asset.id)}
                className="min-h-11 w-full justify-start" data-testid={`button-instagram-account-${asset.id}`}>
                {asset.profilePictureUrl ? <img src={asset.profilePictureUrl} alt="" className="me-2 h-6 w-6 rounded-full" /> : <Instagram className="me-2 h-4 w-4 text-pink-400" />}
                {asset.username ? `@${asset.username}` : `Instagram account ${asset.id}`}
                {select.isSuccess && <Check className="ms-auto h-4 w-4 text-turf" />}
              </Button>
            ))}
          {assets.isError && <p className="text-sm text-red-300" role="alert">{(assets.error as Error).message}</p>}
        </div>
      )}
      {error && <p className="rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-300" role="alert" data-testid="instagram-login-error">{error}</p>}
    </div>
  );
}
