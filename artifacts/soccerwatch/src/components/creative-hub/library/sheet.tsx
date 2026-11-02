import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A bottom sheet on a phone, a centred panel on a wider screen. The close
 * button sits at the inline end, so it is on the left in Arabic.
 */
export function LibrarySheet({ open, onClose, title, closeLabel, dir, children, wide, testId }: {
  open: boolean;
  onClose: () => void;
  title: string;
  closeLabel: string;
  dir: "rtl" | "ltr";
  children: ReactNode;
  wide?: boolean;
  testId?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <DialogPrimitive.Content dir={dir} data-testid={testId} aria-describedby={undefined}
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-3xl border border-line bg-void text-text shadow-2xl",
            "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[86dvh] sm:w-[calc(100%-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl",
            wide ? "sm:max-w-4xl" : "sm:max-w-xl",
          )}>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <DialogPrimitive.Title className="truncate font-display text-base font-bold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-line text-muted-text hover:text-text" aria-label={closeLabel}>
              <X className="h-4 w-4" aria-hidden />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
