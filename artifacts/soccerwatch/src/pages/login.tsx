import { useLocation } from "wouter";
import { useLoginAsGuest } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Crown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 28 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, delay, ease: "easeOut" as const },
});

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function Login() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const guestMutation = useLoginAsGuest();

  const handleGuest = () => {
    guestMutation.mutate(undefined, {
      onSuccess: () => setLocation("/watch"),
      onError: () => {
        toast({ variant: "destructive", title: "Guest login failed", description: "Something went wrong." });
      },
    });
  };

  return (
    <div className="flex-1 flex flex-col field-pattern relative text-white overflow-hidden">
      <div className="absolute inset-0 bg-black/40" />

      <div className="relative z-10 flex-1 flex flex-col justify-between p-6">
        <div className="pt-12">
          <motion.div {...fadeUp(0)} className="flex items-center gap-2 mb-8">
            <motion.div
              initial={{ scale: 0, rotate: -20 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 18, delay: 0.05 }}
              className="w-8 h-8 rounded-full bg-primary flex items-center justify-center"
            >
              <Crown className="w-5 h-5 text-white" />
            </motion.div>
            <span className="font-bold text-xl tracking-tight">SOCCERWATCH</span>
          </motion.div>

          <motion.h1 {...fadeUp(0.12)} className="text-5xl font-bold leading-[1.1] mb-4">
            Every game.<br />Every angle.
          </motion.h1>
          <motion.p {...fadeUp(0.2)} className="text-lg text-white/80 leading-snug">
            Browse field footage, relive the best moments, and save your clip of the week.
          </motion.p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 60 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.28, ease: "easeOut" as const }}
          className="space-y-3 mb-4"
        >
          <Button
            asChild
            className="w-full bg-primary hover:bg-primary/90 text-white font-semibold py-6 rounded-xl text-base"
          >
            <a href={`${basePath}/sign-in`}>Sign In</a>
          </Button>

          <Button
            asChild
            variant="outline"
            className="w-full font-semibold py-6 rounded-xl text-base bg-white/10 border-white/30 text-white hover:bg-white/20 hover:text-white"
          >
            <a href={`${basePath}/sign-up`}>Create Account</a>
          </Button>

          <div className="relative my-2">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/20" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="px-2 text-white/50">Or</span>
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            className="w-full text-white/70 hover:text-white hover:bg-white/10 font-medium py-4 rounded-xl"
            onClick={handleGuest}
            disabled={guestMutation.isPending}
          >
            {guestMutation.isPending ? "Starting…" : "Browse as Guest"}
          </Button>
        </motion.div>
      </div>
    </div>
  );
}
