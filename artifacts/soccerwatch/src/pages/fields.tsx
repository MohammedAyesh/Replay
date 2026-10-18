import { useState } from "react";
import { Link } from "wouter";
import { useGetBunnyCollections, getGetBunnyCollectionsQueryKey, BunnyCollection } from "@workspace/api-client-react";
import { Film, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { motion } from "framer-motion";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import jordanGalaxyCover from "@/assets/jordan-galaxy-cover.png";

const collectionCovers: Record<string, string> = {
  cam1: jordanGalaxyCover,
};

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

  const filtered = (collections ?? [])
    .map((collection, originalIndex) => ({ collection, originalIndex }))
    .filter(({ collection }) => collection.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) =>
      b.collection.videoCount - a.collection.videoCount || a.originalIndex - b.originalIndex
    );

  return (
    <div className="fields-page flex flex-1 min-h-0 flex-col overflow-hidden bg-background">
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" as const } }}
        className={`fields-page-header ${embedded ? "shrink-0 bg-background px-4 pb-3 pt-4" : "sticky top-0 z-10 shrink-0 bg-background px-4 pb-3 pt-4"}`}
      >
        {!embedded && (
          <>
            <h1 className="text-2xl font-bold text-foreground">{t.fields.title}</h1>
            <p className="mb-4 text-sm text-muted-foreground">{t.fields.subtitle}</p>
          </>
        )}
        <div className="relative">
          <Search className="absolute start-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-text" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.fields.searchPlaceholder}
            className="h-[50px] rounded-full border border-line bg-surface ps-[46px] text-text placeholder:text-muted-text focus-visible:ring-turf"
          />
        </div>
      </motion.div>

      <div className="fields-page-scroll min-h-0 flex-1 overflow-y-auto no-scrollbar px-4 py-4 pb-28">
        <div className="fields-card-grid flex flex-col gap-[14px]">
          {isLoading ? (
            <>
              {[1, 2, 3, 4].map((i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { delay: i * 0.08 } }}
                  className="h-[176px] animate-pulse rounded-[18px] border border-line bg-raised"
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
            filtered.map(({ collection }, i) => (
              <CollectionCard key={collection.guid} collection={collection} index={i} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function CollectionCard({ collection, index }: { collection: BunnyCollection; index: number }) {
  const [imageFailed, setImageFailed] = useState(false);
  const coverUrl = collectionCovers[collection.name] ?? collection.previewImageUrl;
  const hasVideos = collection.videoCount > 0;
  const countLabel = useTranslation().t.fields.videoCount(collection.videoCount);

  return (
    <motion.div
      custom={index}
      variants={cardVariants}
      initial="hidden"
      animate="show"
      whileTap={{ scale: 0.97 }}
      className="overflow-hidden rounded-[18px] border border-line bg-raised"
    >
      <Link
        href={`/fields/${collection.guid}`}
        className="group relative block h-[176px] w-full overflow-hidden rounded-[18px] bg-raised text-text"
      >
        {coverUrl && !imageFailed ? (
          <img
            src={coverUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            style={collectionCovers[collection.name] ? { objectPosition: "center 35%" } : undefined}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_0%,#1F2A44,#1B2338_60%)]">
            <svg
              className="absolute inset-0 h-full w-full opacity-[0.45]"
              viewBox="0 0 200 120"
              preserveAspectRatio="xMidYMid slice"
              fill="none"
              stroke="#2FD8C4"
              strokeWidth="1.2"
            >
              <rect x="14" y="12" width="172" height="96" rx="2" />
              <line x1="100" y1="12" x2="100" y2="108" />
              <circle cx="100" cy="60" r="16" />
              <circle cx="100" cy="60" r="1.6" fill="#2FD8C4" />
              <rect x="14" y="38" width="22" height="44" />
              <rect x="164" y="38" width="22" height="44" />
            </svg>
          </div>
        )}
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-void/[0.95] to-transparent"
        />
        <span className="absolute inset-x-4 bottom-[14px] flex items-end justify-between gap-2.5">
          <bdi dir="ltr" className="truncate font-display text-[26px] font-bold leading-none">
            {collection.name}
          </bdi>
          <span className={cn(
            "flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-bold",
            hasVideos ? "bg-turf/15 text-turf" : "bg-void/70 text-[#C9CFDB]",
          )}>
            <Film className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{countLabel}</span>
          </span>
        </span>
      </Link>
    </motion.div>
  );
}
