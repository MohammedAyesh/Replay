import { useLocale } from "./context";

const en = {
  back: "Back",
  lastUpdated: "Last updated",
  privacyPolicy: "Privacy Policy",
  termsOfUse: "Terms of Use",
  contactSupport: "Contact support",
  legal: "Legal",
  accountDeletion: {
    button: "Delete account",
    dialogTitle: "Delete your Replay account?",
    warning: "This permanently deletes your Replay account. This can't be undone.",
    deletedHeading: "Deleted from Replay:",
    deletedItems: [
      "Your profile and photo",
      "Your clips, likes, follows and saved clips",
      "Your place in match squads",
      "Your sign-in account",
    ],
    retainedHeading: "Kept without your name:",
    retainedItems: [
      "Past bookings and payments",
      "VAR review flags and clips already shared with a team",
      "Records we must keep for accounting and platform integrity",
    ],
    confirmInstruction: "Type DELETE or حذف to confirm.",
    confirmLabel: "Type DELETE or حذف",
    confirmPlaceholder: "DELETE or حذف",
    cancel: "Cancel",
    confirmButton: "Delete my account",
    deleting: "Deleting...",
    successTitle: "Account deleted",
    successDescription: "Your Replay account has been deleted.",
    errorTitle: "Couldn't delete account",
    pageTitle: "Deleting your Replay account",
    pageIntro: "You can permanently delete your Replay account from Account settings in the app.",
    appGuide: "In the app: open Account, scroll down, and tap Delete account.",
    pageDeletedHeading: "What gets deleted",
    pageRetainedHeading: "What may be kept",
    openAccount: "Open Account",
    signIn: "Sign in",
    contactWithEmail: "Can't sign in? Email {email} from the email address on your account.",
    contactWithoutEmail: "Can't sign in? Contact Replay support.",
    errors: {
      upcoming_booking: "Cancel or finish your upcoming booking first.",
      admin: "Administrator accounts can't be deleted here. Contact support.",
      field_owner: "Transfer field ownership before deleting your account.",
      rate_limited: "Too many attempts. Try again in an hour.",
      clerk_failed: "We couldn't remove your sign-in account. No account data was changed.",
      data_failed: "We couldn't finish deleting your account. It has been disabled for safety.",
      not_found: "We couldn't find your account. Sign in again and try once more.",
      unauthenticated: "Sign in again before deleting your account.",
      forbidden: "You don't have permission to delete this account.",
      invalid_id: "The account request is invalid.",
      self_delete: "Use Account settings to delete your own account.",
      last_admin: "The last administrator account can't be deleted.",
      unknown: "Something went wrong. Try again.",
    },
  },
};

type LegalStrings = typeof en;

const ar: LegalStrings = {
  back: "رجوع",
  lastUpdated: "آخر تحديث",
  privacyPolicy: "سياسة الخصوصية",
  termsOfUse: "شروط الاستخدام",
  contactSupport: "تواصل مع الدعم",
  legal: "قانوني",
  accountDeletion: {
    button: "حذف الحساب",
    dialogTitle: "هل تريد حذف حساب Replay؟",
    warning: "سيؤدي هذا إلى حذف حساب Replay نهائيًا. لا يمكن التراجع عن ذلك.",
    deletedHeading: "سيتم حذف ما يلي من Replay:",
    deletedItems: [
      "ملفك الشخصي وصورتك",
      "مقاطعك وإعجاباتك ومتابعاتك والمقاطع المحفوظة",
      "مكانك في فرق المباريات",
      "حساب تسجيل الدخول",
    ],
    retainedHeading: "سيتم الاحتفاظ بما يلي دون اسمك:",
    retainedItems: [
      "الحجوزات والمدفوعات السابقة",
      "علامات مراجعة VAR والمقاطع التي تمت مشاركتها مع فريق",
      "السجلات التي يجب الاحتفاظ بها لأغراض المحاسبة وسلامة المنصة",
    ],
    confirmInstruction: "اكتب DELETE أو حذف للتأكيد.",
    confirmLabel: "اكتب DELETE أو حذف",
    confirmPlaceholder: "DELETE أو حذف",
    cancel: "إلغاء",
    confirmButton: "حذف حسابي",
    deleting: "جارٍ الحذف...",
    successTitle: "تم حذف الحساب",
    successDescription: "تم حذف حساب Replay الخاص بك.",
    errorTitle: "تعذر حذف الحساب",
    pageTitle: "حذف حساب Replay",
    pageIntro: "يمكنك حذف حساب Replay نهائيًا من إعدادات الحساب في التطبيق.",
    appGuide: "في التطبيق: افتح الحساب، وانتقل إلى الأسفل، ثم اضغط على حذف الحساب.",
    pageDeletedHeading: "ما سيتم حذفه",
    pageRetainedHeading: "ما قد يتم الاحتفاظ به",
    openAccount: "فتح الحساب",
    signIn: "تسجيل الدخول",
    contactWithEmail: "لا يمكنك تسجيل الدخول؟ راسلنا على {email} من عنوان البريد المرتبط بحسابك.",
    contactWithoutEmail: "لا يمكنك تسجيل الدخول؟ تواصل مع دعم Replay.",
    errors: {
      upcoming_booking: "ألغِ حجزك القادم أو أكمله أولًا.",
      admin: "لا يمكن حذف حسابات المسؤولين من هنا. تواصل مع الدعم.",
      field_owner: "انقل ملكية الملعب قبل حذف حسابك.",
      rate_limited: "عدد المحاولات كبير جدًا. حاول مجددًا بعد ساعة.",
      clerk_failed: "تعذر حذف حساب تسجيل الدخول. لم يتم تغيير بيانات الحساب.",
      data_failed: "تعذر إكمال حذف الحساب. تم تعطيله حفاظًا على أمانه.",
      not_found: "لم نعثر على حسابك. سجّل الدخول مجددًا ثم حاول مرة أخرى.",
      unauthenticated: "سجّل الدخول مجددًا قبل حذف حسابك.",
      forbidden: "لا تملك صلاحية حذف هذا الحساب.",
      invalid_id: "طلب الحساب غير صالح.",
      self_delete: "استخدم إعدادات الحساب لحذف حسابك.",
      last_admin: "لا يمكن حذف حساب المسؤول الأخير.",
      unknown: "حدث خطأ ما. حاول مجددًا.",
    },
  },
};

export type LegalLocale = "en" | "ar";
export type AccountDeletionStrings = LegalStrings["accountDeletion"];

export const accountDeletionStrings: Record<LegalLocale, AccountDeletionStrings> = {
  en: en.accountDeletion,
  ar: ar.accountDeletion,
};

export function useLegalCopy(): LegalStrings & { locale: LegalLocale } {
  const { locale } = useLocale();
  return { ...(locale === "ar" ? ar : en), locale };
}