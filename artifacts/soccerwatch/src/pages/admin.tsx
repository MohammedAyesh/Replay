import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  Eye, EyeOff, UserCheck, UserX, Shield, ShieldOff, Trash2, Plus, Save, X,
  ExternalLink, Image, RefreshCw, Search, Pencil, ChevronDown, ChevronUp
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getGetFeedQueryKey,
  getListClipsQueryKey,
  getListUserClipsQueryKey,
  getGetMeQueryKey,
  getGetAccountStatsQueryKey,
  getGetUserProfileQueryKey,
  getListSavedClipsQueryKey,
  getGetBunnyCollectionsQueryKey,
  getGetFieldQueryKey,
  getGetFieldVideosQueryKey,
  getGetFieldRecordingsQueryKey,
  getListBannersQueryKey,
} from "@workspace/api-client-react";

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
  phone: string | null;
  position: string | null;
  age: number | null;
  gender: string | null;
  clerkId: string | null;
  createdAt: string;
}

interface AdminField {
  id: number;
  name: string;
  location: string;
  courts: number;
  weight: number;
  thumbnailUrl: string | null;
  isHidden: boolean;
  lastRecordedAt: string | null;
  bunnyGuid: string | null;
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
  const [selectedPlayer, setSelectedPlayer] = useState<number | null>(null);
  const [bulkWorking, setBulkWorking] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/admin/clips");
      setClips(data ?? []);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const invalidateFeeds = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getGetFeedQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListUserClipsQueryKey() });
  }, [queryClient]);

  const toggleHidden = async (clip: AdminClip) => {
    await apiFetch(`/admin/clips/${clip.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isHidden: !clip.isHidden }),
    });
    setClips((prev) => prev.map((c) => c.id === clip.id ? { ...c, isHidden: !c.isHidden } : c));
    invalidateFeeds();
  };

  const deleteClip = async (clip: AdminClip) => {
    if (!confirm(`Delete "${clip.title}"? This cannot be undone.`)) return;
    setDeleting(clip.id);
    try {
      await apiFetch(`/admin/clips/${clip.id}`, { method: "DELETE" });
      setClips((prev) => prev.filter((c) => c.id !== clip.id));
      invalidateFeeds();
    } catch { /* silent */ }
    setDeleting(null);
  };

  const players = Array.from(
    new Map(clips.map((c) => [c.userId, { id: c.userId, name: c.userName }])).values()
  ).sort((a, b) => a.name.localeCompare(b.name));

  const bulkSetHidden = async (hidden: boolean) => {
    const targets = clips.filter((c) => c.userId === selectedPlayer && c.isHidden !== hidden);
    if (!targets.length) return;
    setBulkWorking(true);
    try {
      for (const clip of targets) {
        await apiFetch(`/admin/clips/${clip.id}`, {
          method: "PATCH",
          body: JSON.stringify({ isHidden: hidden }),
        });
      }
      setClips((prev) =>
        prev.map((c) => c.userId === selectedPlayer ? { ...c, isHidden: hidden } : c)
      );
      invalidateFeeds();
    } catch { /* silent */ }
    setBulkWorking(false);
  };

  const filtered = clips.filter((c) => {
    if (selectedPlayer !== null && c.userId !== selectedPlayer) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.title.toLowerCase().includes(q) ||
      c.userName.toLowerCase().includes(q) ||
      c.userEmail.toLowerCase().includes(q)
    );
  });

  const selectedPlayerClips = selectedPlayer !== null ? clips.filter((c) => c.userId === selectedPlayer) : [];
  const allHidden = selectedPlayerClips.length > 0 && selectedPlayerClips.every((c) => c.isHidden);
  const noneHidden = selectedPlayerClips.every((c) => !c.isHidden);

  return (
    <div className="space-y-4">
      {/* Player filter row */}
      <div className="flex items-center gap-2">
        <select
          value={selectedPlayer ?? ""}
          onChange={(e) => setSelectedPlayer(e.target.value === "" ? null : Number(e.target.value))}
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-primary appearance-none"
        >
          <option value="">All players</option>
          {players.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {selectedPlayer !== null && (
          <>
            <button
              onClick={() => bulkSetHidden(true)}
              disabled={bulkWorking || allHidden}
              className="px-3 py-2 rounded-xl bg-red-900/40 text-red-400 border border-red-800/50 text-xs font-medium hover:bg-red-900/60 disabled:opacity-40 transition-colors"
              title="Hide all clips from this player"
            >
              <EyeOff className="w-4 h-4" />
            </button>
            <button
              onClick={() => bulkSetHidden(false)}
              disabled={bulkWorking || noneHidden}
              className="px-3 py-2 rounded-xl bg-primary/20 text-primary border border-primary/30 text-xs font-medium hover:bg-primary/30 disabled:opacity-40 transition-colors"
              title="Show all clips from this player"
            >
              <Eye className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
      {/* Search + count row */}
      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clips or players…"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-primary"
          />
        </div>
        <span className="text-zinc-500 text-xs shrink-0">{filtered.length} clips</span>
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
                <button
                  onClick={() => deleteClip(clip)}
                  disabled={deleting === clip.id}
                  className="p-2 rounded-lg bg-zinc-800 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50"
                  title="Delete clip"
                >
                  <Trash2 className="w-4 h-4" />
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
  const [editing, setEditing] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<Partial<AdminUser>>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/admin/users");
      setUsers(data ?? []);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = (user: AdminUser) => {
    setEditing(user.id);
    setEditForm({
      name: user.name,
      email: user.email,
      phone: user.phone ?? "",
      position: user.position ?? "",
      age: user.age ?? undefined,
      gender: user.gender ?? "",
    });
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditForm({});
  };

  const saveUser = async (user: AdminUser) => {
    setSaving(true);
    const body: Record<string, unknown> = {};
    if (editForm.name !== undefined) body.name = editForm.name;
    if (editForm.email !== undefined) body.email = editForm.email;
    if (editForm.phone !== undefined) body.phone = editForm.phone;
    if (editForm.position !== undefined) body.position = editForm.position;
    if (editForm.age !== undefined) body.age = editForm.age == null ? null : Number(editForm.age);
    if (editForm.gender !== undefined) body.gender = editForm.gender;

    try {
      const updated = await apiFetch(`/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, ...updated } : u));
      cancelEdit();
      queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetAccountStatsQueryKey() });
      if (user.clerkId) {
        queryClient.invalidateQueries({ queryKey: getGetUserProfileQueryKey(user.id) });
      }
    } catch { /* silent */ }
    setSaving(false);
  };

  const patchToggle = async (user: AdminUser, updates: Partial<AdminUser>) => {
    try {
      await apiFetch(`/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      });
      setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, ...updates } : u));
      queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetAccountStatsQueryKey() });
      if (user.clerkId) {
        queryClient.invalidateQueries({ queryKey: getGetUserProfileQueryKey(user.id) });
      }
    } catch { /* silent */ }
  };

  const deleteUser = async (user: AdminUser) => {
    if (!confirm(`Permanently delete ${user.name} (${user.email})? This cannot be undone.`)) return;
    setDeleting(user.id);
    try {
      await apiFetch(`/admin/users/${user.id}`, { method: "DELETE" });
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
      queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetAccountStatsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListSavedClipsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetFeedQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
    } catch { /* silent */ }
    setDeleting(null);
  };

  const filtered = users.filter((u) =>
    u.name.toLowerCase().includes(search.toLowerCase()) ||
    u.email.toLowerCase().includes(search.toLowerCase()) ||
    (u.phone ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search accounts…"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-primary"
          />
        </div>
        <span className="text-zinc-500 text-xs shrink-0">{filtered.length} accounts</span>
      </div>

      {loading ? (
        <div className="text-center py-16 text-zinc-500">Loading…</div>
      ) : (
        <div className="space-y-2">
          {filtered.map((user) => {
            const isSelf = user.id === me?.id;
            const isEdit = editing === user.id;
            return (
              <div
                key={user.id}
                className={cn(
                  "rounded-xl border overflow-hidden",
                  user.isDisabled ? "bg-zinc-900/50 border-zinc-800 opacity-60" : "bg-zinc-900 border-zinc-800"
                )}
              >
                <div className="flex items-center gap-3 p-3">
                  <div className="w-9 h-9 rounded-full bg-zinc-800 flex items-center justify-center text-sm font-bold text-zinc-300 flex-shrink-0">
                    {user.name[0]?.toUpperCase() ?? "?"}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
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

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => isEdit ? cancelEdit() : startEdit(user)}
                      className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
                      title={isEdit ? "Cancel" : "Edit account"}
                    >
                      {isEdit ? <X className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                    </button>
                    {!isSelf && (
                      <>
                        <button
                          onClick={() => patchToggle(user, { isAdmin: !user.isAdmin })}
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
                          onClick={() => patchToggle(user, { isDisabled: !user.isDisabled })}
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
                        <button
                          onClick={() => deleteUser(user)}
                          disabled={deleting === user.id}
                          className="p-2 rounded-lg bg-zinc-800 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50"
                          title="Delete account"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {isEdit && (
                  <div className="border-t border-zinc-800 p-3 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-zinc-400 mb-1 block">Name</label>
                        <input
                          value={editForm.name ?? ""}
                          onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-400 mb-1 block">Email</label>
                        <input
                          value={editForm.email ?? ""}
                          onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-400 mb-1 block">Phone</label>
                        <input
                          value={editForm.phone ?? ""}
                          onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-400 mb-1 block">Position</label>
                        <input
                          value={editForm.position ?? ""}
                          onChange={(e) => setEditForm((f) => ({ ...f, position: e.target.value }))}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-400 mb-1 block">Age</label>
                        <input
                          type="number"
                          value={editForm.age ?? ""}
                          onChange={(e) => setEditForm((f) => ({ ...f, age: e.target.value === "" ? undefined : Number(e.target.value) }))}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-zinc-400 mb-1 block">Gender</label>
                        <input
                          value={editForm.gender ?? ""}
                          onChange={(e) => setEditForm((f) => ({ ...f, gender: e.target.value }))}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => saveUser(user)}
                        disabled={saving}
                        className="flex-1 flex items-center justify-center gap-2 bg-primary text-black font-bold py-2.5 rounded-xl text-sm disabled:opacity-50"
                      >
                        <Save className="w-4 h-4" />
                        {saving ? "Saving…" : "Save Changes"}
                      </button>
                      <button onClick={cancelEdit} className="px-4 py-2.5 bg-zinc-800 text-zinc-400 rounded-xl text-sm hover:bg-zinc-700">
                        Cancel
                      </button>
                    </div>
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
  const [nameInput, setNameInput] = useState("");
  const [thumbInput, setThumbInput] = useState("");
  const [weightInput, setWeightInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const queryClient = useQueryClient();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/admin/fields");
      setFields(data ?? []);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const syncFields = async () => {
    setSyncing(true);
    try {
      const data = await apiFetch("/admin/fields/sync", { method: "POST" });
      if (data?.fields) setFields(data.fields);
      queryClient.invalidateQueries({ queryKey: getGetBunnyCollectionsQueryKey() });
    } catch { /* silent */ }
    setSyncing(false);
  };

  const startEdit = (field: AdminField) => {
    setEditing(field.id);
    setNameInput(field.name);
    setThumbInput(field.thumbnailUrl ?? "");
    setWeightInput(String(field.weight));
  };

  const cancelEdit = () => {
    setEditing(null);
    setNameInput("");
    setThumbInput("");
    setWeightInput("");
  };

  const saveField = async (field: AdminField) => {
    setSaving(true);
    try {
      await apiFetch(`/admin/fields/${field.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: nameInput.trim() || field.name,
          thumbnailUrl: thumbInput.trim() || null,
          weight: parseFloat(weightInput) || 1.0,
        }),
      });
      setFields((prev) => prev.map((f) =>
        f.id === field.id
          ? { ...f, name: nameInput.trim() || f.name, thumbnailUrl: thumbInput.trim() || null, weight: parseFloat(weightInput) || 1.0 }
          : f
      ));
      cancelEdit();
      queryClient.invalidateQueries({ queryKey: getGetBunnyCollectionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetFieldQueryKey(field.id) });
      queryClient.invalidateQueries({ queryKey: getGetFieldVideosQueryKey(field.id) });
      queryClient.invalidateQueries({ queryKey: getGetFieldRecordingsQueryKey(field.id) });
    } catch { /* silent */ }
    setSaving(false);
  };

  const toggleHidden = async (field: AdminField) => {
    setToggling(field.id);
    try {
      await apiFetch(`/admin/fields/${field.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isHidden: !field.isHidden }),
      });
      setFields((prev) => prev.map((f) =>
        f.id === field.id ? { ...f, isHidden: !f.isHidden } : f
      ));
      queryClient.invalidateQueries({ queryKey: getGetBunnyCollectionsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetFieldQueryKey(field.id) });
      queryClient.invalidateQueries({ queryKey: getGetFieldVideosQueryKey(field.id) });
      queryClient.invalidateQueries({ queryKey: getGetFieldRecordingsQueryKey(field.id) });
    } catch { /* silent */ }
    setToggling(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-zinc-500 text-xs">{fields.length} field{fields.length !== 1 ? "s" : ""}</span>
        <button
          onClick={syncFields}
          disabled={syncing}
          className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 text-zinc-300 rounded-xl text-sm hover:bg-zinc-700 disabled:opacity-50"
        >
          <RefreshCw className={cn("w-4 h-4", syncing && "animate-spin")} />
          {syncing ? "Syncing…" : "Sync from Bunny"}
        </button>
      </div>

      {loading ? (
        <div className="text-center py-16 text-zinc-500">Loading…</div>
      ) : (
        fields.map((field) => (
          <div
            key={field.id}
            className={cn(
              "border rounded-xl overflow-hidden transition-colors",
              field.isHidden ? "bg-zinc-900/50 border-zinc-800/50 opacity-60" : "bg-zinc-900 border-zinc-800"
            )}
          >
            <div className="flex items-center gap-3 p-3">
              <div className="w-14 h-14 rounded-lg overflow-hidden bg-zinc-800 flex-shrink-0">
                {field.thumbnailUrl ? (
                  <img src={field.thumbnailUrl} alt={field.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full field-pattern opacity-50" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-white font-medium text-sm truncate">{field.name}</p>
                  {field.isHidden && (
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded-full">
                      Hidden
                    </span>
                  )}
                </div>
                <p className="text-zinc-500 text-xs truncate">{field.location}</p>
                <p className="text-zinc-600 text-xs">Weight: {field.weight} · {field.courts} court{field.courts !== 1 ? "s" : ""}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => toggleHidden(field)}
                  disabled={toggling === field.id}
                  title={field.isHidden ? "Show field" : "Hide field"}
                  className={cn(
                    "p-2 rounded-lg transition-colors disabled:opacity-50",
                    field.isHidden
                      ? "bg-amber-400/10 text-amber-400 hover:bg-amber-400/20"
                      : "bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700"
                  )}
                >
                  {field.isHidden ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => editing === field.id ? cancelEdit() : startEdit(field)}
                  className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
                >
                  {editing === field.id ? <X className="w-4 h-4" /> : <Image className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {editing === field.id && (
              <div className="border-t border-zinc-800 p-3 space-y-3">
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">Field Name</label>
                  <input
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    placeholder="Field name"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
                  />
                </div>
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
  const [form, setForm] = useState({ id: "", title: "", upperSubtext: "", lowerSubtext: "", hyperlink: "", imageUrl: "" });
  const [uploadingImage, setUploadingImage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const queryClient = useQueryClient();

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
      imageUrl: banner.imageUrl ?? "",
    });
  };

  const startNew = () => {
    setEditing(null);
    setShowNew(true);
    setForm({ id: "", title: "", upperSubtext: "", lowerSubtext: "", hyperlink: "", imageUrl: "" });
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
            imageUrl: form.imageUrl.trim() || null,
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
            imageUrl: form.imageUrl.trim() || null,
          }),
        });
        setBanners((prev) => prev.map((b) => b.id === editing ? { ...b, ...data } : b));
      }
      cancel();
      queryClient.invalidateQueries({ queryKey: getListBannersQueryKey() });
    } catch { /* silent */ }
    setSaving(false);
  };

  const deleteBanner = async (id: string) => {
    setDeleting(id);
    try {
      await apiFetch(`/admin/banners/${id}`, { method: "DELETE" });
      setBanners((prev) => prev.filter((b) => b.id !== id));
      queryClient.invalidateQueries({ queryKey: getListBannersQueryKey() });
    } catch { /* silent */ }
    setDeleting(null);
  };

  const BannerForm = () => {
    const effectiveImageUrl = form.imageUrl.trim() || (showNew ? "" : `/api/banners/${encodeURIComponent(editing ?? form.id)}/image`);

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const bannerId = showNew ? form.id : editing;
      if (!bannerId) return;
      setUploadingImage(true);
      try {
        const fd = new FormData();
        fd.append("image", file);
        const res = await fetch(`${basePath}/api/admin/banners/${bannerId}/image`, {
          method: "POST",
          credentials: "include",
          body: fd,
        });
        if (res.ok) {
          const data = await res.json() as { imageUrl: string };
          setForm((f) => ({ ...f, imageUrl: data.imageUrl }));
        }
      } catch { /* silent */ }
      setUploadingImage(false);
      e.target.value = "";
    };

    return (
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
        <div>
          <label className="text-xs text-zinc-400 mb-1 block">Image</label>
          <div className="flex gap-2">
            <input
              value={form.imageUrl}
              onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))}
              placeholder="https://example.com/image.jpg or upload below"
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
            />
            <label className="cursor-pointer px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors text-sm flex items-center gap-1.5 flex-shrink-0">
              <Image className="w-4 h-4" />
              <span>Upload</span>
              <input type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
            </label>
          </div>
          {uploadingImage && <p className="text-xs text-zinc-500 mt-1">Uploading image…</p>}
          {effectiveImageUrl && (
            <img
              src={effectiveImageUrl}
              alt="Banner preview"
              className="mt-2 h-24 w-full object-cover rounded-lg bg-zinc-800"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0.3"; }}
            />
          )}
        </div>
        <div className="flex gap-2 pt-1">
          <button
            onClick={saveBanner}
            disabled={saving || uploadingImage || (showNew && !form.id)}
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
  };

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
