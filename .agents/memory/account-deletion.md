---
name: Account deletion retention
description: Durable rules for cross-system account deletion and preserving auditable SoccerWatch history.
---

Delete the Clerk identity before the local database transaction. If Clerk deletion fails, make no local changes. If the local transaction fails after Clerk deletion, disable the local account and log the failure.

Preserve footage, cancellation, payment, VAR, and stat-unlock history by reassigning user references to the disabled “Deleted player” placeholder. Do not change amounts, statuses, unique references, or footage/review state. Remove the account's likes and decrement denormalized counts on both legacy clips and user clips that remain.

Unique-key constraints to preserve:

- `stat_unlocks.reference` is unique and remains unchanged; `user_id` can be shared by multiple rows.
- Cancellation requests are unique by `footage_request_id`; reassigning `requested_by` does not change that key.
- Placeholder creation must tolerate concurrent deletion transactions, then verify that any existing row is the expected disabled system account.

**Why:** Account deletion spans Clerk and the database, with no distributed transaction between them. Deleting linked audit history can break financial and footage records, while ignoring unique keys or like counters can leave inconsistent data.

**How to apply:** Route self-service and admin deletion through the same flow. Check and transactionally recheck active owner-footage work, delete Clerk first, then anonymize retained rows and remove personal content in a transaction. Perform remote media cleanup after commit and log failures.