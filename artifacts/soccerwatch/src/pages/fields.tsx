import { useState } from "react";
import { Link } from "wouter";
import { useListFields } from "@workspace/api-client-react";
import { Search, MapPin, Video } from "lucide-react";
import { Input } from "@/components/ui/input";

export default function Fields() {
  const { data: fields, isLoading } = useListFields();
  const [search, setSearch] = useState("");

  const filteredFields = fields?.filter(f => 
    f.name.toLowerCase().includes(search.toLowerCase()) || 
    f.location.toLowerCase().includes(search.toLowerCase())
  ) || [];

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      <div className="pt-safe px-4 py-6 bg-white border-b sticky top-0 z-10 shadow-sm">
        <h1 className="text-2xl font-bold text-foreground">Fields</h1>
        <p className="text-muted-foreground text-sm mb-4">Browse footage and grab your clip</p>
        
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search fields near you"
            className="pl-9 bg-muted border-transparent focus-visible:ring-primary rounded-xl h-12"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 pb-24">
        {isLoading ? (
          <div className="animate-pulse space-y-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-[240px] bg-muted rounded-2xl" />
            ))}
          </div>
        ) : filteredFields.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            No fields found matching "{search}"
          </div>
        ) : (
          filteredFields.map(field => (
            <Link key={field.id} href={`/fields/${field.id}`}>
              <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow cursor-pointer group">
                <div className="h-32 field-pattern relative flex items-center justify-center">
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                  <div className="absolute top-3 right-3 bg-primary text-white text-xs font-bold px-2 py-1 rounded-full flex items-center gap-1 shadow-md">
                    <Video className="w-3 h-3" />
                    {field.clipCount} clips
                  </div>
                  <div className="absolute bottom-3 left-3 text-white">
                    <h3 className="font-bold text-lg leading-tight shadow-black drop-shadow-md">{field.name}</h3>
                  </div>
                </div>
                <div className="p-4">
                  <div className="flex items-start gap-2 mb-3">
                    <MapPin className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                    <span className="text-sm text-muted-foreground line-clamp-2">{field.location}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium bg-secondary text-secondary-foreground px-2 py-1 rounded-md">
                      {field.courts} Courts
                    </span>
                    {field.lastRecordedAt && (
                      <span className="text-xs font-medium bg-green-100 text-green-800 px-2 py-1 rounded-md">
                        Recorded {new Date(field.lastRecordedAt).toLocaleDateString(undefined, { weekday: 'short' })}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
