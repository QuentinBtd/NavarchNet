# Delivery status — development preview

NavarchNet is an implemented, locally exercised fake-provider vertical slice, not a completed AWS V1 orchestrator. No AWS API/resource mutation, release/tag publication, crates.io upload or GHCR upload has occurred.

## Implemented and verified locally

- Rust modular backend, PostgreSQL 17.11 persistence/migrations, static TypeScript UI and generated API contract.
- Account registration/discovery → VPC/subnet/regional egress selection → immutable auditable plan → durable execution → result/drift/partial-failure inspection.
- Server-side administrator/read-only authorization, explicit local demo credentials and RS256 OIDC access-token verification. Full browser OIDC login/JWKS rotation is not implemented.
- Durable desired connection intent, common database locking order, scope version/revision checks, queue claims, lease fencing, stale-worker rejection, bounded retry, process-crash/reconnect recovery and report-only drift.
- Conservative refusal of unmanaged routes, overlap, IPv6, cross-region egress, application connectivity and unsafe network/subnet replacement. The logical fake plan is not deployable AWS route programming.
- Fresh executed gates: 14 Rust tests, zero failures/ignored; 4 frontend behavior tests; 2 real Chromium end-to-end tests against backend/PostgreSQL; formatting, Clippy, type/lint/build, generated-type comparison and real HTTP SIGKILL/restart smoke.
- cargo-dist 0.33.0 actual x86_64 release compilation/archive/checksum generation, included UI/license/docs/notices and real packaged-binary PostgreSQL/HTTP crash-recovery smoke. No mock `lies` artifacts used.
- Dependency license/source/advisory policy, npm high-severity audit, generated notices for 365 locally resolved Rust/npm components and workflow syntax lint. SECURITY.md documents the single RSA advisory exception; a passing gate does not mean no advisory exists.
- Independent source review: initial requested changes were addressed; integration review found no blocker for an explicitly incomplete preview PR. Subsequent non-blocking stale-extraction/obsolete-notice findings were corrected with fresh extraction and a failing-then-passing notice check.

## Remote verification and infrastructure boundary

Draft PR: https://github.com/QuentinBtd/NavarchNet/pull/1. Exact branch/workflow/PR writes were read back successfully. Ordinary CI runs on PRs and main with read-only permissions, pinned action SHAs, locked installs and no cloud credentials/publication steps.

First actual CI run: https://github.com/QuentinBtd/NavarchNet/actions/runs/39258272015.

- Backend/PostgreSQL/type/UI/browser verification passed remotely.
- Native x86_64 and ARM64 cargo-dist packaging/checksums and real packaged-binary PostgreSQL/HTTP crash-recovery smoke both passed remotely. These are executed gates, not merely configured targets.
- The production container image built, started with real PostgreSQL, became healthy, served the authenticated API and passed the non-root-user check. The restart gate then failed because that runner's Compose `start` command rejects `--wait`. The workflow correction uses the documented `compose up --no-build --wait --wait-timeout 60 app`; subsequent run results are visible in the PR checks. Do not treat the failed initial restart gate as passed.
- No local Docker/Podman/Buildah/nerdctl runtime or Docker socket was available. Container execution therefore depends on actual CI evidence, not a claimed local run.
- GitHub's unrelated Actions-permissions admin read endpoint returned HTTP 403, but ordinary branch/workflow pushes, PR creation and all four CI jobs were allowed. No authentication change or credential bypass was used.

## Remaining acceptance scope

- Actual AWS SDK standard-chain/AssumeRole onboarding, refresh/session attribution, role verification, paginated live discovery, ownership/adoption and read-only topology.
- Action-level TGW/RAM/zonal-NAT/forward-and-return routing execution, external-side-effect stale-worker/crash recovery and actual isolated multi-account egress acceptance.
- Complete browser OIDC authorization-code/PKCE flow, automatic JWKS rotation, production database privilege separation, cursor pagination/retention and supported safe connection migration/deletion.
- Maintainer-gated publication automation, versioned GHCR images, GitHub Releases and verified standard SBOM/provenance. Container restart correction requires its actual subsequent CI gate; publication is still explicitly unexecuted.
- Authenticated/versioned probe ingestion and deployed probes/automatic failover are future scope; active connectivity remains explicitly untested.

Raw validation logs, independent review verdicts, exact remote write/readbacks and the durable handoff are under `/root/.hermes/navarchnet-autonomy/` for this mission. See docs/testing.md, docs/releases.md and docs/aws-onboarding.md for precise boundaries and remaining procedures.
