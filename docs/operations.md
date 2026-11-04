# Operations, recovery, backup and upgrade

## Deployment boundary

The Dockerfile builds static UI assets and a release Rust binary and runs as an unprivileged numeric user. Compose drops capabilities, enables no-new-privileges, uses a read-only application filesystem, persists only PostgreSQL data and publishes the app on loopback. Do not run the demo publicly. Container execution is a separate acceptance gate from compiling the binary; see STATUS.md for actual verification.

For an OIDC deployment, override the app environment to `NAVARCHNET_AUTH_MODE=oidc`, mount an RSA public key read-only, set issuer/audience/key-file and place a TLS reverse proxy in front. Remove demo tokens and the demo-network opt-in from that deployment. Validate issuer claims and key rotation before exposure. There is no built-in full browser SSO flow. Cloud credentials are unnecessary while AWS is disabled.

## Diagnosis and recovery

1. Check liveness/readiness, database availability and disk capacity. Readiness is not cloud/data-plane health.
2. Inspect operation error, immutable plan and step events. Separate queued/retrying/running from failed/partial/succeeded.
3. A running claim has a 15-second database-clock lease. After an interrupted process, another worker can reclaim it with a higher fence. Do not manually lower fencing counters or delete completed events.
4. Retryable provider simulation failures back off and stop after bounded attempts. Permission/topology/conflict failures become durable failed/partial outcomes. Partial completion is not rollback. No existing connectivity is automatically removed.
5. Re-discover after resolving a conflict, inspect drift and create a new plan. Missing identical fake effects may be recreated by reapplication; conflicting effects are report-only. Real network/subnet replacement and deletion are unsupported, including through manual database edits.
6. If the database is unavailable, transactions fail and no fake progress commits. Restore database service/access before attempting recovery. Never fabricate convergence from stale UI state.

Logs exclude bearer credentials/role secrets. Treat topology, audit exports and database backups as sensitive operational information. Lists/events are bounded; use controlled SQL exports for historical forensic analysis. Audit retention and cursor pagination remain future work. Monitor table sizes and volume capacity; do not automatically delete audit records.

### Offline external-effect recovery journal

The internal `external_effects` library is separate from the fake operation executor and has no HTTP mutation endpoint or enabled cloud adapter. `external_effect_intents` stores one immutable action/fingerprint/client token per scope with `prepared`, `dispatched`, or `confirmed` state. `external_effect_events` is append-only state/fence history; repeated `dispatched` rows can represent claims or lease changes, not multiple provider calls.

If interrupted before the durable dispatch marker, a later live claim can obtain the first dispatch permit. Once the marker exists, every takeover is observe-only. Match independently read external identity/token/fingerprint evidence before confirming with the current fence. Wrong evidence, expired leases and old-worker confirmations fail without replacing intent. A missing resource read is not permission to retry: the old request may still be in flight or the read eventually consistent. Preserve scope, token and events and investigate manually; no reset, destructive rollback, action replacement or journal deletion API is provided, even after confirmation. This conservative primitive is not yet a complete multi-step cloud recovery workflow.

Never supply user claims as `ObservedExternalEffect` proof or interpret a local permit as AWS authorization/fencing. A future adapter must validate operation-specific idempotency, target ownership/preconditions, bounded network timeouts, observation provenance and in-flight request behavior before cloud execution can be enabled. The actual isolated replay SIGKILL test proves only the separate local journal/commit recovery protocol, not AWS or data-plane acceptance.

## Backups

Use the PostgreSQL major-version-compatible `pg_dump` tool. Example using the local compose database (the container already receives its password):

    docker compose exec -T database sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U navarchnet -d navarchnet -Fc' > navarchnet.dump

Store the dump encrypted outside the database volume, restrict file permissions and record the application commit/schema version. Back up configuration and the trusted OIDC public key separately; obtain secrets from your secret manager rather than committing them. Do not copy a live data directory as if it were a consistent backup.

Test restore regularly into a separate empty PostgreSQL database:

    pg_restore --exit-on-error --no-owner --dbname=DISPOSABLE_RESTORE_URL navarchnet.dump

Do not run the restored controller with live cloud permissions until ownership, desired state, operation status and provider observations are reconciled. This preview has no AWS executor, but this rule remains important for later onboarding.

## Upgrades and migration failure

Review release notes and migration compatibility first. Stop all controllers, take/verify a backup, deploy a reviewed build, and allow SQLx's migration lock/checksum validation to run. Migrations are forward-only and embedded in the binary; never edit an already-applied migration. On failure, keep the old binary/source/backup and inspect the exact migration error. Do not ignore checksum failures or invent a down-migration. Restore to a separate database to rehearse recovery; avoid destructive in-place rollback.

The crate build script explicitly tracks the repository migrations directory so SQL-only changes invalidate the embedded SQLx migrations. Rebuild before deployment; an old retained binary still intentionally contains its old migration set.

The current preview has no stable rolling-upgrade guarantee; mixed-version workers are unsupported. Restarting a single version after a crash is tested. Published distribution packages must declare schema compatibility before production releases. No release was published during bootstrap.
