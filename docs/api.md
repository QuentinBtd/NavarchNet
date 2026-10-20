# API v1

Base path: `/api/v1`. JSON requests and responses. All routes require `Authorization: Bearer <access-token>`. All non-GET/HEAD requests require the server-side administrator role. Authentication failure is 401; read-only mutation is 403. Schema/malformed bodies are rejected by Axum; business conflicts are 409. Database failures currently use a sanitized 409 response; distinguishing not-found, transient database failure and topology conflict with stable error codes is remaining work.

Routes:

- `GET /snapshot`: bounded accounts/inventory/networks (up to 500 each), plans/operations (100 recent each), auth mode and effective role. Counts describe returned rows, not total historical database rows. No cursor pagination yet.
- `POST /accounts`: `{name, provider:"fake", role_arn:"fake:..."}`. This executable simulation catalog rejects AWS; real read-only role registration uses the separate `/aws/accounts` catalog.
- `POST /accounts/{id}/discover`: synthetic VPC/subnet/route ownership discovery; increments inventory revision.
- `POST /networks`: `{name}` creates the fixed two-AZ eu-west-1 simulated network/policy.
- `POST /plans`: `ConnectionRequest` with account, VPC, subnet IDs, network and `allow_application_traffic:false`. Returns an immutable plan, actions, versions and digest. Unsupported network/subnet replacement after first apply is rejected.
- `POST /plans/{id}/apply`: `{fault:"none"}` or an explicit fake scenario. Returns the durable operation; repeating the same plan returns the same operation. This is idempotency by immutable plan identity, not an arbitrary client idempotency-key feature.
- `GET /operations/{id}`: durable operation status, current step, current-step attempt count and sanitized provider error.
- `GET /operations/{id}/observation`: calculated simulated path, example TEST-NET public IPs, isolation statement, simulated configuration/drift and active-probe status explicitly untested.
- `GET /operations/{id}/events`: ordered bounded step events (1000) including fence and timestamp.
- `POST /operations/{id}/demo-drift`: demo-auth administrators only; removes one fake managed effect after execution is terminal. Reports drift, does not repair it.
- `GET /audit`: most recent 1000 append-only actor/event/target/timestamp records.

## AWS read-only catalog

`GET /snapshot` also returns `aws_read_only_enabled`, `aws_regions` and `aws_accounts`. These do not change the fake planner/provider. All routes below require authentication; POST additionally requires administrator authorization. Disabled access rejects writes before constructing SDK sessions; reads of saved metadata still work.

- `GET /aws/accounts`: up to 500 public account/region registrations, including role ARN, verified identity and requested session attribution. ExternalId and credentials are never returned.
- `POST /aws/accounts`: `RoleRegistration` with `name`, exact `role_arn`, allowlisted `region`, and optional `external_id`. Unknown fields (including permanent access keys) are rejected. STS AssumeRole/GetCallerIdentity must verify the exact account/role before persistence. This verifies identity, not every EC2/RAM permission.
- `POST /aws/accounts/{id}/discover`: bounded read-only STS/EC2/RAM scan, with an audited discovery generation. A failed, incomplete, timed-out or superseded scan never replaces the prior completed snapshot. Request/response identities must match the selected account and region. No database transaction is held during cloud reads.
- `GET /aws/accounts/{id}/topology`: immutable latest completed `AwsTopology` plus append-only metadata-consent records. `complete_for_supported_queries` means only the documented implemented queries, not complete AWS topology. `execution_enabled` and `connectivity_tested` remain false; discovered resources remain `managed:false`. Reported IPs are not measured egress.
- `POST /aws/accounts/{id}/adoptions`: `AdoptionConsent` with current `topology_id`, `resource_kind` (`vpc` or `transit_gateway`), exact `resource_id`, and non-empty reason (at most 1000 UTF-8 bytes). Requires current completed discovery and matching resource owner. Foreign/shared/unknown-owner resources are rejected. Exact actor/reason/snapshot repetition is idempotent; existing consent cannot be silently overwritten. This grants metadata consent only, not permission to alter routes or AWS resources.

The topology view also includes computed `subnet_route_tables`: explicit subnet associations take precedence over implicit main-table selection. A selection requires one unambiguous, owner-matching VPC/subnet/table and an `associated` association state. Incomplete, conflicting, transitioning, foreign or legacy unknown-state records return a typed unresolved reason. This selects reported associations only, not an effective packet path, safe plan or connectivity result. The calculation never rewrites the immutable snapshot; legacy snapshots deserialize missing association state as unknown.

TGW table resources also include typed `tgw_associations` and `tgw_propagations`. `null` means not queried in that observation, while `[]` means a completed empty read. Each relationship preserves attachment/resource/type/state/announcement metadata without inferring ownership or readiness. Capture and persistence limit their aggregate count to 10,000 separately from the resource count; all scoped calls share the EC2 raw-response byte budget. Historical missing fields remain unknown, not retroactively completed. The UI labels reported transitions and unqueried data explicitly. TGW route contents and effective forwarding remain unsupported.

AWS timestamps are UNIX seconds encoded as strings. Accounts are capped at 500; observations/consents at 10,000 resources and persisted snapshots at 32 MiB. These are hard admission limits, not cursor pagination. The frontend initially renders 200 resources and explicitly offers more. See [onboarding](aws-onboarding.md) for query coverage and unsupported topology.

The authoritative typed JSON structures live in Rust `domain` and `api`; `cargo run --locked --bin export-types` generates `frontend/src/generated.ts`. CI compares regeneration byte-for-byte and type-checks the UI. This prevents structural type drift, not every semantic contract regression; API/browser tests provide independent behavior checks.

`Fault` scenarios are `none`, `throttle`, `persistent_throttle`, `eventual_consistency`, `credential_expiry`, `permission`, `partial_failure`. These simulate provider outcomes; no AWS call or real session expiry is exercised. A probe measurement ingestion route is deliberately not exposed until its authentication/replay/versioning contract is implemented.
