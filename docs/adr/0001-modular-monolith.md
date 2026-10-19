# ADR 0001: modular monolith and resource-conscious dependencies

Status: accepted for the development preview, October 19, 2026.

Use Rust 1.99.0 (also the declared MSRV), Axum 0.8.9, Tokio 1.53.3 and SQLx 0.9.0 with PostgreSQL-only, Tokio and rustls features. Current registry metadata and docs were checked before pinning; SQLx requires Rust 1.94 or newer, satisfied by the pinned toolchain. Runtime queries use bind parameters; real PostgreSQL tests validate SQL and migrations. We do not pretend dynamic queries have compile-time SQL validation.

Use one process with bounded pool/worker concurrency and a PostgreSQL queue instead of introducing Redis/Kafka/services. Development/test profiles disable debug info and incremental compilation; build concurrency is one. A project-owned target directory and cache keep constrained hosts manageable.

Use a modest Vite 8.3.4/TypeScript 7.0.2 application with native form controls, not a component-heavy frontend framework. Node 24.22.0 is the verified LTS build runtime; static production assets need no Node server. ts-rs 12.0.1 derives the shared contract. Vitest/jsdom tests behavior; Playwright exercises real browser/backend/PostgreSQL interactions.

Use jsonwebtoken 11.1.0 with its RustCrypto provider for RS256 public verification. The narrowly documented RSA private-key timing advisory exception is in SECURITY.md. OIDC key rotation is an operator-managed public-key-file replacement, not undocumented automatic discovery.

Consequences: fast, inspectable vertical slices and no external controller services. Global lists are bounded development endpoints, not scalable cursor APIs. The AWS SDK/discovery/execution lane is still undelivered; no ambient credential chain is evaluated by this preview. Adding an SDK behind explicit onboarding must preserve these resource limits and external-side-effect safety guarantees.
