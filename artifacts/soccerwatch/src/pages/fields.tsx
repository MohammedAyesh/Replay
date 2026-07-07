import { useState } from "react";
import { Link } from "wouter";
import { useGetBunnyCollections, BunnyCollection } from "@workspace/api-client-react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { motion } from "framer-motion";
import { useTranslation } from "@/i18n";

function splitName(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
}

const cardVariants = {
  hidden: { opacity: 0, y: 32 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, delay: i * 0.1, ease: "easeOut" as const },
  }),
};

export default function Fields() {
  const { data: collections, isLoading } = useGetBunnyCollections();
  const [search, setSearch] = useState("");
  const { t } = useTranslation();

  const filtered = (collections ?? []).filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" as const } }}
        className="pt-safe px-4 py-6 bg-background sticky top-0 z-10"
      >
        <h1 className="text-2xl font-bold text-foreground">{t.fields.title}</h1>
        <p className="text-muted-foreground text-sm mb-4">{t.fields.subtitle}</p>
        <div className="relative">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.fields.searchPlaceholder}
            className="ps-9 bg-muted border-transparent focus-visible:ring-primary rounded-xl h-12"
          />
        </div>
      </motion.div>

      <div className="flex-1 overflow-y-auto px-4 py-4 pb-24 grid grid-cols-2 gap-4 content-start">
        {isLoading ? (
          <>
            {[1, 2, 3, 4].map((i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { delay: i * 0.08 } }}
                className="aspect-[3/4] bg-muted rounded-2xl animate-pulse"
              />
            ))}
          </>
        ) : filtered.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="col-span-2 text-center py-12 text-muted-foreground"
          >
            {t.fields.noFieldsFound}
          </motion.div>
        ) : (
          filtered.map((collection, i) => (
            <CollectionCard key={collection.guid} collection={collection} index={i} />
          ))
        )}
      </div>
    </div>
  );
}

function CollectionCard({ collection, index }: { collection: BunnyCollection; index: number }) {
  const words = splitName(collection.name);

  return (
    <motion.div
      custom={index}
      variants={cardVariants}
      initial="hidden"
      animate="show"
      whileTap={{ scale: 0.95 }}
      className="aspect-[3/4]"
    >
      <Link href={`/fields/${collection.guid}`} className="block h-full">
        <div className="h-full relative overflow-hidden rounded-2xl shadow-md group cursor-pointer">
          {collection.previewImageUrl ? (
            <img
              src={collection.previewImageUrl}
              alt={collection.name}
              className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="absolute inset-0 field-pattern group-hover:scale-105 transition-transform duration-500" />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/40 to-black/80" />

          <div className="absolute inset-0 flex flex-col items-center justify-center px-3 gap-1">
            {words.map((word, wi) => (
              <span
                key={wi}
                className="text-white font-black leading-none tracking-tight text-center drop-shadow-lg"
                style={{ fontSize: `clamp(1rem, ${Math.min(5, 10 / word.length)}vw + 0.5rem, 2.2rem)` }}
              >
                {word}
              </span>
            ))}
          </div>

          <div className="absolute bottom-3 start-0 end-0 px-3">
            <p className="text-white/70 text-[10px] font-medium text-center">
              {collection.videoCount} {collection.videoCount === 1 ? "video" : "videos"}
            </p>
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
