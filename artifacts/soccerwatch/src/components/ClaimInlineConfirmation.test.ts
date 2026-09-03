import React, { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClaimInlineConfirmation } from "./ClaimInlineConfirmation";

type ElementProps = {
  children?: unknown;
  "data-testid"?: string;
  onClick?: () => void;
};

function elements(node: unknown): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  return [node as ReactElement<ElementProps>, ...elements(node.props.children)];
}

describe("ClaimInlineConfirmation", () => {
  it("renders translated counts and never renders a server message", () => {
    const html = renderToStaticMarkup(
      React.createElement(ClaimInlineConfirmation, {
        kind: "offPitchConflict",
        title: "Review before excluding this time",
        body: "This will remove 2 vouched time ranges and undo 3 accepted answers.",
        irreversible: "This cannot be undone.",
        period: "0:20 – 0:30",
        confirmLabel: "Exclude time and continue",
        cancelLabel: "Keep my answers",
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );

    expect(html).toContain("2 vouched time ranges");
    expect(html).toContain("3 accepted answers");
    expect(html).toContain("This cannot be undone.");
    expect(html).not.toContain("Save it anyway?");
    expect(html).not.toContain("server message");
  });

  it("cancels without making a request and keeps the pending period available", () => {
    let requests = 0;
    const pendingPeriod = "0:20 – 0:30";
    const element = ClaimInlineConfirmation({
      kind: "offPitchConflict",
      title: "Review",
      body: "This will remove 1 vouched time range and undo 0 accepted answers.",
      period: pendingPeriod,
      confirmLabel: "Confirm",
      cancelLabel: "Cancel",
      onConfirm: () => { requests += 1; },
      onCancel: () => {},
    });
    const cancelButton = elements(element).find((item) =>
      item.type === "button" && item.props["data-testid"] === "button-offpitch-conflict-cancel");

    cancelButton?.props.onClick?.();
    expect(requests).toBe(0);
    expect(pendingPeriod).toBe("0:20 – 0:30");
  });

  it("invokes confirmation once so the caller can send the confirm flag once", () => {
    const requests: Array<{ confirmConflict: boolean }> = [];
    const element = ClaimInlineConfirmation({
      kind: "offPitchConflict",
      title: "Review",
      body: "Conflict",
      confirmLabel: "Confirm",
      cancelLabel: "Cancel",
      onConfirm: () => { requests.push({ confirmConflict: true }); },
      onCancel: () => {},
    });
    const confirmButton = elements(element).find((item) =>
      item.type === "button" && item.props["data-testid"] === "button-offpitch-confirm");

    confirmButton?.props.onClick?.();
    expect(requests).toEqual([{ confirmConflict: true }]);
  });
});