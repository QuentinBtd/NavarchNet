# Security policy

This is an early development preview, not a production AWS control plane. Only fake-provider registration/execution is enabled. Do not grant it cloud credentials or expose the demo listener publicly.

Report vulnerabilities privately through the repository's GitHub security advisory feature if enabled. No private email address or guaranteed response SLA is asserted. Do not include credentials in public issues. Rotate leaked credentials through the relevant provider; never paste permanent AWS keys into NavarchNet.

## Boundaries

All API reads require a bearer credential. Every API mutation requires administrator authorization on the server. Tokens remain only in browser memory; session changes abort requests and discard delayed responses. Content is rendered as text, with a restrictive CSP and no CORS opt-in. Run behind TLS, limit inbound request rates at the proxy, restrict database access, and supply database transport encryption outside the local container demo.

OIDC mode validates RS256 signatures using an operator-supplied public PEM, issuer, audience, expiration, optional not-before and explicit application roles. It is access-token validation, not a complete browser authorization-code/PKCE login client. There is no automatic JWKS discovery/rotation; replace the trusted public key and restart during a controlled rotation. Do not substitute an ID token for an access token or trust reverse-proxy identity headers directly. See docs/configuration.md.

The database migration identity is powerful. Append-only triggers defend against accidental application writes, not malicious database owners. Separate migration/runtime database privileges before production deployment. Audit and event retention are currently unbounded; back up and size the database accordingly. Lists are bounded, not full-history pagination.

## Dependency policy

Run cargo-deny 0.20.2 checks and npm audit at the high threshold. Unknown registries/Git dependencies and unapproved licenses fail. Duplicate Rust major versions warn because the verified SQLx/JWT graph currently requires them; do not silence actual vulnerabilities with a blanket allow. Review pins, action revisions and base-image digests in dependency PRs. Review new advisories promptly and before release.

One explicit exception: RUSTSEC-2023-0071 (rsa 0.9.10, Marvin private-key timing attack). The current production API only verifies public RSA signatures; it never signs or decrypts with an RSA private key. The rsa dev dependency generates/signs ephemeral keys locally in authentication tests. The current RustSec advisory reports no patched version and permits local use without network-observable private-key operations. The exception is scoped by advisory ID and documented in deny.toml. Review it by November 19, 2026 and on every JWT/RSA change. Any network private-key operation invalidates this justification and must block deployment until the crypto backend is replaced or a patch exists. A passing advisory gate includes this exception; it is not a claim that the dependency has no advisory.

## Distribution

Original code is Apache-2.0. Preserve third-party notices. No release/tag/image is published during bootstrap. Publication requires an explicit reviewed maintainer action; ordinary PR CI never receives cloud credentials or package write permissions.
