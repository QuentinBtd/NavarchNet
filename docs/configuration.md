# Configuration and authentication

The server validates configuration at startup and fails closed if authentication mode or required secrets are missing. It never loads AWS credentials in this preview.

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

## OIDC access-token integration

Configure your identity provider to mint RS256-signed access tokens for the NavarchNet API audience with `sub`, `iss`, `aud`, `exp` and a top-level string-array `roles` claim. `navarchnet-admin` permits mutations; `navarchnet-read-only` permits reads only. Unknown/missing roles deny access. Signature, algorithm, required claims, issuer, audience, expiration and optional not-before are validated; clock leeway is 30 seconds. Keep system clocks synchronized.

Export the issuer's currently trusted RSA public key out-of-band into the mounted PEM. The application does not fetch untrusted token-supplied key URLs or trust identity headers. For rotation, deploy the new public key and restart in a controlled window; overlapping JWKS key sets and automatic refresh are not implemented. Do not enable production exposure until your issuer/claim mapping and key-rotation procedure have been tested.

The UI accepts an access token obtained through your established OIDC client and stores it only in memory. It does not implement authorization-code/PKCE redirect login or refresh tokens. Reloading/signing out drops it. A complete browser SSO client is remaining product scope, not something the reverse proxy magically supplies. Set a TLS reverse proxy, strict ingress/rate limits and security headers; preserve the Authorization header and never put bearer tokens into query parameters.

The server authorizes mutations before deserializing their bodies. Hiding frontend buttons is not the authorization boundary. Demo drift injection is absent outside demo authentication. Current account/network APIs still create only fake resources even in OIDC mode.

## Health and shutdown

`GET /healthz` is liveness; `GET /readyz` verifies database access. Neither requires authentication or reveals topology. `navarchnet --healthcheck` checks local readiness for containers. SIGINT/SIGTERM stop admission, stop the worker loop and close the pool. A process crash leaves durable operations available for lease-based recovery. No process-local task is treated as the source of truth.
