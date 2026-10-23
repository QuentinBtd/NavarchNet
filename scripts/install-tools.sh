#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
root="$PWD/.local/tools"
mkdir -p "$root/bin" "$root/downloads"
case "${1:-}" in
  dist)
    case "$(uname -m)" in
      x86_64) arch=x86_64; digest=4b3f0a5f0ebbdb798f6db649d01b32ba1518376b6f7a0502b7d92b75cc2c8293 ;;
      aarch64|arm64) arch=aarch64; digest=9c554ab21a58ad46eb9b6710f89633ccb26bc2577cf4b0c2d18a5b826a31913e ;;
      *) printf 'Unsupported packaging host\n' >&2; exit 1 ;;
    esac
    archive="cargo-dist-$arch-unknown-linux-gnu.tar.xz"
    curl --fail --silent --show-error --location --proto '=https' "https://github.com/axodotdev/cargo-dist/releases/download/v0.33.0/$archive" -o "$root/downloads/$archive"
    printf '%s  %s\n' "$digest" "$root/downloads/$archive" | sha256sum --check -
    tar -xf "$root/downloads/$archive" -C "$root/downloads"
    cp "$root/downloads/cargo-dist-$arch-unknown-linux-gnu/dist" "$root/bin/dist"
    "$root/bin/dist" --version
    ;;
  deny)
    test "$(uname -m)" = x86_64
    archive=cargo-deny-0.20.2-x86_64-unknown-linux-musl.tar.gz
    curl --fail --silent --show-error --location --proto '=https' "https://github.com/EmbarkStudios/cargo-deny/releases/download/0.20.2/$archive" -o "$root/downloads/$archive"
    printf '%s  %s\n' 9f12ed4c49936e09b48bf862b595cde2fe64fcbd9d74dfacac6131ca824c8d5f "$root/downloads/$archive" | sha256sum --check -
    tar -xf "$root/downloads/$archive" -C "$root/downloads"
    cp "$root/downloads/cargo-deny-0.20.2-x86_64-unknown-linux-musl/cargo-deny" "$root/bin/cargo-deny"
    "$root/bin/cargo-deny" --version
    ;;
  *) printf 'Usage: sh scripts/install-tools.sh dist|deny\n' >&2; exit 2 ;;
esac
