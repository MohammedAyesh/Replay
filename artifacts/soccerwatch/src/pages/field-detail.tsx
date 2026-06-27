import { useState } from "react";
import { Link, useRoute } from "wouter";
import { useGetField, useGetFieldRecordings, getGetFieldQueryKey, getGetFieldRecordingsQueryKey } from "@workspace/api-client-react";
import { ChevronLeft, Play, Calendar, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

const FILTERS = ["Today", "Yesterday", "This Week", "All"];

export default function FieldDetail() {
  const [, params] = useRoute("/fields/:id");
  const fieldId = parseInt(params?.id || "0", 10);

  const { data: field, isLoading: isFieldLoading } = useGetField(fieldId, { query: { enabled: !!fieldId, queryKey: getGetFieldQueryKey(fieldId) } });
  const { data: recordings, isLoading: isRecLoading } = useGetFieldRecordings(fieldId, { query: { enabled: !!fieldId, queryKey: getGetFieldRecordingsQueryKey(fieldId) } });

  const [activeFilter, setActiveFilter] = useState("All");

  if (isFieldLoading || isRecLoading) {
    return <div className="p-6 text-center text-muted-foreground">Loading field data...</div>;
  }

  if (!field) {
    return <div className="p-6 text-center text-muted-foreground">Field not found</div>;
  }

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      <header className="pt-safe px-4 py-4 bg-white border-b sticky top-0 z-10 flex items-center gap-3 shadow-sm">
        <Link href="/fields" className="w-10 h-10 flex items-center justify-center -ml-2 rounded-full hover:bg-muted text-foreground">
          <ChevronLeft className="w-6 h-6" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{field.name}</h1>
          <p className="text-xs text-muted-foreground truncate">{field.location}</p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto pb-24">
        {/* Filter Scroll */}
        <div className="px-4 py-4 flex gap-2 overflow-x-auto no-scrollbar border-b bg-white sticky top-0 z-10">
          {FILTERS.map(f => (
            <button
              key={f}
              onClick={() => setActiveFilter(f)}
              className={`whitespace-nowrap px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                activeFilter === f 
                  ? "bg-foreground text-background" 
                  : "bg-muted text-muted-foreground hover:bg-border"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="p-4 space-y-3">
          {recordings?.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No recordings available for this field.
            </div>
          ) : (
            recordings?.map(rec => (
              <div key={rec.id} className="bg-card border border-border rounded-xl p-4 shadow-sm flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-primary bg-primary/10 px-2 py-0.5 rounded uppercase">
                      {rec.court}
                    </span>
                    {rec.score && (
                      <span className="text-sm font-bold bg-muted px-2 py-0.5 rounded">
                        {rec.score}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5" />
                      {rec.date}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5" />
                      {rec.timeSlot}
                    </div>
                  </div>
                </div>
                <Link href={`/player/${rec.id}`}>
                  <Button size="icon" className="w-12 h-12 rounded-full shrink-0 shadow-md bg-primary hover:bg-primary/90 text-white">
                    <Play className="w-5 h-5 ml-0.5" />
                  </Button>
                </Link>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
