import * as React from "react";
import { Link } from "wouter";
import { useGetMe, useGetAccountStats, useGetAccountClaimedMatches, useUpdateProfile, useDeleteAccount, getGetAccountStatsQueryKey, getGetMeQueryKey, getGetAccountClaimedMatchesQueryKey, type PlayerProfileInputPosition as ProfileInputPosition, type PlayerProfileInputGender as ProfileInputGender } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { useClerk } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ChevronLeft, ChevronDown, LogOut, Globe, Pencil, Shield, Video, FileText, Mail, Ban, Users, Sparkles, Bookmark, Heart, MapPin, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/i18n";
import type { Strings } from "@/i18n/strings";
import { useToast } from "@/hooks/use-toast";
import { Camera, Loader2 } from "lucide-react";
import { useAvatarUpload, useReplayProfile } from "@/lib/match-api";
import { useSupportContact, supportMailto } from "@/lib/client-settings";
import { useLegalCopy } from "@/i18n/legal-strings";
import { useSafetyCopy } from "@/i18n/safety-strings";
import { useFriendsCopy } from "@/i18n/friends-strings";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { isDeleteConfirmation, deletionErrorMessage } from "@/lib/account-deletion";
import { ReplayMark } from "@/components/ReplayMark";
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const POSITIONS = [
  { value: "goalkeeper", label: "Goalkeeper" },
  { value: "defender", label: "Defender" },
  { value: "midfielder", label: "Midfielder" },
  { value: "forward", label: "Forward" },
];

const GENDERS = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "prefer_not_to_say", label: "Prefer not to say" },
];

