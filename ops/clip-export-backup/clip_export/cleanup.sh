#!/bin/bash
# Cleanup for the backup clip exporter (Method B). Added 2026-09-29.
# Finished MP4s and their job records are permanent: vps1-export references
# must remain valid. Only abandoned temporary render files are cleaned up.
set -u
find /opt/replay/exports/work -type f -mmin +720 -delete 2>/dev/null
# A .tmp state file is an interrupted atomic write, not a job record.
find /opt/replay/jobs/clipexport -name '*.tmp' -mmin +60 -delete
