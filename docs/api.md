# API v1

Base path: `/api/v1`. JSON requests and responses. All routes require `Authorization: Bearer <access-token>`. All non-GET/HEAD requests require the server-side administrator role. Authentication failure is 401; read-only mutation is 403. Schema/malformed bodies are rejected by Axum; business conflicts are 409. Database failures currently use a sanitized 409 response; distinguishing not-found, transient database failure and topology conflict with stable error codes is remaining work.

Routes:

- `GET /snapshot`: bounded accounts/inventory/networks (up to 500 each), plans/operations (100 recent each), auth mode and effective role. Counts describe returned rows, not total historical database rows. No cursor pagination yet.
- `POST /accounts`: `{name, provider:"fake", role_arn:"fake:..."}`. AWS registration is rejected rather than falsely verified.
- `POST /accounts/{id}/discover`: synthetic VPC/subnet/route ownership discovery; increments inventory revision.
- `POST /networks`: `{name}` creates the fixed two-AZ eu-west-1 simulated network/policy.
- `POST /plans`: `ConnectionRequest` with account, VPC, subnet IDs, network and `allow_application_traffic:false`. Returns an immutable plan, actions, versions and digest. Unsupported network/subnet replacement after first apply is rejected.
- `POST /plans/{id}/apply`: `{fault:"none"}` or an explicit fake scenario. Returns the durable operation; repeating the same plan returns the same operation. This is idempotency by immutable plan identity, not an arbitrary client idempotency-key feature.
- `GET /operations/{id}`: durable operation status, current step, current-step attempt count and sanitized provider error.
- `GET /operations/{id}/observation`: calculated simulated path, example TEST-NET public IPs, isolation statement, simulated configuration/drift and active-probe status explicitly untested.
- `GET /operations/{id}/events`: ordered bounded step events (1000) including fence and timestamp.
- `POST /operations/{id}/demo-drift`: demo-auth administrators only; removes one fake managed effect after execution is terminal. Reports drift, does not repair it.
- `GET /audit`: most recent 1000 append-only actor/event/target/timestamp records.

The authoritative typed JSON structures live in Rust `domain` and `api`; `cargo run --locked --bin export-types` generates `frontend/src/generated.ts`. CI compares regeneration byte-for-byte and type-checks the UI. This prevents structural type drift, not every semantic contract regression; API/browser tests provide independent behavior checks.

`Fault` scenarios are `none`, `throttle`, `eventual_consistency`, `credential_expiry`, `permission`, `partial_failure`. These simulate provider outcomes; no AWS call or real session expiry is exercised. A probe measurement ingestion route is deliberately not exposed until its authentication/replay/versioning contract is implemented.
