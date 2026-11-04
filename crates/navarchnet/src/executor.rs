//! Fake effects and progress commit together. This is NOT an AWS transaction.
use crate::{
    domain::{Inventory, RegionalNetwork},
    provider::{self, FailureClass},
    store::{Claim, Store, audit},
};
use anyhow::ensure;
use sqlx::Row;

pub async fn tick(store: &Store) -> anyhow::Result<bool> {
    if let Some(claim) = store.claim().await? {
        execute_claim(store, claim).await?;
        Ok(true)
    } else {
        Ok(false)
    }
}

pub async fn execute_claim(store: &Store, claim: Claim) -> anyhow::Result<()> {
    let plan = store.plan(&claim.operation.plan_id).await?;
    let mut tx = store.pool.begin().await?;
    // The same network -> inventory -> operation lock order is used by planning/apply.
    let network: serde_json::Value =
        sqlx::query_scalar("SELECT body FROM networks WHERE id=$1 FOR SHARE")
            .bind(&plan.request.network_id)
            .fetch_one(&mut *tx)
            .await?;
    let inventory: serde_json::Value =
        sqlx::query_scalar("SELECT body FROM inventory WHERE account_id=$1 FOR SHARE")
            .bind(&plan.request.account_id)
            .fetch_one(&mut *tx)
            .await?;
    let network: RegionalNetwork = serde_json::from_value(network)?;
    let inventory: Inventory = serde_json::from_value(inventory)?;
    let row = sqlx::query(
        "SELECT *,lease_until>clock_timestamp() AS valid FROM operations WHERE id=$1 FOR UPDATE",
    )
    .bind(&claim.operation.id)
    .fetch_one(&mut *tx)
    .await?;
    let fence: i64 = row.try_get("fence")?;
    let valid: bool = row.try_get("valid")?;
    let status: String = row.try_get("status")?;
    ensure!(
        fence == claim.fence && valid && status == "running",
        "Stale worker rejected by fencing token or expired lease"
    );
    let step: i32 = row.try_get("step")?;
    let attempts: i32 = row.try_get("attempts")?;
    let fault = serde_json::from_value(row.try_get("fault")?)?;
    let action = plan.actions.get(step as usize);
    let mut failure = if inventory.revision != plan.inventory_revision
        || network.revision != plan.network_revision
    {
        Some((
            FailureClass::Conflict,
            "Stale plan: discovery or policy changed after enqueue; re-plan",
        ))
    } else if action.is_none_or(|a| !a.requires.iter().all(|p| *p < step as u32)) {
        Some((
            FailureClass::InvalidTopology,
            "Invalid operation step or unsatisfied prerequisites",
        ))
    } else {
        provider::simulated_failure(&fault, step, attempts)
    };
    let mut effect = None;
    if failure.is_none() {
        let action = action.expect("Validated action");
        let body = serde_json::to_value(action.effect())?;
        let key = format!("{:?}:{}", action.kind, action.target);
        let previous: Option<serde_json::Value> =
            sqlx::query_scalar("SELECT body FROM fake_effects WHERE scope=$1 AND action_key=$2")
                .bind(&plan.scope)
                .bind(&key)
                .fetch_optional(&mut *tx)
                .await?;
        if previous.is_some_and(|p| p != body) {
            failure = Some((
                FailureClass::Conflict,
                "Conflicting managed resource; report drift before repair",
            ));
        } else {
            effect = Some((key, body));
        }
    }
    let (next_status, next_step, next_attempts, error, outcome, delay) = if let Some((
        class,
        message,
    )) = failure
    {
        let retry = class == FailureClass::Retryable && attempts < 4;
        let status = if retry {
            "retrying"
        } else if step > 0 {
            "partial"
        } else {
            "failed"
        };
        (
            status,
            step,
            attempts + 1,
            Some(message),
            message,
            if retry {
                0.2 * 2f64.powi(attempts)
            } else {
                0.0
            },
        )
    } else {
        let (key, body) = effect.expect("Validated effect");
        sqlx::query("INSERT INTO fake_effects(scope,action_key,body,operation_id,fence) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(scope,action_key) DO NOTHING").bind(&plan.scope).bind(key).bind(body).bind(&claim.operation.id).bind(fence).execute(&mut *tx).await?;
        (
            if step as usize + 1 == plan.actions.len() {
                "succeeded"
            } else {
                "queued"
            },
            step + 1,
            0,
            None,
            "postcondition_verified_in_simulator",
            0.0,
        )
    };
    let changed = sqlx::query("UPDATE operations SET status=$1,step=$2,attempts=$3,error=$4,lease_until='-infinity',next_attempt=clock_timestamp()+make_interval(secs=>$5),updated_at=clock_timestamp() WHERE id=$6 AND fence=$7 AND lease_until>clock_timestamp()").bind(next_status).bind(next_step).bind(next_attempts).bind(error).bind(delay).bind(&claim.operation.id).bind(fence).execute(&mut *tx).await?.rows_affected();
    ensure!(
        changed == 1,
        "Lease expired before commit; all fake effects rolled back"
    );
    sqlx::query("INSERT INTO step_events(operation_id,step,fence,outcome) VALUES ($1,$2,$3,$4)")
        .bind(&claim.operation.id)
        .bind(step)
        .bind(fence)
        .bind(outcome)
        .execute(&mut *tx)
        .await?;
    audit(&mut tx, "executor", next_status, &claim.operation.id).await?;
    tx.commit().await?;
    Ok(())
}
