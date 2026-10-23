#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
command -v mise >/dev/null 2>&1 || { printf 'Install mise, then run mise install and mise run check\n' >&2; exit 2; }
exec mise run check
