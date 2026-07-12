import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Eye, EyeOff, UserCheck, UserX, Shield, ShieldOff, Trash2, Plus, Save, X, ExternalLink, Image } from "lucide-react";
import { cn } from "@/lib/utils";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

type Tab = "clips" | "accounts" | "fields" | "banners";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminClip {
  id: number;
  userId: number;
  videoId: string;
  title: string;
  visibility: string;
  isHidden: boolean;
  likeCount: number;
  viewCount: number;
  shareCount: number;
  score: number;
  createdAt: string;
  thumbnailUrl: string | null;
  playbackUrl: string | null;
  userName: string;
  userEmail: string;
}

interface AdminUser {
  id: number;
  name: string;
  email: string;
  isAdmin: boolean;
  isDisabled: boolean;
  isGuest: boolean;
  profileComplete: boolean;
  createdAt: string;
}

interface AdminField {
  id: number;
  name: string;
  location: string;
  courts: number;
  weight: number;
  thumbnailUrl: string | null;
  lastRecordedAt: string | null;
}

interface AdminBanner {
  id: string;
  title: string;
  upperSubtext: string;
  lowerSubtext: string;
  hyperlink: string | null;
  imageUrl: string;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${basePath}/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

// ─── Clips Tab ────────────────────────────────────────────────────────────────

function ClipsTab() {
  const [clips, setClips] = useState<AdminClip[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/admin/clips");
      setClips(data ?? []);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleHidden = async (clip: AdminClip) => {
    await apiFetch(`/admin/clips/${clip.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isHidden: !clip.isHidden }),
    });
    setClips((prev) => prev.map((c) => c.id === clip.id ? { ...c, isHidden: !c.isHidden } : c));
  };

  const filtered = clips.filter((c) =>
    c.title.toLowerCase().includes(search.toLowerCase()) ||
    c.userName.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clips or users…"
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-primary"
        />
        <span className="text-zinc-500 text-xs">{filtered.length} clips</span>
      </div>

      {loading ? (
        <div className="text-center py-16 text-zinc-500">Loading…</div>
      ) : (
        <div className="space-y-2">
          {filtered.map((clip) => (
            <div
              key={clip.id}
              className={cn(
                "flex items-center gap-3 p-3 rounded-xl border transition-colors",
                clip.isHidden
                  ? "bg-zinc-900/50 border-zinc-800 opacity-60"
                  : "bg-zinc-900 border-zinc-800"
              )}
            >
              {clip.thumbnailUrl ? (
                <img
                  src={clip.thumbnailUrl}
                  alt={clip.title}
                  className="w-16 h-10 object-cover rounded-lg flex-shrink-0 bg-zinc-800"
                />
              ) : (
                <div className="w-16 h-10 rounded-lg bg-zinc-800 flex-shrink-0 flex items-center justify-center">
                  <Image className="w-4 h-4 text-zinc-600" />
                </div>
              )}

              <div className="flex-1 min-w-0">
                <p className="text-white text-sm font-medium truncate">{clip.title}</p>
                <p className="text-zinc-500 text-xs truncate">{clip.userName} · {clip.viewCount}v · {clip.likeCount}♥</p>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                {clip.isHidden && (
                  <span className="text-[10px] bg-red-900/40 text-red-400 px-2 py-0.5 rounded-full border border-red-800/50">
                    Hidden
                  </span>
                )}
                <button
                  onClick={() => toggleHidden(clip)}
                  className={cn(
                    "p-2 rounded-lg transition-colors",
                    clip.isHidden
                      ? "bg-primary/20 text-primary hover:bg-primary/30"
                      : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white"
                  )}
                  title={clip.isHidden ? "Show clip" : "Hide clip"}
                >
                  {clip.isHidden ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Accounts Tab ─────────────────────────────────────────────────────────────

function AccountsTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const { user: me } = useAuth();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/admin/users");
      setUsers(data ?? []);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const patch = async (user: AdminUser, updates: Partial<AdminUser>) => {
    await apiFetch(`/admin/users/${user.id}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
    setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, ...updates } : u));
  };

