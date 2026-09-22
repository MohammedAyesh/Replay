---
name: Footage refund accounting
description: The accounting invariant for approved owner footage cancellations.
---

An approved footage cancellation is represented by changing the footage request to `refunded` with zero billable amount. The ledger may show a zero-valued refunded footage line, but the payment ledger must contain only real positive payments; do not insert a negative `Refund` payment.

**Why:** Negative refund rows were double-counted against the balance after the request amount was already removed, producing an incorrect balance and duplicate refund presentation.

**How to apply:** Keep refund approval and ledger queries aligned with the refunded request status, and remove any legacy negative Refund rows only when they are confirmed to belong to approved cancellations.