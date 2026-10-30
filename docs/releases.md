# Release packaging and ownership

No release, tag, crates.io package or GHCR image is published during bootstrap. This preview is not AWS V1 complete.

## Implemented dry-run path

cargo-dist 0.33.0 is pinned and downloaded with a verified upstream artifact SHA-256 by `scripts/install-tools.sh`. It builds application archives/checksums for Linux x86_64 and ARM64. `ci=[]` deliberately disables generated publication CI. The package is explicitly dist-enabled while Cargo `publish=false` prevents crate publication. Only the server binary is packaged; the type-export developer binary is excluded. Archives include the built static frontend, startup wrapper, full Apache license, docs and generated third-party notices.

    npm --prefix frontend ci --ignore-scripts
    npm --prefix frontend run build
    sh scripts/install-tools.sh dist
    .local/tools/bin/dist plan --output-format=json
    .local/tools/bin/dist build --artifacts=local --target=x86_64-unknown-linux-gnu
    DATABASE_URL=postgres://... sh scripts/verify-package.sh x86_64-unknown-linux-gnu

The `--artifacts=local` command performs real native compilation and archive generation, not cargo-dist's mock `lies` mode. The verifier checks checksums, required assets/license and absence of developer binaries; with DATABASE_URL it starts the packaged binary and runs the real HTTP/crash journey. Extract the archive and run `sh navarchnet-start.sh` with the documented environment. The wrapper resolves its adjacent `dist/` directory. Distribution binaries have the build host's glibc baseline; record/test the target environment before production support claims.

CI's native x86_64/ARM64 packaging matrix uploads only temporary workflow artifacts. It does not create tags/releases/images. ARM64/container execution is not locally proven merely because configuration exists; see STATUS.md.

## Reviewed version process

A maintainer owns a version/changelog PR: update the Cargo workspace version, frontend package/lock version and CHANGELOG.md together, review schema compatibility/upgrade notes and execute all gates on the release commit. Conventional Commits are preferred. One human-controlled process owns tag creation. cargo-dist owns archive/checksum generation only. No other tool creates tags or GitHub Releases in this bootstrap configuration.

release-plz was evaluated against current documentation. It supports unpublished application crates using `git_only=true`, disables registry publication in that mode, and exposes separate git-tag/git-release controls. It could complement cargo-dist as a release-PR-only tool, but would introduce a second version/tag owner if configured carelessly. For the initial single application, a manual reviewed version PR is simpler. Do not enable release-plz defaults or registry publication without a new ADR.

cargo-dist's generated GitHub workflow normally builds, hosts, publishes and announces on version tags; adding `ci=["github"]` is not a harmless local packaging flag. We inspected the current documented generated behavior and kept it disabled. The generated workflow itself is not claimed to have been fully integration-tested here.

## Publication still requires separate implementation/approval

The first publication automation must be an explicit maintainer-dispatched workflow restricted to a reviewed immutable release commit/tag and protected environment, with gates before publishing. Assign exactly one job/tool to GitHub Release creation and artifact upload; cargo-dist must not race a second release creator. Versioned GHCR images should build from that same commit for linux/amd64 and linux/arm64, include license notices and be read back after upload. Add and verify actual SBOM/provenance attestations, not just badges or filenames.

Current inventory/notices are not signed SBOM/provenance. Container publication, standard SBOM generation and attestation verification remain undelivered. No workflow has package-write/cloud permissions in ordinary PR CI. Do not invoke a manual tag/release/image command during bootstrap.

GitHub's current documentation says GITHUB_TOKEN-generated push/tag events do not trigger downstream workflows. workflow_dispatch/repository_dispatch are exceptions; certain automation-generated PR events can create approval-required runs. Therefore future publication must not depend on an unverified token-created tag triggering a second workflow. A single explicit dispatch avoids this trigger ambiguity without requiring broader credentials.
