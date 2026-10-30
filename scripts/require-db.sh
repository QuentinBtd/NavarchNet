#!/bin/sh
set -eu
: "${DATABASE_URL:?Set DATABASE_URL to a disposable real PostgreSQL database; this gate never skips}"
exec "$@"
