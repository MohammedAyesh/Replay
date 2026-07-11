import { useCallback, useRef, useState } from "react";

const ESCALATION = [5, 10, 20, 30];
const DOUBLE_TAP_MS = 340;
const CONSECUTIVE_WINDOW_MS = 1400;

export interface SkipFlash {
  side: "left" | "right";
  amount: number;
  key: number;
}

export function useSkipTap(options: {
  onSkip: (delta: number) => void;
  onSingleTap?: () => void;
  disabled?: boolean;
}) {
  const { onSkip, onSingleTap, disabled } = options;
  const [flash, setFlash] = useState<SkipFlash | null>(null);

  const r = useRef({
    lastTapTime: 0,
    consecutiveCount: 0,
    lastSkipTime: 0,
    flashTimeout: null as ReturnType<typeof setTimeout> | null,
  });

  const handleTap = useCallback(
    (clientX: number, rect: DOMRect) => {
      if (disabled) return;
      const now = Date.now();
      const dt = now - r.current.lastTapTime;

      if (dt > 0 && dt < DOUBLE_TAP_MS) {
        const side = clientX - rect.left < rect.width / 2 ? "left" : "right";

        if (now - r.current.lastSkipTime > CONSECUTIVE_WINDOW_MS) {
          r.current.consecutiveCount = 0;
        }
        const amount = ESCALATION[Math.min(r.current.consecutiveCount, ESCALATION.length - 1)];
        const delta = side === "left" ? -amount : amount;

        onSkip(delta);
        r.current.consecutiveCount++;
        r.current.lastSkipTime = now;
        r.current.lastTapTime = 0;

        if (r.current.flashTimeout) clearTimeout(r.current.flashTimeout);
        setFlash({ side, amount, key: now });
        r.current.flashTimeout = setTimeout(() => setFlash(null), 900);
      } else {
        r.current.lastTapTime = now;
        onSingleTap?.();
      }
    },
    [disabled, onSkip, onSingleTap],
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (e.changedTouches.length !== 1) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      handleTap(e.changedTouches[0].clientX, rect);
    },
    [handleTap],
  );

  return { flash, onTouchEnd };
}
