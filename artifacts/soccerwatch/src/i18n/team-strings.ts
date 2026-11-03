import { useLocale } from "./context";
import { useConsoleWording } from "@/lib/console-kind";

const en = {
  chat: {
    archived: "Archived",
    hidden: "Hidden chats",
    archive: "Archive",
    unarchive: "Move back to chats",
    mute: "Mute",
    unmute: "Unmute",
    block: "Block",
    unblock: "Unblock",
    personal: "Mark as personal",
    personalConfirm: "This chat leaves Replay: its messages here are deleted and new ones aren't kept. Your WhatsApp itself isn't touched.",
    blockConfirm: "Nothing from this number will be kept, and nothing will be sent to it, until you unblock it.",
    confirm: "Yes, do it",
    cancel: "Cancel",
    actions: "Chat options",
    noLink: "Not a player's family",
    later: "Later",
    linkAgain: "Link to a player",
    mutedLabel: "Muted",
    blockedNote: "You blocked this number. Messages from it aren't kept, and nothing is sent to it.",
    restore: "Bring back",
    personalTag: "Personal",
    blockedTag: "Blocked",
    noHidden: "Nothing hidden.",
    needPermission: "Only the owner can archive, mute, block or hide chats, unless he gives your role that permission.",
  },
  team: {
    nav: "Team",
    title: "Team & permissions",
    description: "Add a manager or coaches, and choose what each role sees: managers, coaches, parents and players.",
    members: "Members",
    roles: { owner: "Owner", manager: "Manager", coach: "Coach", parent: "Parents", player: "Players" } as Record<string, string>,
    you: "You",
    remove: "Remove",
    makeManager: "Make manager",
    makeCoach: "Make coach",
    invite: "Invite",
    inviteManager: "Invite a manager",
    inviteCoach: "Invite a coach",
    inviteHint: "Send the link on WhatsApp. Whoever opens it, signs in and accepts joins with that role. Each link works once, for 7 days.",
    labelPlaceholder: "Who is it for? (only you see this)",
    pending: "Waiting to be accepted",
    copy: "Copy link",
    copied: "Copied",
    share: "Send on WhatsApp",
    revoke: "Cancel",
    expires: (d: string) => `Until ${d}`,
    managerNote: "A manager has your controls in every section you let him see, but never this Team screen.",
    whatTitle: "What each role sees",
    whatHint: "Turn a screen off and that role no longer sees it. For coaches, opening Fees, Ads, Branding or Studio gives them full control there.",
    console: "Academy console",
    family: "Family page (parents and players)",
    allowed: "What they may do",
    chatsManage: "Archive, mute, block and hide chats",
    sections: {
      dashboard: "Dashboard", squads: "Squads", players: "Players", registrations: "Registrations", attendance: "Attendance",
      schedule: "Schedule & results", recordings: "Recordings", matches: "Matches", fees: "Fees & payments", announcements: "Announcements",
      chats: "Chats", people: "People", whatsapp: "WhatsApp", social: "Instagram & Facebook", ads: "Ads", profile: "Profile", branding: "Branding", studio: "Studio",
    } as Record<string, string>,
    screens: {
      schedule: "Schedule", footage: "Session videos", matches: "Match pages", attendance: "Attendance", news: "News", fees: "Fees", payments: "Payments",
    } as Record<string, string>,
    saved: "Saved",
  },
  invite: {
    title: (academy: string, role: string) => `Join ${academy} as ${role}`,
    body: "Accept to get the academy console on this account.",
    signIn: "Sign in to accept",
    accept: "Accept",
    done: "You're in. Opening the academy console…",
    gone: "This invite link has expired or was already used. Ask the academy for a new one.",
    missing: "This invite link isn't valid.",
  },
};

type Strings = typeof en;

