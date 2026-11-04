#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${DATABASE_PASSWORD:?Set a disposable demo database password}"
: "${NAVARCHNET_ADMIN_TOKEN:?Set an ephemeral demo admin token}"
: "${NAVARCHNET_READER_TOKEN:?Set a different ephemeral demo reader token}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-navarchnet-qualification}"
case "$COMPOSE_PROJECT_NAME" in navarchnet-*) ;; *) printf 'Only a separate navarchnet-* Compose project is allowed\n' >&2; exit 2 ;; esac
cleanup() {
  status=$?
  trap - EXIT
  docker compose down --volumes || { cleanup_status=$?; test "$status" -ne 0 || status=$cleanup_status; }
  exit "$status"
}
trap cleanup EXIT
docker compose config --quiet
docker compose up --build --wait --wait-timeout 180
curl --fail http://127.0.0.1:8080/readyz
curl --fail --silent -H "Authorization: Bearer $NAVARCHNET_READER_TOKEN" http://127.0.0.1:8080/api/v1/snapshot > /dev/null
test "$(docker compose exec -T app id -u)" = 65532
docker compose stop app
docker compose up --no-build --wait --wait-timeout 60 app
curl --fail http://127.0.0.1:8080/readyz
