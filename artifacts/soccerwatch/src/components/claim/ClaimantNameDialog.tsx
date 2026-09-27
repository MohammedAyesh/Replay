import { useEffect, useRef, useState } from "react";

import { useClaimCopy } from "@/i18n/claim-strings";
import { PrimaryAction, TextLink } from "@/components/claim/primitives";

export function ClaimantNameDialog({
  defaultName,
  saving,
  onCancel,
  onConfirm,
}: {
  defaultName: string;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const copy = useClaimCopy();
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, saving]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) { setError(copy.name.empty); return; }
    if (trimmed.length > 40) { setError(copy.name.tooLong); return; }
    onConfirm(trimmed);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-void/80 px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-10"
      onClick={(event) => { if (event.target === event.currentTarget && !saving) onCancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={copy.name.title}
        className="relative w-full max-w-[408px] rounded-2xl border border-line bg-surface p-5"
      >
        <p className="pe-10 font-display text-lg font-bold text-text">{copy.name.title}</p>
        <p className="mt-1.5 text-sm leading-6 text-muted-text">{copy.name.lead}</p>
        <label htmlFor="claim-name" className="mt-4 block font-display text-xs font-bold uppercase tracking-[0.12em] text-muted-text">
          {copy.name.label}
        </label>
        <input
          id="claim-name"
          ref={inputRef}
          value={name}
          onChange={(event) => { setName(event.target.value); setError(null); }}
          placeholder={copy.name.placeholder}
          maxLength={60}
          className="mt-1.5 h-12 w-full rounded-xl border border-line bg-raised px-4 text-base text-text outline-none focus:border-turf"
        />
        {error && <p className="mt-2 text-xs text-text" role="alert">{error}</p>}
        <div className="mt-4">
          <PrimaryAction onClick={submit} disabled={saving}>
            {saving ? copy.common.saving : copy.name.save}
          </PrimaryAction>
        </div>
        <div className="mt-1">
          <TextLink onClick={onCancel}>{copy.name.cancel}</TextLink>
        </div>
      </div>
    </div>
  );
}