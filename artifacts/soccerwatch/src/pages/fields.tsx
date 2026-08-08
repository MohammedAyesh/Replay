import { useState } from "react";
import { Link } from "wouter";
import { useGetBunnyCollections, getGetBunnyCollectionsQueryKey, BunnyCollection } from "@workspace/api-client-react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { motion } from "framer-motion";
import { useTranslation } from "@/i18n";

const cardVariants = {
  hidden: { opacity: 0, y: 32 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, delay: i * 0.1, ease: "easeOut" as const },
  }),
};

export default function Fields({ embedded = false }: { embedded?: boolean }) {
  const { data: collections, isLoading } = useGetBunnyCollections({
    query: {
      queryKey: getGetBunnyCollectionsQueryKey(),
      staleTime: 5 * 60 * 1000,
      gcTime: 5 * 60 * 1000,
    },
  });
  const [search, setSearch] = useState("");
  const { t } = useTranslation();

  const filtered = (collections ?? []).filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden bg-background">
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" as const } }}
        className="sticky top-0 z-10 shrink-0 bg-background px-4 pb-3 pt-4"
      >
        {!embedded && (
          <>
            <h1 className="text-2xl font-bold text-foreground">{t.fields.title}</h1>
            <p className="mb-4 text-sm text-muted-foreground">{t.fields.subtitle}</p>
          </>
        )}
        <div className="relative">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.fields.searchPlaceholder}
            className="h-11 rounded-full border border-border bg-card ps-9 focus-visible:ring-primary"
          />
        </div>
      </motion.div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-28">
        <div className="flex flex-col gap-3">
          {isLoading ? (
            <>
              {[1, 2, 3, 4].map((i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { delay: i * 0.08 } }}
                  className="h-[150px] animate-pulse rounded-[22px] border border-border bg-card"
                />
              ))}
            </>
          ) : filtered.length === 0 ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="py-12 text-center text-muted-foreground"
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
    </div>
  );
}

function CollectionCard({ collection, index }: { collection: BunnyCollection; index: number }) {
  return (
    <motion.div
      custom={index}
      variants={cardVariants}
      initial="hidden"
      animate="show"
      whileTap={{ scale: 0.97 }}
      className="overflow-hidden rounded-[22px] border border-border bg-card"
    >
      <Link href={`/fields/${collection.guid}`} className="block">
        {/* Photo area */}
        <div className="relative h-24 w-full overflow-hidden">
          {collection.previewImageUrl ? (
            <img
              src={collection.previewImageUrl}
              alt={collection.name}
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="absolute inset-0 field-pattern bg-card" />
          )}
          {/* Top + bottom gradient for readability */}
          <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/40" />
        </div>

        {/* Content block */}
        <div className="px-3 py-2.5">
          <p className="truncate font-display text-sm font-semibold leading-[1.25] text-foreground">
            {collection.name}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {collection.videoCount} {collection.videoCount === 1 ? "video" : "videos"}
          </p>
        </div>
      </Link>
    </motion.div>
  );
}