export default function Account() {
  const { isGuest, user: authUser, isAdmin } = useAuth();
  const { t, locale } = useTranslation();
  const legal = useLegalCopy();
  const safety = useSafetyCopy();
  const friendsCopy = useFriendsCopy();
  const { supportEmail } = useSupportContact();
  const supportHref = supportMailto(supportEmail);
  const { signOut } = useClerk();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: user } = useGetMe({ query: { enabled: !isGuest, queryKey: getGetMeQueryKey() } });
  const displayUser = user ?? authUser;
  const { data: stats } = useGetAccountStats({ query: { enabled: !isGuest, queryKey: getGetAccountStatsQueryKey() } });
  const { data: claimedMatches } = useGetAccountClaimedMatches({ query: { enabled: !isGuest, queryKey: getGetAccountClaimedMatchesQueryKey() } });
  const [isLoggingOut, setIsLoggingOut] = React.useState(false);
  const [isEditOpen, setIsEditOpen] = React.useState(false);
  const [isDeleteAccountOpen, setIsDeleteAccountOpen] = React.useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = React.useState("");
  const [activeTab, setActiveTab] = React.useState<"profile" | "settings">(() =>
    isGuest || new URLSearchParams(window.location.search).get("tab") === "settings" ? "settings" : "profile"
  );

  const updateProfile = useUpdateProfile();
  const deleteAccount = useDeleteAccount();

  const confirmAccountDeletion = () => {
    if (!isDeleteConfirmation(deleteConfirmation) || deleteAccount.isPending) return;
    deleteAccount.mutate(undefined, {
      onSuccess: async () => {
        queryClient.clear();
        try {
          sessionStorage.setItem("replay_account_deleted", "1");
        } catch {
          // Continue to the landing page if browser storage is unavailable.
        }
        try {
          await signOut();
        } catch {
          // The identity may already be unavailable after successful deletion.
        }
        window.location.replace(`${basePath}/`);
      },
      onError: (error) => {
        const data = (error as { data?: { reason?: unknown } } | null)?.data;
        const reason = typeof data?.reason === "string" ? data.reason : undefined;
        toast({
          variant: "destructive",
          title: legal.accountDeletion.errorTitle,
          description: deletionErrorMessage(reason, locale),
        });
      },
    });
  };

  const handleLogout = () => {
    setIsLoggingOut(true);
    if (isLoggingOut) return;

    // Wipe all cached queries so the next user doesn't see stale data
    queryClient.clear();

    if (isGuest) {
      // The guest session lives in the guestId cookie, so redirecting without
      // calling logout left it set — the "logged out" guest was silently
      // signed straight back in on the next request. Wait for the server to
      // clear it (with a short timeout so a slow network can't trap the user)
      // before navigating.
      const logoutPromise = fetch(`${basePath}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      }).catch(() => {});
      const guestTimeout = new Promise((resolve) => setTimeout(resolve, 2000));
      Promise.race([logoutPromise, guestTimeout]).then(() => {
        window.location.replace(`${basePath}/`);
      });
      return;
    }

    // Clear backend session (fire-and-forget)
    fetch(`${basePath}/api/auth/logout`, { method: "POST", credentials: "include" })
      .catch(() => {});

    // Sign out of Clerk, then navigate.  We race against a 700ms timeout
    // so the user isn't stuck if signOut hangs or never resolves.
    const signOutPromise = signOut().catch(() => {});
    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 700));
    Promise.race([signOutPromise, timeoutPromise]).then(() => {
      window.location.replace(`${basePath}/`);
    });
  };

  const handleSaveProfile = (data: {
    name: string;
    phone: string;
    position: ProfileInputPosition;
    age: number;
    gender: ProfileInputGender;
  }) => {
    updateProfile.mutate(
      { data },
      {
        onSuccess: (updated) => {
          queryClient.setQueryData(getGetMeQueryKey(), updated);
          toast({ title: t.account.profileUpdated, description: t.account.profileUpdatedDesc });
          setIsEditOpen(false);
        },
        onError: () => {
          toast({ variant: "destructive", title: t.account.profileUpdateFailed, description: t.account.profileUpdateFailedDesc });
        },
      }
    );
  };

  const initial = displayUser?.name?.charAt(0)?.toUpperCase() || "G";
  const name = isGuest ? t.account.guestName : displayUser?.name || t.account.playerFallback;
  const rawEmail = isGuest ? "" : displayUser?.email || "";
  const email = rawEmail.endsWith("@soccerwatch.local") ? "" : rawEmail;
  const positionLabels: Record<string, string> = {
    goalkeeper: t.account.goalkeeper,
    defender: t.account.defender,
    midfielder: t.account.midfielder,
    forward: t.account.forward,
  };
  const genderLabels: Record<string, string> = {
    male: t.account.male,
    female: t.account.female,
    prefer_not_to_say: t.account.preferNotToSay,
  };
  const accountRowClass = "flex min-h-14 w-full items-center gap-3 px-3.5 text-start text-text transition-colors hover:bg-raised/60";
  const iconBox = "flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]";
  const renderChevron = () => (
    <>
      <ChevronRight className="h-[18px] w-[18px] text-muted-text rtl:hidden" aria-hidden="true" />
      <ChevronLeft className="h-[18px] w-[18px] text-muted-text ltr:hidden" aria-hidden="true" />
    </>
  );

  return (
    <div className="account-page flex flex-col flex-1 h-full min-h-0 overflow-hidden bg-background">
      {isLoggingOut && <ReplaySignOutOverlay />}

      <div className="account-page-scroll flex-1 overflow-y-auto no-scrollbar pb-28">
        <div className="px-4 pb-safe pt-5">
          <section className="flex flex-col items-center gap-1.5 text-center">
            <AvatarPicker initial={initial} userId={isGuest ? null : displayUser?.id ?? null} />
            <h1 className="mt-1 max-w-full truncate font-display text-[23px] font-extrabold leading-tight text-text" dir="auto">{name}</h1>
            {email && <p className="max-w-full truncate text-[13px] text-muted-text" dir="ltr">{email}</p>}
          </section>

          {!isGuest && (
            <div role="tablist" aria-label={t.account.accountTabs} className="mt-4 grid grid-cols-2 gap-1 rounded-full border border-line bg-surface p-[5px]">
              {(["profile", "settings"] as const).map((tab) => (
                <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} onClick={() => setActiveTab(tab)}
                  className={`min-h-11 rounded-full px-3 text-[15px] font-extrabold transition-colors ${activeTab === tab ? "bg-turf text-void" : "text-muted-text hover:text-text"}`}>
                  {tab === "profile" ? t.account.profileTab : t.account.settingsTab}
                </button>
              ))}
            </div>
          )}

          {(isGuest || activeTab === "profile") && !isGuest && (
            <div className="mt-4 space-y-4">
              <section className="overflow-hidden rounded-[18px] border border-line bg-surface">
                <div className="flex items-center gap-2.5 px-3 py-3">
                  <MiniPitch position={displayUser?.position ?? null} />
                  <div className="grid min-w-0 flex-1 grid-cols-3">
                    <ProfileValue value={displayUser?.position ? positionLabels[displayUser.position] ?? "—" : "—"} label={t.account.position} />
                    <ProfileValue value={displayUser?.age != null ? (locale === "ar" ? `${displayUser.age} سنة` : `${displayUser.age} yrs`) : "—"} label={t.account.age} />
                    <ProfileValue value={displayUser?.gender ? genderLabels[displayUser.gender] ?? "—" : "—"} label={t.account.gender} />
                  </div>
                </div>
                <div className="grid grid-cols-3 border-t border-line px-2 py-3">
                  <StatCard icon={<Bookmark />} label={t.account.savedClips} value={stats?.savedClips ?? 0} />
                  <StatCard icon={<Heart />} label={t.account.likesGiven} value={stats?.likesGiven ?? 0} />
                  <StatCard icon={<MapPin />} label={t.account.fields} value={stats?.fieldsVisited ?? 0} />
                </div>
              </section>

              <details open className="group overflow-hidden rounded-2xl border border-line bg-surface">
                <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-3.5 [&::-webkit-details-marker]:hidden">
                  <span className={`${iconBox} bg-turf/10 text-turf`}><Target className="h-[18px] w-[18px]" /></span>
                  <span className="flex-1 text-[15px] font-semibold text-text">{t.account.foundYourself}</span>
                  <span className="font-display text-base font-bold tabular-nums text-text">{claimedMatches?.filter((match) => match.state === "confirmed").length ?? 0}</span>
                  <ChevronDown className="h-[18px] w-[18px] rotate-180 text-muted-text transition-transform group-open:rotate-0" />
                </summary>
                <div className="space-y-2 px-3.5 pb-3.5">
                  {claimedMatches?.length ? claimedMatches.map((match) => (
                    <Link key={`${match.recordingId}-${match.personId}`} href={`/find/${match.recordingId}`}
                      className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-line bg-raised px-3 py-2.5">
                      <span className="min-w-0"><span className="block truncate text-sm font-semibold text-text">{match.recordingLabel}</span><span className="block text-xs text-muted-text">{match.date} · {Math.round(match.supportPercent)}% {t.account.support}</span></span>
                      <span className={`shrink-0 text-xs font-bold ${match.state === "confirmed" ? "text-turf" : "text-muted-text"}`}>
                        {match.state === "confirmed" ? t.account.confirmed : match.state === "disputed" ? t.account.disputed : match.state === "needs_resolution" ? t.account.needsResolution : match.state}
                      </span>
                    </Link>
                  )) : <p className="rounded-xl bg-void px-3.5 py-3 text-sm text-muted-text">{t.account.noClaimedMatches}</p>}
                </div>
              </details>

              {user && <AccountGroup title={t.account.accountGroup}>
                {user && <Link href={`/portfolio/${user.id}`} className={accountRowClass}>
                  <span className={`${iconBox} bg-turf/10 text-turf`}><Sparkles className="h-[18px] w-[18px]" /></span><span className="flex-1 text-[15px] font-semibold">{t.account.myPortfolio}</span>{renderChevron()}
                </Link>}
                {user && <button type="button" onClick={() => setIsEditOpen(true)} className={accountRowClass}>
                  <span className={`${iconBox} bg-raised text-muted-text`}><Pencil className="h-[18px] w-[18px]" /></span><span className="flex-1 text-[15px] font-semibold">{t.account.editProfile}</span>{renderChevron()}
                </button>}
                {user && <Link href="/friends" data-testid="link-friends" className={accountRowClass}>
                  <span className={`${iconBox} bg-turf/10 text-turf`}><Users className="h-[18px] w-[18px]" /></span><span className="flex-1 text-[15px] font-semibold">{friendsCopy.title}</span>{renderChevron()}
                </Link>}
              </AccountGroup>}
            </div>
          )}

          {(isGuest || activeTab === "settings") && (
            <div className="mt-4 space-y-4">
              {!isGuest && user && <AccountGroup title={t.account.accountGroup}>
                <Link href="/account/blocked" data-testid="link-blocked-players" className={accountRowClass}>
                  <span className={`${iconBox} bg-raised text-muted-text`}><Ban className="h-[18px] w-[18px]" /></span><span className="flex-1 text-[15px] font-semibold">{safety.blockedPlayers}</span>{renderChevron()}
                </Link>
              </AccountGroup>}

              <AccountGroup title={t.account.appGroup}>
                <div className={`${accountRowClass} justify-between`}>
                  <span className="flex items-center gap-3"><span className={`${iconBox} bg-raised text-muted-text`}><Globe className="h-[18px] w-[18px]" /></span><span className="text-[15px] font-semibold">{t.account.language}</span></span>
                  <LanguageToggle />
                </div>
                <Link href="/privacy" className={accountRowClass}><span className={`${iconBox} bg-raised text-muted-text`}><Shield className="h-[18px] w-[18px]" /></span><span className="flex-1 text-[15px] font-semibold">{legal.privacyPolicy}</span>{renderChevron()}</Link>
                <Link href="/terms" className={accountRowClass}><span className={`${iconBox} bg-raised text-muted-text`}><FileText className="h-[18px] w-[18px]" /></span><span className="flex-1 text-[15px] font-semibold">{legal.termsOfUse}</span>{renderChevron()}</Link>
                {supportHref && <a href={supportHref} className={accountRowClass}><span className={`${iconBox} bg-raised text-muted-text`}><Mail className="h-[18px] w-[18px]" /></span><span className="flex-1 text-[15px] font-semibold">{legal.contactSupport}</span>{renderChevron()}</a>}
              </AccountGroup>

              {!isGuest && ((displayUser?.ownedFieldIds?.length ?? 0) > 0 || isAdmin) && <AccountGroup title={t.account.controlPanels}>
                {(displayUser?.ownedFieldIds?.length ?? 0) > 0 && <Link href="/owner" data-testid="link-owner-console" className={accountRowClass}><span className={`${iconBox} bg-[#7B5CFF]/15 text-[#B9A8FF]`}><Video className="h-[18px] w-[18px]" /></span><span className="flex-1 text-[15px] font-semibold">{t.account.ownerConsole}</span>{renderChevron()}</Link>}
                {isAdmin && <Link href="/admin" data-testid="link-admin-console" className={accountRowClass}><span className={`${iconBox} bg-[#7B5CFF]/15 text-[#B9A8FF]`}><Shield className="h-[18px] w-[18px]" /></span><span className="flex-1 text-[15px] font-semibold">{t.account.adminPanel}</span>{renderChevron()}</Link>}
              </AccountGroup>}

              <div className="pb-safe pt-1">
                <Button type="button" variant="outline" disabled={isLoggingOut} className="min-h-[54px] w-full rounded-2xl border border-line bg-transparent font-semibold text-text hover:bg-raised disabled:opacity-50" onClick={handleLogout}>
                  <LogOut className="me-2 h-5 w-5" />{isLoggingOut ? (isGuest ? "Redirecting..." : "Signing out...") : (isGuest ? t.account.signInRegister : t.account.signOut)}
                </Button>
                {!isGuest && <div className="mt-1 text-center"><button type="button" onClick={() => setIsDeleteAccountOpen(true)} className="min-h-10 px-3 text-xs font-medium text-muted-text underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turf">{legal.accountDeletion.button}</button></div>}
              </div>
            </div>
          )}
        </div>
      </div>

      <AlertDialog
        open={isDeleteAccountOpen}
        onOpenChange={(open) => {
          setIsDeleteAccountOpen(open);
          if (!open) setDeleteConfirmation("");
        }}
      >
        <AlertDialogContent dir={locale === "ar" ? "rtl" : "ltr"} className="max-h-[90dvh] overflow-y-auto border-line bg-surface text-text">
          <AlertDialogHeader className="text-start">
            <AlertDialogTitle>{legal.accountDeletion.dialogTitle}</AlertDialogTitle>
            <AlertDialogDescription className="text-start text-muted-text">
              {legal.accountDeletion.warning}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <section className="space-y-2 text-sm">
            <h3 className="font-semibold">{legal.accountDeletion.deletedHeading}</h3>
            <ul className="list-disc space-y-1 ps-6 text-muted-text">
              {legal.accountDeletion.deletedItems.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
          <section className="space-y-2 text-sm">
            <h3 className="font-semibold">{legal.accountDeletion.retainedHeading}</h3>
            <ul className="list-disc space-y-1 ps-6 text-muted-text">
              {legal.accountDeletion.retainedItems.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
          <div className="space-y-2">
            <Label htmlFor="delete-account-confirmation">
              {legal.accountDeletion.confirmLabel}
            </Label>
            <Input
              id="delete-account-confirmation"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={deleteConfirmation}
              placeholder={legal.accountDeletion.confirmPlaceholder}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              className="min-h-11 text-start"
            />
            <p className="text-xs text-muted-text">{legal.accountDeletion.confirmInstruction}</p>
          </div>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel disabled={deleteAccount.isPending} className="min-h-11">
              {legal.accountDeletion.cancel}
            </AlertDialogCancel>
            <button
              type="button"
              disabled={!isDeleteConfirmation(deleteConfirmation) || deleteAccount.isPending}
              onClick={confirmAccountDeletion}
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-[#FF5A3C] px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deleteAccount.isPending
                ? legal.accountDeletion.deleting
                : legal.accountDeletion.confirmButton}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit Profile Dialog */}
      {isEditOpen && displayUser && !isGuest && (
        <EditProfileDialog
          user={displayUser}
          locale={locale}
          onClose={() => setIsEditOpen(false)}
          onSave={handleSaveProfile}
          isSaving={updateProfile.isPending}
          t={t.account}
        />
      )}
    </div>
  );
}

