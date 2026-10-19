use navarchnet::{domain::*, executor, store::Store};
use sqlx::postgres::PgPoolOptions;

async fn isolated() -> anyhow::Result<Store> {
    let url = std::env::var("DATABASE_URL").expect("Real PostgreSQL required");
    let admin = Store::connect(&url).await?;
    let schema = format!("test_{}", uuid::Uuid::new_v4().simple());
    // Identifier is generated exclusively from a UUID, never user input.
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
        .execute(&admin.pool)
        .await?;
    admin.pool.close().await;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(move |connection, _| {
            let sql = format!("SET search_path TO {schema}");
            Box::pin(async move {
                sqlx::query(sqlx::AssertSqlSafe(sql))
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect(&url)
        .await?;
    let store = Store { pool };
    store.migrate().await?;
    Ok(store)
}
async fn setup(store: &Store) -> anyhow::Result<ConnectionRequest> {
    let account = store
        .register("admin", "App", ProviderKind::Fake, "fake:role")
        .await?;
    let inventory = store.discover("admin", &account.id).await?;
    let network = store.create_demo_network("admin", "Regional").await?;
    Ok(ConnectionRequest {
        account_id: account.id,
        vpc_id: inventory.vpc_id,
        subnet_ids: inventory.subnets.into_iter().map(|s| s.id).collect(),
        network_id: network.id,
        allow_application_traffic: false,
    })
}
async fn finish(store: &Store) -> anyhow::Result<()> {
    for _ in 0..20 {
        if !executor::tick(store).await? {
            break;
        }
    }
    Ok(())
}

#[tokio::test]
async fn changed_connection_intent_is_rejected_until_safe_migration_is_supported()
-> anyhow::Result<()> {
    let store = isolated().await?;
    let request = setup(&store).await?;
    let plan = store.create_plan("admin", request.clone()).await?;
    store.apply("admin", &plan.id, Fault::None).await?;
    finish(&store).await?;
    let mut changed = request.clone();
    changed.subnet_ids.pop();
    let error = store
        .create_plan("admin", changed)
        .await
        .expect_err("Shrinking a connection must not silently leave obsolete routes");
    assert!(error.to_string().contains("migration"));
    let mut changed = request.clone();
    changed.network_id = store.create_demo_network("admin", "Other").await?.id;
    assert!(store.create_plan("admin", changed).await.is_err());
    let repeat = store.create_plan("admin", request).await?;
    let op = store.apply("admin", &repeat.id, Fault::None).await?;
    finish(&store).await?;
    assert_eq!(store.operation(&op.id).await?.status, "succeeded");
    let effects: i64 = sqlx::query_scalar("SELECT count(*) FROM fake_effects")
        .fetch_one(&store.pool)
        .await?;
    assert_eq!(
        effects,
        plan.actions.len() as i64,
        "Idempotent reapplication must not duplicate effects"
    );
    let expanded = setup(&store).await?;
    let mut initial = expanded.clone();
    initial.subnet_ids.truncate(1);
    let initial_plan = store.create_plan("admin", initial).await?;
    store.apply("admin", &initial_plan.id, Fault::None).await?;
    finish(&store).await?;
    assert!(
        store
            .create_plan("admin", expanded)
            .await
            .unwrap_err()
            .to_string()
            .contains("migration"),
        "Adding a second discovered attachment subnet requires a safe migration, not silent expansion"
    );
    Ok(())
}

#[tokio::test]
async fn resource_conflict_is_durable_partial_not_infinite_running() -> anyhow::Result<()> {
    let store = isolated().await?;
    let request = setup(&store).await?;
    let plan = store.create_plan("admin", request.clone()).await?;
    store.apply("admin", &plan.id, Fault::None).await?;
    finish(&store).await?;
    sqlx::query("UPDATE fake_effects SET body=jsonb_set(body,'{postcondition}', '\"manual conflict\"') WHERE action_key LIKE 'NatRoute:%'").execute(&store.pool).await?;
    let next = store.create_plan("admin", request).await?;
    let op = store.apply("admin", &next.id, Fault::None).await?;
    finish(&store).await?;
    let result = store.operation(&op.id).await?;
    assert_eq!(result.status, "partial");
    assert!(result.error.unwrap().contains("Conflicting"));
    assert!(store.claim().await?.is_none());
    Ok(())
}

#[tokio::test]
async fn stale_versions_discovery_and_simultaneous_requests_are_distinct() -> anyhow::Result<()> {
    let store = isolated().await?;
    let request = setup(&store).await?;
    let first = store.create_plan("admin", request.clone()).await?;
    let stale = store.create_plan("admin", request.clone()).await?;
    let (a, b) = tokio::join!(
        store.apply("admin", &first.id, Fault::None),
        store.apply("admin", &first.id, Fault::None)
    );
    assert_eq!(a?.id, b?.id);
    assert!(
        store
            .apply("admin", &stale.id, Fault::None)
            .await
            .unwrap_err()
            .to_string()
            .contains("Stale plan")
    );
    let (a, b) = tokio::join!(store.claim(), store.claim());
    let claims = [a?, b?].into_iter().flatten().collect::<Vec<_>>();
    assert_eq!(claims.len(), 1);
    executor::execute_claim(&store, claims.into_iter().next().unwrap()).await?;
    finish(&store).await?;
    let discovered = store.create_plan("admin", request.clone()).await?;
    store.discover("admin", &request.account_id).await?;
    assert!(
        store
            .apply("admin", &discovered.id, Fault::None)
            .await
            .unwrap_err()
            .to_string()
            .contains("discovery")
    );
    for _ in 0..10 {
        let existing = store.create_plan("admin", request.clone()).await?;
        let pair = tokio::time::timeout(std::time::Duration::from_secs(4), async {
            tokio::join!(
                store.create_plan("admin", request.clone()),
                store.apply("admin", &existing.id, Fault::None)
            )
        })
        .await
        .expect("Concurrent planning and applying must not deadlock");
        pair.0?;
        pair.1?;
        finish(&store).await?;
    }
    Ok(())
}

#[tokio::test]
async fn queued_execution_invalidates_changed_discovery() -> anyhow::Result<()> {
    let store = isolated().await?;
    let request = setup(&store).await?;
    let plan = store.create_plan("admin", request.clone()).await?;
    let op = store.apply("admin", &plan.id, Fault::None).await?;
    store.discover("admin", &request.account_id).await?;
    executor::tick(&store).await?;
    let result = store.operation(&op.id).await?;
    assert_eq!(result.status, "failed");
    assert_eq!(result.step, 0);
    assert!(result.error.unwrap().contains("Stale plan"));
    Ok(())
}

#[tokio::test]
async fn provider_fault_classes_have_bounded_and_visible_outcomes() -> anyhow::Result<()> {
    let store = isolated().await?;
    for (fault, expected) in [
        (Fault::EventualConsistency, "succeeded"),
        (Fault::CredentialExpiry, "succeeded"),
        (Fault::Permission, "failed"),
    ] {
        let request = setup(&store).await?;
        let plan = store.create_plan("admin", request).await?;
        let op = store.apply("admin", &plan.id, fault).await?;
        for _ in 0..25 {
            executor::tick(&store).await?;
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
        assert_eq!(store.operation(&op.id).await?.status, expected);
    }
    let request = setup(&store).await?;
    let plan = store.create_plan("admin", request).await?;
    let op = store
        .apply("admin", &plan.id, Fault::PersistentThrottle)
        .await?;
    for _ in 0..5 {
        executor::tick(&store).await?;
        sqlx::query("UPDATE operations SET next_attempt='-infinity' WHERE id=$1")
            .bind(&op.id)
            .execute(&store.pool)
            .await?;
    }
    let exhausted = store.operation(&op.id).await?;
    assert_eq!(exhausted.status, "failed");
    assert_eq!(exhausted.attempts, 5);
    assert!(store.claim().await?.is_none());
    Ok(())
}
