# Backup clip exporter (Method B) — runs on vps1

The app has two independent ways to turn a clip into an MP4:

| | Method A (primary) | Method B (backup, this folder) |
|---|---|---|
| where | Replit api-server, in-process | vps1 (Contabo), own systemd unit per job |
| language / renderer | Node, FFmpeg zoompan filter graph | Python, per-frame cv2 affine warp |
| FFmpeg | Replit nix 7.1.1 | Ubuntu 6.1.1 |
| source lookup | Bunny Stream API + playlist | public HLS playlist only (no API key) |
| output | Bunny Storage (`storage.bunnycdn.com/...`) | vps1 disk, served by the control API |
| `exported_url` | the storage URL | `vps1-export:<job>` |

The only shared dependency is the recording on Bunny Stream — the footage exists nowhere else.

**Failover** (`artifacts/api-server/src/lib/exportFailover.ts`): a clip is reported failed only
when both methods have failed. Method A throwing, being lost (restart / another autoscale
instance), hanging past 12 min, or not being configured all hand the clip to Method B.

## Drawn branding (2026-10-25)
The app's drawn overlay and end screen (Admin → Branding) reach this renderer as URLs in the
job spec: `overlayUrl` (a PNG, as before) and `endScreen` `{cardUrl, seconds, blur, dim, kind}`,
a short VP9-with-alpha card the app draws and puts in Bunny Storage
(`branding/drawn/`, `branding/endscreens/`, content-addressed). `clip_export/endscreen.py`
lays the card over the last seconds (blur, duck, head stream-copied up to a forced keyframe),
mirroring `artifacts/api-server/src/lib/clipBranding/endScreenVideo.ts`. Branding is not part
of the job id, and any failure keeps the plain clip. `exportRevision` (admin re-clips) is part
of the job id, so a re-clip never reuses an older export.

These files match what runs on vps1 as of 2026-10-25 (render.py was 883 lines there; this
folder had been behind it).

## Deploy / update
Copy this folder to vps1 and run `bash deploy.sh`. It installs to `/opt/replay/clip_export/`,
adds two lines to `control.py` (backup taken), a cron file, and restarts `replay-control`
(KillMode=process, so running renders and live jobs are untouched).

## Endpoints (control API, `X-Api-Key`)
`POST /export/clip` · `GET /export/clip/{job}` · `GET /export/clip/{job}/file` (Range) ·
`GET /export/health`

`DELETE /export/clip/{job}` is retained only as a compatibility response and always
returns `405`; it cannot stop a render or delete output/state.

## Operations
- Log: `/var/log/replay-clipexport.log`. State: `/opt/replay/jobs/clipexport/<job>.json`.
- Files: `/opt/replay/exports/<job>.mp4` and
  `/opt/replay/jobs/clipexport/<job>.json` are retained permanently because
  `vps1-export:<job>` references must remain usable. `cleanup.sh` only removes
  abandoned temporary render files and interrupted `.tmp` state writes.
- Daily canary 05:10 UTC (`canary.sh`): renders a 6 s window of the newest recording via the
  real API path, and reports how many user clips fell back to vps1 in the last 24 h (any
  number > 0 means Method A is failing). Alerts go to the ntfy topic in `/etc/replay/alert.env`.
- Kill switch in the app: `BACKUP_EXPORT_DISABLED=1`.
