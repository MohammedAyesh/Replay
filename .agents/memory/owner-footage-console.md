---
name: Owner footage console
description: Contract and billing rules for field-owner footage requests and public links.
---

Owner footage links use the public `/w/<32-hex-token>` path; the owner API exposes the matching playback manifest at `/w/<token>/manifest.m3u8`. Links are active only for ready/partial, unrevoked requests before the 14-day expiry.

**Why:** Step 2 stores and returns links before the public playback route exists, so Step 3 must preserve these exact paths and expiry semantics.

**How to apply:** Keep owner authorization field-scoped or admin-only, use integer fils, and compute the charge once on the first ready/partial transition.