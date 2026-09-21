---
name: Owner footage console
description: Contract and billing rules for field-owner footage requests and public links.
---

Owner footage links use the public `/w/<32-hex-token>` path; the owner API exposes the matching playback manifest at `/w/<token>/manifest.m3u8`. Links are active only for ready/partial, unrevoked requests before the 14-day expiry.

**Why:** Step 2 stores and returns links before the public playback route exists, so Step 3 must preserve these exact paths and expiry semantics.

**How to apply:** Keep owner authorization field-scoped or admin-only, use integer fils, and compute the charge once on the first ready/partial transition.

Scheduled bookings may be up to 14 days ahead; future/current hours bypass historical SD-card availability checks, while past hours still require camera availability. Scheduled bookings can be cancelled only before recording starts, and cancellation must succeed remotely before local state changes.

**Why:** The camera’s historical availability endpoint cannot describe future recording windows, and cancelling locally before the VPS confirms would leave orphaned scheduled pulls.

**How to apply:** Enforce overlap and booking caps before queueing, preserve 404 indistinguishability for invalid public tokens, and keep admin payment entry in JOD while storing integer fils.