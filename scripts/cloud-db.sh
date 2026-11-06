#!/usr/bin/env bash
# Postgres for environments without Docker (cloud sessions): installs it if missing,
# starts it on 127.0.0.1:5434, creates the owner role and writes .env with random values.
# Throwaway: only for running tests and the dev server in a sandbox.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  as_pg() { runuser -u postgres -- "$@"; }
else
  SUDO="sudo"
  as_pg() { sudo -u postgres "$@"; }
fi

if ! ls /usr/lib/postgresql/*/bin/pg_ctl >/dev/null 2>&1; then
  $SUDO apt-get update -qq
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq postgresql >/dev/null
fi
BIN=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
DATA=/tmp/gestionale-pg
PORT=5434

if [ ! -f "$DATA/PG_VERSION" ]; then
  $SUDO mkdir -p "$DATA"
  $SUDO chown postgres:postgres "$DATA"
  as_pg "$BIN/initdb" -D "$DATA" -A trust -U postgres >/dev/null
fi
if ! as_pg "$BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
  as_pg "$BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -l "$DATA/log" -w start >/dev/null
fi

if [ ! -f .env ]; then
  rnd() { node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; }
  OWNER=$(rnd); APP=$(rnd); AUTH=$(rnd); CSRF=$(rnd)$(rnd)
  sed -e "s/CHANGE_ME_OWNER/$OWNER/g" -e "s/CHANGE_ME_APP/$APP/g" -e "s/CHANGE_ME_AUTH/$AUTH/g" \
    -e "s/CHANGE_ME_AT_LEAST_32_CHARACTERS_LONG/$CSRF/" .env.example > .env
  chmod 600 .env
fi
OWNER=$(sed -n 's/^DB_OWNER_PASSWORD=//p' .env)

psql -h 127.0.0.1 -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -q <<SQL
do \$\$ begin
  if not exists (select from pg_roles where rolname = 'gestionale_owner') then
    create role gestionale_owner login superuser password '$OWNER';
  else
    alter role gestionale_owner password '$OWNER';
  end if;
end \$\$;
select 'create database gestionale owner gestionale_owner'
where not exists (select from pg_database where datname = 'gestionale') \gexec
SQL
echo "Postgres pronto su 127.0.0.1:$PORT, .env scritto"
