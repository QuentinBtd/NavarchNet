# Primary source and decision ledger

Checked October 19, 2026 during bootstrap. This ledger records implementation decisions, not permission to access AWS or publish. Registry metadata and actual CLI/build outputs were checked before pins. Raw research/validation evidence for the implementation mission is retained outside the checkout at `/root/.hermes/navarchnet-autonomy/`.

| Source | Verified fact / decision |
| --- | --- |
| https://docs.rs/axum/0.8.9/axum/ and `cargo info axum@0.8.9` | Current selected Axum API; Rust support compatible with pinned 1.99.0. |
| https://docs.rs/sqlx/0.9.0/sqlx/ and `cargo info sqlx@0.9.0` | SQLx 0.9.0 requires Rust 1.94+, uses explicit safe/dynamic SQL wrappers; bind parameters used for user values; real migrations/tests executed. |
| https://docs.rs/tokio/1.53.3/tokio/ and registry metadata | Selected runtime features, no unnecessary full runtime feature set. |
| https://docs.rs/ts-rs/12.0.1/ts_rs/ | Type declaration generation uses the version's Config API, verified by actual generation/type checking. |
| https://docs.rs/jsonwebtoken/11.1.0/jsonwebtoken/ | RS256 validation, required issuer/audience/time claims and explicit application roles. Signed positive/negative tests executed. |
| https://nodejs.org/dist/index.json and https://nodejs.org/dist/v24.22.0/SHASUMS256.txt | Node 24.22.0 LTS binary selected and checksum verified. npm registry metadata verified TypeScript 7.0.2, Vite 8.3.4, Vitest 5.0.5, jsdom 30.1.3, Biome 2.5.15 and Playwright 1.64.1 before pinning. |
| https://www.apache.org/licenses/LICENSE-2.0.txt | Complete standard text downloaded unmodified as LICENSE. No invented holder. |
| https://docs.aws.amazon.com/whitepapers/latest/building-scalable-secure-multi-vpc-network-infrastructure/using-nat-gateway-for-centralized-egress.html | Forward/return routing and TGW table separation; same-AZ zonal NAT topology; extra TGW processing means no blanket saving claim. |
| https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html and https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateways-regional.html | Public versus private NAT; current regional NAT mode is materially different from zonal NAT, supports TGW return routes and may take up to 60 minutes to expand. ADR 0002 explicitly chooses zonal public NAT first. |
| https://docs.aws.amazon.com/vpc/latest/tgw/working-with-transit-gateways.html | RAM sharing, owner-versus-consumer API boundaries, shared-subnet ownership and AZ-ID mapping. Live AWS behavior remains unexecuted. |
| https://docs.aws.amazon.com/sdk-for-rust/latest/dg/credproviders.html | Standard controller chain and SDK temporary sessions; implemented lazily behind opt-in OIDC-only read access, not exercised with ambient/live credentials. Replay fixtures verify AssumeRole, identity, signing credentials and session policy. |
| https://docs.docker.com/reference/cli/docker/compose/up/ | Current documented `up --no-build --wait --wait-timeout` replaces a runner-rejected `start --wait`; real initial CI failure is retained, not downgraded. |
| https://fck-nat.dev/configuration/ | Future ENI/EIP identity/HA integration, not a deployed NAT replacement; no throughput or savings invented. |
| https://axodotdev.github.io/cargo-dist/book/ and https://axodotdev.github.io/cargo-dist/book/reference/config.html | Current default generated workflow builds/hosts/publishes/announces; explicitly use ci=[] and real local builds. Config/workspace/member syntax was verified against current docs and actual 0.33.0 CLI. |
| https://github.com/axodotdev/cargo-dist/releases/tag/v0.33.0 | Verified selected CLI release and archive checksums. x86_64 SHA-256 4b3f0a5f0ebbdb798f6db649d01b32ba1518376b6f7a0502b7d92b75cc2c8293; ARM64 SHA-256 9c554ab21a58ad46eb9b6710f89633ccb26bc2577cf4b0c2d18a5b826a31913e. |
| https://release-plz.dev/docs/config | git_only supports publish=false application crates; separate tag/release ownership controls. Evaluated but not enabled; manual version PR selected. |
| https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow | Current GITHUB_TOKEN push/tag suppression and dispatch exceptions; some automated PR runs require approval. Avoid assuming a token-created tag triggers publication. |
| https://docs.github.com/en/actions/reference/runners/github-hosted-runners | Public native ubuntu-24.04 and ubuntu-24.04-arm runners selected, not an unverified custom host. |
| https://embarkstudios.github.io/cargo-deny/ and https://github.com/EmbarkStudios/cargo-deny/releases/tag/0.20.2 | CLI selected and SHA-256 9f12ed4c49936e09b48bf862b595cde2fe64fcbd9d74dfacac6131ca824c8d5f verified. Current online docs include an advisory-ignore allow field unsupported by the pinned release; actual CLI rejected it, so only verified id/reason syntax is used. |
| https://rustsec.org/advisories/RUSTSEC-2023-0071.html | Exact still-unpatched RSA private-key timing advisory; documented public-verification-only/runtime and ephemeral local-test exception. Passing policy is not an absence-of-advisories claim. |
| Locked upstream `webpki-roots` LICENSE and Lightning CSS LICENSE/package metadata | Preserve CDLA-Permissive-2.0 trust-data text and unmodified MPL-2.0 build-tool notices; original code remains Apache-2.0. |

