//! Real PostgreSQL journal and isolated replay effects; no cloud provider is constructed.
mod support;
use navarchnet::{
    external_effects::{EffectDirective, ObservedExternalEffect},
    store::Store,
};

#[tokio::test]
async fn external_intents_have_separate_durable_storage_not_fake_effects() -> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT to_regclass(current_schema() || '.external_effect_intents') IS NOT NULL",
    )
    .fetch_one(&store.pool)
    .await?;
    assert!(
        exists,
        "External effects need a separately durable intent journal before dispatch"
    );
    Ok(())
}

#[tokio::test]
async fn intent_identity_and_dispatch_history_cannot_be_rewritten_or_deleted() -> anyhow::Result<()>
{
    let (store, _) = support::isolated().await?;
    let mut failures = vec![];
    for (index, mutation) in [
        "UPDATE external_effect_intents SET desired_sha256=repeat('b',64) WHERE id=$1",
        "UPDATE external_effect_intents SET client_token='replacement' WHERE id=$1",
        "UPDATE external_effect_intents SET action_key='replacement' WHERE id=$1",
        "UPDATE external_effect_intents SET scope='replacement' WHERE id=$1",
        "UPDATE external_effect_intents SET state='prepared' WHERE id=$1",
        "DELETE FROM external_effect_intents WHERE id=$1",
    ]
    .into_iter()
    .enumerate()
    {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO external_effect_intents(id,scope,action_key,desired_sha256,client_token,state) VALUES($1,$1,'fixture',repeat('a',64),$1,'dispatched')")
            .bind(&id).execute(&store.pool).await?;
        if sqlx::query(mutation)
            .bind(&id)
            .execute(&store.pool)
            .await
            .is_ok()
        {
            failures.push(index);
        }
    }
    assert!(
        failures.is_empty(),
        "Unsafe journal mutations succeeded: {failures:?}"
    );
    Ok(())
}

#[tokio::test]
async fn committed_replay_effect_survives_controller_reconnect_without_second_dispatch()
-> anyhow::Result<()> {
    let (store, url) = support::isolated().await?;
    let (external, _) = support::isolated().await?;
    // Separate schema/connection/commit represents an offline external system, not fake_effects.
    sqlx::query("CREATE TABLE replay_resources(client_token text PRIMARY KEY, desired_sha256 text NOT NULL, external_id text NOT NULL)").execute(&external.pool).await?;
    let digest = "a".repeat(64);
    let intent = store
        .prepare_external_effect("offline-scope", "create-fixture", &digest)
        .await?;
    let again = store
        .prepare_external_effect("offline-scope", "create-fixture", &digest)
        .await?;
    assert_eq!(intent, again);
    let first = store.claim_external_effect(&intent.id, 15).await?.unwrap();
    assert_eq!(first.directive(), EffectDirective::DispatchOnce);
    assert!(store.claim_external_effect(&intent.id, 15).await?.is_none());
    let permit = store.begin_external_dispatch(&first).await?;
    assert!(store.begin_external_dispatch(&first).await.is_err());
    sqlx::query("INSERT INTO replay_resources VALUES($1,$2,'replay-resource-1')")
        .bind(permit.client_token())
        .bind(permit.desired_sha256())
        .execute(&external.pool)
        .await?;
    // Crash window: external commit exists, but no journal confirmation was written.
    sqlx::query("UPDATE external_effect_intents SET lease_until='-infinity' WHERE id=$1")
        .bind(&intent.id)
        .execute(&store.pool)
        .await?;
    store.pool.close().await;
    let resumed = Store::connect(&url).await?;
    let takeover = resumed
        .claim_external_effect(&intent.id, 15)
        .await?
        .unwrap();
    assert!(takeover.fence() > first.fence());
    assert_eq!(takeover.directive(), EffectDirective::ObserveOnly);
    assert!(resumed.begin_external_dispatch(&takeover).await.is_err());
    let (token, fingerprint, external_id): (String, String, String) =
        sqlx::query_as("SELECT client_token,desired_sha256,external_id FROM replay_resources")
            .fetch_one(&external.pool)
            .await?;
    let observation = ObservedExternalEffect {
        client_token: token,
        desired_sha256: fingerprint,
        external_id,
    };
    assert!(
        resumed
            .confirm_external_effect(&first, &observation)
            .await
            .is_err()
    );
    resumed
        .confirm_external_effect(&takeover, &observation)
        .await?;
    assert!(
        resumed
            .claim_external_effect(&intent.id, 15)
            .await?
            .is_none()
    );
    assert_eq!(
        resumed.external_effect(&intent.id).await?.state,
        "confirmed"
    );
    let external_count: i64 = sqlx::query_scalar("SELECT count(*) FROM replay_resources")
        .fetch_one(&external.pool)
        .await?;
    assert_eq!(external_count, 1);
    let dispatch_events: i64 = sqlx::query_scalar("SELECT count(*) FROM external_effect_events WHERE intent_id=$1 AND state='dispatched' AND fence=$2").bind(&intent.id).bind(first.fence()).fetch_one(&resumed.pool).await?;
    assert_eq!(dispatch_events, 2); // dispatch and test-only lease expiry, not two provider calls
    Ok(())
}

