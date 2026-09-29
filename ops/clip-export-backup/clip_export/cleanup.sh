#!/bin/bash
# Retention for the backup clip exporter (Method B). Added 2026-09-29.
# A finished export is kept 60 days. If a user downloads after that, the app's
# verify step sees the file gone and re-renders it (Method A first, then B), so
# expiry here never becomes a failed download -- as long as the recording is
# still on Bunny Stream (14 days). Kept longer than that on purpose.
set -u
find /opt/replay/exports -maxdepth 1 -name 'c*.mp4' -mtime +60 -delete
find /opt/replay/exports/work -type f -mmin +720 -delete 2>/dev/null
find /opt/replay/jobs/clipexport -name '*.json' -mtime +60 -delete
find /opt/replay/jobs/clipexport -name '*.tmp' -mmin +60 -delete