Official Docker Hub API tag records were read before pinning multi-architecture image-index digests:

- `library/postgres:17.11-bookworm`: sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826
- `library/rust:1.99.0-slim-bookworm`: sha256:2c3a22f0a5533ea2dd5a16627bc841228151faa2d4de2644ac9987e4a2f1f2fa
- `library/node:24.22.0-bookworm-slim`: sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
- `library/debian:bookworm-slim`: sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

GitHub action tag refs were resolved from their actual primary repositories with `git ls-remote` before copying full SHAs into CI: checkout v6, setup-node v6, rust-cache v2 and upload-artifact v4. No mutable action tag is used in the workflow.

## Local-first and AWS read-only continuation — October 19, 2026

| Primary source | Checked decision / boundary |
| --- | --- |
| https://mise.jdx.dev/configuration.html and https://mise.jdx.dev/tasks/ | Exact `.mise.toml`, exact Rust/Node/prek/actionlint versions and one shared set of local/opt-in CI tasks. Installed tool linking and actual task/hook execution were verified, not inferred from configuration. |
| https://prek.j178.dev/ and https://github.com/j178/prek/releases/tag/v0.5.6 | Selected prek 0.5.6; actual CLI uses `--stage`, validates the configuration and installs/runs pre-commit and full pre-push hooks locally. |
| https://github.com/jdx/mise-action/tree/fc42bcc7ddbf51124c30f95a877a0c5168a3bfde | Selected pinned action/config inputs, explicit mise version, GitHub token persistence disabled. Manual-only workflow policy is locally tested; no new Actions run qualifies this continuation. |
| https://docs.rs/aws-config/1.12.0/aws_config/sts/struct.AssumeRoleProvider.html and https://docs.rs/aws-sdk-sts/1.119.0/aws_sdk_sts/ | Official SDK typed AssumeRole, ExternalId/session-name/session-policy configuration and GetCallerIdentity. Exact APIs were checked against downloaded source and replayed requests. No live credential-chain or IAM evaluation claim. |
| https://docs.rs/aws-sdk-ram/1.116.0/aws_sdk_ram/ | Official typed sharing/resource/principal/invitation reads, both ownership contexts and paginated fixtures. TGW resource/principal filters do not classify every share/invitation as a TGW. |
| https://docs.rs/aws-sigv4/1.6.0/aws_sigv4/ and https://docs.aws.amazon.com/AWSEC2/latest/APIReference/Query-Requests.html | Signed EC2 Query adapter with temporary token headers; generated EC2 compile probe was deliberately stopped for resource pressure. See ADR 0004; not a generated EC2-client success or an OOM claim. |
| https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html and https://docs.aws.amazon.com/service-authorization/latest/reference/list_ram.html | Current canonical references: the 9 selected EC2 Describe and 4 RAM read/list actions have empty resource-type columns. Saved HTML was parsed and all 13 names matched; use exact actions/region constraints and Resource `*`, not wildcard actions. Older long service slugs returned a generic reference redirect and were not treated as usable action tables. |
| https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html#condition-keys-requestedregion | `aws:RequestedRegion` is an endpoint-region condition, not a guarantee against every service's cross-region effects. Applied to the exact read-only action set. |
| https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_notaction.html | Explicit Deny with NotAction excludes the named read/identity actions; separate allow and wrong-region-deny statements are sent in the inline session policy. Local tests inspect serialized policy shape; no live IAM evaluation was run. |
| https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html | AWS documents identity retrieval as requiring no permissions. Account/assumed-role identity and temporary signing headers are verified in fixtures, not in a real account. |

Current local source evidence is separate from the historical remote fake-only CI/archives. Public/private provider-reported IP addresses and available resource states are observations, not active egress/isolation measurements. No AWS resource, invitation acceptance, release or package publication occurred.

## Observed subnet associations and optional Floci — October 19, 2026

- https://docs.aws.amazon.com/vpc/latest/userguide/subnet-route-tables.html and https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_RouteTableAssociation.html: explicit subnet associations versus implicit main table, absent implicit subnet IDs and optional association state. The implementation selects reported configuration conservatively, keeps missing/transitioning state unresolved, and does not infer a verified packet path.
- https://github.com/floci-io/floci/tree/ee15f502bfc017861b67b076b82e1ccd032c7129: pinned release 2.3.0 source and OCI source-revision label verified. Exact dispatch inventory and gaps, stale TGW documentation, actual native startup/retirement and the unexecuted provider-compatibility boundary are recorded in [Floci evaluation](floci-evaluation.md). This does not replace deterministic faults or real AWS multi-account/two-AZ acceptance.
- https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_GetTransitGatewayRouteTableAssociations.html and https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_GetTransitGatewayRouteTablePropagations.html: exact required table ID, response collection names, continuation tokens and MaxResults range checked from primary Markdown. Typed association/propagation fields preserve unknown types and transitional states. These two exact read actions were added to the bounded inline session policy; no route-content or live IAM qualification is implied. The current primary service-authorization table also has empty resource-type columns for these actions.
