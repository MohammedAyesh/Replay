import { useState, useMemo } from "react";
import { Link, useRoute } from "wouter";
import { useGetField, useGetFieldRecordings, Recording } from "@workspace/api-client-react";
import { ChevronLeft, ChevronRight, Clock, Play } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "@/i18n";

function groupByDate(recordings: Recording[]): Map<string, Recording[]> {
  const map = new Map<string, Recording[]>();
  for (const rec of recordings) {
    const existing = map.get(rec.date) ?? [];
    existing.push(rec);
    map.set(rec.date, existing);
  }
  return map;
}

function formatDateLabel(iso: string): string {
  const [year, month, day] = iso.split("-");
  const d = new Date(Number(year), Number(month) - 1, Number(day));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function FieldDetail() {
  const [, params] = useRoute("/fields/:id");
  const fieldId = parseInt(params?.id ?? "0", 10);
  const { toast } = useToast();
  const { t, locale } = useTranslation();

  const { data: field, isLoading: fieldLoading } = useGetField(fieldId);
  const { data: recordings, isLoading: recLoading } = useGetFieldRecordings(fieldId);

  const isLoading = fieldLoading || recLoading;

  const sortedDates = useMemo(() => {
    if (!recordings) return [];
    const dates = Array.from(new Set(recordings.map((r) => r.date)));
    return dates.sort((a, b) => b.localeCompare(a));
  }, [recordings]);

  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const currentDate = selectedDate ?? sortedDates[0] ?? null;

  const byDate = useMemo(() => groupByDate(recordings ?? []), [recordings]);
  const forDate = byDate.get(currentDate ?? "") ?? [];

  const courtsLabel = (n: number) =>
    n === 1 ? `1 ${t.fieldDetail.court}` : `${n} ${t.fieldDetail.courts}`;

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      <motion.header
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" as const } }}
        className="pt-safe px-4 py-4 bg-white border-b sticky top-0 z-10 flex items-center gap-3 shadow-sm"
      >
        <Link
          href="/fields"
          className="w-10 h-10 flex items-center justify-center -ms-2 rounded-full hover:bg-muted text-foreground"
        >
          <ChevronLeft className="w-6 h-6 rtl:hidden" />
          <ChevronRight className="w-6 h-6 ltr:hidden" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{isLoading ? t.fieldDetail.loading : (field?.name ?? "Field")}</h1>
          <p className="text-xs text-muted-foreground">
            {isLoading ? "…" : t.fieldDetail.recordings(recordings?.length ?? 0)}
          </p>
        </div>
      </motion.header>

      <motion.div
        initial={{ opacity: 0, scale: 1.04 }}
        animate={{ opacity: 1, scale: 1, transition: { duration: 0.5, ease: "easeOut" as const } }}
        className="relative h-36 overflow-hidden shrink-0"
      >
        <div className="absolute inset-0 field-pattern" />
        <div className="absolute inset-0 bg-gradient-to-t from-background/80 to-transparent" />
        {field && (
          <div className="absolute bottom-3 start-4 text-foreground">
            <p className="text-sm font-medium opacity-70">{field.location}</p>
            <p className="text-xs opacity-50">{courtsLabel(field.courts)}</p>
          </div>
        )}
      </motion.div>

      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading ? (
          <div className="animate-pulse p-4 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 bg-muted rounded-xl" />
            ))}
          </div>
        ) : sortedDates.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0, transition: { delay: 0.1 } }}
            className="flex flex-col items-center justify-center py-20 px-6 text-center"
          >
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Play className="w-6 h-6 text-primary" />
            </div>
            <h3 className="font-semibold text-foreground mb-1">{t.fieldDetail.noRecordingsTitle}</h3>
            <p className="text-sm text-muted-foreground">{t.fieldDetail.noRecordingsDesc}</p>
          </motion.div>
        ) : (
          <>
            <div className="px-4 py-3 flex gap-2 overflow-x-auto no-scrollbar border-b bg-white sticky top-0 z-10">
              {sortedDates.map((d, i) => (
                <motion.button
                  key={d}
                  initial={{ opacity: 0, x: locale === "ar" ? 12 : -12 }}
                  animate={{ opacity: 1, x: 0, transition: { delay: i * 0.06, duration: 0.3, ease: "easeOut" as const } }}
                  whileTap={{ scale: 0.93 }}
                  onClick={() => setSelectedDate(d)}
                  className={`whitespace-nowrap px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                    d === currentDate
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground hover:bg-border"
                  }`}
                >
                  {formatDateLabel(d)}
                </motion.button>
              ))}
            </div>

            <div className="p-4">
              {currentDate && (
                <motion.p
                  key={currentDate}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-3"
                >
                  {formatDateLabel(currentDate)}
                </motion.p>
              )}

              <AnimatePresence mode="wait">
                <motion.div
                  key={currentDate}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { duration: 0.2 } }}
                  exit={{ opacity: 0 }}
                  className="grid grid-cols-3 gap-3"
                >
                  {forDate.map((rec, i) => (
                    <motion.button
                      key={rec.id}
                      initial={{ opacity: 0, scale: 0.88, y: 12 }}
                      animate={{
                        opacity: 1, scale: 1, y: 0,
                        transition: { delay: i * 0.06, duration: 0.35, ease: "easeOut" as const },
                      }}
                      whileTap={{ scale: 0.92 }}
                      onClick={() =>
                        toast({
                          title: t.fieldDetail.videoComingSoon,
                          description: `${rec.court} · ${rec.timeSlot}`,
                          className: "bg-primary text-white border-none",
                        })
                      }
                      className="flex flex-col items-center gap-1.5 bg-card border border-border rounded-2xl py-4 px-2 shadow-sm hover:border-primary hover:shadow-md active:scale-95 transition-colors group"
                    >
                      <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center group-hover:bg-primary group-active:bg-primary transition-colors">
                        <Clock className="w-4 h-4 text-primary group-hover:text-white group-active:text-white" />
                      </div>
                      <span className="text-sm font-bold text-foreground font-mono">
                        {rec.timeSlot}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{rec.court}</span>
                    </motion.button>
                  ))}
                </motion.div>
              </AnimatePresence>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
