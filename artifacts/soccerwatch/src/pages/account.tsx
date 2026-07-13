import * as React from "react";
import { Link, useLocation } from "wouter";
import { useGetMe, useGetAccountStats, useUpdateProfile, getGetAccountStatsQueryKey, getGetMeQueryKey, type ProfileInputPosition, type ProfileInputGender } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { useClerk } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ChevronLeft, LogOut, Globe, Pencil, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/i18n";
import type { Strings } from "@/i18n/strings";
import { useToast } from "@/hooks/use-toast";

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
  const { signOut } = useClerk();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: user } = useGetMe({ query: { enabled: !isGuest, queryKey: getGetMeQueryKey() } });
  const displayUser = user ?? authUser;
  const { data: stats } = useGetAccountStats({ query: { enabled: !isGuest, queryKey: getGetAccountStatsQueryKey() } });

  const [isLoggingOut, setIsLoggingOut] = React.useState(false);
  const [isEditOpen, setIsEditOpen] = React.useState(false);

  const updateProfile = useUpdateProfile();

  const handleLogout = () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);

    // Wipe all cached queries so the next user doesn't see stale data
    queryClient.clear();

    if (isGuest) {
      window.location.href = `${basePath}/`;
      return;
    }

    // Clear backend session (fire-and-forget)
    fetch(`${basePath}/api/auth/logout`, { method: "POST", credentials: "include" })
      .catch(() => {});

    // Sign out of Clerk, then navigate.  We race against a 2-second timeout
    // so the user isn't stuck if signOut hangs or never resolves.
    const signOutPromise = signOut().catch(() => {});
    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 2000));
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

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      <div className="pt-safe px-4 py-6 bg-background">
        <h1 className="text-2xl font-bold text-foreground">{t.account.title}</h1>
        <p className="text-muted-foreground text-sm">{isGuest ? t.account.guestSubtitle : t.account.subtitle}</p>
      </div>

      <div className="flex-1 overflow-y-auto pb-24">
        {/* Profile Card */}
        <div className="p-6 flex flex-col items-center bg-background">
          <div className="w-24 h-24 rounded-full bg-zinc-800 text-primary flex items-center justify-center text-4xl font-bold mb-4 shadow-inner">
            {initial}
          </div>
          <h2 className="text-xl font-bold text-foreground">{name}</h2>
          <p className="text-muted-foreground text-sm">{email}</p>
          {!isGuest && (
            <div className="flex flex-wrap justify-center gap-2 mt-3">
              {displayUser?.position && (
                <span className="px-2.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold capitalize">
                  {displayUser.position}
                </span>
              )}
              {displayUser?.age != null && (
                <span className="px-2.5 py-1 rounded-full bg-muted text-muted-foreground text-xs font-semibold">
                  {displayUser.age} yrs
                </span>
              )}
              {displayUser?.gender && (
                <span className="px-2.5 py-1 rounded-full bg-muted text-muted-foreground text-xs font-semibold capitalize">
                  {displayUser.gender.replace(/_/g, " ")}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Stats */}
        {!isGuest && (
          <div className="px-4 pb-4 bg-background">
            <div className="grid grid-cols-3 gap-4">
              <StatCard label={t.account.savedClips} value={stats?.savedClips ?? 0} />
              <StatCard label={t.account.likesGiven} value={stats?.likesGiven ?? 0} />
              <StatCard label={t.account.fields} value={stats?.fieldsVisited ?? 0} />
            </div>
          </div>
        )}

        {/* Settings List */}
        <div className="mt-2 bg-background">
          {!isGuest && user && (
            <button
              onClick={() => setIsEditOpen(true)}
              className="w-full flex items-center justify-between p-4 bg-background hover:bg-muted/30 transition-colors"
            >
              <div className="flex items-center gap-3">
                <Pencil className="w-5 h-5 text-muted-foreground" />
                <span className="font-medium text-foreground">{t.account.editProfile}</span>
              </div>
              <ChevronRight className="w-5 h-5 text-muted-foreground rtl:hidden" />
              <ChevronLeft className="w-5 h-5 text-muted-foreground ltr:hidden" />
            </button>
          )}
          {/* Language toggle */}
          <LanguageToggle />

          {isAdmin && (
            <Link
              href="/admin"
              className="w-full flex items-center justify-between p-4 bg-background hover:bg-muted/30 transition-colors"
            >
              <div className="flex items-center gap-3">
                <Shield className="w-5 h-5 text-primary" />
                <span className="font-medium text-foreground">Admin Panel</span>
              </div>
              <ChevronRight className="w-5 h-5 text-muted-foreground rtl:hidden" />
              <ChevronLeft className="w-5 h-5 text-muted-foreground ltr:hidden" />
            </Link>
          )}
        </div>

        <div className="p-6 mt-4">
          <Button
            type="button"
            variant="outline"
            disabled={isLoggingOut}
            className="w-full text-destructive hover:bg-destructive/5 hover:text-destructive py-6 rounded-xl font-semibold disabled:opacity-50 border-0"
            onClick={handleLogout}
          >
            <LogOut className="w-5 h-5 me-2" />
            {isLoggingOut
              ? (isGuest ? "Redirecting..." : "Signing out...")
              : (isGuest ? t.account.signInRegister : t.account.signOut)}
          </Button>
        </div>
      </div>

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

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="p-3 text-center">
      <div className="text-2xl font-bold text-foreground mb-0.5">{value}</div>
      <div className="text-[10px] uppercase font-medium text-muted-foreground tracking-wider">{label}</div>
    </div>
  );
}

function SettingRow({ icon, label }: { icon: React.ReactNode; label: string; borderBottom?: boolean }) {
  return (
    <button className="w-full flex items-center justify-between p-4 bg-background hover:bg-muted/30 transition-colors">
      <div className="flex items-center gap-3">
        {icon}
        <span className="font-medium text-foreground">{label}</span>
      </div>
      <ChevronRight className="w-5 h-5 text-muted-foreground rtl:hidden" />
      <ChevronLeft className="w-5 h-5 text-muted-foreground ltr:hidden" />
    </button>
  );
}

function LanguageToggle() {
  const { t, locale, setLocale } = useTranslation();
  return (
    <div className="w-full flex items-center justify-between p-4 bg-background">
      <div className="flex items-center gap-3">
        <Globe className="w-5 h-5 text-muted-foreground" />
        <span className="font-medium text-foreground">{t.account.language}</span>
      </div>
      <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
        <button
          onClick={() => setLocale("en")}
          className={`px-3 py-1 rounded-md text-sm font-semibold transition-colors ${
            locale === "en"
              ? "bg-zinc-700 text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          EN
        </button>
        <button
          onClick={() => setLocale("ar")}
          className={`px-3 py-1 rounded-md text-sm font-semibold transition-colors ${
            locale === "ar"
              ? "bg-zinc-700 text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          عربي
        </button>
      </div>
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
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 bg-zinc-950">
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
      <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 pt-6 pb-8 space-y-5">
        <p className="text-muted-foreground text-sm">{t.editProfileDesc}</p>

        <div className="space-y-1.5">
          <Label htmlFor="edit-name" className="text-sm font-medium">{t.fullName}</Label>
          <Input
            id="edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.fullName}
            autoComplete="name"
            className="h-12"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="edit-phone" className="text-sm font-medium">{t.phoneNumber}</Label>
          <Input
            id="edit-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 555 000 0000"
            autoComplete="tel"
            className="h-12"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="edit-position" className="text-sm font-medium">{t.preferredPosition}</Label>
          <select
            id="edit-position"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            className="w-full h-12 rounded-md border border-input bg-transparent px-3 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring text-base appearance-none"
          >
            <option value="" disabled>{t.selectPosition}</option>
            {POSITIONS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="edit-age" className="text-sm font-medium">{t.age}</Label>
          <Input
            id="edit-age"
            type="number"
            min={10}
            max={99}
            value={age}
            onChange={(e) => setAge(e.target.value)}
            placeholder="25"
            className="h-12"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="edit-gender" className="text-sm font-medium">{t.gender}</Label>
          <select
            id="edit-gender"
            value={gender}
            onChange={(e) => setGender(e.target.value)}
            className="w-full h-12 rounded-md border border-input bg-transparent px-3 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring text-base appearance-none"
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
            className="w-full bg-primary hover:bg-primary/90 text-white font-semibold py-6 rounded-xl text-base disabled:opacity-50"
          >
            {isSaving ? t.saving : t.saveChanges}
          </Button>
        </div>
      </form>
    </div>
  );
}
