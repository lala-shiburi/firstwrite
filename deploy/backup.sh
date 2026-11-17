#!/usr/bin/env bash
set -Eeuo pipefail

backup_type="${1:-daily}"
case "$backup_type" in
  daily|pre-migration) ;;
  *)
    printf '%s\n' 'Usage: deploy/backup.sh [daily|pre-migration]' >&2
    exit 2
    ;;
esac

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
compose_dir="${COMPOSE_DIR:-$(cd -- "$script_dir/.." && pwd)}"
backup_config="${BACKUP_CONFIG:-/etc/firstwrite/backup.env}"

if [[ ! -r "$backup_config" ]]; then
  printf 'Backup configuration is missing or unreadable: %s\n' "$backup_config" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$backup_config"

: "${AGE_RECIPIENT:?AGE_RECIPIENT must be configured}"
: "${RCLONE_REMOTE:?RCLONE_REMOTE must be configured}"
: "${ALERT_WEBHOOK_URL:?ALERT_WEBHOOK_URL must be configured}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary_backup="$(mktemp "${TMPDIR:-/tmp}/firstwrite-backup.XXXXXX")"
trap 'rm -f -- "$temporary_backup"' EXIT

send_failure_alert() {
  local exit_code=$?
  if (( exit_code != 0 )); then
    printf '%s\n' "First Write $backup_type backup failed on $(hostname -s) at $(date -u +%FT%TZ)." >&2
    curl --silent --show-error --fail \
      --data-urlencode "text=Morning Pages $backup_type backup failed on $(hostname -s) at $(date -u +%FT%TZ)." \
      "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 || printf '%s\n' 'Backup failure alert delivery failed.' >&2
  fi
  exit "$exit_code"
}
trap send_failure_alert ERR

cd "$compose_dir"
docker compose exec -T db sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  | age --encrypt --recipient "$AGE_RECIPIENT" >"$temporary_backup"

if [[ "$backup_type" == pre-migration ]]; then
  remote_path="$RCLONE_REMOTE/pre-migration/firstwrite-$timestamp.dump.age"
else
  remote_path="$RCLONE_REMOTE/daily/firstwrite-$timestamp.dump.age"
fi
rclone copyto "$temporary_backup" "$remote_path" --immutable

if [[ "$backup_type" == daily && "$(date -u +%u)" == 7 ]]; then
  rclone copyto "$temporary_backup" "$RCLONE_REMOTE/weekly/firstwrite-$timestamp.dump.age" --immutable
fi

if [[ "$backup_type" == daily ]]; then
  rclone delete "$RCLONE_REMOTE/daily" --min-age 14d --rmdirs
  rclone delete "$RCLONE_REMOTE/weekly" --min-age 56d --rmdirs
fi

printf 'Encrypted %s backup uploaded: %s\n' "$backup_type" "$remote_path"
