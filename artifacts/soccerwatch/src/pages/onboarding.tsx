import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useUpdateProfile, useGetMe, getGetMeQueryKey, type ProfileInputPosition, type ProfileInputGender } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import { useUser } from "@clerk/react";
import { useAuth } from "@/lib/auth";
import { useTranslation } from "@/i18n";
import { useToast } from "@/hooks/use-toast";
import { ChevronLeft, ChevronRight, Globe } from "lucide-react";
import { LogoMark } from "@/components/layout";

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

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 28 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, delay, ease: "easeOut" as const },
});

export default function Onboarding() {
  const [, setLocation] = useLocation();
  const { locale, setLocale } = useTranslation();
  const { toast } = useToast();
  const { user: authUser, isLoading: authLoading, isGuest } = useAuth();
  const { isSignedIn } = useUser();
  const { data: me } = useGetMe();
  const user = me ?? authUser;

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [position, setPosition] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");

  const queryClient = useQueryClient();
  const updateProfile = useUpdateProfile();

  const isArabic = locale === "ar";

  const handleBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      setLocation("/");
    }
  };

  // Guard: only kick truly unauthenticated users to login. If Clerk says
  // the user IS signed in, wait for the local user record to arrive instead
  // of bouncing them back to login during the sign-in handshake window.
  useEffect(() => {
    if (authLoading) return;
    if (isSignedIn) return;
    if (isGuest || !user) {
      setLocation("/");
    }
  }, [authLoading, isSignedIn, isGuest, user, setLocation]);

  // Guard: already complete users go to home
  useEffect(() => {
    if (authLoading) return;
    if (user?.profileComplete) {
      setLocation("/home");
    }
  }, [authLoading, user, setLocation]);

  const allFilled = name.trim() && phone.trim() && position && age && gender;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!allFilled) return;

    updateProfile.mutate(
      {
        data: {
          name: name.trim(),
          phone: phone.trim(),
          position: position as ProfileInputPosition,
          age: parseInt(age, 10),
          gender: gender as ProfileInputGender,
        },
      },
      {
        onSuccess: (data) => {
          // Update the cached user immediately so the auth guard sees profileComplete=true
          queryClient.setQueryData(getGetMeQueryKey(), data);
          setLocation("/home");
        },
        onError: () => {
          toast({ variant: "destructive", title: "Failed to save profile", description: "Please try again" });
        },
      }
    );
  };

  if (authLoading || !user || isGuest || user.profileComplete) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[#0B0F1A] text-white">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
          className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full"
        />
      </div>
    );
  }

  return (
    <div
      dir={isArabic ? "rtl" : "ltr"}
      className="relative min-h-[100dvh] w-full overflow-visible bg-[#0B0F1A] text-[#F3F6FA]"
      style={{
        background:
          "radial-gradient(90% 55% at 0% 0%, rgba(47,216,196,.18), transparent 62%), radial-gradient(85% 60% at 100% 0%, rgba(123,92,255,.18), transparent 64%), radial-gradient(70% 45% at 50% 100%, rgba(212,255,79,.07), transparent 70%), #0B0F1A",
        fontFamily: isArabic ? "'Tajawal','Inter',sans-serif" : "'Inter','Tajawal',sans-serif",
      }}
    >
      <button
        type="button"
        aria-label={isArabic ? "رجوع" : "Back"}
        onClick={handleBack}
        className="fixed left-4 top-4 z-50 flex h-[34px] w-[34px] items-center justify-center rounded-[11px] border border-white/[0.1] bg-white/[0.04] text-[#F3F6FA] transition-colors hover:bg-white/[0.08]"
      >
        {isArabic ? <ChevronRight className="h-4 w-4" aria-hidden="true" /> : <ChevronLeft className="h-4 w-4" aria-hidden="true" />}
      </button>
      <button
        type="button"
        aria-label={isArabic ? "تغيير اللغة" : "Change language"}
        onClick={() => setLocale(isArabic ? "en" : "ar")}
        className="fixed right-4 top-4 z-50 flex items-center gap-1.5 rounded-full border-0 bg-white/[0.07] px-3.5 py-2 text-xs font-semibold tracking-[0.03em] text-[#F3F6FA] transition-colors hover:bg-white/[0.11]"
      >
        <Globe className="h-3.5 w-3.5" aria-hidden="true" />
        {locale.toUpperCase()}
      </button>

      <div className="relative z-10 mx-auto flex w-full max-w-[440px] flex-col px-5 pb-12 pt-20">
        <motion.div {...fadeUp(0)} className="flex justify-center">
          <LogoMark size={52} />
        </motion.div>

        <motion.h1 {...fadeUp(0.1)} className="mt-7 text-3xl font-bold leading-tight">
          Complete your profile
        </motion.h1>
        <motion.p {...fadeUp(0.15)} className="mb-8 mt-2 text-[#2FD8C4]">
          Help us personalize your Replay experience.
        </motion.p>

        {/* Form */}
        <motion.form
          {...fadeUp(0.2)}
          onSubmit={handleSubmit}
          className="flex flex-col gap-5 pb-safe"
        >
          <div className="space-y-1.5">
            <Label htmlFor="onboarding-name" className="text-sm font-semibold text-white/70">Full name</Label>
            <Input
              id="onboarding-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your full name"
              className="h-12 rounded-[13px] border-white/10 bg-white/[0.035] text-[#F3F6FA] placeholder:text-white/35 focus-visible:border-[#D4FF4F] focus-visible:ring-[#D4FF4F]"
              autoComplete="name"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="onboarding-phone" className="text-sm font-semibold text-white/70">Phone number</Label>
            <Input
              id="onboarding-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555 000 0000"
              className="h-12 rounded-[13px] border-white/10 bg-white/[0.035] text-[#F3F6FA] placeholder:text-white/35 focus-visible:border-[#D4FF4F] focus-visible:ring-[#D4FF4F]"
              autoComplete="tel"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="onboarding-position" className="text-sm font-semibold text-white/70">Preferred position</Label>
            <select
              id="onboarding-position"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              className="h-12 w-full appearance-none rounded-[13px] border border-white/10 bg-white/[0.035] px-3 text-[#F3F6FA] focus:outline-none focus:ring-2 focus:ring-[#D4FF4F]"
              style={{ backgroundImage: "none" }}
            >
              <option value="" disabled className="text-black">Select position</option>
              {POSITIONS.map((p) => (
                <option key={p.value} value={p.value} className="text-black">{p.label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="onboarding-age" className="text-sm font-semibold text-white/70">Age</Label>
            <Input
              id="onboarding-age"
              type="number"
              min={10}
              max={99}
              value={age}
              onChange={(e) => setAge(e.target.value)}
              placeholder="25"
              className="h-12 rounded-[13px] border-white/10 bg-white/[0.035] text-[#F3F6FA] placeholder:text-white/35 focus-visible:border-[#D4FF4F] focus-visible:ring-[#D4FF4F]"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="onboarding-gender" className="text-sm font-semibold text-white/70">Gender</Label>
            <select
              id="onboarding-gender"
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className="h-12 w-full appearance-none rounded-[13px] border border-white/10 bg-white/[0.035] px-3 text-[#F3F6FA] focus:outline-none focus:ring-2 focus:ring-[#D4FF4F]"
              style={{ backgroundImage: "none" }}
            >
              <option value="" disabled className="text-black">Select gender</option>
              {GENDERS.map((g) => (
                <option key={g.value} value={g.value} className="text-black">{g.label}</option>
              ))}
            </select>
          </div>

          <div className="pt-4">
            <Button
              type="submit"
              disabled={!allFilled || updateProfile.isPending}
              className="h-14 w-full rounded-[14px] bg-[#D4FF4F] py-6 text-base font-semibold text-[#0B0F1A] hover:bg-[#c8f240] disabled:opacity-50"
            >
              {updateProfile.isPending ? "Saving..." : "Continue"}
            </Button>
          </div>
        </motion.form>
      </div>
    </div>
  );
}
