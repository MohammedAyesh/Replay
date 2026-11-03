import { useMemo, useState } from "react";
import { CalendarPlus, MessageCircle, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useVenueCopy } from "@/i18n/venue-strings";
import { cn } from "@/lib/utils";
import { dayName, jod, useCustomers, type Customer } from "@/lib/venue-api";
import { Card, ErrorText, SectionHeader, Skeleton } from "./shared";

const SEGMENTS = ["all", "regular", "new", "returning", "lapsed", "lead"] as const;

export function CustomersSection({ venueId, onOpenChat, onBook }: { venueId: number; onOpenChat: (phone: string) => void; onBook: (c: Customer) => void }) {
  const copy = useVenueCopy();
  const q = useCustomers(venueId);
  const [segment, setSegment] = useState<(typeof SEGMENTS)[number]>("all");
  const [query, setQuery] = useState("");
  const all = q.data?.customers ?? [];
  const list = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter((c) => (segment === "all" || c.segment === segment) && (!needle || [c.name, c.display, c.phone, ...c.tags].join(" ").toLowerCase().includes(needle)));
  }, [all, segment, query]);

  return (
    <section className="space-y-5" data-testid="field-customers">
      <SectionHeader title={copy.customers.title} description={copy.customers.description} />
      <div className="flex flex-wrap gap-1.5">
        {SEGMENTS.map((s) => (
          <button key={s} type="button" onClick={() => setSegment(s)} className={cn("min-h-9 rounded-full px-3.5 text-sm font-semibold", segment === s ? "bg-turf/15 text-turf" : "bg-raised text-muted-text hover:text-text")}>
            {copy.customers.segments[s]} <span className="tabular-nums opacity-70">{s === "all" ? all.length : all.filter((c) => c.segment === s).length}</span>
          </button>
        ))}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-text" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={copy.customers.search} className="min-h-10 ps-9" />
      </div>
      {q.isLoading ? <Skeleton rows={4} /> : q.isError ? <ErrorText error={q.error} /> : list.length === 0 ? (
        <Card><p className="text-sm text-muted-text">{copy.customers.empty}</p></Card>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-line text-xs text-muted-text">
              <tr>
                <th className="p-3 text-start font-semibold">{copy.bookings.name}</th>
                <th className="p-3 text-start font-semibold">{copy.customers.bookings}</th>
                <th className="p-3 text-start font-semibold">{copy.customers.last}</th>
                <th className="p-3 text-start font-semibold">{copy.customers.next}</th>
                <th className="p-3 text-start font-semibold">{copy.customers.spent}</th>
                <th className="p-3 text-start font-semibold">{copy.customers.noShows}</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((c) => (
                <tr key={c.phone} className="hover:bg-raised/40">
                  <td className="p-3">
                    <p className="font-semibold text-text" dir="auto">{c.name || c.display}</p>
                    <p className="text-xs text-muted-text" dir="ltr">{c.name ? c.display : ""} <span className="ms-1 rounded-full bg-raised px-1.5 text-[10px]">{copy.customers.segments[c.segment]}</span></p>
                  </td>
                  <td className="p-3 tabular-nums">{c.bookings}</td>
                  <td className="p-3 text-muted-text">{c.lastStartLocal ? dayName(c.lastStartLocal.slice(0, 10), copy.locale) : copy.customers.never}</td>
                  <td className="p-3 text-muted-text">{c.nextStartLocal ? dayName(c.nextStartLocal.slice(0, 10), copy.locale) : copy.customers.never}</td>
                  <td className="p-3 tabular-nums">{jod(c.spentFils, copy.locale)}</td>
                  <td className={cn("p-3 tabular-nums", c.noShows > 0 && "text-[#FF8A73]")}>{c.noShows}</td>
                  <td className="p-3">
                    <div className="flex justify-end gap-1.5">
                      <Button type="button" size="sm" variant="outline" onClick={() => onOpenChat(c.phone)}><MessageCircle className="me-1 h-3.5 w-3.5" />{copy.customers.chat}</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => onBook(c)}><CalendarPlus className="me-1 h-3.5 w-3.5" />{copy.customers.book}</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
