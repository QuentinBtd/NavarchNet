# ADR 0004: Bounded AWS read-only observations, not executable inventory

Status: accepted for the development read-only slice; live AWS qualification is unexecuted.

## Context

AWS discovery must not turn fake-provider plans, observed tags or IAM access into permission to mutate an existing network. Ordinary validation must remain credential-free and runnable locally. This host has 2 GiB RAM; the isolated generated `aws-sdk-ec2 = 1.268.0` compile probe was deliberately interrupted under memory/swap pressure (observed rustc RSS 1,627,808 KiB). The probe did not prove an OOM or a successful build. Repeating the full generated EC2 build on this host is not a useful development gate.

## Decision

Use official generated STS/RAM SDK clients and the SDK standard controller credential chain, loaded lazily only after explicit enablement and authenticated administrator admission. Use SDK AssumeRole for 900-second target sessions, exact account/role verification, actor-hash/UUID requested session names, temporary-credential caching/refresh and a compact inline read-only session policy. The policy names only implemented EC2/RAM reads and GetCallerIdentity, explicitly denies other actions, and constrains the selected region with both allow and deny statements. Fixture tests inspect the actual SDK request policy and temporary signing headers; no live IAM evaluation is claimed.

Use a narrowly typed EC2 Query adapter with official `aws-sigv4`, fixed read-only actions and regional HTTPS endpoints. Do not expose arbitrary endpoints/actions through the application API. Retain XML field validation, reject DTD/foreign roots/ambiguous fields, preserve unknown route targets and fail closed. Bound each body to 8 MiB, all EC2 response bodies across pages/retries to 32 MiB, XML depth to 32, nodes to 100,000, pages to 100, tokens to 4096 bytes and observation resources to 10,000. RAM uses official SDK pagination and resource bounds; its raw JSON response bytes are not part of the EC2 counter. Admit one active provider verification/discovery per shared factory. API timeouts include waiting for admission.

Persist role configuration separately from authenticated public metadata, never serialize target credentials, and exclude ExternalId from responses/audit bodies. Store AWS accounts, immutable observations and metadata consent separately from executable fake inventory. An account discovery generation fences late results; incomplete/failed/superseded scans preserve the prior snapshot. Adoption requires current completed discovery, exact resource kind/ID and owner account, administrator consent and an audit reason. Only owned VPC/TGW metadata can be consented; child routes, shared resources and unknown owners are excluded. Every observation remains unmanaged with execution/connectivity disabled.

## Consequences

The adapter is not the generated EC2 client. Query/protocol evolution and retry/error classification need explicit fixture coverage. Reconsider generated EC2 on an adequately sized, authorized isolated build host rather than silently widening resource usage. SDK replay/loopback fixtures and real PostgreSQL exercise contracts, not cloud acceptance or complete credential-chain environments.

This slice cannot infer an effective egress path or isolation from a public IP/resource state. Scoped TGW associations/propagations are now read with the same EC2 byte budget and a separate 10,000-relationship capture/persistence limit; missing legacy fields remain unqueried, not completed empty scans. TGW route contents, full effective route analysis, SG/NACL effects and mutation planning remain separate work. Metadata consent is not a cloud ownership tag or routing grant. Future write execution needs a separately reviewed capability/session boundary and durable external-effect recovery; do not reuse this read-only factory as an execution provider.

See [AWS onboarding](../aws-onboarding.md), [testing](../testing.md) and the dated primary-source ledger in [sources](../sources.md).
