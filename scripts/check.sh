#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?Set DATABASE_URL to a disposable real PostgreSQL database}"
export CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 RUST_TEST_THREADS=1
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo run --locked --bin export-types > frontend/src/generated.check.ts
trap 'rm -f frontend/src/generated.check.ts' EXIT
cmp frontend/src/generated.ts frontend/src/generated.check.ts
rm frontend/src/generated.check.ts
npm --prefix frontend ci --ignore-scripts --no-fund
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend run build
cargo build --locked --bin navarchnet
node scripts/smoke.mjs
