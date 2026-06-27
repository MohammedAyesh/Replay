import { useState } from "react";
import { useLocation } from "wouter";
import { useLogin, useLoginAsGuest } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Crown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Login() {
  const [, setLocation] = useLocation();
  const { setUser } = useAuth();
  const { toast } = useToast();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const loginMutation = useLogin();
  const guestMutation = useLoginAsGuest();

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    
    loginMutation.mutate(
      { data: { email, password } },
      {
        onSuccess: (data) => {
          setUser(data.user);
          setLocation("/watch");
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Login failed",
            description: "Please check your credentials and try again.",
          });
        },
      }
    );
  };

  const handleGuest = () => {
    guestMutation.mutate(undefined, {
      onSuccess: (data) => {
        setUser(data.user);
        setLocation("/watch");
      },
      onError: () => {
        toast({
          variant: "destructive",
          title: "Guest login failed",
          description: "Something went wrong.",
        });
      },
    });
  };

  return (
    <div className="flex-1 flex flex-col field-pattern relative text-white">
      <div className="absolute inset-0 bg-black/40" /> {/* Dark overlay */}
      
      <div className="relative z-10 flex-1 flex flex-col justify-between p-6">
        <div className="pt-12">
          <div className="flex items-center gap-2 mb-8">
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
              <Crown className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-xl tracking-tight">SOCCERWATCH</span>
          </div>
          
          <h1 className="text-5xl font-bold leading-[1.1] mb-4">
            Every game.<br />Every angle.
          </h1>
          <p className="text-lg text-white/80 leading-snug">
            Browse field footage, relive the best moments, and save your clip of the week.
          </p>
        </div>

        <div className="bg-card text-card-foreground rounded-[20px] p-6 shadow-xl mb-4">
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="player@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="bg-muted border-transparent focus:border-primary"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-muted border-transparent focus:border-primary"
              />
            </div>
            <Button 
              type="submit" 
              className="w-full bg-primary hover:bg-primary/90 text-white font-semibold py-6 rounded-xl"
              disabled={loginMutation.isPending}
            >
              {loginMutation.isPending ? "Signing in..." : "Sign In"}
            </Button>
          </form>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">Or</span>
            </div>
          </div>

          <Button 
            type="button" 
            variant="outline" 
            className="w-full font-semibold py-6 rounded-xl"
            onClick={handleGuest}
            disabled={guestMutation.isPending}
          >
            {guestMutation.isPending ? "Starting..." : "Browse as Guest"}
          </Button>
        </div>
      </div>
    </div>
  );
}
