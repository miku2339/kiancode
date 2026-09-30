#!/bin/sh
set -eu
app_password=$(cat /run/secrets/app_password)
case "$APP_DATABASE:$APP_USER:$app_password" in *[!a-z0-9_:]*) echo 'Invalid database bootstrap configuration' >&2; exit 1;; esac
printf "CREATE ROLE %s LOGIN PASSWORD '%s';\nCREATE DATABASE %s OWNER %s;\nREVOKE ALL ON DATABASE %s FROM PUBLIC;\n" "$APP_USER" "$app_password" "$APP_DATABASE" "$APP_USER" "$APP_DATABASE" | psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1
unset app_password