const ar: Strings = {
  chat: {
    archived: "المؤرشفة",
    hidden: "المحادثات المخفية",
    archive: "أرشفة",
    unarchive: "رجّعها للمحادثات",
    mute: "كتم",
    unmute: "إلغاء الكتم",
    block: "حظر",
    unblock: "إلغاء الحظر",
    personal: "خاصة (شخصية)",
    personalConfirm: "هالمحادثة بتطلع من Replay: رسائلها هون بتنحذف والجديدة ما بتنحفظ. الواتساب تبعك نفسه ما بتأثر.",
    blockConfirm: "ما رح ينحفظ أي إشي من هالرقم، وما رح يوصله أي إشي، لحد ما تلغي الحظر.",
    confirm: "أكيد",
    cancel: "إلغاء",
    actions: "خيارات المحادثة",
    noLink: "مش من أهالي اللاعبين",
    later: "بعدين",
    linkAgain: "اربطه بلاعب",
    mutedLabel: "مكتومة",
    blockedNote: "إنت حاظر هالرقم. رسائله ما بتنحفظ وما بينبعتله إشي.",
    restore: "رجّعها",
    personalTag: "شخصية",
    blockedTag: "محظور",
    noHidden: "ما في إشي مخفي.",
    needPermission: "صاحب الأكاديمية بس بقدر يؤرشف، يكتم، يحظر أو يخفي المحادثات، إلا إذا أعطى دورك هالصلاحية.",
  },
  team: {
    nav: "الفريق",
    title: "الفريق والصلاحيات",
    description: "ضيف مدير أو مدربين، واختار شو بيشوف كل دور: المدير، المدربين، الأهالي واللاعبين.",
    members: "الأعضاء",
    roles: { owner: "المالك", manager: "مدير", coach: "مدرب", parent: "الأهالي", player: "اللاعبين" },
    you: "إنت",
    remove: "إزالة",
    makeManager: "خلّيه مدير",
    makeCoach: "خلّيه مدرب",
    invite: "دعوة",
    inviteManager: "ادعُ مدير",
    inviteCoach: "ادعُ مدرب",
    inviteHint: "ابعت الرابط على واتساب. اللي بفتحه وبسجّل دخول وبقبل بنضم بهالدور. كل رابط بشتغل مرة وحدة، لمدة ٧ أيام.",
    labelPlaceholder: "لمين؟ (إنت بس بتشوفها)",
    pending: "بانتظار القبول",
    copy: "نسخ الرابط",
    copied: "انسخ",
    share: "ابعت على واتساب",
    revoke: "إلغاء",
    expires: (d: string) => `لحد ${d}`,
    managerNote: "المدير عنده صلاحياتك بكل قسم بتسمحله يشوفه، بس أبداً مش شاشة الفريق هاي.",
    whatTitle: "شو بيشوف كل دور",
    whatHint: "سكّر شاشة وهالدور ما عاد يشوفها. للمدربين، فتح الرسوم أو الإعلانات أو الهوية أو الاستوديو بيعطيهم تحكم كامل فيها.",
    console: "لوحة الأكاديمية",
    family: "صفحة العائلة (الأهالي واللاعبين)",
    allowed: "شو مسموحلهم",
    chatsManage: "أرشفة، كتم، حظر وإخفاء المحادثات",
    sections: {
      dashboard: "الرئيسية", squads: "الفرق", players: "اللاعبين", registrations: "التسجيلات", attendance: "الحضور",
      schedule: "الجدول والنتائج", recordings: "التسجيلات المصوّرة", matches: "المباريات", fees: "الرسوم والدفعات", announcements: "الإعلانات",
      chats: "المحادثات", people: "الأشخاص", whatsapp: "واتساب", social: "إنستغرام وفيسبوك", ads: "الإعلانات الممولة", profile: "الملف", branding: "الهوية", studio: "الاستوديو",
    },
    screens: {
      schedule: "الجدول", footage: "فيديوهات الحصص", matches: "صفحات المباريات", attendance: "الحضور", news: "الأخبار", fees: "الرسوم", payments: "الدفعات",
    },
    saved: "انحفظ",
  },
  invite: {
    title: (academy: string, role: string) => `انضم لـ${academy} كـ${role}`,
    body: "اقبل عشان تصير عندك لوحة الأكاديمية على هالحساب.",
    signIn: "سجّل دخول عشان تقبل",
    accept: "قبول",
    done: "انضميت. عم نفتح لوحة الأكاديمية…",
    gone: "رابط الدعوة انتهى أو انستعمل. اطلب رابط جديد من الأكاديمية.",
    missing: "رابط الدعوة مش صحيح.",
  },
};

/** Field console: the "coach" role is the front desk. */
function venueOverrides(c: Strings & { locale: "ar" | "en" }): Strings & { locale: "ar" | "en" } {
  const swap = (text: string) => c.locale === "ar"
    ? text.replace(/المدربين/g, "موظفين الاستقبال").replace(/مدرب/g, "موظف استقبال").replace(/والأهالي واللاعبين/g, "")
    : text.replace(/\bcoaches\b/g, "front desk staff").replace(/\bCoaches\b/g, "Front desk").replace(/\bcoach\b/g, "front desk").replace(/\bCoach\b/g, "Front desk").replace(/, parents and players/g, "");
  const walk = (v: unknown): unknown => typeof v === "string" ? swap(v)
    : typeof v === "function" ? (...args: unknown[]) => walk((v as (...a: unknown[]) => unknown)(...args))
    : Array.isArray(v) ? v.map(walk)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "locale" ? x : walk(x)]))
    : v;
  return walk(c) as Strings & { locale: "ar" | "en" };
}

export function useTeamCopy(): Strings & { locale: "ar" | "en" } {
  const { locale } = useLocale();
  return useConsoleWording({ ...(locale === "ar" ? ar : en), locale: locale === "ar" ? "ar" : "en" }, venueOverrides);
}