#[tokio::test]
async fn concurrent_admission_and_claims_preserve_one_scope_and_reject_unproven_confirmation()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let digest = "a".repeat(64);
    let (a, b) = tokio::join!(
        store.prepare_external_effect("scope", "action", &digest),
        store.prepare_external_effect("scope", "action", &digest)
    );
    let a = a?;
    assert_eq!(a, b?);
    assert!(
        store
            .prepare_external_effect("scope", "different", &digest)
            .await
            .is_err()
    );
    assert!(
        store
            .prepare_external_effect("scope", "action", &"b".repeat(64))
            .await
            .is_err()
    );
    for (scope, key, hash) in [
        ("", "action", digest.as_str()),
        ("scope", "\n", digest.as_str()),
        ("scope", "action", "BAD"),
    ] {
        assert!(
            store
                .prepare_external_effect(scope, key, hash)
                .await
                .is_err()
        );
    }
    assert!(store.claim_external_effect(&a.id, 0).await.is_err());
    assert!(store.claim_external_effect(&a.id, 301).await.is_err());
    let (one, two) = tokio::join!(
        store.claim_external_effect(&a.id, 15),
        store.claim_external_effect(&a.id, 15)
    );
    let claims: Vec<_> = [one?, two?].into_iter().flatten().collect();
    assert_eq!(claims.len(), 1);
    let first = &claims[0];
    let mut observation = ObservedExternalEffect {
        client_token: a.client_token.clone(),
        desired_sha256: digest.clone(),
        external_id: "replay-id".into(),
    };
    assert!(
        store
            .confirm_external_effect(first, &observation)
            .await
            .is_err()
    );
    sqlx::query("UPDATE external_effect_intents SET lease_until='-infinity' WHERE id=$1")
        .bind(&a.id)
        .execute(&store.pool)
        .await?;
    assert!(store.begin_external_dispatch(first).await.is_err());
    let next = store.claim_external_effect(&a.id, 15).await?.unwrap();
    assert_eq!(next.directive(), EffectDirective::DispatchOnce); // no dispatch marker existed
    store.begin_external_dispatch(&next).await?;
    for mode in 0..3 {
        observation.client_token = if mode == 0 {
            "wrong-token".into()
        } else {
            a.client_token.clone()
        };
        observation.desired_sha256 = if mode == 1 {
            "b".repeat(64)
        } else {
            digest.clone()
        };
        observation.external_id = if mode == 2 {
            "\n".into()
        } else {
            "replay-id".into()
        };
        assert!(
            store
                .confirm_external_effect(&next, &observation)
                .await
                .is_err()
        );
    }
    sqlx::query("UPDATE external_effect_intents SET lease_until='-infinity' WHERE id=$1")
        .bind(&a.id)
        .execute(&store.pool)
        .await?;
    let uncertain = store.claim_external_effect(&a.id, 15).await?.unwrap();
    assert_eq!(uncertain.directive(), EffectDirective::ObserveOnly);
    assert!(store.begin_external_dispatch(&uncertain).await.is_err());
    assert_eq!(store.external_effect(&a.id).await?.state, "dispatched");
    assert!(
        store
            .prepare_external_effect("scope", "replacement", &digest)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM external_effect_events WHERE intent_id=$1")
            .bind(&a.id)
            .execute(&store.pool)
            .await
            .is_err()
    );
    Ok(())
}

