---
name: Camera upload filename format
description: Filename layouts used by the soccer field cameras; two formats in the wild.
---

## Format A — long (original)

`cam{N}_{title}_{NN}_{YYYYMMDDhhmmss}.mp4`

- `camN` — camera index (1 or 2).
- `{title}` — human-readable title; **may contain spaces**, so splitting on `_` gives exactly four segments.
- `NN` — two-digit sequence/score marker, not a date.
- `YYYYMMDDhhmmss` — 14-digit capture timestamp. Parse as source-of-truth; ignore `fs.stat` mtime (unreliable after camera clock resets).

## Format B — short

`cam{N}_{YYYYMMDD}{HH}`  (no extension, or `.mp4`)

Examples: `cam1_2026072714`, `cam2_2026072709`

- `camN` — camera index.
- `YYYYMMDD` — date.
- `HH` — two-digit hour in 24-hour time (e.g. `14` = 14:00 / 2 pm).
- No explicit end time in the filename — derive `endTime = startTime + duration` using the recording's duration field or the actual media duration.

**Why:** Both formats appear in real uploads. The auto-upload ingestion pipeline (task: "Let cameras auto-upload footage and create clips without manual steps") must detect which format is present and extract the correct start timestamp from either.

**How to apply:**
1. Try Format A first: check if the stem contains exactly three `_` separators with a 14-digit tail.
2. Fall back to Format B: match `/^cam(\d+)_(\d{8})(\d{2})$/i`. Parse `YYYYMMDD` + `HH:00` in `Asia/Amman` timezone to get `startTime`. Compute `endTime = startTime + durationSeconds * 1000`.
3. In both formats, pull `camN` from the first segment to route to the right academy / Bunny collection.
