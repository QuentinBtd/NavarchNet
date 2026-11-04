# Configuration and authentication

The server validates configuration at startup and fails closed if authentication mode or required secrets are missing. AWS SDK access defaults off; disabled startup and the demo never evaluate the controller credential chain.

Environment variables:

- `DATABASE_URL` (required): PostgreSQL connection URL. Use a dedicated database identity and require TLS for external databases. Do not log or commit the URL/password. The built-in local compose database uses a private network and SCRAM password authentication.
- `NAVARCHNET_BIND`: socket address, default `127.0.0.1:8080`.
- `NAVARCHNET_STATIC_DIR`: built frontend directory, default `frontend/dist`. Distribution wrapper selects the adjacent `dist/` directory.
- `NAVARCHNET_AUTH_MODE` (required): `demo` or `oidc`; there is no implicit anonymous mode.
- `NAVARCHNET_ADMIN_TOKEN`, `NAVARCHNET_READER_TOKEN`: required in demo mode, distinct strings of at least 32 bytes. Generate independent high-entropy values; length validation does not create entropy. They are local demo operator credentials, not per-person identities.
- `NAVARCHNET_ALLOW_DEMO_NETWORK=true`: explicitly allow non-loopback demo binding for isolated container networks. Compose still publishes only to 127.0.0.1. Do not use this as production Internet authentication.
- `NAVARCHNET_OIDC_KEY_FILE`: trusted RSA public PEM file in OIDC mode. Never a private key.
- `NAVARCHNET_OIDC_ISSUER`: exact HTTPS issuer string.
- `NAVARCHNET_OIDC_AUDIENCE`: exact resource/API audience.
- `RUST_LOG`: tracing filter; `navarchnet=info` is sufficient for normal operation. Do not enable SQL/HTTP payload/header logging around credentials.
- `NAVARCHNET_AWS_READ_ONLY`: absent or exactly `false` disables SDK access; exactly `true` explicitly enables the read-only adapter. Other values fail startup. Enabling it with demo authentication is rejected.
- `NAVARCHNET_AWS_REGIONS`: required non-empty comma-separated region allowlist when read-only access is enabled, for example `eu-west-1,eu-west-3`. Values are validated, not trimmed/repaired. Commercial AWS partition only; China/GovCloud/isolated partitions are unsupported. Each account registration selects one allowed region.

AWS onboarding accepts a role ARN and optional ExternalId, never access-key fields. The official SDK controller chain is loaded lazily only for an enabled, authenticated administrator request; prefer workload identity or another operator-managed short-lived source. Target sessions request 900 seconds and carry a region-scoped read-only inline policy with explicit denial of other actions. SDK and Query requests are bounded; the shared factory admits one active verification/discovery at a time. Verification is capped at 30 seconds and discovery at 180 seconds, including waiting for admission. See [AWS onboarding](aws-onboarding.md) for exact permissions and verification limits. ExternalId is private PostgreSQL configuration; role ARNs are visible to authenticated readers. No target credentials are serialized into database metadata.

## OIDC access-token integration

Configure your identity provider to mint RS256-signed access tokens for the NavarchNet API audience with `sub`, `iss`, `aud`, `exp` and a top-level string-array `roles` claim. `navarchnet-admin` permits mutations; `navarchnet-read-only` permits reads only. Unknown/missing roles deny access. Signature, algorithm, required claims, issuer, audience, expiration and optional not-before are validated; clock leeway is 30 seconds. Keep system clocks synchronized.

Export the issuer's currently trusted RSA public key out-of-band into the mounted PEM. The application does not fetch untrusted token-supplied key URLs or trust identity headers. For rotation, deploy the new public key and restart in a controlled window; overlapping JWKS key sets and automatic refresh are not implemented. Do not enable production exposure until your issuer/claim mapping and key-rotation procedure have been tested.

The UI accepts an access token obtained through your established OIDC client and stores it only in memory. It does not implement authorization-code/PKCE redirect login or refresh tokens. Reloading/signing out drops it. A complete browser SSO client is remaining product scope, not something the reverse proxy magically supplies. Set a TLS reverse proxy, strict ingress/rate limits and security headers; preserve the Authorization header and never put bearer tokens into query parameters.

The server authorizes non-GET operations before deserializing their bodies. Hiding frontend buttons is not the authorization boundary. Demo drift injection is absent outside demo authentication. The original account/network/planner APIs create only fake resources even in OIDC mode. Separate `/aws/accounts` endpoints verify roles, read observations and record metadata consent only; none can execute AWS resource mutations. Saved AWS observations remain readable when SDK access is disabled.

## Health and shutdown

`GET /healthz` is liveness; `GET /readyz` verifies database access. Neither requires authentication or reveals topology. `navarchnet --healthcheck` checks local readiness for containers. SIGINT/SIGTERM stop admission, stop the worker loop and close the pool. A process crash leaves durable operations available for lease-based recovery. No process-local task is treated as the source of truth.
