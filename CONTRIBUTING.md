# Contributing

All code, comments, UI, docs, issues, pull requests and commit messages are in English. Contributions to original NavarchNet code are provided under Apache-2.0; preserve third-party licenses and notices and do not add unsupported rights-holder claims.

Use small vertical slices and Conventional Commits. Write a failing behavior test before implementing meaningful domain changes or defect fixes, then make it pass and refactor. Run `DATABASE_URL=postgres://... sh scripts/check.sh` and the applicable browser/package gates before requesting review. PostgreSQL tests require a real disposable database and must never silently skip. No live AWS tests on normal PRs.

Keep API, domain, store, executor and providers separate within one Rust application. Do not introduce Kafka, Redis, microservices or dynamic plugins for hypothetical scale. Any change to ownership, route isolation, locking order, revision preconditions, retries or execution fencing requires a PostgreSQL regression test and independent source review.

The supported build toolchain is pinned in rust-toolchain.toml; MSRV is the same exact release until a separately reviewed policy changes it. Commit Cargo.lock and frontend/package-lock.json. Use locked installs and regenerate `frontend/src/generated.ts` with `cargo run --locked --bin export-types`. Do not edit generated types manually.

No cloud mutations, paid test resources, crates.io/GHCR uploads or release/tag publication without separate explicit maintainer approval. Fake-provider tests are not AWS connectivity evidence. Document both completed gates and missing acceptance criteria in docs/STATUS.md.
