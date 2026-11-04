#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export NAVARCHNET_STATIC_DIR="$root/dist"
exec "$root/navarchnet" "$@"
