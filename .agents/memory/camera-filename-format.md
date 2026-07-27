---
name: Camera upload filename format
description: Filename layout used by the soccer field cameras; trailing YYYYMMDDhhmmss is the capture timestamp.
---

Cameras now upload files with this exact layout:

`cam{N}_{title}_{NN}_{YYYYMMDDhhmmss}.mp4`

- `camN` — camera index (1 or 2). Pull from this to route to the right academy / live stream.
- `{title}` — the human-readable title; **may contain spaces** (e.g. `Jordan Galaxy 1`), so splitting on `_` gives exactly four segments.
- `NN` — two-digit field; sequence/score marker, not a date. Don't confuse it with the timestamp.
- `YYYYMMDDhhmmss` — 14-digit capture timestamp at end. Parse as a UTC-ish timestamp; the camera is the source of truth, not `fs.stat` mtime (which drifts across reboots or wrong timezones).

**Why:** The current recordings pipeline has admins enter `date` and `timeSlot` by hand. The upcoming auto-upload workstream ("Let cameras auto-upload footage and create clips without manual steps") will need to fill those `recordings` columns straight from the filename so admins don't have to.

**How to apply:** When building the camera→recording ingestion, split on `_`, take the last segment, strip `.mp4`, parse `YYYYMMDDhhmmss → Date`. Don't trust `stat.mtime` — it's unreliable for cameras that reset clocks. Pull `camN` from segment 0 to decide which Bunny collection / academy the file belongs to.
