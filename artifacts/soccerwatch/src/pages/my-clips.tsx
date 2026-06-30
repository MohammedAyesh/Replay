import { Link } from "wouter";
import { useListSavedClips, getListSavedClipsQueryKey, Clip } from "@workspace/api-client-react";
import { Bookmark, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { motion } from "framer-motion";
import { useTranslation } from "@/i18n";

function getBunnyThumbnailUrl(clip: Clip): string | null {
  if (clip.bunnyPlaybackUrl) {
    return clip.bunnyPlaybackUrl.replace("/playlist.m3u8", "/thumbnail.jpg");
  }
  return null;
}

export default function MyClips() {
  const { isGuest } = useAuth();
  const { t } = useTranslation();
  const { data: clips, isLoading } = useListSavedClips({
    query: { enabled: !isGuest, queryKey: getListSavedClipsQueryKey() },
  });

  if (isGuest) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } }}
        className="flex-1 bg-background flex flex-col h-full overflow-hidden items-center justify-center p-6 text-center"
      >
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1, transition: { type: "spring", stiffness: 280, damping: 18, delay: 0.1 } }}
          className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4"
        >
          <Bookmark className="w-8 h-8 text-muted-foreground" />
        </motion.div>
        <h2 className="text-xl font-bold mb-2">{t.myClips.signInTitle}</h2>
        <p className="text-muted-foreground mb-6">
          {t.myClips.signInDesc}
        </p>
        <Link href="/">
          <Button className="w-full max-w-[200px] bg-primary text-white">{t.myClips.signInButton}</Button>
        </Link>
      </motion.div>
    );
  }

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" as const } }}
        className="pt-safe px-4 py-6 bg-white border-b sticky top-0 z-10 shadow-sm flex items-end justify-between"
      >
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t.myClips.title}</h1>
          <p className="text-muted-foreground text-sm">{t.myClips.savedHighlights(clips?.length || 0)}</p>
        </div>
      </motion.div>

      <div className="flex-1 overflow-y-auto px-4 py-6 pb-24">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { delay: i * 0.08 } }}
                className="aspect-[3/4] bg-muted rounded-xl animate-pulse"
              />
            ))}
          </div>
        ) : !clips || clips.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } }}
            className="text-center py-20"
          >
            <motion.div
              initial={{ scale: 0.7, opacity: 0 }}
              animate={{ scale: 1, opacity: 1, transition: { type: "spring", stiffness: 260, damping: 18, delay: 0.1 } }}
              className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4"
            >
              <Video className="w-8 h-8 text-muted-foreground" />
            </motion.div>
            <p className="text-muted-foreground">{t.myClips.noClipsYet}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {t.myClips.noClipsDesc}
            </p>
            <Link href="/watch">
              <Button variant="outline" className="mt-6">{t.myClips.goToWatch}</Button>
            </Link>
          </motion.div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {clips.map((clip, i) => (
              <ClipCard key={clip.id} clip={clip} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ClipCard({ clip, index }: { clip: Clip; index: number }) {
  const thumbnailUrl = getBunnyThumbnailUrl(clip);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9, y: 16 }}
      animate={{
        opacity: 1, scale: 1, y: 0,
        transition: { delay: index * 0.07, duration: 0.4, ease: "easeOut" as const },
      }}
      whileTap={{ scale: 0.95 }}
    >
      <Link href={`/player/${clip.id}`}>
        <div className="relative aspect-[3/4] rounded-xl overflow-hidden shadow-sm group cursor-pointer">
          <div className="absolute inset-0 field-pattern bg-[#0d1f0d]" />

          {thumbnailUrl && (
            <img
              src={thumbnailUrl}
              alt={clip.momentLabel}
              className="absolute inset-0 w-full h-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          )}

          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
          <div className="absolute inset-0 group-hover:bg-white/5 transition-colors duration-200" />

          <div className="absolute top-2 left-2 bg-primary text-white text-[9px] font-bold px-1.5 py-0.5 rounded shadow-sm">
            {clip.momentLabel}
          </div>

          <div className="absolute bottom-2 left-2 right-2">
            <h3 className="text-white font-bold text-sm leading-tight mb-0.5 line-clamp-2">
              {clip.fieldName}
            </h3>
            <p className="text-primary text-[10px] font-medium">
              {clip.court} • {clip.date}
            </p>
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
