import { AnimatePresence, motion } from "framer-motion";
import type { SkipFlash as SkipFlashState } from "@/hooks/use-skip-tap";

function chevronCount(amount: number) {
  if (amount <= 5) return 1;
  if (amount <= 10) return 2;
  return 3;
}

function ChevronGroup({ side, count }: { side: "left" | "right"; count: number }) {
  return (
    <div className={`flex items-center ${side === "left" ? "flex-row-reverse gap-[-4px]" : "flex-row gap-[-4px]"}`}>
      {Array.from({ length: count }).map((_, i) => (
        <motion.svg
          key={i}
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="white"
          initial={{ opacity: 0.3 + i * 0.25, x: side === "left" ? 6 - i * 3 : -6 + i * 3 }}
          animate={{ opacity: 0.5 + i * 0.25, x: 0 }}
          transition={{ delay: i * 0.04, duration: 0.15 }}
          className="drop-shadow-lg"
        >
          {side === "right" ? (
            <path d="M8 5.14v14l11-7-11-7z" />
          ) : (
            <path d="M16 5.14v14L5 12.14l11-7z" />
          )}
        </motion.svg>
      ))}
    </div>
  );
}

export function SkipFlash({ flash }: { flash: SkipFlashState | null }) {
  return (
    <AnimatePresence>
      {flash && (
        <motion.div
          key={flash.key}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className={`absolute inset-y-0 pointer-events-none flex items-center justify-center ${
            flash.side === "left" ? "left-0 right-[40%]" : "left-[40%] right-0"
          }`}
        >
          <motion.div
            initial={{ scale: 0.3, opacity: 0.55 }}
            animate={{ scale: 2.2, opacity: 0 }}
            transition={{ duration: 0.55, ease: "easeOut" }}
            className="absolute w-20 h-20 rounded-full bg-white/25"
          />
          <div className="relative flex flex-col items-center gap-1.5">
            <ChevronGroup side={flash.side} count={chevronCount(flash.amount)} />
            <motion.span
              initial={{ opacity: 1, y: 0 }}
              animate={{ opacity: 0, y: -8 }}
              transition={{ delay: 0.45, duration: 0.3 }}
              className="text-white text-[11px] font-bold tracking-wide drop-shadow-lg"
            >
              {flash.side === "left" ? "−" : "+"}{flash.amount}s
            </motion.span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
