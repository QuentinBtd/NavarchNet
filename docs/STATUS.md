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

## Configured but not yet executed/verified remotely

- Ordinary GitHub Actions on pull requests and main, minimal read-only permissions, pinned action SHAs, locked installs, real PostgreSQL services, browser/HTTP smoke, non-root container demo and native x86_64/ARM64 packaging jobs.
- Multi-stage production Dockerfile and isolated local Compose deployment. No Docker/Podman/Buildah/nerdctl runtime or Docker socket was available on this host, so local container execution is unverified.
- Native ARM64 packaging/execution is unverified; this host has only x86_64 Linux and Windows Rust targets installed. A configured ARM target is not an executed gate.
- GitHub's Actions-permissions read endpoint returned HTTP 403 `Resource not accessible by personal access token`. That does not establish whether ordinary Git pushes/workflow updates are allowed; exact write/readback results are retained in the mission artifacts.

## Remaining acceptance scope

- Actual AWS SDK standard-chain/AssumeRole onboarding, refresh/session attribution, role verification, paginated live discovery, ownership/adoption and read-only topology.
- Action-level TGW/RAM/zonal-NAT/forward-and-return routing execution, external-side-effect stale-worker/crash recovery and actual isolated multi-account egress acceptance.
- Complete browser OIDC authorization-code/PKCE flow, automatic JWKS rotation, production database privilege separation, cursor pagination/retention and supported safe connection migration/deletion.
- Maintainer-gated publication automation, versioned GHCR images, GitHub Releases, verified standard SBOM/provenance and full release-platform/container acceptance.
- Authenticated/versioned probe ingestion and deployed probes/automatic failover are future scope; active connectivity remains explicitly untested.

Raw validation logs, independent review verdicts, exact remote write/readbacks and the durable handoff are under `/root/.hermes/navarchnet-autonomy/` for this mission. See docs/testing.md, docs/releases.md and docs/aws-onboarding.md for precise boundaries and remaining procedures.
