import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "@/lib/academy-studio-api";

/**
 * Stars in the Creative hub (routes/academyFavorites.ts): each console user's
 * own starred templates, clips and drafts, which come first in their lists.
 */
export type FavoriteKind = "template" | "clip" | "project";
export type Favorites = Record<FavoriteKind, string[]>;
const EMPTY: Favorites = { template: [], clip: [], project: [] };

const key = (academyId: number) => ["academy", academyId, "favorites"] as const;
const path = (academyId: number) => `/academy/console/academies/${academyId}/favorites`;

export function useFavorites(academyId: number) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: key(academyId), staleTime: 60_000, queryFn: () => call<Favorites>(path(academyId)) });
  const toggle = useMutation({
    mutationFn: (v: { kind: FavoriteKind; key: string; on: boolean }) => call<Favorites>(path(academyId), { method: "PUT", body: JSON.stringify(v) }),
    // Stars move at once; the server's answer settles it, a failure puts it back.
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key(academyId) });
      const before = qc.getQueryData<Favorites>(key(academyId));
      qc.setQueryData<Favorites>(key(academyId), toggled(before ?? EMPTY, v.kind, v.key, v.on));
      return { before };
    },
    onError: (_e, _v, ctx) => { if (ctx?.before) qc.setQueryData(key(academyId), ctx.before); },
    onSuccess: (data) => qc.setQueryData(key(academyId), data),
  });
  const data = q.data ?? EMPTY;
  return {
    data,
    isStarred: (kind: FavoriteKind, k: string | number) => data[kind].includes(String(k)),
    toggle: (kind: FavoriteKind, k: string | number) => toggle.mutate({ kind, key: String(k), on: !data[kind].includes(String(k)) }),
  };
}

export function toggled(f: Favorites, kind: FavoriteKind, k: string, on: boolean): Favorites {
  const rest = f[kind].filter((x) => x !== k);
  return { ...f, [kind]: on ? [k, ...rest] : rest };
}

/** Starred items first, in star order (newest star first); the rest keep their order. */
export function starredFirst<T>(items: readonly T[], keyOf: (t: T) => string | number, starred: readonly string[]): T[] {
  if (!starred.length) return [...items];
  const rank = new Map(starred.map((k, i) => [k, i]));
  const on: T[] = [], off: T[] = [];
  for (const it of items) (rank.has(String(keyOf(it))) ? on : off).push(it);
  on.sort((a, b) => rank.get(String(keyOf(a)))! - rank.get(String(keyOf(b)))!);
  return [...on, ...off];
}
