import { useState } from "react";
import { Link } from "wouter";
import { useListFields, Field } from "@workspace/api-client-react";
import { Search, Camera, Video } from "lucide-react";
import { Input } from "@/components/ui/input";
import { motion } from "framer-motion";

const cardVariants = {
  hidden: { opacity: 0, y: 32 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, delay: i * 0.1, ease: "easeOut" as const },
  }),
};

export default function Fields() {
  const { data: fields, isLoading } = useListFields();
  const [search, setSearch] = useState("");

  const filtered = (fields ?? []).filter((f) =>
    f.name.toLowerCase().includes(search.toLowerCase()) ||
    f.location.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" as const } }}
        className="pt-safe px-4 py-6 bg-white border-b sticky top-0 z-10 shadow-sm"
      >
        <h1 className="text-2xl font-bold text-foreground">Fields</h1>
        <p className="text-muted-foreground text-sm mb-4">
          Browse footage from your field's cameras
        </p>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search fields"
            className="pl-9 bg-muted border-transparent focus-visible:ring-primary rounded-xl h-12"
          />
        </div>
      </motion.div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 pb-24">
        {isLoading ? (
          <div className="space-y-4">
            {[1, 2].map((i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { delay: i * 0.1 } }}
                className="h-[200px] bg-muted rounded-2xl animate-pulse"
              />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-12 text-muted-foreground"
          >
            No fields found
          </motion.div>
        ) : (
          filtered.map((field, i) => (
            <FieldCard key={field.id} field={field} index={i} />
          ))
        )}
      </div>
    </div>
  );
}

function FieldCard({ field, index }: { field: Field; index: number }) {
  return (
    <motion.div
      custom={index}
      variants={cardVariants}
      initial="hidden"
      animate="show"
      whileTap={{ scale: 0.97 }}
    >
      <Link href={`/fields/${field.id}`}>
        <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow cursor-pointer group">
          <div className="h-36 relative flex items-center justify-center overflow-hidden">
            <div className="absolute inset-0 field-pattern group-hover:scale-105 transition-transform duration-500" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-black/10" />

            <div className="absolute top-3 right-3 bg-primary text-white text-xs font-bold px-2 py-1 rounded-full flex items-center gap-1 shadow-md">
              <Video className="w-3 h-3" />
              {field.clipCount} clips
            </div>

            <div className="absolute bottom-3 left-3 flex items-center gap-2 text-white">
              <Camera className="w-4 h-4 opacity-80" />
              <h3 className="font-bold text-lg leading-tight drop-shadow-md">{field.name}</h3>
            </div>
          </div>

          <div className="px-4 py-3 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{field.location}</span>
            {field.lastRecordedAt && (
              <span className="text-xs font-medium bg-green-100 text-green-800 px-2 py-1 rounded-md ml-auto">
                Last recorded {new Date(field.lastRecordedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            )}
            {field.clipCount === 0 && (
              <span className="text-xs text-muted-foreground ml-auto">No clips yet</span>
            )}
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
