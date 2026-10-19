# ADR 0003: packaging without publication automation

Status: accepted for bootstrap, October 19, 2026.

Use cargo-dist 0.33.0 as an actual archive/checksum builder. Distribute the frontend beside the binary with a path-resolving wrapper. Keep Cargo `publish=false`, enable dist explicitly, select only the server binary and configure Linux x86_64/ARM64 native package jobs. Ordinary PR/main CI remains read-only and cloud-credential-free.

Do not install cargo-dist's default tag-triggered build/host/publish/announce workflow during bootstrap. `ci=[]` means local packaging only. A temporary Actions artifact is not a GitHub Release or registry publication.

Current release-plz supports `git_only=true` for Cargo publish=false applications and separate tag/release flags. This is compatible in principle with a release-PR-only role, but a single manual version/changelog PR is more maintainable initially. One maintainer owns version/tag decisions; cargo-dist only owns packaging until separately approved publication automation assigns a single release/artifact owner.

This deliberately leaves publication/provenance/GHCR acceptance incomplete rather than granting untested write permissions or publishing a bootstrap release. See docs/releases.md for the precise remaining requirements and GITHUB_TOKEN event limitations.
