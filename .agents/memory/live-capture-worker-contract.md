---
name: Live capture worker contract
description: Deployed control API behavior for live DVR clip capture, status polling, and ball-follow validation.
---

The live capture control API uses `POST /live/clip/{camera}?start=&end=&title=` and returns `{ job, state: "queued" }`. The string in `job` is the identifier for `GET /live/clip/job/{job}`. Poll status values are `queued`, `cutting`, `uploading`, `encoding`, `ready`, and `failed`. A ready response supplies the Bunny `guid`, clip `duration`, and source `offsetStart` / `offsetEnd`; saved fractions are offsets divided by duration. Unknown jobs return 404. Ball-follow is valid only when `/livepan/status/{camera}` returns `on: true` and `state: "live"`, and the ball path response explicitly has `available: true`.

**Why:** Bunny encoding can remain queued for more than an hour and still complete successfully, so elapsed time alone must not fail a known active job.

**How to apply:** Poll known jobs every five seconds for the first hour, then back off while continuing to accept status updates. An unknown job may be expired after a deliberate grace window. Refuse future clip end times before sending the request.