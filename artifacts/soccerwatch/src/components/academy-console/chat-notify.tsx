import { Bell, BellOff, BellRing, Loader2 } from "lucide-react";
import { useState } from "react";
import { useLocale } from "@/i18n/context";
import { useChatNotifications } from "@/lib/push-notifications";
import { cn } from "@/lib/utils";

const STRINGS = {
  en: {
    turnOn: "Notify me on this device",
    on: "Notifications on",
    turnOff: "Turn off on this device",
    blocked: "Notifications are blocked for Replay in this browser. Allow them in the site settings, then try again.",
    iosInstall: "On iPhone: tap Share, then Add to Home Screen, and open Replay from there to turn on notifications.",
    unsupported: "This browser can't show notifications.",
    failed: "Couldn't turn them on. Try again.",
    hint: "New WhatsApp, Instagram and Messenger messages buzz this phone or computer, even with Replay closed. A chat handed to someone tells only them; muted chats stay quiet.",
  },
  ar: {
    turnOn: "نبّهني على هالجهاز",
    on: "التنبيهات شغّالة",
    turnOff: "وقّفها على هالجهاز",
    blocked: "التنبيهات مسكّرة لـReplay بهالمتصفح. اسمحلها من إعدادات الموقع وجرّب كمان مرة.",
    iosInstall: "عالآيفون: اضغط مشاركة، بعدين «إضافة إلى الشاشة الرئيسية»، وافتح Replay من هناك عشان تشغّل التنبيهات.",
    unsupported: "هالمتصفح ما بيدعم التنبيهات.",
    failed: "ما زبط تشغيلها. جرّب كمان مرة.",
    hint: "رسائل واتساب وإنستغرام وماسنجر الجديدة بتوصلك عالموبايل أو الكمبيوتر حتى لو Replay مسكّر. المحادثة المحوّلة لشخص بتنبّهه هو بس، والمحادثات المكتومة ما بتنبّه.",
  },
};

/** Chats → "Notify me on this device": new messages as phone or computer notifications. */
export function ChatNotifyButton({ academyId }: { academyId: number }) {
  const { locale } = useLocale();
  const t = STRINGS[locale === "ar" ? "ar" : "en"];
  const n = useChatNotifications(academyId);
  const [showHint, setShowHint] = useState(false);
  if (n.state === "loading") return null;
  const note = n.state === "blocked" ? t.blocked : n.state === "ios-install" ? t.iosInstall : n.state === "unsupported" ? t.unsupported : n.error ? t.failed : showHint ? t.hint : null;
  const on = n.state === "on";
  const canAct = n.state === "on" || n.state === "off";
  return (
    <div className="space-y-1.5" data-testid="chat-notify">
      <button type="button" disabled={n.busy || (!canAct && n.state !== "blocked" && n.state !== "ios-install")}
        onClick={() => { if (!canAct) { setShowHint(true); return; } setShowHint(!on); void (on ? n.turnOff() : n.turnOn()); }}
        title={on ? t.turnOff : t.hint}
        className={cn("inline-flex min-h-9 items-center gap-2 rounded-full px-3.5 text-xs font-semibold transition-colors disabled:opacity-60",
          on ? "bg-turf/15 text-turf" : "border border-line bg-raised text-text hover:border-turf/50")}
        data-testid={on ? "chat-notify-off" : "chat-notify-on"}>
        {n.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          : on ? <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
          : canAct ? <Bell className="h-3.5 w-3.5" aria-hidden="true" /> : <BellOff className="h-3.5 w-3.5" aria-hidden="true" />}
        {on ? t.on : t.turnOn}
      </button>
      {note ? <p className="max-w-xl text-xs leading-5 text-muted-text" role={n.error ? "alert" : undefined}>{note}</p> : null}
    </div>
  );
}
