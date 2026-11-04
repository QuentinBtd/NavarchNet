# NavarchNet

A self-hosted Rust/PostgreSQL network orchestration development preview. The working application provides a credential-free fake-provider journey from account registration and VPC discovery to an immutable plan, durable execution, result inspection, partial failure and drift reporting.

This is not yet a complete AWS V1 implementation. AWS onboarding and read-only discovery are implemented behind explicit OIDC-only enablement and a region allowlist; AWS mutation is disabled. Saved AWS topology and audited VPC/TGW metadata consent are separate from executable simulation plans. SDK replay/loopback/PostgreSQL fixtures exercise this slice, not a live account. No fake-provider result or provider-reported public IP proves AWS connectivity. Existing connection network/subnet replacement is rejected until a safe migration workflow exists.

## Quickstart

Prerequisites: Rust 1.99.0, Node 24.22.0, PostgreSQL 17, or Docker Compose v2. There is no JavaScript runtime dependency in the production server.

For the isolated container demo:

    cp .env.example .env
    # Replace both demo tokens and the database password with local random values.
    docker compose up --build --wait

Open http://127.0.0.1:8080. Enter the configured administrator token. Register a fake account, discover VPCs, create a regional network, select subnets, generate a plan, review its actions and apply. Refresh operation history, inspect results, then simulate external drift. The scenario selector demonstrates throttling, eventual consistency, expired sessions, permission denial and partial completion. Use the reader token to verify read-only access.

Without containers, provide a disposable PostgreSQL database and run:

    export DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5432/navarchnet
    export NAVARCHNET_AUTH_MODE=demo
    export NAVARCHNET_ADMIN_TOKEN=YOUR_RANDOM_TOKEN_AT_LEAST_32_BYTES
    export NAVARCHNET_READER_TOKEN=A_DIFFERENT_RANDOM_TOKEN_AT_LEAST_32_BYTES
    npm --prefix frontend ci --ignore-scripts
    npm --prefix frontend run build
    cargo run --locked --bin navarchnet

The listener defaults to 127.0.0.1:8080. Migrations run at startup. Demo authentication requires explicit opt-in and loopback binding unless isolated container networking is explicitly enabled.

## Validation

    mise install
    mise run frontend-install
    mise run hooks-install
    mise run browser-install
    DATABASE_URL=postgres://... mise run full

The exact `.mise.toml` pins the toolchain and shares validation between local development and opt-in CI. `prek` installs a fast pre-commit hook and a complete local pre-push hook. `mise run full` runs workflow-policy checks, formatting, Clippy, every Rust test (including real PostgreSQL), generated API type comparison, locked frontend installation, type checking, lint, behavior tests, production builds, HTTP/process-crash smoke, security/license checks and real browser tests. Missing database/browser prerequisites fail, never silently skip. `sh scripts/check.sh` remains an alias for `mise run check` (the source/build/crash subset).

Heavy GitHub Actions are manual-only through `workflow_dispatch`, with separate verify/container/package choices. Pushes and PRs do not repeatedly build Rust/SDKs, databases, browsers or ARM64 packages. Use the local mise tasks first; Actions are not a development test host. No cloud credentials are needed. See docs/testing.md for the full local/qualification boundary and docs/STATUS.md for actual delivery status.

## Documentation

- docs/architecture.md and docs/adr/: module boundaries, persistence and safety choices
- docs/configuration.md: authentication, configuration and OIDC access-token integration
- docs/api.md: versioned API and generated TypeScript contract
- docs/aws-onboarding.md: opt-in AWS read-only scope, role/session policy, routing/RAM prerequisites and unexecuted live qualification
- docs/operations.md: shutdown, diagnosis, recovery, backup and upgrades
- docs/testing.md: local/CI tests and opt-in AWS acceptance
- docs/floci-evaluation.md: pinned optional emulator coverage/gaps and unexecuted provider compatibility
- docs/releases.md: packaging dry runs and explicit publication ownership
- docs/sources.md: primary source and decision ledger
- SECURITY.md and CONTRIBUTING.md

## License

Original NavarchNet code is Apache-2.0; see the complete standard LICENSE. Apache-2.0 permits commercial use and hosted services subject to its terms. Third-party code retains its own licenses. No trademark or package-name availability claim is made.
