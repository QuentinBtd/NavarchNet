use navarchnet::{domain::*, executor, store::Store};
mod support;

#[tokio::test]
async fn durable_journey_fencing_retry_recovery_and_drift() -> anyhow::Result<()> {
    let (store, url) = support::isolated().await?;
    let id = uuid::Uuid::new_v4().to_string();
    let account = store
        .register(
            "test-admin",
            &format!("App {id}"),
            ProviderKind::Fake,
            "fake:role",
        )
        .await?;
    let inventory = store.discover("test-admin", &account.id).await?;
    let network = store
        .create_demo_network("test-admin", &format!("net-{id}"))
        .await?;
    let request = ConnectionRequest {
        account_id: account.id.clone(),
        vpc_id: inventory.vpc_id.clone(),
        subnet_ids: inventory.subnets.iter().map(|s| s.id.clone()).collect(),
        network_id: network.id.clone(),
        allow_application_traffic: false,
    };
    let plan = store.create_plan("test-admin", request.clone()).await?;
    let op = store.apply("test-admin", &plan.id, Fault::Throttle).await?;
    assert_eq!(
        store.apply("test-admin", &plan.id, Fault::None).await?.id,
        op.id
    );
    let stale_plan = store.create_plan("test-admin", request.clone()).await?;
    assert!(
        store
            .apply("test-admin", &stale_plan.id, Fault::None)
            .await
            .is_err()
    );
    let first = store.claim().await?.unwrap();
    assert!(store.claim().await?.is_none());
    store.expire_lease_for_test(&op.id).await?;
    let takeover = store.claim().await?.unwrap();
    assert!(takeover.fence > first.fence);
    assert!(executor::execute_claim(&store, first).await.is_err());
    executor::execute_claim(&store, takeover).await?;
    for _ in 0..30 {
        executor::tick(&store).await?;
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    }
    assert_eq!(store.operation(&op.id).await?.status, "succeeded");
    let reconnect = Store::connect(&url).await?;
    assert_eq!(
        reconnect.operation(&op.id).await?.step as usize,
        plan.actions.len()
    );
    assert!(!store.observe(&op.id).await?.drift);
    store.inject_drift("test-admin", &op.id).await?;
    assert!(store.observe(&op.id).await?.drift);
    assert!(
        store
            .apply("test-admin", &stale_plan.id, Fault::None)
            .await
            .is_err()
    );
    let repair = store.create_plan("test-admin", request).await?;
    let broken = store
        .apply("test-admin", &repair.id, Fault::PartialFailure)
        .await?;
    for _ in 0..15 {
        executor::tick(&store).await?;
    }
    let partial = store.operation(&broken.id).await?;
    assert_eq!(partial.status, "partial");
    assert!(partial.step > 0);
    assert!(partial.error.is_some());
    assert!(
        sqlx::query("UPDATE plans SET body = '{}' WHERE id = $1")
            .bind(&plan.id)
            .execute(&store.pool)
            .await
            .is_err()
    );
    Ok(())
}