function ReplaySignOutOverlay() {
  return (
    <div
      className="fixed inset-0 z-[9999] grid place-items-center bg-void"
      role="status"
      aria-label="Signing out"
    >
      <ReplayMark className="replay-sign-out-loader" />
    </div>
  );
}

function AccountGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-1.5 text-[13px] font-bold text-muted-text">{title}</h2>
      <div className="overflow-hidden rounded-2xl border border-line bg-surface [&>*+*]:border-t [&>*+*]:border-line">{children}</div>
    </section>
  );
}

function ProfileValue({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 flex-col items-center justify-center gap-0.5 px-1 text-center [&+&]:border-s [&+&]:border-line">
      <span className="max-w-full truncate font-display text-[16px] font-extrabold leading-tight text-text">{value}</span>
      <span className="text-[11px] text-muted-text">{label}</span>
    </div>
  );
}

function MiniPitch({ position }: { position: string | null }) {
  const xByPosition: Record<string, number> = { goalkeeper: 182, defender: 148, midfielder: 100, forward: 52 };
  const x = position ? xByPosition[position] : undefined;
  return (
    <div className="relative h-[58px] w-24 shrink-0 overflow-hidden rounded-[10px] bg-[#102629]">
      <svg viewBox="0 0 200 120" className="absolute inset-0 h-full w-full" aria-hidden="true">
        <defs><radialGradient id="account-pitch-glow"><stop offset="0" stopColor="#D4FF4F" stopOpacity=".55" /><stop offset="1" stopColor="#D4FF4F" stopOpacity="0" /></radialGradient></defs>
        <g fill="none" stroke="#2FD8C4" strokeOpacity=".45" strokeWidth="3">
          <rect x="8" y="8" width="184" height="104" rx="6" /><line x1="100" y1="8" x2="100" y2="112" />
          <circle cx="100" cy="60" r="18" /><rect x="8" y="36" width="24" height="48" /><rect x="168" y="36" width="24" height="48" />
        </g>
        {x !== undefined && <><circle cx={x} cy="60" r="34" fill="url(#account-pitch-glow)" /><circle cx={x} cy="60" r="9" fill="#D4FF4F" /></>}
      </svg>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | string }) {
  return (
    <div className="flex flex-col items-center gap-1 [&+&]:border-s [&+&]:border-line">
      <span className="font-display text-[22px] font-bold leading-none tabular-nums text-text">{value}</span>
      <span className="flex items-center gap-1 text-xs text-muted-text"><span className="text-[#B9A8FF] [&>svg]:h-[13px] [&>svg]:w-[13px]">{icon}</span>{label}</span>
    </div>
  );
}

