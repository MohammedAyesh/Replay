#!/bin/bash
# Housekeeping for the backup clip exporter (Method B).
#
# 2026-09-29 (evening): finished exports and their job files are KEPT FOREVER.
# Mohammed: "Clips should never be deleted ever." The 60-day deletion of
# /opt/replay/exports/c*.mp4 and of the job JSONs was removed; the job JSON is
# what the control API checks before serving a file, so deleting it would break
# the clip just as surely as deleting the MP4. Previous version:
# cleanup.sh.bak-20260929-*-keepforever.
#
# Only scratch is cleaned: half-written work files and atomic-write leftovers.
set -u
find /opt/replay/exports/work -maxdepth 1 -type f -mmin +720 -delete 2>/dev/null
find /opt/replay/exports/work/srccache -type f -mmin +720 -delete 2>/dev/null
find /opt/replay/jobs/clipexport -name '*.tmp' -mmin +60 -delete