  const filtered = users.filter((u) =>
    u.name.toLowerCase().includes(search.toLowerCase()) ||
    u.email.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search accounts…"
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-primary"
        />
        <span className="text-zinc-500 text-xs">{filtered.length} accounts</span>
      </div>

      {loading ? (
        <div className="text-center py-16 text-zinc-500">Loading…</div>
      ) : (
        <div className="space-y-2">
          {filtered.map((user) => {
            const isSelf = user.id === me?.id;
            return (
              <div
                key={user.id}
                className={cn(
                  "flex items-center gap-3 p-3 rounded-xl border",
                  user.isDisabled ? "bg-zinc-900/50 border-zinc-800 opacity-60" : "bg-zinc-900 border-zinc-800"
                )}
              >
                <div className="w-9 h-9 rounded-full bg-zinc-800 flex items-center justify-center text-sm font-bold text-zinc-300 flex-shrink-0">
                  {user.name[0]?.toUpperCase() ?? "?"}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-white text-sm font-medium truncate">{user.name}</p>
                    {user.isAdmin && (
                      <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded-full border border-primary/30">
                        Admin
                      </span>
                    )}
                    {isSelf && (
                      <span className="text-[10px] bg-zinc-700 text-zinc-400 px-1.5 py-0.5 rounded-full">
                        You
                      </span>
                    )}
                  </div>
                  <p className="text-zinc-500 text-xs truncate">{user.email}</p>
                </div>

                {!isSelf && (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => patch(user, { isAdmin: !user.isAdmin })}
                      className={cn(
                        "p-2 rounded-lg transition-colors",
                        user.isAdmin
                          ? "bg-primary/20 text-primary hover:bg-primary/30"
                          : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white"
                      )}
                      title={user.isAdmin ? "Remove admin" : "Make admin"}
                    >
                      {user.isAdmin ? <Shield className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => patch(user, { isDisabled: !user.isDisabled })}
                      className={cn(
                        "p-2 rounded-lg transition-colors",
                        user.isDisabled
                          ? "bg-red-900/30 text-red-400 hover:bg-red-900/50"
                          : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white"
                      )}
                      title={user.isDisabled ? "Enable account" : "Disable account"}
                    >
                      {user.isDisabled ? <UserCheck className="w-4 h-4" /> : <UserX className="w-4 h-4" />}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Fields Tab ───────────────────────────────────────────────────────────────

function FieldsTab() {
  const [fields, setFields] = useState<AdminField[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<number | null>(null);
  const [thumbInput, setThumbInput] = useState("");
  const [weightInput, setWeightInput] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/admin/fields");
      setFields(data ?? []);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = (field: AdminField) => {
    setEditing(field.id);
    setThumbInput(field.thumbnailUrl ?? "");
    setWeightInput(String(field.weight));
  };

  const cancelEdit = () => { setEditing(null); setThumbInput(""); setWeightInput(""); };

  const saveField = async (field: AdminField) => {
    setSaving(true);
    try {
      await apiFetch(`/admin/fields/${field.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          thumbnailUrl: thumbInput.trim() || null,
          weight: parseFloat(weightInput) || 1.0,
        }),
      });
      setFields((prev) => prev.map((f) =>
        f.id === field.id
          ? { ...f, thumbnailUrl: thumbInput.trim() || null, weight: parseFloat(weightInput) || 1.0 }
          : f
      ));
      cancelEdit();
    } catch { /* silent */ }
    setSaving(false);
  };

  return (
    <div className="space-y-3">
      {loading ? (
        <div className="text-center py-16 text-zinc-500">Loading…</div>
      ) : (
        fields.map((field) => (
          <div key={field.id} className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="flex items-center gap-3 p-3">
              <div className="w-14 h-14 rounded-lg overflow-hidden bg-zinc-800 flex-shrink-0">
                {field.thumbnailUrl ? (
                  <img src={field.thumbnailUrl} alt={field.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full field-pattern opacity-50" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white font-medium text-sm">{field.name}</p>
                <p className="text-zinc-500 text-xs truncate">{field.location}</p>
                <p className="text-zinc-600 text-xs">Weight: {field.weight} · {field.courts} court{field.courts !== 1 ? "s" : ""}</p>
              </div>
              <button
                onClick={() => editing === field.id ? cancelEdit() : startEdit(field)}
                className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
              >
                {editing === field.id ? <X className="w-4 h-4" /> : <Image className="w-4 h-4" />}
              </button>
            </div>

            {editing === field.id && (
              <div className="border-t border-zinc-800 p-3 space-y-3">
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">Thumbnail URL</label>
                  <input
                    value={thumbInput}
                    onChange={(e) => setThumbInput(e.target.value)}
                    placeholder="https://example.com/image.jpg"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
                  />
                  {thumbInput && (
                    <img
                      src={thumbInput}
                      alt="preview"
                      className="mt-2 h-24 w-full object-cover rounded-lg bg-zinc-800"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0.3"; }}
                    />
                  )}
                </div>
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">Recommendation Weight</label>
                  <input
                    type="number"
                    value={weightInput}
                    onChange={(e) => setWeightInput(e.target.value)}
                    step="0.1"
                    min="0"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                  />
                </div>
                <button
                  onClick={() => saveField(field)}
                  disabled={saving}
                  className="w-full flex items-center justify-center gap-2 bg-primary text-black font-bold py-2.5 rounded-xl text-sm disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  {saving ? "Saving…" : "Save Changes"}
                </button>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ─── Banners Tab ──────────────────────────────────────────────────────────────

function BannersTab() {
  const [banners, setBanners] = useState<AdminBanner[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ id: "", title: "", upperSubtext: "", lowerSubtext: "", hyperlink: "" });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/admin/banners");
      setBanners(data ?? []);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = (banner: AdminBanner) => {
    setEditing(banner.id);
    setShowNew(false);
    setForm({
      id: banner.id,
      title: banner.title,
      upperSubtext: banner.upperSubtext,
      lowerSubtext: banner.lowerSubtext,
      hyperlink: banner.hyperlink ?? "",
    });
  };

  const startNew = () => {
    setEditing(null);
    setShowNew(true);
    setForm({ id: "", title: "", upperSubtext: "", lowerSubtext: "", hyperlink: "" });
  };

  const cancel = () => { setEditing(null); setShowNew(false); };

  const saveBanner = async () => {
    setSaving(true);
    try {
      if (showNew) {
        const data = await apiFetch("/admin/banners", {
          method: "POST",
          body: JSON.stringify({
            id: form.id,
            title: form.title,
            upperSubtext: form.upperSubtext,
            lowerSubtext: form.lowerSubtext,
            hyperlink: form.hyperlink || null,
          }),
        });
        setBanners((prev) => [...prev, data]);
      } else if (editing) {
        const data = await apiFetch(`/admin/banners/${editing}`, {
          method: "PATCH",
          body: JSON.stringify({
            title: form.title,
            upperSubtext: form.upperSubtext,
            lowerSubtext: form.lowerSubtext,
            hyperlink: form.hyperlink || null,
          }),
        });
        setBanners((prev) => prev.map((b) => b.id === editing ? { ...b, ...data } : b));
      }
      cancel();
    } catch { /* silent */ }
    setSaving(false);
  };

  const deleteBanner = async (id: string) => {
    setDeleting(id);
    try {
      await apiFetch(`/admin/banners/${id}`, { method: "DELETE" });
      setBanners((prev) => prev.filter((b) => b.id !== id));
    } catch { /* silent */ }
    setDeleting(null);
  };

  const BannerForm = () => (
    <div className="bg-zinc-900 border border-primary/30 rounded-xl p-4 space-y-3">
      {showNew && (
        <div>
          <label className="text-xs text-zinc-400 mb-1 block">Banner ID (slug, no spaces)</label>
          <input
            value={form.id}
            onChange={(e) => setForm((f) => ({ ...f, id: e.target.value.replace(/[^a-zA-Z0-9_-]/g, "") }))}
            placeholder="my-banner"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
          />
        </div>
      )}
      {(["title", "upperSubtext", "lowerSubtext"] as const).map((field) => (
        <div key={field}>
          <label className="text-xs text-zinc-400 mb-1 block capitalize">{field.replace(/([A-Z])/g, " $1")}</label>
          <input
            value={form[field]}
            onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
            placeholder={field}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
          />
        </div>
      ))}
      <div>
        <label className="text-xs text-zinc-400 mb-1 block">Hyperlink (optional)</label>
        <input
          value={form.hyperlink}
          onChange={(e) => setForm((f) => ({ ...f, hyperlink: e.target.value }))}
          placeholder="https://example.com"
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
        />
      </div>
      <div className="flex gap-2 pt-1">
        <button
          onClick={saveBanner}
          disabled={saving || (showNew && !form.id)}
          className="flex-1 flex items-center justify-center gap-2 bg-primary text-black font-bold py-2.5 rounded-xl text-sm disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {saving ? "Saving…" : showNew ? "Create Banner" : "Save Changes"}
        </button>
        <button onClick={cancel} className="px-4 py-2.5 bg-zinc-800 text-zinc-400 rounded-xl text-sm hover:bg-zinc-700">
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-zinc-500 text-xs">{banners.length} banner{banners.length !== 1 ? "s" : ""}</span>
        <button
          onClick={startNew}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-black font-bold rounded-xl text-sm"
        >
          <Plus className="w-4 h-4" />
          New Banner
        </button>
      </div>

      {showNew && <BannerForm />}

      {loading ? (
        <div className="text-center py-16 text-zinc-500">Loading…</div>
      ) : (
        <div className="space-y-2">
          {banners.map((banner) => (
            <div key={banner.id}>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                <div className="flex items-center gap-3 p-3">
                  <img
                    src={banner.imageUrl}
                    alt={banner.title}
                    className="w-16 h-10 object-cover rounded-lg bg-zinc-800 flex-shrink-0"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0.3"; }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium text-sm truncate">{banner.title}</p>
                    {banner.hyperlink && (
                      <a href={banner.hyperlink} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 text-primary text-xs truncate hover:underline">
                        <ExternalLink className="w-3 h-3" />
                        {banner.hyperlink}
                      </a>
                    )}
                    {!banner.hyperlink && (
                      <p className="text-zinc-600 text-xs">{banner.upperSubtext || "—"}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => editing === banner.id ? cancel() : startEdit(banner)}
                      className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
                    >
                      {editing === banner.id ? <X className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => deleteBanner(banner.id)}
                      disabled={deleting === banner.id}
                      className="p-2 rounded-lg bg-zinc-800 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                {editing === banner.id && (
                  <div className="border-t border-zinc-800 p-3">
                    <BannerForm />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Admin Console ───────────────────────────────────────────────────────

const TABS: { id: Tab; label: string }[] = [
  { id: "clips", label: "Clips" },
  { id: "accounts", label: "Accounts" },
  { id: "fields", label: "Fields" },
  { id: "banners", label: "Banners" },
];

export default function Admin() {
  const { user, isLoading, isAdmin } = useAuth();
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<Tab>("clips");

  useEffect(() => {
    if (!isLoading && (!user || !isAdmin)) {
      setLocation("/home");
    }
  }, [isLoading, user, isAdmin, setLocation]);

  if (isLoading || !user || !isAdmin) {
    return null;
  }

  return (
    <div className="flex-1 flex flex-col bg-background min-h-0 overflow-hidden">
      {/* Header */}
      <div className="pt-safe px-4 pt-5 pb-3 bg-zinc-950 border-b border-zinc-800/60 flex-shrink-0">
        <p className="text-zinc-500 text-xs uppercase tracking-widest font-semibold mb-0.5">Admin Console</p>
        <h1 className="font-display font-black text-3xl text-white uppercase tracking-tight">REPLAY</h1>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-zinc-800/60 bg-zinc-950 flex-shrink-0 px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "px-4 py-3 text-sm font-semibold transition-colors relative",
              tab === t.id ? "text-primary" : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            {t.label}
            {tab === t.id && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 pb-24">
        {tab === "clips" && <ClipsTab />}
        {tab === "accounts" && <AccountsTab />}
        {tab === "fields" && <FieldsTab />}
        {tab === "banners" && <BannersTab />}
      </div>
    </div>
  );
}
