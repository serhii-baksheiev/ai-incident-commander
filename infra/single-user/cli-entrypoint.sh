#!/bin/sh
# Turns AIC_POSTGRES_PASSWORD_FILE (a Docker secret path) into PGPASSWORD
# before the CLI ever runs, so node-postgres reads the password from the
# process environment even though the compose environment's connection
# string (AIC_POSTGRES_URL) carries none.
set -eu

if [ -n "${AIC_POSTGRES_PASSWORD_FILE:-}" ]; then
  PGPASSWORD="$(cat "$AIC_POSTGRES_PASSWORD_FILE")"
  export PGPASSWORD
fi

exec node /app/apps/cli/dist/index.js "$@"
