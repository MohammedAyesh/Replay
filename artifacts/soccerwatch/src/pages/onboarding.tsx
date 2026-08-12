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

const POSITION_VALUES = ["goalkeeper", "defender", "midfielder", "forward"] as const;
const GENDER_VALUES = [
  { value: "male", labelKey: "male" },
  { value: "female", labelKey: "female" },
  { value: "prefer_not_to_say", labelKey: "preferNotToSay" },
] as const;

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 28 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, delay, ease: "easeOut" as const },
});

export default function Onboarding() {
  const [, setLocation] = useLocation();
  const { t, locale } = useTranslation();
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
  const copy = t.onboarding;
  const isArabic = locale === "ar";
  const textDirection = isArabic ? "rtl" : "ltr";

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
          toast({
            variant: "destructive",
            title: copy.saveFailed,
            description: copy.saveFailedDesc,
          });
        },
      }
    );
  };

  if (authLoading || !user || isGuest || user.profileComplete) {
    return (
      <div className="flex w-full items-center justify-center py-20">
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
      dir={textDirection}
      className={`w-full flex flex-col text-white ${isArabic ? "text-right" : "text-left"}`}
      style={{
        fontFamily: isArabic
          ? "'Tajawal', 'Cairo', sans-serif"
          : "'Inter', system-ui, sans-serif",
      }}
    >
      <motion.h1
        {...fadeUp(0.1)}
        className={`mb-2 text-3xl font-bold leading-tight ${isArabic ? "font-['Cairo']" : ""}`}
      >
        {copy.title}
      </motion.h1>
      <motion.p {...fadeUp(0.15)} className="mb-8 text-sm text-[#2FD8C4]">
        {copy.subtitle}
      </motion.p>

      <motion.form
        {...fadeUp(0.2)}
        onSubmit={handleSubmit}
        className="flex flex-col gap-4"
      >
        <div className="space-y-1.5">
          <Label htmlFor="onboarding-name" className="text-sm font-medium text-white/80">
            {copy.fullName}
          </Label>
          <Input
            id="onboarding-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={copy.fullNamePlaceholder}
            className={`h-12 rounded-[13px] border-white/10 bg-white/[0.04] text-white placeholder:text-white/40 focus-visible:ring-primary ${isArabic ? "text-right" : "text-left"}`}
            autoComplete="name"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="onboarding-phone" className="text-sm font-medium text-white/80">
            {copy.phoneNumber}
          </Label>
          <Input
            id="onboarding-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={copy.phonePlaceholder}
            className={`h-12 rounded-[13px] border-white/10 bg-white/[0.04] text-white placeholder:text-white/40 focus-visible:ring-primary ${isArabic ? "text-right" : "text-left"}`}
            autoComplete="tel"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="onboarding-position" className="text-sm font-medium text-white/80">
            {copy.preferredPosition}
          </Label>
          <select
            id="onboarding-position"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            className={`h-12 w-full appearance-none rounded-[13px] border border-white/10 bg-white/[0.04] px-3 text-white focus:outline-none focus:ring-2 focus:ring-primary ${isArabic ? "text-right" : "text-left"}`}
            style={{ backgroundImage: "none" }}
          >
            <option value="" disabled className="text-black">{copy.selectPosition}</option>
            {POSITION_VALUES.map((value) => (
              <option key={value} value={value} className="text-black">
                {copy.positions[value]}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="onboarding-age" className="text-sm font-medium text-white/80">
            {copy.age}
          </Label>
          <Input
            id="onboarding-age"
            type="number"
            min={10}
            max={99}
            value={age}
            onChange={(e) => setAge(e.target.value)}
            placeholder={copy.agePlaceholder}
            className={`h-12 rounded-[13px] border-white/10 bg-white/[0.04] text-white placeholder:text-white/40 focus-visible:ring-primary ${isArabic ? "text-right" : "text-left"}`}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="onboarding-gender" className="text-sm font-medium text-white/80">
            {copy.gender}
          </Label>
          <select
            id="onboarding-gender"
            value={gender}
            onChange={(e) => setGender(e.target.value)}
            className={`h-12 w-full appearance-none rounded-[13px] border border-white/10 bg-white/[0.04] px-3 text-white focus:outline-none focus:ring-2 focus:ring-primary ${isArabic ? "text-right" : "text-left"}`}
            style={{ backgroundImage: "none" }}
          >
            <option value="" disabled className="text-black">{copy.selectGender}</option>
            {GENDER_VALUES.map(({ value, labelKey }) => (
              <option key={value} value={value} className="text-black">
                {copy.genders[labelKey]}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-4">
          <Button
            type="submit"
            disabled={!allFilled || updateProfile.isPending}
            className="w-full rounded-[14px] bg-primary py-4 text-base font-semibold text-[#0B0F1A] hover:bg-primary/90 disabled:opacity-50"
          >
            {updateProfile.isPending ? copy.saving : copy.continue}
          </Button>
        </div>
      </motion.form>
    </div>
  );
}
