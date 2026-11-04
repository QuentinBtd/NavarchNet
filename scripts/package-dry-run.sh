#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?Set DATABASE_URL to a disposable real PostgreSQL database}"
case "$(uname -m)" in x86_64) native=x86_64-unknown-linux-gnu ;; aarch64|arm64) native=aarch64-unknown-linux-gnu ;; *) printf 'Unsupported native packaging host\n' >&2; exit 2 ;; esac
export DIST_TARGET="${DIST_TARGET:-$native}"
test "$DIST_TARGET" = "$native" || { printf 'Package verification requires a matching native execution host\n' >&2; exit 2; }
mise run frontend-install
mise run frontend-build
sh scripts/install-tools.sh dist
mkdir -p .local/reports
.local/tools/bin/dist plan --output-format=json > .local/reports/dist-plan.json
.local/tools/bin/dist build --artifacts=local --target="$DIST_TARGET"
sh scripts/verify-package.sh "$DIST_TARGET"
