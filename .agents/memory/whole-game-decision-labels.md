---
name: Whole-game decision labels
description: Durable constraints for collecting training labels from explicit /find decisions.
---

For the whole-game claim flow, write labels only when the user makes an identity decision. Keep label writes out of the page's autosave, which persists the complete claim state after ordinary navigation and review steps. Reuse the claim-chain label kinds and row shape; deduplicate retries using the row's natural decision key under a transaction lock. The server must validate the client's bundle fingerprint and store the active bundle's fingerprint.

**Why:** Autosaves are not decision events and can repeat many times; treating each as a label creates duplicates or labels non-decisions. The existing label shape has no separate event ID or unique constraint, so repeat safety must not require schema changes.

**How to apply:** When extending `/find`, add label calls beside explicit choices only. Keep skips, navigation, empty taps, and routine state saves label-free. Validate stale bundle identity before writing.