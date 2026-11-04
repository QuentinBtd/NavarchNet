#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
case "${1:-}" in x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu) target=$1 ;; *) printf 'Unsupported package target\n' >&2; exit 2 ;; esac
archive="navarchnet-$target.tar.xz"
(cd target/distrib && sha256sum --check "$archive.sha256")
mkdir -p ".local/package-check"
extraction=$(mktemp -d "$PWD/.local/package-check/$target.XXXXXXXX")
tar -xJf "target/distrib/$archive" -C "$extraction"
package="$extraction/navarchnet-$target"
for file in navarchnet navarchnet-start.sh LICENSE README.md dist/index.html docs/configuration.md third-party/components.json; do test -s "$package/$file"; done
cmp LICENSE "$package/LICENSE"
test ! -e "$package/export-types"
file "$package/navarchnet"
printf 'Package verified without publication: %s\n' "$package"
: "${DATABASE_URL:?Set DATABASE_URL for the mandatory real packaged-binary smoke}"
NAVARCHNET_BINARY="$package/navarchnet" NAVARCHNET_STATIC_DIR="$package/dist" node scripts/smoke.mjs