function LanguageToggle() {
  const { locale, setLocale } = useTranslation();
  return (
    <div role="group" aria-label={locale === "ar" ? "اللغة" : "Language"} className="flex items-center gap-0.5 rounded-full border border-line bg-void p-1">
        <button
          type="button"
          onClick={() => setLocale("en")}
          aria-pressed={locale === "en"}
          className={`min-h-8 rounded-full px-3 text-xs font-bold transition-colors ${locale === "en" ? "bg-turf text-void" : "text-muted-text hover:text-text"}`}
        >
          EN
        </button>
        <button
          type="button"
          onClick={() => setLocale("ar")}
          aria-pressed={locale === "ar"}
          className={`min-h-8 rounded-full px-3 text-xs font-bold transition-colors ${locale === "ar" ? "bg-turf text-void" : "text-muted-text hover:text-text"}`}
        >
          عربي
        </button>
    </div>
  );
}

function EditProfileDialog({
  user,
  locale,
  onClose,
  onSave,
  isSaving,
  t,
}: {
  user: { name?: string | null; phone?: string | null; position?: string | null; age?: number | null; gender?: string | null };
  locale: "en" | "ar";
  onClose: () => void;
  onSave: (data: { name: string; phone: string; position: string; age: number; gender: string }) => void;
  isSaving: boolean;
  t: Strings["account"];
}) {
  const [name, setName] = React.useState(user.name ?? "");
  const [phone, setPhone] = React.useState(user.phone ?? "");
  const [position, setPosition] = React.useState(user.position ?? "");
  const [age, setAge] = React.useState(user.age != null ? String(user.age) : "");
  const [gender, setGender] = React.useState(user.gender ?? "");

  const allFilled = name.trim() && phone.trim() && position && age && gender;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!allFilled) return;
    onSave({
      name: name.trim(),
      phone: phone.trim(),
      position,
      age: parseInt(age, 10),
      gender,
    });
  };

  const rtl = locale === "ar";

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between px-4 py-4 bg-background">
        <button
          onClick={onClose}
          className="flex items-center gap-1 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
        >
          {rtl ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
          {rtl ? "رجوع" : "Back"}
        </button>
        <h2 className="text-lg font-bold text-foreground">{t.editProfile}</h2>
        <div className="w-16" />
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-6 pt-6 pb-32 space-y-5">
        <p className="text-muted-foreground text-sm">{t.editProfileDesc}</p>

        <div className="space-y-1.5">
          <Label htmlFor="edit-name" className="text-sm font-medium text-foreground">{t.fullName}</Label>
          <Input
            id="edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.fullName}
            autoComplete="name"
            className="h-12 border-border bg-card text-foreground"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="edit-phone" className="text-sm font-medium text-foreground">{t.phoneNumber}</Label>
          <Input
            id="edit-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 555 000 0000"
            autoComplete="tel"
            className="h-12 border-border bg-card text-foreground"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="edit-position" className="text-sm font-medium text-foreground">{t.preferredPosition}</Label>
          <select
            id="edit-position"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            className="w-full h-12 rounded-md border border-border bg-card px-3 text-base text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring appearance-none"
          >
            <option value="" disabled>{t.selectPosition}</option>
            {POSITIONS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="edit-age" className="text-sm font-medium text-foreground">{t.age}</Label>
          <Input
            id="edit-age"
            type="number"
            min={10}
            max={99}
            value={age}
            onChange={(e) => setAge(e.target.value)}
            placeholder="25"
            className="h-12 border-border bg-card text-foreground"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="edit-gender" className="text-sm font-medium text-foreground">{t.gender}</Label>
          <select
            id="edit-gender"
            value={gender}
            onChange={(e) => setGender(e.target.value)}
            className="w-full h-12 rounded-md border border-border bg-card px-3 text-base text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring appearance-none"
          >
            <option value="" disabled>{t.selectGender}</option>
            {GENDERS.map((g) => (
              <option key={g.value} value={g.value}>{g.label}</option>
            ))}
          </select>
        </div>

        <div className="pt-4">
          <Button
            type="submit"
            disabled={!allFilled || isSaving}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-semibold py-6 rounded-xl text-base disabled:opacity-50"
          >
            {isSaving ? t.saving : t.saveChanges}
          </Button>
        </div>
      </form>
    </div>
  );
}


