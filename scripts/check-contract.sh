#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .local/reports
check=.local/reports/generated.check.ts
trap 'rm -f "$check"' EXIT
cargo run --locked --bin export-types > "$check"
cmp frontend/src/generated.ts "$check"
