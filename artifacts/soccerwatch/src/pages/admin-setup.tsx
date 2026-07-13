import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Shield, ArrowLeft } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/+$/, "");

export default function AdminSetup() {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const { user } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${basePath}/api/auth/admin-setup`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const data = await res.json().catch(() => ({ error: "Failed to parse response" }));
      if (!res.ok) {
        toast({ variant: "destructive", title: "Setup failed", description: data.error || "Unknown error" });
      } else if (data.ok) {
        toast({ variant: "default", title: "Done!", description: "You are now an admin." });
        setLocation("/admin");
      } else {
        toast({ variant: "destructive", title: "Unexpected response", description: JSON.stringify(data) });
      }
    } catch (err) {
      toast({ variant: "destructive", title: "Request failed", description: String(err) });
    }
    setLoading(false);
  };

  return (
    <div className="flex-1 flex flex-col bg-background">
      <div className="flex items-center gap-2 p-4 border-b border-border">
        <button onClick={() => setLocation("/home")} className="p-2 rounded-lg hover:bg-accent text-foreground">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-bold text-foreground">Admin Setup</h1>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex flex-col items-center gap-3">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
              <Shield className="w-7 h-7 text-primary" />
            </div>
            <p className="text-sm text-muted-foreground text-center">
              Enter the admin setup secret from Replit to grant admin privileges to <strong>{user?.email ?? "your account"}</strong>.
            </p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Admin setup secret"
              autoComplete="off"
              className="w-full bg-muted border border-border rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary"
            />
            <Button
              type="submit"
              disabled={loading || !token.trim()}
              className="w-full bg-primary hover:bg-primary/90 text-black font-bold py-3 rounded-xl text-sm disabled:opacity-50"
            >
              {loading ? "Setting up…" : "Grant Admin Access"}
            </Button>
          </form>
          <p className="text-xs text-muted-foreground text-center leading-relaxed">
            This only works once the <code>ADMIN_SETUP_SECRET</code> env variable is configured in Replit.
            After setup, remove the secret to disable this page.
          </p>
        </div>
      </div>
    </div>
  );
}
