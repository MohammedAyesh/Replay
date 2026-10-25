import { describe, expect, it } from "vitest";
import { bookingPaymentActions } from "./booking-payment-actions";

const booking = { method: "cliq" as const, requestId: 7, mine: true, payAtFieldAllowed: true };

describe("booking payment actions", () => {
  it("a CliQ booking waiting for its transfer: no cash to take, cancellable, switchable to the field", () => {
    expect(bookingPaymentActions({ status: "awaiting_payment", phase: "pre", isOwner: true }, booking))
      .toEqual({ lockedIn: false, canCollect: false, canCancel: true, canSwitch: true });
  });

  it("pay at the field: the field takes the cash, cancellable only before kick-off", () => {
    const field = { ...booking, method: "field" as const };
    expect(bookingPaymentActions({ status: "scheduled", phase: "pre", isOwner: true }, field))
      .toMatchObject({ lockedIn: true, canCollect: true, canCancel: true, canSwitch: true });
    expect(bookingPaymentActions({ status: "recording", phase: "live", isOwner: false }, field))
      .toMatchObject({ canCollect: false, canCancel: false });
  });

  it("switched from the field to CliQ: still locked in, so the field can still take cash and the booker can still cancel", () => {
    expect(bookingPaymentActions({ status: "scheduled", phase: "pre", isOwner: true }, booking))
      .toEqual({ lockedIn: true, canCollect: true, canCancel: true, canSwitch: true });
    expect(bookingPaymentActions({ status: "recording", phase: "live", isOwner: true }, booking))
      .toMatchObject({ canCollect: true, canCancel: false });
  });

  it("only the booker switches, and only to the field when it is allowed", () => {
    expect(bookingPaymentActions({ status: "awaiting_payment", phase: "pre", isOwner: false }, { ...booking, mine: false }).canSwitch).toBe(false);
    expect(bookingPaymentActions({ status: "awaiting_payment", phase: "pre", isOwner: false }, { ...booking, payAtFieldAllowed: false }).canSwitch).toBe(false);
  });
});
