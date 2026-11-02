import { useLocale } from "./context";

const en = {
  nav: "Ads",
  title: "Ads",
  description: "The Facebook and Instagram ads Replay runs for your academy, what they cost, and what became of everyone they brought in.",
  updated: (when: string) => `Numbers from Meta updated ${when}`,
  empty: "No ads yet. Ask Replay to run ads for your academy, and they show up here with every lead they bring.",
  totals: { spent: "Spent", reached: "People reached", leads: "Leads", joined: "Joined", perLead: "Cost per lead", perJoined: "Cost per player who joined" },
  campaign: {
    active: "Running",
    paused: "Paused",
    ended: "Ended",
    since: (date: string) => `Since ${date}`,
    spent: "Spent",
    last30: (amount: string) => `${amount} in the last 30 days`,
    reach: "Reached",
    clicks: "Clicks",
    chats: "WhatsApp chats",
    forms: "Form leads",
    perLead: "Per lead",
    perJoined: "Per player joined",
  },
  funnel: { leads: "Leads", contacted: "Contacted", trial: "Trial", joined: "Joined" },
  other: "Chats from ads not linked to a campaign",
  recent: "People from your ads",
  recentHint: "Each one is in People as a lead. Move them along as you talk to them: contacted, trial, joined.",
  source: { whatsapp: "WhatsApp", lead_form: "Form" } as Record<string, string>,
  stage: { new: "New", contacted: "Contacted", trial: "Trial", joined: "Joined", lost: "Lost" } as Record<string, string>,
  openChat: "Chat",
  noLeads: "No one from your ads yet.",
  error: "Couldn't load your ads.",
};

export type AdsStrings = typeof en;

const ar: AdsStrings = {
  nav: "الإعلانات",
  title: "الإعلانات",
  description: "إعلانات فيسبوك وإنستغرام اللي بتشغّلها Replay لأكاديميتك، قديش كلّفت، وشو صار مع كل واحد جابته.",
  updated: (when: string) => `أرقام Meta محدّثة ${when}`,
  empty: "ما في إعلانات لسّا. اطلب من Replay تشغّل إعلانات لأكاديميتك، وبتطلع هون مع كل شخص بتجيبه.",
  totals: { spent: "المصروف", reached: "وصلت لـ", leads: "مهتمين", joined: "سجّلوا", perLead: "تكلفة المهتم", perJoined: "تكلفة اللاعب المسجّل" },
  campaign: {
    active: "شغّالة",
    paused: "موقّفة",
    ended: "خلصت",
    since: (date: string) => `من ${date}`,
    spent: "المصروف",
    last30: (amount: string) => `${amount} بآخر 30 يوم`,
    reach: "وصلت لـ",
    clicks: "نقرات",
    chats: "محادثات واتساب",
    forms: "نماذج",
    perLead: "لكل مهتم",
    perJoined: "لكل لاعب سجّل",
  },
  funnel: { leads: "مهتمين", contacted: "تواصلنا", trial: "تجربة", joined: "سجّلوا" },
  other: "محادثات من إعلانات مش مربوطة بحملة",
  recent: "الناس اللي جابتهم إعلاناتك",
  recentHint: "كل واحد موجود بالأشخاص كمهتم. حرّكه وإنت بتحكي معه: تواصلنا، تجربة، سجّل.",
  source: { whatsapp: "واتساب", lead_form: "نموذج" },
  stage: { new: "جديد", contacted: "تواصلنا", trial: "تجربة", joined: "سجّل", lost: "ما كمّل" },
  openChat: "محادثة",
  noLeads: "ما إجا حدا من إعلاناتك لسّا.",
  error: "ما قدرنا نحمّل الإعلانات.",
};

export function useAdsCopy(): AdsStrings & { locale: "ar" | "en" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale: locale === "ar" ? "ar" : "en" };
}
