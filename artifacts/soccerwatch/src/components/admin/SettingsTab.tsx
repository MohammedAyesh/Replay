import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The settings tab.
 *
 * Its organising idea is the preview at the top. Precedence here is
 * priority-first, which means no single rule tells you what a given person
 * actually gets — a broad promotion can outrank a per-user override by design.
 * So the page is built around the question an admin actually has ("what does
 * this user, at this field, get right now?") rather than around the table, and
 * every value shown is the answer for the context in the bar, not an abstraction.
 */

type ScopeType = "global" | "field" | "academy" | "user";

interface SettingDefinition {
  key: string;
  group: string;
  label: string;
  description: string;
  type: "number" | "boolean" | "string" | "enum";
  defaultValue: number | boolean | string;
  min?: number;
  max?: number;
  integer?: boolean;
  options?: string[];
  unit?: string;
  appliesToNewWorkOnly?: boolean;
}

interface Rule {
  id: number;
  key: string;
  value: number | boolean | string;
  priority: number;
  scopeType: ScopeType;
  scopeId: number | null;
  excludes: { scopeType: Exclude<ScopeType, "global">; scopeId: number }[];
  enabled: boolean;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  daysOfWeek: number[] | null;
  startMinute: number | null;
  endMinute: number | null;
  timezone: string;
  note: string | null;
}

interface Resolution {
  value: number | boolean | string;
  rule: Rule | null;
  matched: Rule[];
}

interface PreviewEntry {
  definition: SettingDefinition;
  resolution: Resolution;
  isDefault: boolean;
}

interface PreviewContext {
  userId: string;
  academyId: string;
  fieldId: string;
  at: string;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`${basePath}/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body;
}

function minutesToTime(m: number | null): string {
  if (m == null) return "";
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function timeToMinutes(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins <= 1439 ? mins : null;
}

function formatValue(def: SettingDefinition, value: number | boolean | string): string {
  if (def.type === "boolean") return value ? "On" : "Off";
  return def.unit ? `${value} ${def.unit}` : String(value);
}

/** One line describing when and to whom a rule applies. */
function describeRule(rule: Rule): string {
  const parts: string[] = [];
  parts.push(rule.scopeType === "global" ? "Everyone" : `${rule.scopeType} #${rule.scopeId}`);
  if (rule.excludes.length) {
    parts.push(`except ${rule.excludes.map((e) => `${e.scopeType} #${e.scopeId}`).join(", ")}`);
  }
  if (rule.daysOfWeek?.length) parts.push(rule.daysOfWeek.map((d) => DAY_NAMES[d]).join("/"));
  if (rule.startMinute != null && rule.endMinute != null) {
    parts.push(`${minutesToTime(rule.startMinute)}–${minutesToTime(rule.endMinute)} ${rule.timezone}`);
  }
  if (rule.effectiveFrom || rule.effectiveUntil) {
    const from = rule.effectiveFrom ? new Date(rule.effectiveFrom).toLocaleDateString("en-GB") : "…";
    const until = rule.effectiveUntil ? new Date(rule.effectiveUntil).toLocaleDateString("en-GB") : "…";
    parts.push(`${from} → ${until}`);
  }
  return parts.join(" · ");
}

const emptyDraft = (key: string) => ({
  key,
  value: "" as string,
  scopeType: "global" as ScopeType,
  scopeId: "",
  priority: "0",
  excludes: "",
  daysOfWeek: [] as number[],
  startMinute: "",
  endMinute: "",
  effectiveFrom: "",
  effectiveUntil: "",
  timezone: "Asia/Amman",
  note: "",
});

export default function SettingsTab() {
  const [context, setContext] = useState<PreviewContext>({ userId: "", academyId: "", fieldId: "", at: "" });
  const [entries, setEntries] = useState<PreviewEntry[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReturnType<typeof emptyDraft> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [schemaNotice, setSchemaNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams();
    if (context.userId) params.set("userId", context.userId);
    if (context.academyId) params.set("academyId", context.academyId);
    if (context.fieldId) params.set("fieldId", context.fieldId);
    if (context.at) params.set("at", new Date(context.at).toISOString());
    try {
      const [preview, ruleList] = await Promise.all([
        api(`/admin/settings/preview?${params.toString()}`),
        api("/admin/settings/rules"),
      ]);
      setEntries(preview.settings);
      setRules(ruleList.rules);
      // Distinguish "not configured yet" from "broken". The first has a remedy
      // and the admin can act on it; a bare failure gives them nothing.
      setSchemaNotice(
        ruleList.schemaReady === false || preview.schemaReady === false
          ? (ruleList.message ?? preview.message ?? null)
          : null,
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }, [context]);

  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => {
    const map = new Map<string, PreviewEntry[]>();
    for (const entry of entries) {
      const list = map.get(entry.definition.group) ?? [];
      list.push(entry);
      map.set(entry.definition.group, list);
    }
    return [...map.entries()];
  }, [entries]);

  const rulesFor = useCallback((key: string) => rules.filter((r) => r.key === key), [rules]);

  const submit = async () => {
    if (!draft) return;
    const def = entries.find((e) => e.definition.key === draft.key)?.definition;
    if (!def) return;
    setBusy(true);
    setError(null);
    try {
      let value: number | boolean | string;
      if (def.type === "boolean") value = draft.value === "true";
      else if (def.type === "number") value = Number(draft.value);
      else value = draft.value;

      const excludes = draft.excludes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((token) => {
          const [scopeType, id] = token.split(/[:#\s]+/);
          return { scopeType: scopeType as "field" | "academy" | "user", scopeId: Number(id) };
        });

      await api("/admin/settings/rules", {
        method: "POST",
        body: JSON.stringify({
          key: draft.key,
          value,
          scopeType: draft.scopeType,
          scopeId: draft.scopeType === "global" ? null : Number(draft.scopeId),
          priority: Number(draft.priority) || 0,
          excludes,
          daysOfWeek: draft.daysOfWeek.length ? draft.daysOfWeek : null,
          startMinute: timeToMinutes(draft.startMinute),
          endMinute: timeToMinutes(draft.endMinute),
          effectiveFrom: draft.effectiveFrom ? new Date(draft.effectiveFrom).toISOString() : null,
          effectiveUntil: draft.effectiveUntil ? new Date(draft.effectiveUntil).toISOString() : null,
          timezone: draft.timezone,
          note: draft.note || null,
        }),
      });
      setDraft(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleRule = async (rule: Rule) => {
    setBusy(true);
    try {
      await api(`/admin/settings/rules/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  const removeRule = async (rule: Rule) => {
    setBusy(true);
    try {
      await api(`/admin/settings/rules/${rule.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  const input = "bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-100 w-full";
  const labelCls = "text-[11px] uppercase tracking-wider text-zinc-500 font-semibold";

  return (
    <div className="space-y-5">
      {/* The preview context. Everything below is resolved for exactly this. */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
        <p className="text-zinc-300 text-sm font-semibold mb-1">Resolve for</p>
        <p className="text-zinc-500 text-xs mb-3">
          Every value below is what this person actually gets. Leave a field blank to
          ignore that scope.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div><span className={labelCls}>User id</span>
            <input className={input} value={context.userId}
              onChange={(e) => setContext({ ...context, userId: e.target.value })} placeholder="any" /></div>
          <div><span className={labelCls}>Academy id</span>
            <input className={input} value={context.academyId}
              onChange={(e) => setContext({ ...context, academyId: e.target.value })} placeholder="any" /></div>
          <div><span className={labelCls}>Field id</span>
            <input className={input} value={context.fieldId}
              onChange={(e) => setContext({ ...context, fieldId: e.target.value })} placeholder="any" /></div>
          <div><span className={labelCls}>At</span>
            <input type="datetime-local" className={input} value={context.at}
              onChange={(e) => setContext({ ...context, at: e.target.value })} /></div>
        </div>
      </div>

      {schemaNotice && (
        <div className="rounded border border-amber-800/60 bg-amber-950/30 px-3 py-2.5">
          <p className="text-amber-300 text-sm font-semibold">Settings storage is not set up yet</p>
          <p className="text-amber-200/70 text-xs mt-1">{schemaNotice}</p>
          <p className="text-amber-200/50 text-xs mt-1.5">
            Everything below still shows the value each setting ships with, and those
            are what the product is using. Rules cannot be saved until the tables exist.
          </p>
        </div>
      )}

      {error && (
        <div className="rounded border border-red-900/60 bg-red-950/40 text-red-300 text-sm px-3 py-2">{error}</div>
      )}

      {groups.map(([group, groupEntries]) => (
        <div key={group}>
          <h3 className="text-zinc-400 text-xs uppercase tracking-widest font-bold mb-2">{group}</h3>
          <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800/70 overflow-hidden">
            {groupEntries.map(({ definition, resolution, isDefault }) => {
              const keyRules = rulesFor(definition.key);
              const open = expanded === definition.key;
              return (
                <div key={definition.key} className="bg-zinc-950/40">
                  <button
                    onClick={() => setExpanded(open ? null : definition.key)}
                    className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-zinc-900/50"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-zinc-100 text-sm font-medium">{definition.label}</p>
                      <p className="text-zinc-500 text-xs truncate">{definition.key}</p>
                    </div>
                    <span className={cn(
                      "text-sm font-semibold tabular-nums",
                      isDefault ? "text-zinc-400" : "text-primary",
                    )}>
                      {formatValue(definition, resolution.value)}
                    </span>
                    <span className={cn(
                      "text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded",
                      isDefault ? "bg-zinc-800 text-zinc-400" : "bg-primary/15 text-primary",
                    )}>
                      {isDefault ? "Default" : `Rule #${resolution.rule?.id}`}
                    </span>
                  </button>

                  {open && (
                    <div className="px-3 pb-3 space-y-3">
                      <p className="text-zinc-400 text-xs leading-relaxed">{definition.description}</p>
                      {definition.appliesToNewWorkOnly && (
                        <p className="text-amber-400/80 text-xs">
                          Applies to work started after the change — anything already
                          rendering keeps the value it began with.
                        </p>
                      )}

                      {/* Why this value won. With priority-first precedence this
                          is the only way to understand a result. */}
                      {resolution.matched.length > 0 && (
                        <div className="rounded border border-zinc-800 bg-black/30 p-2">
                          <p className={labelCls}>Rules matching this context, winner first</p>
                          <ul className="mt-1 space-y-1">
                            {resolution.matched.map((m, i) => (
                              <li key={m.id} className="text-xs flex items-start gap-2">
                                <span className={i === 0 ? "text-primary font-semibold" : "text-zinc-600"}>
                                  {i === 0 ? "WINS" : "beaten"}
                                </span>
                                <span className="text-zinc-300">
                                  {formatValue(definition, m.value)}
                                  <span className="text-zinc-500"> · priority {m.priority} · {describeRule(m)}</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div>
                        <p className={labelCls}>All rules for this setting</p>
                        {keyRules.length === 0 && (
                          <p className="text-zinc-600 text-xs mt-1">
                            None. The shipped default of {formatValue(definition, definition.defaultValue)} applies to everyone.
                          </p>
                        )}
                        <ul className="mt-1 space-y-1">
                          {keyRules.map((r) => (
                            <li key={r.id} className="flex items-center gap-2 text-xs">
                              <span className={cn("tabular-nums", r.enabled ? "text-zinc-200" : "text-zinc-600 line-through")}>
                                {formatValue(definition, r.value)}
                              </span>
                              <span className="text-zinc-500 flex-1 truncate">
                                p{r.priority} · {describeRule(r)}{r.note ? ` · ${r.note}` : ""}
                              </span>
                              <button onClick={() => void toggleRule(r)} disabled={busy}
                                className="text-zinc-400 hover:text-zinc-200 px-1">
                                {r.enabled ? "Disable" : "Enable"}
                              </button>
                              <button onClick={() => void removeRule(r)} disabled={busy}
                                className="text-red-400/80 hover:text-red-300 px-1">Delete</button>
                            </li>
                          ))}
                        </ul>
                      </div>

                      {draft?.key === definition.key ? (
                        <div className="rounded border border-zinc-800 bg-black/30 p-3 space-y-2">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                            <div>
                              <span className={labelCls}>Value</span>
                              {definition.type === "boolean" ? (
                                <select className={input} value={draft.value}
                                  onChange={(e) => setDraft({ ...draft, value: e.target.value })}>
                                  <option value="">Choose…</option>
                                  <option value="true">On</option>
                                  <option value="false">Off</option>
                                </select>
                              ) : definition.type === "enum" ? (
                                <select className={input} value={draft.value}
                                  onChange={(e) => setDraft({ ...draft, value: e.target.value })}>
                                  <option value="">Choose…</option>
                                  {definition.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                                </select>
                              ) : (
                                <input className={input} value={draft.value} inputMode="decimal"
                                  placeholder={String(definition.defaultValue)}
                                  onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
                              )}
                            </div>
                            <div>
                              <span className={labelCls}>Applies to</span>
                              <select className={input} value={draft.scopeType}
                                onChange={(e) => setDraft({ ...draft, scopeType: e.target.value as ScopeType })}>
                                <option value="global">Everyone</option>
                                <option value="field">One field</option>
                                <option value="academy">One academy</option>
                                <option value="user">One user</option>
                              </select>
                            </div>
                            <div>
                              <span className={labelCls}>Scope id</span>
                              <input className={input} value={draft.scopeId} disabled={draft.scopeType === "global"}
                                onChange={(e) => setDraft({ ...draft, scopeId: e.target.value })} />
                            </div>
                            <div>
                              <span className={labelCls}>Priority</span>
                              <input className={input} value={draft.priority}
                                onChange={(e) => setDraft({ ...draft, priority: e.target.value })} />
                            </div>
                          </div>

                          <div>
                            <span className={labelCls}>Except (e.g. “academy:3, user:12”)</span>
                            <input className={input} value={draft.excludes} placeholder="nobody"
                              onChange={(e) => setDraft({ ...draft, excludes: e.target.value })} />
                          </div>

                          <div>
                            <span className={labelCls}>Days</span>
                            <div className="flex gap-1 mt-1">
                              {DAY_NAMES.map((d, i) => (
                                <button key={d} type="button"
                                  onClick={() => setDraft({
                                    ...draft,
                                    daysOfWeek: draft.daysOfWeek.includes(i)
                                      ? draft.daysOfWeek.filter((x) => x !== i)
                                      : [...draft.daysOfWeek, i],
                                  })}
                                  className={cn("px-2 py-1 rounded text-xs",
                                    draft.daysOfWeek.includes(i) ? "bg-primary text-black font-semibold" : "bg-zinc-900 text-zinc-400")}>
                                  {d}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                            <div><span className={labelCls}>From (time)</span>
                              <input className={input} placeholder="20:00" value={draft.startMinute}
                                onChange={(e) => setDraft({ ...draft, startMinute: e.target.value })} /></div>
                            <div><span className={labelCls}>To (time)</span>
                              <input className={input} placeholder="01:00" value={draft.endMinute}
                                onChange={(e) => setDraft({ ...draft, endMinute: e.target.value })} /></div>
                            <div><span className={labelCls}>Time zone</span>
                              <input className={input} value={draft.timezone}
                                onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} /></div>
                            <div><span className={labelCls}>Starts</span>
                              <input type="date" className={input} value={draft.effectiveFrom}
                                onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })} /></div>
                            <div><span className={labelCls}>Ends</span>
                              <input type="date" className={input} value={draft.effectiveUntil}
                                onChange={(e) => setDraft({ ...draft, effectiveUntil: e.target.value })} /></div>
                          </div>
                          <p className="text-zinc-600 text-[11px]">
                            A time window may cross midnight — 20:00 to 01:00 is one evening,
                            and a day selected here means the day it starts.
                          </p>

                          <div><span className={labelCls}>Note</span>
                            <input className={input} value={draft.note} placeholder="Why this rule exists"
                              onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></div>

                          <div className="flex gap-2 pt-1">
                            <button onClick={() => void submit()} disabled={busy}
                              className="px-3 py-1.5 rounded bg-primary text-black text-sm font-semibold disabled:opacity-50">
                              {busy ? "Saving…" : "Add rule"}
                            </button>
                            <button onClick={() => setDraft(null)}
                              className="px-3 py-1.5 rounded bg-zinc-800 text-zinc-300 text-sm">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <button onClick={() => setDraft(emptyDraft(definition.key))}
                          className="text-primary text-xs font-semibold">+ Add a rule</button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
