# Off-schedule FTP gap store (vps1)

cam1 records to its SD card only in the hours its continuous (TIMING) schedule
covers: 00–02, 08–12 and 16–24 Amman time, every day. In every other hour
(02–08, 12–16) the camera now pushes its clips over FTP to vps1, which keeps
them in a rolling store capped at **100 GB**. Any window from the store can be
pulled into Bunny Stream **with its audio**, from the admin console or the owner
console, like an SD pull.

Deployed 2026-10-30 to `/opt/reocam/gapstore/` (code + data), config
`/etc/reocam/gapstore.json`, cron `/etc/cron.d/reocam-gapstore`, log
`/var/log/reocam-gapstore.log`, API mounted in `/opt/replay/control.py`.

## How it fits around live / auto-pan / VAR

| state | camera FTP |
|---|---|
| off-schedule hour, nothing live | `enable 1`, schedule = the off-schedule hours only (TIMING row), other rows 0 |
| recorded hour, nothing live | `enable 0` — so `livehold.py`, which only switches FTP on when `enable` is 0, still does it for Start Live |
| live / auto-pan / VAR holds the camera | left to them; once `enable` is 1, widened to all 168 hours so a session that crosses 16:00 or 08:00 keeps its feed |

`sync-schedule` runs every minute from cron and talks to the camera only when
the wanted state changes, plus a verify read every 10 min. Every write is read
back. Holds are the same tests `ftp_guard.sh` makes: `/opt/reocam/var-only/<cam>.*`,
`/opt/reocam/live-hold/<cam>.*`, `replay-bunnylive@<cam>`, `replay-livepan@<cam>`.

The store keeps its own marker `/opt/reocam/live-hold/<cam>.gapstore`, so
`process-all.sh` does not archive these clips and `ftp_guard.sh` stops deleting
them on arrival. `ingest` takes over `ftp_guard.sh`'s job for that camera while
nothing holds it: clips from recorded hours are deleted, `.jpg` too, and live
segments older than an hour are pruned. During a hold, off-schedule clips are
hard-linked into the store and live/VAR keep (and later delete) their own copy.

## Ingest (cron, every minute)

- A clip is taken once its size has been stable 45 s, it is 30 s old and
  ffprobe reads it (an unfinished MP4 has no moov atom). Abandoned uploads are
  dropped after 30 min.
- **The camera's clips overlap**: ~14 s clips every ~10 s, and identical packets
  show the next clip's frame 0 is the previous clip's frame 200 (2026-10-30). The
  store cuts each clip back to where the next one starts (stream copy), so every
  second is kept once (~30% more footage per GB) and joins never repeat.
- Rolling cap: oldest clips are deleted first until the store is under
  `capBytes` (100 GB) **and** the disk has `minFreeBytes` (20 GB) free. Clips a
  running pull is reading are never deleted under it.
- cam1 writes ~1 MB/s → ~3.6 GB per off-schedule hour → ~36 GB a day → the
  100 GB store holds roughly the last 2½–3 days of off-schedule footage.

## Pulls

`POST /gapstore/{cam}/pull?start=&end=&title=` (control API key; Amman local
times) → job `gs-…`, run in its own `gapstore-pull-<job>` systemd unit. It
joins the clips in one pass with the concat demuxer and stream copy, as
`ftp_window_clip.py` does, so the camera's HEVC video and AAC audio are not
re-encoded. Uploads to Bunny Stream (camera collection, streamed `curl -T`, key
on stdin) and polls for status 4. Status body follows `/record-hq`
(`status`, `progress`, `note`, `videoId`, `durationSeconds`), so the app's
existing refresh code reads it. `partial` when under 95% of the window was in
the store.

**Trap found here:** `-fflags +genpts` together with `-avoid_negative_ts
make_zero` on a concat + `-ss` + `-c copy` cut makes ffmpeg 6.1.1 and 7.0.2 both
ignore `-t` and start the video ~1.9 s after the audio. `ftp_window_clip.py` uses
both flags, so its output likely has that offset.

Other routes: `GET /gapstore/status`, `GET /gapstore/{cam}/available[?date=]`,
`GET /gapstore/{cam}/coverage?start=&end=`, `GET /gapstore/pulls`,
`GET|DELETE /gapstore/{cam}/pull/{job}`.

## App

`lib/gapStore.ts`: owner/academy availability = SD hours ∪ store hours (store
hours tagged `source: "ftp"`; store alone if the camera is unreachable). A past
window is pulled from the store when it holds more of the window than the SD
card's hours do; job ids `gs-…` route status/cancel to `/gapstore`. Admin →
Request Footage marks store hours ⚡, and a range of only ⚡ hours is pulled with
`source=ftp`.

## Operate

```sh
python3 /opt/reocam/gapstore/gapstore.py status
python3 /opt/reocam/gapstore/gapstore.py available cam1 2026-10-30
python3 /opt/reocam/gapstore/gapstore.py sync-schedule --dry-run
```

Switch off: `rm /etc/cron.d/reocam-gapstore`, set `"enabled": false` for the
camera in `/etc/reocam/gapstore.json`, then `gapstore.py disable cam1` (removes
the marker, so `ftp_guard.sh` resumes, and switches FTP off unless live/VAR is
on). Mount: restore `control.py.bak-*-gapstore` and restart `replay-control`.

Tests: `python3 ops/gapstore/test_gapstore.py` (fake Reolink + fake Bunny +
synthetic HEVC/AAC clips with a flash and beep every 5 s to check A/V sync).
