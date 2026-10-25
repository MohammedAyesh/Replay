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

  const lastTouchRef = useRef(0);
  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      lastTouchRef.current = Date.now();
      if (e.changedTouches.length !== 1) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      handleTap(e.changedTouches[0].clientX, rect);
    },
    [handleTap],
  );

  /** Mouse and trackpad: a double-click on either half skips, like a double-tap. */
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      // Phones can fire a synthetic dblclick after a double-tap the touch handler already used.
      if (disabled || Date.now() - lastTouchRef.current < 1000) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const now = Date.now();
      const side = e.clientX - rect.left < rect.width / 2 ? "left" : "right";
      const amount = ESCALATION[1];
      onSkip(side === "left" ? -amount : amount);
      if (r.current.flashTimeout) clearTimeout(r.current.flashTimeout);
      setFlash({ side, amount, key: now });
      r.current.flashTimeout = setTimeout(() => setFlash(null), 900);
    },
    [disabled, onSkip],
  );

  return { flash, onTouchEnd, onDoubleClick };
}