/** Tap the face to set a photo. It shows on every match roster and the teams board. */
function AvatarPicker({ initial, userId }: { initial: string; userId: number | null }) {
  const { locale } = useTranslation();
  const { toast } = useToast();
  const profile = useReplayProfile(userId);
  const upload = useAvatarUpload();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const avatarUrl = profile.data?.avatarUrl ?? null;
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
      toast({ title: locale === "ar" ? "الصورة أكبر من ٦ ميغا" : "That photo is over 6 MB", variant: "destructive" });
      return;
    }
    try {
      await upload.mutateAsync(file);
      toast({ title: locale === "ar" ? "تم تحديث صورتك" : "Photo updated" });
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : "Upload failed", variant: "destructive" });
    }
  };
  return (
    <button
      type="button"
      disabled={!userId || upload.isPending}
      onClick={() => inputRef.current?.click()}
      aria-label={locale === "ar" ? "غيّر صورتك" : "Change your photo"}
      className="relative flex h-20 w-20 shrink-0 items-center justify-center rounded-full p-[3px]"
      style={{ background: "linear-gradient(135deg, var(--replay-turf), var(--replay-violet))" }}
    >
      <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-surface font-display text-[28px] font-bold text-text">
        {avatarUrl ? <img src={avatarUrl} alt="" className="h-full w-full object-cover" /> : initial}
      </span>
      {userId && (
        <span className="absolute -bottom-0.5 -end-0.5 flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-floodlight text-void">
          {upload.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
        </span>
      )}
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
    </button>
  );
}
