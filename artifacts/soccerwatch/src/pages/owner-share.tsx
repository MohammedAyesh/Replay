import { useEffect } from "react";
import { useLocation, useRoute } from "wouter";
import {
  getListUserClipsQueryKey,
  useCreateUserClip,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ClipPlayer, type ClipDraft } from "@/components/clip-player/ClipPlayer";
import { useAuth } from "@/lib/auth";

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

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function ownerWindowLabel(meta: OwnerShareMeta): string {
  const date = meta.startLocal.slice(0, 10);
  const [year, month, day] = date.split("-").map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day, 12));
  const weekday = new Intl.DateTimeFormat("en-JO", {
    weekday: "long",
    timeZone: "Asia/Amman",
  }).format(calendarDate);
  const monthName = new Intl.DateTimeFormat("en-JO", {
    month: "long",
    timeZone: "Asia/Amman",
  }).format(calendarDate);
  return `${weekday} ${calendarDate.getUTCDate()} ${monthName} · ${meta.startLocal.slice(11, 16)}–${meta.endLocal.slice(11, 16)}`;
}

export default function OwnerShare() {
  const [, params] = useRoute("/w/:token");
  const [, setLocation] = useLocation();
  const { user, isGuest } = useAuth();
  const queryClient = useQueryClient();
  const createUserClip = useCreateUserClip();
  const token = params?.token ?? window.__OWNER_SHARE__?.token ?? "";
  const meta = window.__OWNER_SHARE__?.token === token ? window.__OWNER_SHARE__ : null;

  useEffect(() => {
    if (meta) document.title = `${meta.fieldName} · Replay`;
  }, [meta]);

  if (!meta || !token) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-[#0B0F1A] px-6 text-center text-muted-foreground">
        This link is no longer available.
      </main>
    );
  }

  const saveClip = async (draft: ClipDraft) => {
    await createUserClip.mutateAsync({
      data: {
        videoId: "",
        ownerShareToken: token,
        title: draft.title,
        startTime: draft.startTime,
        endTime: draft.endTime,
        cropPath: draft.cropPath,
        visibility: "private",
        aspectRatio: draft.aspectRatio,
      },
    });
    await queryClient.invalidateQueries({ queryKey: getListUserClipsQueryKey() });
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[#0B0F1A] text-foreground">
      <div className="border-b border-white/[0.08] px-4 pb-3 pt-5">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">REPLAY · SHARED FOOTAGE</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{meta.fieldName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{ownerWindowLabel(meta)}</p>
      </div>
      <div className="p-3 sm:p-5">
        <ClipPlayer
          src={`${basePath}/w/${encodeURIComponent(token)}/manifest.m3u8`}
          title={meta.fieldName}
          source={{ kind: "ownerShare", token }}
          layout="inline"
          canSave={Boolean(user) && !isGuest}
          onRequireAuth={() => setLocation("/sign-in")}
          onSave={saveClip}
        />
      </div>
      <p className="px-4 pb-6 text-center text-xs text-muted-foreground">
        Record a moment to save your own private clip.
      </p>
    </main>
  );
}