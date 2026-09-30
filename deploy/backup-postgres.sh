#!/bin/sh
set -eu
: "${CONTAINER:?}" "${DATABASE:?}" "${BACKUP_DIRECTORY:?}"
case "$CONTAINER:$DATABASE" in *[!a-zA-Z0-9_:.-]*) exit 1;; esac
mkdir -p "$BACKUP_DIRECTORY"
chmod 700 "$BACKUP_DIRECTORY"
umask 077
backup="$BACKUP_DIRECTORY/$DATABASE-$(date -u +%Y%m%dT%H%M%SZ).dump"
trap 'rm -f "$backup.partial"' EXIT
docker exec "$CONTAINER" pg_dump -U postgres -d "$DATABASE" -Fc > "$backup.partial"
[ -s "$backup.partial" ]
mv "$backup.partial" "$backup"
sha256sum "$backup" > "$backup.sha256"
printf '%s\n' "$backup"