// Child scope is confined to the two generated local PostgreSQL schemas supplied by this test.
#[tokio::test]
async fn sigkill_after_separate_external_commit_recovers_by_observation_only() -> anyhow::Result<()>
{
    const CHILD: &str = "NAVARCHNET_OFFLINE_EFFECT_CHILD";
    if let Ok(id) = std::env::var(CHILD) {
        let store = Store::connect(&std::env::var("NAVARCHNET_OFFLINE_JOURNAL_DB")?).await?;
        let external = Store::connect(&std::env::var("NAVARCHNET_OFFLINE_REPLAY_DB")?).await?;
        let claim = store.claim_external_effect(&id, 15).await?.unwrap();
        let permit = store.begin_external_dispatch(&claim).await?;
        sqlx::query("INSERT INTO replay_resources VALUES($1,$2,'killed-worker-resource')")
            .bind(permit.client_token())
            .bind(permit.desired_sha256())
            .execute(&external.pool)
            .await?;
        std::future::pending::<()>().await;
        unreachable!();
    }
    let (store, journal_url) = support::isolated().await?;
    let (external, replay_url) = support::isolated().await?;
    sqlx::query("CREATE TABLE replay_resources(client_token text PRIMARY KEY, desired_sha256 text NOT NULL, external_id text NOT NULL)").execute(&external.pool).await?;
    let intent = store
        .prepare_external_effect("sigkill-scope", "offline-replay-create", &"c".repeat(64))
        .await?;
    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = ChildGuard(
        std::process::Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "sigkill_after_separate_external_commit_recovers_by_observation_only",
                "--nocapture",
            ])
            .env(CHILD, &intent.id)
            .env("NAVARCHNET_OFFLINE_JOURNAL_DB", &journal_url)
            .env("NAVARCHNET_OFFLINE_REPLAY_DB", &replay_url)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?,
    );
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM replay_resources")
                .fetch_one(&external.pool)
                .await?;
            if count == 1 {
                return Ok::<_, anyhow::Error>(());
            }
            anyhow::ensure!(
                child.0.try_wait()?.is_none(),
                "Offline replay child exited before independent commit"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await??;
    child.0.kill()?;
    let exit = child.0.wait()?;
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(exit.signal(), Some(9));
    }
    assert!(!exit.success());
    assert_eq!(store.external_effect(&intent.id).await?.state, "dispatched");
    sqlx::query("UPDATE external_effect_intents SET lease_until='-infinity' WHERE id=$1")
        .bind(&intent.id)
        .execute(&store.pool)
        .await?;
    let resumed = Store::connect(&journal_url).await?;
    let claim = resumed
        .claim_external_effect(&intent.id, 15)
        .await?
        .unwrap();
    assert_eq!(claim.directive(), EffectDirective::ObserveOnly);
    assert!(resumed.begin_external_dispatch(&claim).await.is_err());
    let (token, digest, id): (String, String, String) =
        sqlx::query_as("SELECT client_token,desired_sha256,external_id FROM replay_resources")
            .fetch_one(&external.pool)
            .await?;
    resumed
        .confirm_external_effect(
            &claim,
            &ObservedExternalEffect {
                client_token: token,
                desired_sha256: digest,
                external_id: id,
            },
        )
        .await?;
    assert_eq!(
        resumed.external_effect(&intent.id).await?.state,
        "confirmed"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM replay_resources")
        .fetch_one(&external.pool)
        .await?;
    assert_eq!(count, 1);
    Ok(())
}
