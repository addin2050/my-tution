#!/usr/bin/env bash
# Safe online backup of the SQLite database (works while the app is running).
# Cron example (daily at 02:30):  30 2 * * * /opt/tuition/backup.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DB="$APP_DIR/data/tuition.db"
OUT_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
sqlite3 "$DB" ".backup '$OUT_DIR/tuition-$STAMP.db'"
gzip "$OUT_DIR/tuition-$STAMP.db"
find "$OUT_DIR" -name 'tuition-*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "Backup written: $OUT_DIR/tuition-$STAMP.db.gz"
# Also copy $OUT_DIR off the server (rclone / scp / rsync), otherwise a disk failure loses both.
