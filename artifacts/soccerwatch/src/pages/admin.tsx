import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  Eye, EyeOff, UserCheck, UserX, Shield, ShieldOff, Trash2, Plus, Save, X,
  ExternalLink, Image, RefreshCw, Search, Pencil, ChevronDown, ChevronUp,
  GraduationCap, Video, Check, Radio, Square, AlertTriangle, Lock,
  Play, Clock, CheckCircle2, XCircle, Loader2, ExternalLink as LinkIcon,
} from "lucide-react";
import Hls from "hls.js";
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

type Tab = "clips" | "accounts" | "fields" | "banners" | "academies" | "live";

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
  academyId: number | null;
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

interface AdminAcademy {
  id: number;
  name: string;
  fieldId: number;
  fieldName: string;
  fieldLocation: string;
  daysOfWeek: string[];
  description: string | null;
  logoUrl: string | null;
  liveAccess: boolean;
  cameraIds: string[];
  recordingCount: number;
}

interface AdminRecording {
  id: number;
  fieldId: number;
  court: string;
  date: string;
  timeSlot: string;
  duration: string;
  score: string | null;
  videoUrl: string;
  fieldName: string | null;
}

interface FieldVideo {
  guid: string;
  title: string;
  thumbnailUrl: string;
  playbackUrl: string;
  duration: number; // seconds
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
  const [academies, setAcademies] = useState<{ id: number; name: string }[]>([]);
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
      const [data, acData] = await Promise.all([
        apiFetch("/admin/users"),
        apiFetch("/academies"),
      ]);
      setUsers(data ?? []);
      setAcademies((acData ?? []).map((a: AdminAcademy) => ({ id: a.id, name: a.name })));
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
      academyId: user.academyId ?? null,
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
    if (editForm.academyId !== undefined) body.academyId = editForm.academyId ?? null;

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
                    <div>
                      <label className="text-xs text-zinc-400 mb-1 block">Academy (Live Access)</label>
                      <select
                        value={editForm.academyId ?? ""}
                        onChange={(e) => setEditForm((f) => ({ ...f, academyId: e.target.value === "" ? null : Number(e.target.value) }))}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary"
                      >
                        <option value="">— No academy —</option>
                        {academies.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
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
                  {editing === field.id ? <X className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
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

  // A plain render helper, NOT a component.
  //
  // This used to be a `BannerForm` component defined here and rendered as JSX.
  // Defining a component inside the parent's render body gives it a new
  // identity on every render, so each keystroke made React unmount the whole
  // form and mount a fresh one: the input lost focus and every character after
  // the first was dropped. Calling it as a function inlines the elements into
  // this component's tree instead, and the inputs keep their DOM nodes.
  const renderBannerForm = () => {
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

      {showNew && renderBannerForm()}

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
                    {renderBannerForm()}
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

// ─── Academies helpers ────────────────────────────────────────────────────────

function secondsToMinStr(secs: number): string {
  if (!secs) return "";
  const m = Math.round(secs / 60);
  return m > 0 ? `${m}min` : `${secs}s`;
}

/**
 * Parse a Bunny video title into court/date/timeSlot for the recordings table.
 * Mirrors parseVideoFilename in field-detail.tsx — keep the two in sync.
 * Supports:
 *   Format A: cam{N}_..._{DDMMYYYY}_{HHMMSS}     e.g. cam1_Field_01_19072026_150000
 *   Format C: cam{N}_{YYYY-MM-DD}_{HH:MM}        e.g. cam1_2026-07-28_11:00 (on-demand recordings)
 *   Format B: cam{N}_{YYYYMMDD}{HH}              e.g. cam1_2026072714
 * Falls back to today's date only if none of these match, which should only
 * happen for a title that was never machine-generated in the first place.
 */
function parseVideoTitle(title: string): { court: string; date: string; timeSlot: string; duration: string } {
  const name = title.replace(/\.\w+$/, "");
  const parts = name.split("_");
  const camMatch = parts[0]?.match(/^cam(\d+)$/i);
  const court = camMatch ? `Camera ${camMatch[1]}` : "Court 1";

  if (parts.length >= 3) {
    const datePart = parts[parts.length - 2];
    const timePart = parts[parts.length - 1];

    // Format A: DDMMYYYY + HHMMSS
    if (/^\d{8}$/.test(datePart) && /^\d{6}$/.test(timePart)) {
      const day = datePart.slice(0, 2), month = datePart.slice(2, 4), year = datePart.slice(4, 8);
      return { court, date: `${year}-${month}-${day}`, timeSlot: `${timePart.slice(0, 2)}:${timePart.slice(2, 4)}`, duration: "" };
    }

    // Format C: YYYY-MM-DD + HH:MM
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart) && /^\d{1,2}:\d{2}$/.test(timePart)) {
      return { court, date: datePart, timeSlot: timePart, duration: "" };
    }
  }

  // Format B: cam{N}_YYYYMMDDHH (10 digits, no separate time segment)
  if (parts.length === 2 && /^\d{10}$/.test(parts[1])) {
    const chunk = parts[1];
    const year = chunk.slice(0, 4), month = chunk.slice(4, 6), day = chunk.slice(6, 8), hh = chunk.slice(8, 10);
    return { court, date: `${year}-${month}-${day}`, timeSlot: `${hh}:00`, duration: "" };
  }

  return { court: "Court 1", date: new Date().toISOString().slice(0, 10), timeSlot: "", duration: "" };
}

// ─── Academies Tab ────────────────────────────────────────────────────────────

const ALL_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_LABELS: Record<string, string> = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
  friday: "Fri", saturday: "Sat", sunday: "Sun",
};

function AcademiesTab() {
  const [academies, setAcademies] = useState<AdminAcademy[]>([]);
  const [fields, setFields] = useState<AdminField[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [form, setForm] = useState({ name: "", fieldId: 0, daysOfWeek: [] as string[], description: "", logoUrl: "", cameraIds: [] as string[] });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);

  // Per-academy recording data
  const [recMap, setRecMap] = useState<Record<number, AdminRecording[]>>({});
  const [allRecordings, setAllRecordings] = useState<AdminRecording[]>([]);
  const [recLoading, setRecLoading] = useState<number | null>(null);
  const [addingRec, setAddingRec] = useState<number | null>(null);
  const [removingRec, setRemovingRec] = useState<string | null>(null);

  // Intro video
  const [introUrl, setIntroUrl] = useState<string | null>(null);
  const [introLoading, setIntroLoading] = useState(true);
  const [introUploading, setIntroUploading] = useState(false);

  // Add-recording from field videos
  const [fieldVideos, setFieldVideos] = useState<Record<number, FieldVideo[]>>({});
  const [videosLoading, setVideosLoading] = useState<number | null>(null);
  const [selectedVideoGuid, setSelectedVideoGuid] = useState<string | null>(null);
  const [linkingRec, setLinkingRec] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [acData, fData] = await Promise.all([
        apiFetch("/admin/academies"),
        apiFetch("/admin/fields"),
      ]);
      setAcademies(acData ?? []);
      setFields(fData ?? []);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    apiFetch("/admin/clip-intro")
      .then((data) => setIntroUrl(data?.introVideoUrl ?? null))
      .catch(() => {})
      .finally(() => setIntroLoading(false));
  }, []);

  const uploadIntro = async (file: File) => {
    setIntroUploading(true);
    try {
      const formData = new FormData();
      formData.append("video", file);
      const response = await fetch(`${basePath}/api/admin/clip-intro`, {
        method: "POST", credentials: "include", body: formData,
      });
      if (!response.ok) throw new Error("Upload failed");
      const data = await response.json();
      setIntroUrl(data.introVideoUrl);
    } catch { /* keep current intro */ }
    setIntroUploading(false);
  };

  const removeIntro = async () => {
    await apiFetch("/admin/clip-intro", { method: "DELETE" });
    setIntroUrl(null);
  };

  const linkVideo = async (academy: AdminAcademy) => {
    const videos = fieldVideos[academy.fieldId] ?? [];
    const video = videos.find((v) => v.guid === selectedVideoGuid);
    if (!video) return;
    setLinkingRec(true);
    try {
      const parsed = parseVideoTitle(video.title);
      const rec: AdminRecording = await apiFetch("/admin/recordings", {
        method: "POST",
        body: JSON.stringify({
          fieldId: academy.fieldId,
          court: parsed.court,
          date: parsed.date,
          timeSlot: parsed.timeSlot,
          duration: parsed.duration || secondsToMinStr(video.duration),
          score: null,
          videoUrl: video.playbackUrl,
        }),
      });
      setAllRecordings((p) => [...p, rec]);
      setSelectedVideoGuid(null);
    } catch { /* silent */ }
    setLinkingRec(false);
  };

  const loadRecordings = useCallback(async (academy: AdminAcademy) => {
    setRecLoading(academy.id);
    setVideosLoading(academy.fieldId);
    try {
      const [acRecs, recordings, videos] = await Promise.all([
        apiFetch(`/academies/${academy.id}/recordings`),
        apiFetch("/admin/recordings"),
        apiFetch(`/fields/${academy.fieldId}/videos`),
      ]);
      setRecMap((p) => ({ ...p, [academy.id]: acRecs ?? [] }));
      setAllRecordings(recordings ?? []);
      setFieldVideos((p) => ({ ...p, [academy.fieldId]: videos ?? [] }));
    } catch { /* silent */ }
    setRecLoading(null);
    setVideosLoading(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleExpand = (academy: AdminAcademy) => {
    if (expandedId === academy.id) {
      setExpandedId(null);
      setSelectedVideoGuid(null);
    } else {
      setExpandedId(academy.id);
      setSelectedVideoGuid(null);
      if (!recMap[academy.id]) loadRecordings(academy);
    }
  };

  const startNew = () => {
    setEditing("new");
    setForm({ name: "", fieldId: fields[0]?.id ?? 0, daysOfWeek: [], description: "", logoUrl: "", cameraIds: [] });
  };

  const startEdit = (a: AdminAcademy) => {
    setEditing(a.id);
    setForm({ name: a.name, fieldId: a.fieldId, daysOfWeek: a.daysOfWeek, description: a.description ?? "", logoUrl: a.logoUrl ?? "", cameraIds: a.cameraIds ?? [] });
  };

  const cancelEdit = () => { setEditing(null); };

  const toggleDay = (day: string) => {
    setForm((f) => ({
      ...f,
      daysOfWeek: f.daysOfWeek.includes(day)
        ? f.daysOfWeek.filter((d) => d !== day)
        : [...f.daysOfWeek, day],
    }));
  };

  const saveAcademy = async () => {
    if (!form.name.trim() || !form.fieldId) return;
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        fieldId: form.fieldId,
        daysOfWeek: form.daysOfWeek,
        description: form.description.trim() || null,
        logoUrl: form.logoUrl.trim() || null,
        cameraIds: form.cameraIds,
      };
      if (editing === "new") {
        const created = await apiFetch("/admin/academies", { method: "POST", body: JSON.stringify(body) });
        setAcademies((p) => [...p, created]);
      } else {
        const updated = await apiFetch(`/admin/academies/${editing}`, { method: "PATCH", body: JSON.stringify(body) });
        setAcademies((p) => p.map((a) => a.id === editing ? updated : a));
      }
      cancelEdit();
    } catch { /* silent */ }
    setSaving(false);
  };

  const deleteAcademy = async (id: number, name: string) => {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    setDeleting(id);
    try {
      await apiFetch(`/admin/academies/${id}`, { method: "DELETE" });
      setAcademies((p) => p.filter((a) => a.id !== id));
      if (expandedId === id) setExpandedId(null);
    } catch { /* silent */ }
    setDeleting(null);
  };

  const toggleLiveAccess = async (academy: AdminAcademy) => {
    const next = !academy.liveAccess;
    setAcademies((p) => p.map((a) => a.id === academy.id ? { ...a, liveAccess: next } : a));
    try {
      await apiFetch(`/admin/academies/${academy.id}`, {
        method: "PATCH",
        body: JSON.stringify({ liveAccess: next }),
      });
    } catch {
      // Revert on failure
      setAcademies((p) => p.map((a) => a.id === academy.id ? { ...a, liveAccess: !next } : a));
    }
  };

  const addRecording = async (academy: AdminAcademy, recordingId: number) => {
    setAddingRec(recordingId);
    try {
      await apiFetch(`/admin/academies/${academy.id}/recordings`, {
        method: "POST",
        body: JSON.stringify({ recordingId }),
      });
      await loadRecordings(academy);
      setAcademies((p) => p.map((a) => a.id === academy.id ? { ...a, recordingCount: a.recordingCount + 1 } : a));
    } catch { /* silent */ }
    setAddingRec(null);
  };

  const removeRecording = async (academy: AdminAcademy, recordingId: number) => {
    setRemovingRec(`${academy.id}-${recordingId}`);
    try {
      await apiFetch(`/admin/academies/${academy.id}/recordings/${recordingId}`, { method: "DELETE" });
      setRecMap((p) => ({ ...p, [academy.id]: (p[academy.id] ?? []).filter((r) => r.id !== recordingId) }));
      setAcademies((p) => p.map((a) => a.id === academy.id ? { ...a, recordingCount: Math.max(0, a.recordingCount - 1) } : a));
    } catch { /* silent */ }
    setRemovingRec(null);
  };

  const linkedIds = (academyId: number) => new Set((recMap[academyId] ?? []).map((r) => r.id));

  return (
    <div className="space-y-4">
      {/* Clip intro video */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex items-center gap-2 mb-1">
          <Video className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-white">Clip intro video</h3>
        </div>
        <p className="text-xs text-zinc-500 mb-3">
          This video is prepended to every newly exported player clip.
        </p>
        {introLoading ? (
          <p className="text-xs text-zinc-500">Loading…</p>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <label className="cursor-pointer rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-black hover:bg-primary/90">
              {introUploading ? "Uploading…" : introUrl ? "Replace intro" : "Choose intro video"}
              <input
                type="file"
                accept="video/mp4,video/webm,video/quicktime"
                className="hidden"
                disabled={introUploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadIntro(file);
                  event.target.value = "";
                }}
              />
            </label>
            {introUrl && (
              <button type="button" onClick={() => void removeIntro()} className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-red-400 hover:bg-zinc-700">
                Remove
              </button>
            )}
            <span className="text-xs text-zinc-500">{introUrl ? "✓ Active" : "No intro selected"}</span>
          </div>
        )}
      </div>

      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-zinc-500 text-xs">{academies.length} {academies.length === 1 ? "academy" : "academies"}</span>
        <button
          onClick={startNew}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-black rounded-xl text-sm font-bold hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Academy
        </button>
      </div>

      {/* New academy form */}
      {editing === "new" && (
        <AcademyForm
          form={form}
          fields={fields}
          saving={saving}
          onToggleDay={toggleDay}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          onSave={saveAcademy}
          onCancel={cancelEdit}
          title="New Academy"
        />
      )}

      {loading ? (
        <div className="text-center py-16 text-zinc-500">Loading…</div>
      ) : academies.length === 0 && editing !== "new" ? (
        <div className="text-center py-12 text-zinc-500">
          <GraduationCap className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No academies yet. Create one above.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {academies.map((academy) => {
            const isExpanded = expandedId === academy.id;
            const isEditing = editing === academy.id;
            const linked = linkedIds(academy.id);
            const availableToAdd = allRecordings.filter((r) => !linked.has(r.id));

            return (
              <div key={academy.id} className="border border-zinc-800 rounded-xl overflow-hidden bg-zinc-900">
                {/* Academy header row */}
                <div className="flex items-center gap-3 p-3">
                  <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {academy.logoUrl ? (
                      <img src={academy.logoUrl} alt={academy.name} className="w-full h-full object-cover" />
                    ) : (
                      <GraduationCap className="w-4 h-4 text-primary" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium text-sm truncate">{academy.name}</p>
                    <p className="text-zinc-500 text-xs truncate">{academy.fieldLocation} · {academy.recordingCount} rec.</p>
                    {academy.daysOfWeek.length > 0 && (
                      <div className="flex gap-1 mt-0.5 flex-wrap">
                        {academy.daysOfWeek.map((d) => (
                          <span key={d} className="text-[9px] font-bold uppercase tracking-wide bg-primary/15 text-primary px-1 py-0.5 rounded">
                            {DAY_LABELS[d] ?? d}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => toggleLiveAccess(academy)}
                      className={cn(
                        "p-2 rounded-lg transition-colors",
                        academy.liveAccess
                          ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                          : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
                      )}
                      title={academy.liveAccess ? "Revoke live access" : "Grant live access"}
                    >
                      <Radio className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => toggleExpand(academy)}
                      className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
                      title={isExpanded ? "Collapse" : "Manage recordings"}
                    >
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => isEditing ? cancelEdit() : startEdit(academy)}
                      className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"
                      title={isEditing ? "Cancel" : "Edit academy"}
                    >
                      {isEditing ? <X className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => deleteAcademy(academy.id, academy.name)}
                      disabled={deleting === academy.id}
                      className="p-2 rounded-lg bg-zinc-800 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50"
                      title="Delete academy"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Edit form */}
                {isEditing && (
                  <div className="border-t border-zinc-800 p-3">
                    <AcademyForm
                      form={form}
                      fields={fields}
                      saving={saving}
                      academyId={academy.id}
                      onToggleDay={toggleDay}
                      onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
                      onSave={saveAcademy}
                      onCancel={cancelEdit}
                      title="Edit Academy"
                    />
                  </div>
                )}

                {/* Recordings panel */}
                {isExpanded && !isEditing && (
                  <div className="border-t border-zinc-800 p-3 space-y-3">
                    {recLoading === academy.id ? (
                      <div className="text-center py-4 text-zinc-500 text-sm">Loading recordings…</div>
                    ) : (
                      <>
                        {/* Linked recordings */}
                        <div>
                          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                            Linked Recordings ({(recMap[academy.id] ?? []).length})
                          </p>
                          {(recMap[academy.id] ?? []).length === 0 ? (
                            <p className="text-zinc-600 text-xs py-2">No recordings linked yet.</p>
                          ) : (
                            <div className="space-y-1.5">
                              {(recMap[academy.id] ?? []).map((rec) => (
                                <div key={rec.id} className="flex items-center gap-2 p-2 rounded-lg bg-zinc-800/50">
                                  <Video className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-white text-xs font-medium truncate">{rec.date} · {rec.timeSlot}</p>
                                    <p className="text-zinc-500 text-[11px] truncate">{rec.court} · {rec.duration}{rec.score ? ` · ${rec.score}` : ""}</p>
                                  </div>
                                  <button
                                    onClick={() => removeRecording(academy, rec.id)}
                                    disabled={removingRec === `${academy.id}-${rec.id}`}
                                    className="p-1.5 rounded-lg bg-zinc-700 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50 flex-shrink-0"
                                    title="Remove recording"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Add from field recordings */}
                        {availableToAdd.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                              Choose recordings from any field
                            </p>
                            <div className="space-y-1.5 max-h-48 overflow-y-auto">
                              {availableToAdd.map((rec) => (
                                <div key={rec.id} className="flex items-center gap-2 p-2 rounded-lg bg-zinc-800/30 border border-zinc-800">
                                  <Video className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-zinc-300 text-xs font-medium truncate">{rec.fieldName} · {rec.date} · {rec.timeSlot}</p>
                                    <p className="text-zinc-600 text-[11px] truncate">{rec.court} · {rec.duration}{rec.score ? ` · ${rec.score}` : ""}</p>
                                  </div>
                                  <button
                                    onClick={() => addRecording(academy, rec.id)}
                                    disabled={addingRec === rec.id}
                                    className="flex items-center gap-1 px-2 py-1 rounded-lg bg-primary/20 text-primary hover:bg-primary/30 transition-colors disabled:opacity-50 flex-shrink-0 text-xs font-medium"
                                    title="Add recording"
                                  >
                                    {addingRec === rec.id ? (
                                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                    ) : (
                                      <>
                                        <Plus className="w-3 h-3" />
                                        Add
                                      </>
                                    )}
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Link a field video as a new recording */}
                        <div className="pt-1">
                          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                            Link a field video
                          </p>
                          {videosLoading === academy.fieldId ? (
                            <p className="text-zinc-600 text-xs py-1">Loading videos…</p>
                          ) : (fieldVideos[academy.fieldId] ?? []).length === 0 ? (
                            <p className="text-zinc-600 text-xs py-1">No videos found for this field.</p>
                          ) : (
                            <div className="flex gap-2 items-center">
                              <select
                                value={selectedVideoGuid ?? ""}
                                onChange={(e) => setSelectedVideoGuid(e.target.value || null)}
                                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-white min-w-0"
                              >
                                <option value="">— choose a video —</option>
                                {(fieldVideos[academy.fieldId] ?? [])
                                  .filter((v) => !allRecordings.some((r) => r.videoUrl.includes(v.guid)))
                                  .map((v) => (
                                    <option key={v.guid} value={v.guid}>{v.title}</option>
                                  ))}
                              </select>
                              <button
                                onClick={() => void linkVideo(academy)}
                                disabled={!selectedVideoGuid || linkingRec}
                                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-black text-xs font-bold hover:bg-primary/90 disabled:opacity-50 transition-colors flex-shrink-0"
                              >
                                {linkingRec ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                Link
                              </button>
                            </div>
                          )}
                        </div>
                      </>
                    )}
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

function AcademyForm({
  form,
  fields,
  saving,
  academyId,
  onToggleDay,
  onChange,
  onSave,
  onCancel,
  title,
}: {
  form: { name: string; fieldId: number; daysOfWeek: string[]; description: string; logoUrl: string; cameraIds: string[] };
  fields: AdminField[];
  saving: boolean;
  academyId?: number;
  onToggleDay: (day: string) => void;
  onChange: (patch: Partial<typeof form>) => void;
  onSave: () => void;
  onCancel: () => void;
  title: string;
}) {
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !academyId) return;
    setUploadingLogo(true);
    try {
      const fd = new FormData();
      fd.append("logo", file);
      const res = await fetch(`${basePath}/api/admin/academies/${academyId}/logo`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (res.ok) {
        const data = await res.json() as { logoUrl: string };
        onChange({ logoUrl: data.logoUrl });
      }
    } catch { /* silent */ }
    setUploadingLogo(false);
    e.target.value = "";
  };

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{title}</p>

      {/* Logo preview */}
      <div>
        <label className="text-xs text-zinc-400 mb-1 block">Logo (optional)</label>
        <div className="flex items-center gap-3">
          <div className="w-14 h-14 rounded-xl bg-zinc-800 border border-zinc-700 flex items-center justify-center flex-shrink-0 overflow-hidden">
            {form.logoUrl ? (
              <img src={form.logoUrl} alt="Logo" className="w-full h-full object-cover" />
            ) : (
              <GraduationCap className="w-6 h-6 text-zinc-600" />
            )}
          </div>
          <div className="flex-1 space-y-1.5">
            <input
              value={form.logoUrl}
              onChange={(e) => onChange({ logoUrl: e.target.value })}
              placeholder="https://example.com/logo.png"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
            />
            {academyId && (
              <>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploadingLogo}
                  className="text-xs text-primary hover:underline disabled:opacity-50"
                >
                  {uploadingLogo ? "Uploading…" : "or upload file"}
                </button>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
              </>
            )}
          </div>
          {form.logoUrl && (
            <button
              type="button"
              onClick={() => onChange({ logoUrl: "" })}
              className="text-zinc-500 hover:text-red-400 transition-colors text-xs"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      <div>
        <label className="text-xs text-zinc-400 mb-1 block">Academy Name</label>
        <input
          value={form.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="e.g. Elite Youth Academy"
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary"
        />
      </div>
      <div>
        <label className="text-xs text-zinc-400 mb-1 block">Field</label>
        <select
          value={form.fieldId}
          onChange={(e) => onChange({ fieldId: Number(e.target.value) })}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-primary appearance-none"
        >
          {fields.map((f) => (
            <option key={f.id} value={f.id}>{f.name} — {f.location}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-xs text-zinc-400 mb-2 block">Days of Week</label>
        <div className="flex flex-wrap gap-1.5">
          {ALL_DAYS.map((day) => {
            const active = form.daysOfWeek.includes(day);
            return (
              <button
                key={day}
                type="button"
                onClick={() => onToggleDay(day)}
                className={cn(
                  "px-2.5 py-1 rounded-lg text-xs font-semibold uppercase tracking-wide transition-colors",
                  active
                    ? "bg-primary text-black"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white"
                )}
              >
                {DAY_LABELS[day]}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <label className="text-xs text-zinc-400 mb-2 block">Cameras (optional)</label>
        <div className="flex gap-2">
          {(["camera1", "camera2"] as const).map((cam) => {
            const label = cam === "camera1" ? "Camera 1" : "Camera 2";
            const active = form.cameraIds.includes(cam);
            return (
              <button
                key={cam}
                type="button"
                onClick={() =>
                  onChange({
                    cameraIds: active
                      ? form.cameraIds.filter((c) => c !== cam)
                      : [...form.cameraIds, cam],
                  })
                }
                className={cn(
                  "flex-1 py-2 rounded-lg text-xs font-semibold transition-colors border",
                  active
                    ? "bg-primary text-black border-primary"
                    : "bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700 hover:text-white"
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <label className="text-xs text-zinc-400 mb-1 block">Description (optional)</label>
        <textarea
          value={form.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Brief description of the academy…"
          rows={2}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-primary resize-none"
        />
      </div>
      <div className="flex gap-2">
        <button
          onClick={onSave}
          disabled={saving || !form.name.trim()}
          className="flex-1 flex items-center justify-center gap-2 bg-primary text-black font-bold py-2.5 rounded-xl text-sm disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {saving ? "Saving…" : "Save Academy"}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2.5 bg-zinc-800 text-zinc-400 rounded-xl text-sm hover:bg-zinc-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Live Schedules ───────────────────────────────────────────────────────────

const SCHEDULE_DAYS = [
  { key: "monday",    label: "Mo" },
  { key: "tuesday",   label: "Tu" },
  { key: "wednesday", label: "We" },
  { key: "thursday",  label: "Th" },
  { key: "friday",    label: "Fr" },
  { key: "saturday",  label: "Sa" },
  { key: "sunday",    label: "Su" },
] as const;

interface LiveSchedule {
  id: number;
  camera: string;
  startTime: string;
  endTime: string;
  daysOfWeek: string[];
  enabled: boolean;
}

function LiveSchedulesSection({ adminPassword }: { adminPassword: string }) {
  const [schedules, setSchedules] = useState<LiveSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    camera: "camera1" as "camera1" | "camera2",
    startTime: "",
    endTime: "",
    daysOfWeek: [] as string[],
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const apiFetch = useCallback(async (path: string, opts?: RequestInit) => {
    const res = await fetch(`${basePath}/api${path}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Admin-Password": adminPassword, ...(opts?.headers ?? {}) },
      ...opts,
    });
    if (!res.ok && res.status !== 204) throw new Error(`${res.status}`);
    return res.status === 204 ? null : res.json();
  }, [adminPassword]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/admin/live-schedules");
      setSchedules(Array.isArray(data) ? data : []);
    } catch { /* silent */ }
    setLoading(false);
  }, [apiFetch]);

  useEffect(() => { load(); }, [load]);

  const toggleDay = (day: string) =>
    setForm((f) => ({
      ...f,
      daysOfWeek: f.daysOfWeek.includes(day)
        ? f.daysOfWeek.filter((d) => d !== day)
        : [...f.daysOfWeek, day],
    }));

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!form.startTime || !form.endTime) { setFormError("Start and end times are required"); return; }
    setSaving(true);
    try {
      const row = await apiFetch("/admin/live-schedules", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setSchedules((s) => [...s, row as LiveSchedule]);
      setForm({ camera: "camera1", startTime: "", endTime: "", daysOfWeek: [] });
      setAdding(false);
    } catch {
      setFormError("Failed to save schedule");
    }
    setSaving(false);
  };

  const toggleEnabled = async (s: LiveSchedule) => {
    try {
      const updated = await apiFetch(`/admin/live-schedules/${s.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      setSchedules((prev) => prev.map((x) => x.id === s.id ? updated as LiveSchedule : x));
    } catch { /* silent */ }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this schedule?")) return;
    try {
      await apiFetch(`/admin/live-schedules/${id}`, { method: "DELETE" });
      setSchedules((s) => s.filter((x) => x.id !== id));
    } catch { /* silent */ }
  };

  const dayLabel = (d: string) => SCHEDULE_DAYS.find((x) => x.key === d)?.label ?? d;
  const cameraLabel = (c: string) => c === "camera1" ? "Cam 1" : "Cam 2";

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-primary" />
          <h2 className="text-white font-bold text-base">Live Schedules</h2>
        </div>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity"
          >
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        )}
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-3 space-y-3">
        <p className="text-zinc-500 text-xs">
          Schedules fire in <span className="text-zinc-300 font-medium">Asia/Amman</span> time. Empty days = every day.
        </p>

        {/* Add form */}
        {adding && (
          <form onSubmit={handleAdd} className="space-y-3 pb-3 border-b border-zinc-800">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Camera</label>
                <select
                  value={form.camera}
                  onChange={(e) => setForm((f) => ({ ...f, camera: e.target.value as "camera1" | "camera2" }))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2 text-sm text-white outline-none focus:border-primary appearance-none"
                >
                  <option value="camera1">Camera 1</option>
                  <option value="camera2">Camera 2</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-1.5 col-span-1">
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">Start</label>
                  <input
                    type="time"
                    value={form.startTime}
                    onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2 text-sm text-white outline-none focus:border-primary"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">End</label>
                  <input
                    type="time"
                    value={form.endTime}
                    onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2 text-sm text-white outline-none focus:border-primary"
                  />
                </div>
              </div>
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1.5 block">Days (empty = every day)</label>
              <div className="flex gap-1">
                {SCHEDULE_DAYS.map(({ key, label }) => {
                  const active = form.daysOfWeek.includes(key);
                  return (
                    <button
                      key={key} type="button" onClick={() => toggleDay(key)}
                      className={cn(
                        "flex-1 py-1.5 rounded-lg text-[11px] font-semibold transition-colors",
                        active ? "bg-primary text-black" : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700 hover:text-white"
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            {formError && (
              <p className="text-red-400 text-xs flex items-center gap-1">
                <XCircle className="w-3.5 h-3.5" /> {formError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="submit" disabled={saving}
                className="flex-1 flex items-center justify-center gap-1.5 bg-primary text-black font-bold py-2.5 rounded-xl text-xs disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {saving ? "Saving…" : "Save Schedule"}
              </button>
              <button
                type="button" onClick={() => { setAdding(false); setFormError(null); }}
                className="px-4 py-2.5 bg-zinc-800 text-zinc-400 rounded-xl text-xs hover:bg-zinc-700"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* List */}
        {loading ? (
          <div className="text-zinc-600 text-xs text-center py-3">Loading…</div>
        ) : schedules.length === 0 && !adding ? (
          <p className="text-zinc-600 text-xs text-center py-3">No schedules yet. Add one to auto-start and stop streams.</p>
        ) : (
          <div className="space-y-2">
            {schedules.map((s) => (
              <div key={s.id} className={cn(
                "flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors",
                s.enabled ? "border-zinc-700 bg-zinc-800/60" : "border-zinc-800 bg-zinc-900/40 opacity-60"
              )}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-white">{cameraLabel(s.camera)}</span>
                    <span className="text-xs text-zinc-300 font-mono">
                      {s.startTime} → {s.endTime}
                    </span>
                    {s.daysOfWeek.length > 0 ? (
                      <span className="text-[10px] text-zinc-500">
                        {s.daysOfWeek.map(dayLabel).join(" · ")}
                      </span>
                    ) : (
                      <span className="text-[10px] text-zinc-600">Every day</span>
                    )}
                  </div>
                </div>
                {/* Enabled toggle */}
                <button
                  onClick={() => toggleEnabled(s)}
                  title={s.enabled ? "Disable" : "Enable"}
                  className={cn(
                    "w-8 h-5 rounded-full transition-colors flex-shrink-0 relative",
                    s.enabled ? "bg-primary" : "bg-zinc-700"
                  )}
                >
                  <span className={cn(
                    "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform",
                    s.enabled ? "translate-x-3" : "translate-x-0.5"
                  )} />
                </button>
                <button
                  onClick={() => handleDelete(s.id)}
                  className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-900/20 transition-colors flex-shrink-0"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Live Control Tab ─────────────────────────────────────────────────────────

const CAMERAS = ["camera1", "camera2"] as const;
type Camera = typeof CAMERAS[number];

const LIVE_PLAYBACK_BASE = "https://replayjo.b-cdn.net";

interface CameraStatus {
  live: boolean;
  startedAt?: string;
  viewers?: number;
  [k: string]: unknown;
}

interface RecordingJob {
  id: string;
  camera: string;
  title: string;
  startTime: string;
  duration: number;
  submittedAt: string;
  status: string;
  jobId?: string;
}

function HlsPlayer({ url, className }: { url: string; className?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return undefined;

    if (Hls.isSupported()) {
      const hls = new Hls({ liveSyncDurationCount: 3 });
      hls.loadSource(url);
      hls.attachMedia(el);
      el.muted = true;
      el.play().catch(() => { /* autoplay blocked */ });
      return () => hls.destroy();
    } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = url;
      el.muted = true;
      el.play().catch(() => { /* autoplay blocked */ });
    }
    return undefined;
  }, [url]);

  return (
    <video
      ref={videoRef}
      className={cn("w-full rounded-xl bg-black", className)}
      playsInline
      muted
      controls
    />
  );
}

function CameraCard({
  camera,
  adminPassword,
}: {
  camera: Camera;
  adminPassword: string;
}) {
  const [status, setStatus] = useState<CameraStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPlayer, setShowPlayer] = useState(false);

  const contaboFetch = useCallback(async (path: string, opts?: RequestInit) => {
    const res = await fetch(`${basePath}/api${path}`, {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Password": adminPassword,
        ...(opts?.headers ?? {}),
      },
      ...opts,
    });
    if (res.status === 401) throw new Error("bad_password");
    if (!res.ok) throw new Error(`${res.status}`);
    if (res.status === 204) return null;
    return res.json();
  }, [adminPassword]);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await contaboFetch(`/admin/contabo/status/${camera}`);
      setStatus(data as CameraStatus);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error";
      setError(msg === "bad_password" ? "Wrong password" : "Could not reach control server");
    } finally {
      setLoading(false);
    }
  }, [camera, contaboFetch]);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 8000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const handleStart = async () => {
    setWorking(true);
    try {
      await contaboFetch(`/admin/contabo/live/start/${camera}`, { method: "POST" });
      await fetchStatus();
    } catch {
      setError("Start failed");
    } finally {
      setWorking(false);
    }
  };

  const handleStop = async () => {
    if (!confirm(`Stop live stream for ${camera}?`)) return;
    setWorking(true);
    try {
      await contaboFetch(`/admin/contabo/live/stop/${camera}`, { method: "POST" });
      setShowPlayer(false);
      await fetchStatus();
    } catch {
      setError("Stop failed");
    } finally {
      setWorking(false);
    }
  };

  const playbackUrl = `${LIVE_PLAYBACK_BASE}/${camera}/index.m3u8`;
  const isLive = status?.live === true;
  const label = camera === "camera1" ? "Camera 1" : "Camera 2";

  return (
    <div className={cn(
      "rounded-2xl border overflow-hidden transition-colors",
      isLive ? "border-red-600/60 bg-zinc-900" : "border-zinc-800 bg-zinc-900/60",
    )}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800/60">
        <div className={cn(
          "w-2.5 h-2.5 rounded-full flex-shrink-0",
          loading ? "bg-zinc-600 animate-pulse" :
          isLive ? "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)] animate-pulse" :
          "bg-zinc-600"
        )} />
        <span className="text-white font-semibold text-sm">{label}</span>
        {isLive && (
          <span className="text-[10px] bg-red-600/20 text-red-400 border border-red-600/40 px-2 py-0.5 rounded-full font-medium tracking-wide ml-auto">
            LIVE
          </span>
        )}
        {!isLive && !loading && (
          <span className="text-[10px] text-zinc-500 ml-auto">Offline</span>
        )}
      </div>

      {/* Status info */}
      <div className="px-4 py-3 space-y-3">
        {error && (
          <div className="flex items-center gap-2 text-amber-400 text-xs bg-amber-900/20 border border-amber-700/40 rounded-xl px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            {error}
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-zinc-500 text-xs">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Checking status…
          </div>
        )}

        {!loading && isLive && status?.startedAt && (
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <Clock className="w-3 h-3" />
            Started {new Date(status.startedAt as string).toLocaleTimeString()}
          </div>
        )}

        {/* Playback link when live */}
        {isLive && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <a
                href={playbackUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors truncate"
              >
                <LinkIcon className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{playbackUrl}</span>
              </a>
            </div>
            <button
              onClick={() => setShowPlayer((p) => !p)}
              className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white transition-colors"
            >
              <Play className="w-3 h-3" />
              {showPlayer ? "Hide preview" : "Preview stream"}
            </button>
            {showPlayer && (
              <HlsPlayer url={playbackUrl} className="max-h-48" />
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 pt-1">
          <button
            onClick={handleStart}
            disabled={working || loading || isLive}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-semibold bg-red-600 text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Radio className="w-3.5 h-3.5" />
            Start Live
          </button>
          <button
            onClick={handleStop}
            disabled={working || loading || !isLive}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-semibold bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Square className="w-3.5 h-3.5" />
            Stop Live
          </button>
          <button
            onClick={fetchStatus}
            disabled={loading}
            className="px-3 py-2.5 rounded-xl bg-zinc-800 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700 transition-colors disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </div>
    </div>
  );
}

function RecordingRequestForm({
  adminPassword,
  onSubmitted,
}: {
  adminPassword: string;
  onSubmitted: () => void;
}) {
  const [camera, setCamera] = useState<Camera>("camera1");
  const [startTime, setStartTime] = useState("");
  const [duration, setDuration] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const contaboPost = async (path: string, body: unknown) => {
    const res = await fetch(`${basePath}/api${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Password": adminPassword,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401) throw new Error("Wrong password");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `Error ${res.status}`);
    return data;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const dur = parseFloat(duration);
    if (!startTime.trim()) { setError("Start time is required"); return; }
    if (isNaN(dur) || dur <= 0) { setError("Duration must be a positive number (seconds)"); return; }
    if (!title.trim()) { setError("Title is required"); return; }

    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await contaboPost(`/admin/contabo/record/${camera}`, {
        startTime: startTime.trim(),
        duration: dur,
        title: title.trim(),
      });
      setSuccess(true);
      setStartTime("");
      setDuration("");
      setTitle("");
      onSubmitted();
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-zinc-400 mb-1.5 block font-medium">Camera</label>
          <select
            value={camera}
            onChange={(e) => setCamera(e.target.value as Camera)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-primary appearance-none"
          >
            <option value="camera1">Camera 1</option>
            <option value="camera2">Camera 2</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-zinc-400 mb-1.5 block font-medium">Duration (seconds)</label>
          <input
            type="number"
            min="1"
            step="1"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            placeholder="e.g. 300"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-primary"
          />
        </div>
      </div>
      <div>
        <label className="text-xs text-zinc-400 mb-1.5 block font-medium">
          Start Time <span className="text-zinc-600 font-normal">(offset in live stream, e.g. "00:02:30" or seconds from start)</span>
        </label>
        <input
          type="text"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          placeholder="e.g. 00:02:30 or 150"
          className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-primary"
        />
      </div>
      <div>
        <label className="text-xs text-zinc-400 mb-1.5 block font-medium">Recording Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Galaxy Field – Morning Session"
          className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-primary"
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 text-red-400 text-xs bg-red-900/20 border border-red-700/40 rounded-xl px-3 py-2">
          <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {error}
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 text-green-400 text-xs bg-green-900/20 border border-green-700/40 rounded-xl px-3 py-2">
          <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
          Recording request submitted — check the list below for status
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full flex items-center justify-center gap-2 bg-primary text-black font-bold py-3 rounded-xl text-sm disabled:opacity-50 hover:opacity-90 transition-opacity"
      >
        {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Video className="w-4 h-4" />}
        {submitting ? "Submitting…" : "Request Recording"}
      </button>
    </form>
  );
}

function RecordingsList({
  adminPassword,
  refreshKey,
}: {
  adminPassword: string;
  refreshKey: number;
}) {
  const [jobs, setJobs] = useState<RecordingJob[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(`${basePath}/api/admin/contabo/recordings`, {
        credentials: "include",
        headers: { "X-Admin-Password": adminPassword },
      });
      if (res.ok) {
        const data = await res.json();
        setJobs(Array.isArray(data) ? data : []);
      }
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, [adminPassword]);

  useEffect(() => { fetchJobs(); }, [fetchJobs, refreshKey]);
  useEffect(() => {
    const id = setInterval(fetchJobs, 10000);
    return () => clearInterval(id);
  }, [fetchJobs]);

  const statusColor = (s: string) => {
    if (s === "done" || s === "completed") return "text-green-400 bg-green-900/20 border-green-700/40";
    if (s === "error" || s === "failed") return "text-red-400 bg-red-900/20 border-red-700/40";
    if (s === "processing") return "text-blue-400 bg-blue-900/20 border-blue-700/40";
    return "text-amber-400 bg-amber-900/20 border-amber-700/40"; // queued / submitted
  };

  const StatusIcon = ({ s }: { s: string }) => {
    if (s === "done" || s === "completed") return <CheckCircle2 className="w-3 h-3" />;
    if (s === "error" || s === "failed") return <XCircle className="w-3 h-3" />;
    if (s === "processing") return <Loader2 className="w-3 h-3 animate-spin" />;
    return <Clock className="w-3 h-3" />;
  };

  if (loading) return <div className="text-center py-8 text-zinc-500 text-sm">Loading…</div>;
  if (!jobs.length) return (
    <div className="text-center py-8 text-zinc-600 text-sm">No recording requests yet</div>
  );

  return (
    <div className="space-y-2">
      {jobs.map((job) => (
        <div key={job.id} className="flex items-start gap-3 p-3 rounded-xl border border-zinc-800 bg-zinc-900">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-white text-sm font-medium truncate">{job.title}</span>
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full border flex items-center gap-1 font-medium",
                statusColor(job.status)
              )}>
                <StatusIcon s={job.status} />
                {job.status}
              </span>
            </div>
            <p className="text-zinc-500 text-xs mt-0.5">
              {job.camera} · start: {job.startTime} · {job.duration}s
            </p>
            <p className="text-zinc-600 text-[10px] mt-0.5">
              {new Date(job.submittedAt).toLocaleString()}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function LiveTab() {
  // The live-control password is held in memory for the life of this component
  // only.
  //
  // It used to be written to sessionStorage in plaintext and echoed on every
  // request, so anything running in the page origin — Clerk, the Replit dev
  // banner, an ad creative, any XSS — could read it and start or stop a camera,
  // and it survived every navigation until someone remembered to click "Lock
  // console". The cost of this change is re-entering it after a page reload,
  // which is the right trade for a credential that controls a live broadcast.
  const [unlocked, setUnlocked] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [pwError, setPwError] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [configMissing, setConfigMissing] = useState<string[]>([]);
  const [recordRefresh, setRecordRefresh] = useState(0);

  // Verify password by calling /admin/contabo/config — if it returns 401, password is wrong
  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError(false);
    try {
      const res = await fetch(`${basePath}/api/admin/contabo/config`, {
        credentials: "include",
        headers: { "X-Admin-Password": passwordInput },
      });
      if (res.status === 401) { setPwError(true); return; }
      const data = await res.json() as { configured: boolean; missing?: string[] };
      if (data.missing && data.missing.length > 0) setConfigMissing(data.missing);
      setAdminPassword(passwordInput);
      setUnlocked(true);
      // Deliberately not persisted — see the note on the state above.
      // Clear any value left behind by an older build.
      try {
        sessionStorage.removeItem("contabo_unlocked");
        sessionStorage.removeItem("contabo_pw");
      } catch { /* no sessionStorage */ }
    } catch {
      setPwError(true);
    }
  };

  if (!unlocked) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-4">
        <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center mb-4">
          <Lock className="w-5 h-5 text-zinc-400" />
        </div>
        <h2 className="text-white font-bold text-lg mb-1">Live Control</h2>
        <p className="text-zinc-500 text-sm mb-6 text-center">Enter the admin password to access the live stream controls</p>
        <form onSubmit={handleUnlock} className="w-full max-w-xs space-y-3">
          <input
            type="password"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            placeholder="Admin password"
            autoFocus
            className={cn(
              "w-full bg-zinc-800 border rounded-xl px-4 py-3 text-sm text-white placeholder:text-zinc-500 outline-none transition-colors",
              pwError ? "border-red-600" : "border-zinc-700 focus:border-primary"
            )}
          />
          {pwError && (
            <p className="text-red-400 text-xs flex items-center gap-1.5">
              <XCircle className="w-3.5 h-3.5" /> Incorrect password
            </p>
          )}
          <button
            type="submit"
            className="w-full bg-primary text-black font-bold py-3 rounded-xl text-sm hover:opacity-90 transition-opacity"
          >
            Unlock
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Config warning */}
      {configMissing.length > 0 && (
        <div className="rounded-2xl border border-amber-600/40 bg-amber-900/10 px-4 py-4 space-y-2">
          <div className="flex items-center gap-2 text-amber-400 font-semibold text-sm">
            <AlertTriangle className="w-4 h-4" />
            Missing Replit Secrets
          </div>
          <p className="text-zinc-400 text-xs">
            Add these secrets in the Replit Secrets panel, then restart the API server:
          </p>
          <ul className="space-y-1">
            {configMissing.map((k) => (
              <li key={k} className="text-xs font-mono bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-amber-300">
                {k}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Live Control ───────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Radio className="w-4 h-4 text-red-500" />
          <h2 className="text-white font-bold text-base">Live Control</h2>
        </div>
        <div className="grid grid-cols-1 gap-3">
          {CAMERAS.map((cam) => (
            <CameraCard key={cam} camera={cam} adminPassword={adminPassword} />
          ))}
        </div>
      </section>

      {/* ── Live Schedules ────────────────────────────────── */}
      <LiveSchedulesSection adminPassword={adminPassword} />


      {/* Lock button */}
      <button
        onClick={() => {
          setUnlocked(false);
          setAdminPassword("");
          setPasswordInput("");
        }}
        className="flex items-center gap-2 text-zinc-600 text-xs hover:text-zinc-400 transition-colors mx-auto"
      >
        <Lock className="w-3 h-3" /> Lock console
      </button>
    </div>
  );
}

// ─── Main Admin Console ───────────────────────────────────────────────────────

const TABS: { id: Tab; label: string }[] = [
  { id: "clips", label: "Clips" },
  { id: "accounts", label: "Accounts" },
  { id: "fields", label: "Fields" },
  { id: "banners", label: "Banners" },
  { id: "academies", label: "Academies" },
  { id: "live", label: "Live Control" },
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
      <div className="flex border-b border-zinc-800/60 bg-zinc-950 flex-shrink-0 px-2 overflow-x-auto scrollbar-none" style={{ scrollbarWidth: "none" }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "px-4 py-3 text-sm font-semibold transition-colors relative whitespace-nowrap flex-shrink-0",
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
        {tab === "academies" && <AcademiesTab />}
        {tab === "live" && <LiveTab />}
      </div>
    </div>
  );
}
