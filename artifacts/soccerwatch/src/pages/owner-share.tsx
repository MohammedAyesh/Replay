import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListUserClipsQueryKey,
  useCreateUserClip,
} from "@workspace/api-client-react";
import { ClipPlayer, type ClipDraft } from "@/components/clip-player/ClipPlayer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "@/i18n";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

export type OwnerShareMeta = {
  token: string;
  fieldName: string;
  startLocal: string;
  endLocal: string;
  expiresAt: string;
};

declare global {
  interface Window {
    __OWNER_SHARE__?: OwnerShareMeta;
  }
}

function calendarDate(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function ownerWindowLabel(meta: OwnerShareMeta, locale: "en" | "ar"): string {
  const date = calendarDate(meta.startLocal);
  const formatterLocale = locale === "ar" ? "ar-JO" : "en-US";
  const weekday = new Intl.DateTimeFormat(formatterLocale, {
    weekday: "long",
    timeZone: "Asia/Amman",
  }).format(date);
  const month = new Intl.DateTimeFormat(formatterLocale, {
    month: "long",
    timeZone: "Asia/Amman",
  }).format(date);
  return `${weekday} ${date.getUTCDate()} ${month} · ${meta.startLocal.slice(11, 16)}–${meta.endLocal.slice(11, 16)}`;
}

function expiryLabel(meta: OwnerShareMeta, locale: "en" | "ar"): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "Asia/Amman",
  }).format(new Date(meta.expiresAt));
}

