import React from "react";

type ClaimInlineConfirmationProps = {
  kind: "offPitchConflict" | "demoReset";
  title: string;
  body: string;
  irreversible?: string;
  period?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirming?: boolean;
};

export function ClaimInlineConfirmation({
  kind,
  title,
  body,
  irreversible,
  period,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  confirming = false,
}: ClaimInlineConfirmationProps) {
  return (
    <div
      className="claim-panel claim-panel-warning claim-inline-confirmation"
      role={kind === "demoReset" ? "alertdialog" : "alert"}
      data-testid={kind === "demoReset" ? "demo-reset-confirmation" : "offpitch-conflict-confirmation"}
    >
      <b>{title}</b>
      <span>{body}</span>
      {irreversible && <strong>{irreversible}</strong>}
      {period && <small>{period}</small>}
      <div className="claim-confirmation-actions">
        <button
          type="button"
          className="claim-button claim-button-primary"
          data-testid={kind === "demoReset" ? "button-confirm-demo-reset" : "button-offpitch-confirm"}
          onClick={onConfirm}
          disabled={confirming}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          className="claim-button claim-button-secondary"
          data-testid={kind === "demoReset" ? "button-cancel-demo-reset" : "button-offpitch-conflict-cancel"}
          onClick={onCancel}
          disabled={confirming}
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}