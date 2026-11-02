import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, QrCode, Smartphone } from "lucide-react";
import { useWhatsappCopy } from "@/i18n/whatsapp-strings";
import { useConnectWhatsapp, useWhatsappQr } from "@/lib/academy-whatsapp-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Link a WhatsApp number to a WAHA session, by QR (from a computer) or by an
 * 8-character pairing code (when the console is open on the same phone).
 */
export function WhatsappLinkDialog({
  target,
  open,
  onOpenChange,
  title,
  onLinked,
}: {
  target: number | "replay";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  onLinked?: () => void;
}) {
  const copy = useWhatsappCopy();
  const [method, setMethod] = useState<"qr" | "code">(() =>
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches ? "code" : "qr");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connect = useConnectWhatsapp(target);
  const qr = useWhatsappQr(target, open);
  const status = qr.data?.status ?? null;
  const linked = status === "WORKING";

  useEffect(() => {
    if (!open) {
      setCode(null);
      setError(null);
      return;
    }
    if (method === "qr") {
      setError(null);
      connect.mutate({ method: "qr" }, { onError: (e) => setError((e as Error).message) });
    }
    // Start only when the dialog opens or the method changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, method]);

  useEffect(() => {
    if (linked) onLinked?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked]);

  const requestCode = () => {
    setError(null);
    setCode(null);
    connect.mutate(
      { method: "code", phone },
      {
        onSuccess: (result) => setCode(result.code),
        onError: (e) => setError((e as Error).message),
      },
    );
  };

  const steps = method === "qr" ? copy.link.qrSteps : copy.link.codeSteps;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir={copy.locale === "ar" ? "rtl" : "ltr"} className="max-h-[92dvh] overflow-y-auto border-line bg-surface text-text sm:max-w-lg">
        <DialogHeader className="text-start">
          <DialogTitle>{title ?? copy.link.title}</DialogTitle>
          <DialogDescription className="sr-only">{copy.link.title}</DialogDescription>
        </DialogHeader>

        {linked ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center" data-testid="whatsapp-link-done">
            <CheckCircle2 className="h-12 w-12 text-turf" aria-hidden="true" />
            <p className="font-display text-xl font-bold">{copy.link.done}</p>
            {(qr.data?.phone || qr.data?.name) && (
              <p className="text-sm text-muted-text" dir="ltr">{[qr.data?.name, qr.data?.phone].filter(Boolean).join(" · ")}</p>
            )}
            <Button type="button" onClick={() => onOpenChange(false)} className="mt-2 min-h-11 bg-floodlight font-bold text-void">{copy.link.close}</Button>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-raised p-1">
              {(["qr", "code"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethod(m)}
                  className={cn(
                    "flex min-h-10 items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors",
                    method === m ? "bg-surface text-text shadow" : "text-muted-text hover:text-text",
                  )}
                  data-testid={`whatsapp-link-method-${m}`}
                >
                  {m === "qr" ? <QrCode className="h-4 w-4" aria-hidden="true" /> : <Smartphone className="h-4 w-4" aria-hidden="true" />}
                  {m === "qr" ? copy.link.qrTab : copy.link.codeTab}
                </button>
              ))}
            </div>

            <ol className="list-decimal space-y-1.5 ps-5 text-sm leading-6 text-muted-text">
              {steps.map((step) => <li key={step}>{step}</li>)}
            </ol>

            {method === "qr" ? (
              <div className="flex min-h-[280px] items-center justify-center rounded-2xl border border-line bg-white p-4">
                {qr.data?.qr ? (
                  <img src={qr.data.qr} alt="WhatsApp QR" className="h-64 w-64" data-testid="whatsapp-qr" />
                ) : (
                  <span className="flex items-center gap-2 text-sm text-neutral-600">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    {connect.isPending ? copy.link.starting : copy.link.waiting}
                  </span>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="whatsapp-link-phone">{copy.link.phone}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="whatsapp-link-phone"
                      dir="ltr"
                      inputMode="tel"
                      placeholder="07X XXX XXXX"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="min-h-11"
                      data-testid="input-whatsapp-link-phone"
                    />
                    <Button type="button" disabled={!phone.trim() || connect.isPending} onClick={requestCode} className="min-h-11 shrink-0 bg-floodlight font-bold text-void" data-testid="button-whatsapp-get-code">
                      {connect.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : copy.link.getCode}
                    </Button>
                  </div>
                </div>
                {code && (
                  <div className="rounded-2xl border border-turf/40 bg-turf/10 p-5 text-center">
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-turf">{copy.link.codeLabel}</p>
                    <p dir="ltr" className="mt-2 select-all font-mono text-3xl font-bold tracking-[0.2em] text-text" data-testid="whatsapp-pairing-code">{code}</p>
                    <p className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-text"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />{copy.link.waiting}</p>
                  </div>
                )}
              </div>
            )}

            {(error || status === "FAILED") && (
              <p className="text-sm text-red-400" role="alert">{error ?? copy.link.failed}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
