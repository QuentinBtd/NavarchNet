# Testing and acceptance boundaries

## Mandatory local/PR gates

Set DATABASE_URL to a disposable real PostgreSQL 17 database, then run `sh scripts/check.sh`. It runs Rust formatting/Clippy, unit/property tests, actual PostgreSQL migrations/coordination/recovery tests, generated Rust/TypeScript contract comparison, locked npm installation, type checking/lint/behavior tests, production frontend build and a real HTTP/process restart smoke. There is no PostgreSQL skip mode. Additional PostgreSQL schema creation privileges are required for isolated integration schemas; never point tests at production.

`npm --prefix frontend run e2e` runs Playwright against the production-built frontend and a spawned Rust server, backed by the same real disposable database. Install Chromium with the pinned Playwright package first. The central journey registers/discovers an account, selects VPC/subnets/egress, reviews/applies a plan, inspects convergence/untested probes, injects drift and observes partial failure. A second browser test checks read-only UI/API authorization. Session unit tests reject delayed responses after logout.

`sh scripts/install-tools.sh deny` and `.local/tools/bin/cargo-deny --locked check` enforce advisory/license/source policy. SECURITY.md documents the single RSA advisory exception and review date. `npm --prefix frontend audit --audit-level=high` fails high/critical npm advisories. `node scripts/notices.mjs --check` verifies generated dependency notices. It is an attribution/component inventory, not a signed or complete standard SBOM/provenance attestation.

`sh scripts/install-tools.sh dist`, `.local/tools/bin/dist build --artifacts=local --target=x86_64-unknown-linux-gnu` and `sh scripts/verify-package.sh x86_64-unknown-linux-gnu` exercise packaging without publication. Set DATABASE_URL for the package verifier to also run the real packaged-binary HTTP/crash smoke. ARM64 uses its own native runner/target; a configured target is not an executed ARM64 test.

## What tests establish

Domain tests establish conservative logical plan ordering/rejection, not actual EC2 route programming. PostgreSQL tests establish immutable records, scope serialization, simultaneous apply idempotency, independent claims, stale-worker rejection, revision invalidation, retry persistence, partial conflicts, drift and reconnect recovery. The HTTP smoke SIGKILLs an unfinished application process, restarts it, waits for durable completion, verifies idempotent reapplication and then checks drift/partial failure. A fake effect and progress commit atomically in PostgreSQL; AWS effects cannot inherit that property.

Independent source review found real lock-order, connection replacement/effect-conflict and logout race defects. Regression tests and conservative unsupported-change rejection address them. The first frontend browser run also found an illegal native fetch binding; it was fixed and the real browser journey rerun. Raw mission validation logs live outside the repository; STATUS.md records the final gate boundary, not an invented coverage percentage.

## Opt-in AWS acceptance — NOT RUN and not implemented as a passing suite

No cloud acceptance workflow or implicit credential-chain invocation is configured. Until SDK discovery/execution and action-level ownership are implemented, the following is a required future acceptance procedure, not an executable success claim.

1. Obtain separate explicit authorization for a disposable network account and two disposable application accounts, one specified region and two AZ IDs. Register exact role ARNs/ExternalIds, spending limits, resource inventory tags and cleanup owner. Capture a cost estimate and baseline resources/routes before mutation.
2. Verify standard-chain controller identity, target AssumeRole identities, role capabilities, RAM organization/invitation flows and attachment acceptance. Test pagination and supported/unsupported ownership/topology. No production account shortcuts.
3. Create or explicitly adopt the approved zonal public managed-NAT regional design. Review each forward/return route and isolation rule. Apply with operation/client tokens and ownership tags.
4. Deploy authorized disposable probe workloads in each application account/AZ. Verify actual IPv4 Internet egress/public IPs and return traffic using independent endpoints. Record results per AZ/account. Check that application A cannot reach B by default; allow shared services only under a separate explicit policy.
5. Reapply and restart controllers mid-operation. Verify no duplicate resources, no old-worker mutations after takeover, bounded throttling/session retries, permission/partial failure recovery and stale-plan invalidation. Inject a bounded manual managed-route change and confirm report-only drift before any repair.
6. Inventory every created/adopted resource and actual billable components. Remove only explicitly test-owned resources in dependency-safe order, preserve pre-existing resources, and verify through a read-back inventory that no NAT/TGW/EIP/compute/share/probe resource remains billable. Document any manual recovery and residual cost.

Attach exact account/region/AZ inventory, command/API evidence, probe outputs, costs and cleanup readbacks to the eventual acceptance report. Do not equate a simulator, API-success response, missing heartbeat or a calculated path with tested connectivity.
