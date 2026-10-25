import type { MatchRoom } from "./match-api";

type Booking = NonNullable<MatchRoom["booking"]>;

/**
 * What can be done about a booking's waiting payment on the match page.
 *
 * A booking is locked in (its recording is already scheduled) once it is pay at
 * the field, including one the booker then switched to CliQ. A locked-in
 * booking can still be paid in cash (the field ticks it off) and cancelled by
 * the booker before kick-off, so a switch to CliQ never leaves it without a
 * way to be paid or dropped.
 */
export function bookingPaymentActions(
  room: Pick<MatchRoom, "status" | "phase" | "isOwner">,
  booking: Pick<Booking, "method" | "requestId" | "mine" | "payAtFieldAllowed">,
): { lockedIn: boolean; canCollect: boolean; canCancel: boolean; canSwitch: boolean } {
  const field = booking.method === "field";
  const lockedIn = field || room.status !== "awaiting_payment";
  return {
    lockedIn,
    // Whoever is at the field (the owner or an admin) ticks the cash off.
    canCollect: lockedIn && room.isOwner,
    canCancel: Boolean(booking.requestId) && (lockedIn ? room.phase === "pre" : true),
    canSwitch: booking.mine && Boolean(booking.requestId) && (field || booking.payAtFieldAllowed),
  };
}
