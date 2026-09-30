#!/bin/sh
set -eu
: "${CONTAINER:?}" "${BACKUP_FILE:?}" "${RESTORE_DATABASE:?}"
case "$RESTORE_DATABASE" in restore_[a-zA-Z0-9_]*) ;; *) echo 'Restore into a new restore_ database first.' >&2; exit 1;; esac
case "$CONTAINER:$RESTORE_DATABASE" in *[!a-zA-Z0-9_:.-]*) exit 1;; esac
sha256sum -c "$BACKUP_FILE.sha256"
# createdb must fail if the destination already exists.
docker exec "$CONTAINER" createdb -U postgres "$RESTORE_DATABASE"
docker exec -i "$CONTAINER" pg_restore -U postgres -d "$RESTORE_DATABASE" --exit-on-error < "$BACKUP_FILE"
printf 'Restored into %s; verify records before changing any service connection.\n' "$RESTORE_DATABASE"
