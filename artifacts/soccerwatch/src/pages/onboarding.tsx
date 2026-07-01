import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useUpdateProfile, useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Crown } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "@/lib/auth";
import { useTranslation } from "@/i18n";
import { useToast } from "@/hooks/use-toast";

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
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user: authUser, isLoading: authLoading, isGuest } = useAuth();
  const { data: me } = useGetMe();
  const user = me ?? authUser;

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [position, setPosition] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");

  const queryClient = useQueryClient();
  const updateProfile = useUpdateProfile();

  // Guard: guests and unauthenticated users go to login
  useEffect(() => {
    if (authLoading) return;
    if (isGuest || !user) {
      setLocation("/");
    }
  }, [authLoading, isGuest, user, setLocation]);

  // Guard: already complete users go to watch
  useEffect(() => {
    if (authLoading) return;
    if (user?.profileComplete) {
      setLocation("/watch");
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
          position,
          age: parseInt(age, 10),
          gender,
        },
      },
      {
        onSuccess: (data) => {
          // Update the cached user immediately so the auth guard sees profileComplete=true
          queryClient.setQueryData(getGetMeQueryKey(), data);
          setLocation("/watch");
        },
        onError: () => {
          toast({ variant: "destructive", title: "Failed to save profile", description: "Please try again" });
        },
      }
    );
  };

  if (authLoading || !user || isGuest || user.profileComplete) {
    return (
      <div className="flex-1 flex items-center justify-center bg-black text-white">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
          className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full"
        />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col field-pattern relative text-white overflow-hidden">
      <div className="absolute inset-0 bg-black/60" />

      <div className="relative z-10 flex-1 flex flex-col px-6 pt-safe pt-8 pb-safe">
        {/* Header */}
        <motion.div {...fadeUp(0)} className="flex items-center gap-2 mb-8">
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
            <Crown className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-xl tracking-tight">SOCCERWATCH</span>
        </motion.div>

        <motion.h1 {...fadeUp(0.1)} className="text-3xl font-bold leading-tight mb-2">
          Complete your profile
        </motion.h1>
        <motion.p {...fadeUp(0.15)} className="text-white/70 mb-8">
          Help us personalize your SoccerWatch experience.
        </motion.p>

        {/* Form */}
        <motion.form
          {...fadeUp(0.2)}
          onSubmit={handleSubmit}
          className="flex-1 flex flex-col gap-4 overflow-y-auto pb-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="onboarding-name" className="text-white/80 text-sm font-medium">Full name</Label>
            <Input
              id="onboarding-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your full name"
              className="bg-white/10 border-white/20 text-white placeholder:text-white/40 focus-visible:ring-primary h-12"
              autoComplete="name"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="onboarding-phone" className="text-white/80 text-sm font-medium">Phone number</Label>
            <Input
              id="onboarding-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555 000 0000"
              className="bg-white/10 border-white/20 text-white placeholder:text-white/40 focus-visible:ring-primary h-12"
              autoComplete="tel"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="onboarding-position" className="text-white/80 text-sm font-medium">Preferred position</Label>
            <select
              id="onboarding-position"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              className="w-full h-12 rounded-md bg-white/10 border border-white/20 text-white px-3 focus:outline-none focus:ring-2 focus:ring-primary appearance-none"
              style={{ backgroundImage: "none" }}
            >
              <option value="" disabled className="text-black">Select position</option>
              {POSITIONS.map((p) => (
                <option key={p.value} value={p.value} className="text-black">{p.label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="onboarding-age" className="text-white/80 text-sm font-medium">Age</Label>
            <Input
              id="onboarding-age"
              type="number"
              min={10}
              max={99}
              value={age}
              onChange={(e) => setAge(e.target.value)}
              placeholder="25"
              className="bg-white/10 border-white/20 text-white placeholder:text-white/40 focus-visible:ring-primary h-12"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="onboarding-gender" className="text-white/80 text-sm font-medium">Gender</Label>
            <select
              id="onboarding-gender"
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className="w-full h-12 rounded-md bg-white/10 border border-white/20 text-white px-3 focus:outline-none focus:ring-2 focus:ring-primary appearance-none"
              style={{ backgroundImage: "none" }}
            >
              <option value="" disabled className="text-black">Select gender</option>
              {GENDERS.map((g) => (
                <option key={g.value} value={g.value} className="text-black">{g.label}</option>
              ))}
            </select>
          </div>

          <div className="mt-auto pt-4">
            <Button
              type="submit"
              disabled={!allFilled || updateProfile.isPending}
              className="w-full bg-primary hover:bg-primary/90 text-white font-semibold py-6 rounded-xl text-base disabled:opacity-50"
            >
              {updateProfile.isPending ? "Saving..." : "Continue"}
            </Button>
          </div>
        </motion.form>
      </div>
    </div>
  );
}