function readDraft(token: string): ClipDraft | null {
  try {
    const raw = sessionStorage.getItem(`ownerShareDraft:${token}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClipDraft;
    if (
      typeof parsed.startTime !== "number" ||
      typeof parsed.endTime !== "number" ||
      !Array.isArray(parsed.cropPath) ||
      (parsed.aspectRatio !== "16:9" && parsed.aspectRatio !== "9:16") ||
      typeof parsed.title !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveDraft(token: string, draft: ClipDraft): void {
  try {
    sessionStorage.setItem(`ownerShareDraft:${token}`, JSON.stringify(draft));
  } catch {
    // The save prompt still works if storage is unavailable; the user can retry.
  }
}

function clearDraft(token: string): void {
  try {
    sessionStorage.removeItem(`ownerShareDraft:${token}`);
  } catch {
    // Ignore storage cleanup failures after a successful save.
  }
}

export default function OwnerShare() {
  const [, params] = useRoute("/w/:token");
  const [, setLocation] = useLocation();
  const { locale } = useTranslation();
  const { toast } = useToast();
  const { user, isGuest } = useAuth();
  const queryClient = useQueryClient();
  const createUserClip = useCreateUserClip();
  const token = params?.token ?? window.__OWNER_SHARE__?.token ?? "";
  const injectedMeta = window.__OWNER_SHARE__?.token === token ? window.__OWNER_SHARE__ : null;
  const [meta, setMeta] = useState<OwnerShareMeta | null>(injectedMeta);
  const [metaLoading, setMetaLoading] = useState(!injectedMeta);
  const [unavailable, setUnavailable] = useState(false);
  const [authPromptOpen, setAuthPromptOpen] = useState(false);
  const [isRestoringDraft, setIsRestoringDraft] = useState(false);
  const restoringRef = useRef(false);
  const isArabic = locale === "ar";
  const copy = isArabic
    ? {
        availableUntil: "متاح حتى",
        wantClips: "بدك مقاطعك الخاصة؟",
        openReplay: "افتح Replay",
        saving: "جاري حفظ مقطعك…",
        saved: "تم الحفظ في مقاطعي",
        myClips: "مقاطعي",
        authTitle: "سجّل مجاناً لحفظ هذا المقطع",
        authDescription: "أنشئ حسابًا مجانيًا للعودة إلى هذا المقطع وحفظه.",
        signUp: "إنشاء حساب",
        signIn: "تسجيل الدخول",
        unavailable: "هذا الرابط لم يعد متاحاً.",
        loading: "جاري تحميل المقطع…",
      }
    : {
        availableUntil: "Available until",
        wantClips: "Want your own clips?",
        openReplay: "Open Replay",
        saving: "Saving your clip…",
        saved: "Saved to My Clips",
        myClips: "My Clips",
        authTitle: "Sign up free to save this clip",
        authDescription: "Create a free account to return to this footage and save it.",
        signUp: "Sign up",
        signIn: "Sign in",
        unavailable: "This link is no longer available.",
        loading: "Loading clip…",
      };

  useEffect(() => {
    document.title = meta ? `${meta.fieldName} · Replay` : "Replay";
  }, [meta]);

  useEffect(() => {
    if (!token) {
      setMetaLoading(false);
      setUnavailable(true);
      return;
    }
    if (injectedMeta) {
      setMeta(injectedMeta);
      setMetaLoading(false);
      return;
    }

    let cancelled = false;
    setMetaLoading(true);
    fetch(`/w/${encodeURIComponent(token)}/meta`, { credentials: "include" })
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 404) {
          setUnavailable(true);
          setMeta(null);
          return;
        }
        if (!response.ok) throw new Error(`Metadata request failed: ${response.status}`);
        setMeta((await response.json()) as OwnerShareMeta);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setMetaLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [injectedMeta, token]);

  const redirectPath = `/w/${encodeURIComponent(token)}`;
  const authPath = (path: "/sign-up" | "/sign-in") =>
    `${path}?redirect_url=${encodeURIComponent(redirectPath)}`;

  const notifySaved = useCallback(() => {
    toast({
      title: copy.saved,
      description: (
        <Link href="/my-clips" className="font-semibold underline underline-offset-2">
          {copy.myClips}
        </Link>
      ),
      className: "bg-primary text-white border-none",
      duration: 3500,
    });
  }, [copy.myClips, copy.saved, toast]);

  const saveOwnerClip = useCallback(async (draft: ClipDraft) => {
    await createUserClip.mutateAsync({
      data: {
        title: draft.title,
        startTime: draft.startTime,
        endTime: draft.endTime,
        cropPath: draft.cropPath,
        visibility: "private",
        aspectRatio: draft.aspectRatio,
        ownerShareToken: token,
      },
    });
    await queryClient.invalidateQueries({ queryKey: getListUserClipsQueryKey() });
  }, [createUserClip, queryClient, token]);

  useEffect(() => {
    if (!user || isGuest || !token || restoringRef.current) return;
    const draft = readDraft(token);
    if (!draft) return;

    restoringRef.current = true;
    setIsRestoringDraft(true);
    saveOwnerClip(draft)
      .then(() => {
        clearDraft(token);
        notifySaved();
      })
      .catch(() => {
        restoringRef.current = false;
        toast({
          title: isArabic ? "تعذر حفظ المقطع" : "Could not save your clip",
          variant: "destructive",
        });
      })
      .finally(() => setIsRestoringDraft(false));
  }, [isArabic, isGuest, notifySaved, saveOwnerClip, toast, token, user]);

  const onRequireAuth = (draft: ClipDraft) => {
    saveDraft(token, draft);
    setAuthPromptOpen(true);
  };

  if (metaLoading) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-[#0B0F1A] px-6 text-center text-muted-foreground">
        {copy.loading}
      </main>
    );
  }

  if (unavailable || !meta) {
    return (
      <main
        dir={isArabic ? "rtl" : "ltr"}
        className="flex min-h-0 flex-1 items-center justify-center bg-[#0B0F1A] px-6 text-center text-muted-foreground"
      >
        {copy.unavailable}
      </main>
    );
  }

  return (
    <main
      dir={isArabic ? "rtl" : "ltr"}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[#0B0F1A] text-foreground"
    >
      <div className="border-b border-white/[0.08] px-4 pb-3 pt-5">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">REPLAY</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{meta.fieldName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{ownerWindowLabel(meta, locale)}</p>
        <span className="mt-3 inline-flex rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
          {copy.availableUntil} {expiryLabel(meta, locale)}
        </span>
      </div>

      {isRestoringDraft && (
        <div className="px-4 pt-3 text-sm font-medium text-primary" role="status">
          {copy.saving}
        </div>
      )}

      <div className="p-3 sm:p-5">
        <ClipPlayer
          src={`/w/${token}/manifest.m3u8`}
          title={meta.fieldName}
          source={{ kind: "ownerShare", token }}
          layout="inline"
          canSave={Boolean(user) && !isGuest}
          onRequireAuth={onRequireAuth}
          onSave={async (draft) => {
            await saveOwnerClip(draft);
          }}
        />
      </div>

      <div className="mx-3 mb-6 flex items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-[#141B2C] p-4 sm:mx-5">
        <p className="text-sm font-semibold">{copy.wantClips}</p>
        <Link
          href="/home"
          className="shrink-0 rounded-xl bg-primary px-3 py-2 text-sm font-bold text-[#0B0F1A]"
        >
          {copy.openReplay}
        </Link>
      </div>

      <Dialog open={authPromptOpen} onOpenChange={setAuthPromptOpen}>
        <DialogContent
          dir={isArabic ? "rtl" : "ltr"}
          className={cn("border-white/10 bg-[#141B2C] text-white", isArabic && "text-right")}
        >
          <DialogHeader>
            <DialogTitle>{copy.authTitle}</DialogTitle>
            <DialogDescription className="text-white/65">{copy.authDescription}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setLocation(authPath("/sign-up"))}
              className="flex-1 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-[#0B0F1A]"
            >
              {copy.signUp}
            </button>
            <button
              type="button"
              onClick={() => setLocation(authPath("/sign-in"))}
              className="flex-1 rounded-xl border border-white/15 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white"
            >
              {copy.signIn}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}