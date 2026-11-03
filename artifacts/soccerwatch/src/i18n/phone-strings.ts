import { useLocale } from "./context";

/** Phone videos and photos sorted by match time (Matches, the review queue, the family page). */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const en = {
  title: "Phone videos & photos",
  intro: "Add videos and photos from your phones. Replay reads when each was filmed and puts it before, during or after the match.",
  add: "Add videos or photos",
  uploading: (n: number) => `Uploading ${n}…`,
  added: (n: number) => `${n} added`,
  failed: (name: string) => `Couldn't add ${name}`,
  empty: "Nothing yet. Videos filmed during the match line up with the camera's footage.",
  phases: { before: "Before", during: "During", after: "After", unlinked: "Not linked" } as Record<string, string>,
  at: (s: number) => `at ${clock(s)} in the match video`,
  venue: { at_venue: "At the venue", elsewhere: "Not at the venue", unknown: "" } as Record<string, string>,
  confidence: { high: "", medium: "Time checked roughly", low: "Time unsure" } as Record<string, string>,
  fromParent: "From a parent",
  review: {
    title: "Which match is this from?",
    intro: "Replay couldn't tell when these were filmed. Pick the session, and whether it's from before, during or after.",
    reasons: { date_only: "Forwarded on WhatsApp: only the day is known", no_time: "No date in the file", no_session: "No session near when it was filmed" } as Record<string, string>,
    pickSession: "Session",
    pickPhase: "When",
    save: "Save",
    saved: "Saved",
    noSessions: "No sessions that day",
    day: "Day",
  },
  tag: "Who's in it?",
  tagged: "Tagged",
  remove: "Remove",
  family: {
    button: "Send us a video or photo",
    hint: "From the match or training. We read when it was filmed; your location is never kept.",
    sent: "Sent. Thank you!",
    failed: "Couldn't send it. Try again.",
  },
};

type PhoneStrings = typeof en;

const ar: PhoneStrings = {
  title: "فيديوهات وصور التلفون",
  intro: "ضيفوا فيديوهات وصور من تلفوناتكم. Replay بيقرأ إمتى تصوّر كل واحد وبيحطه قبل الماتش أو خلاله أو بعده.",
  add: "ضيف فيديوهات أو صور",
  uploading: (n) => `عم نرفع ${n}…`,
  added: (n) => (n === 1 ? "انضاف واحد" : `انضافوا ${n}`),
  failed: (name) => `ما زبط نضيف ${name}`,
  empty: "ما في إشي لسّا. الفيديوهات اللي تصوّرت خلال الماتش بتنحط جنب تصوير الكاميرا.",
  phases: { before: "قبل", during: "خلال", after: "بعد", unlinked: "مش مربوط" },
  at: (s) => `على الدقيقة ${clock(s)} من فيديو الماتش`,
  venue: { at_venue: "بالملعب", elsewhere: "مش بالملعب", unknown: "" },
  confidence: { high: "", medium: "الوقت تقريبي", low: "الوقت مش أكيد" },
  fromParent: "من أهل لاعب",
  review: {
    title: "من أي ماتش هاد؟",
    intro: "Replay ما عرف إمتى تصوّروا. اختار الحصة، وإذا هو قبل أو خلال أو بعد.",
    reasons: { date_only: "انبعث عالواتساب: بنعرف اليوم بس", no_time: "ما في تاريخ بالملف", no_session: "ما في حصة قريبة من وقت التصوير" },
    pickSession: "الحصة",
    pickPhase: "إمتى",
    save: "احفظ",
    saved: "انحفظ",
    noSessions: "ما في حصص هداك اليوم",
    day: "اليوم",
  },
  tag: "مين فيه؟",
  tagged: "معلّم",
  remove: "شيل",
  family: {
    button: "ابعتلنا فيديو أو صورة",
    hint: "من الماتش أو التمرين. بنقرأ إمتى تصوّر؛ موقعكم ما بنحتفظ فيه أبداً.",
    sent: "انبعث. يعطيك العافية!",
    failed: "ما زبط نبعثه. جرّب كمان مرة.",
  },
};

export function usePhoneCopy(): PhoneStrings & { locale: "ar" | "en" } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale: locale === "ar" ? "ar" : "en" };
}

export const phoneStrings = { en, ar };
