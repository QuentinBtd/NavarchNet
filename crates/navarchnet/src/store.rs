use crate::{domain::*, provider};
use anyhow::{Context, ensure};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgPoolOptions};

#[derive(Clone)]
pub struct Store {
    pub pool: PgPool,
}
#[derive(Debug, Clone)]
pub struct Claim {
    pub operation: Operation,
    pub fence: i64,
}

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn encode<T: Serialize>(value: &T) -> anyhow::Result<Value> {
    Ok(serde_json::to_value(value)?)
}
fn decode<T: DeserializeOwned>(value: Value) -> anyhow::Result<T> {
    Ok(serde_json::from_value(value)?)
}
fn operation_row(row: sqlx::postgres::PgRow) -> anyhow::Result<Operation> {
    Ok(Operation {
        id: row.try_get("id")?,
        plan_id: row.try_get("plan_id")?,
        scope: row.try_get("scope")?,
        status: row.try_get("status")?,
        step: row.try_get("step")?,
        attempts: row.try_get("attempts")?,
        error: row.try_get("error")?,
        fault: decode(row.try_get("fault")?)?,
    })
}

impl Store {
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        Ok(Self {
            pool: PgPoolOptions::new()
                .max_connections(5)
                .acquire_timeout(std::time::Duration::from_secs(5))
                .connect(url)
                .await?,
        })
    }
    pub async fn migrate(&self) -> anyhow::Result<()> {
        sqlx::migrate!("../../migrations").run(&self.pool).await?;
        Ok(())
    }
    pub async fn ready(&self) -> anyhow::Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }
    pub async fn accounts(&self) -> anyhow::Result<Vec<Account>> {
        sqlx::query_scalar::<_, Value>("SELECT body FROM accounts ORDER BY id LIMIT 500")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(decode)
            .collect()
    }
    pub async fn networks(&self) -> anyhow::Result<Vec<RegionalNetwork>> {
        sqlx::query_scalar::<_, Value>("SELECT body FROM networks ORDER BY id LIMIT 500")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(decode)
            .collect()
    }
    pub async fn inventories(&self) -> anyhow::Result<Vec<Inventory>> {
        sqlx::query_scalar::<_, Value>("SELECT body FROM inventory ORDER BY account_id LIMIT 500")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(decode)
            .collect()
    }
    pub async fn plans(&self) -> anyhow::Result<Vec<Plan>> {
        sqlx::query_scalar::<_, Value>("SELECT body FROM plans ORDER BY created_at DESC LIMIT 100")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(decode)
            .collect()
    }
    pub async fn operations(&self) -> anyhow::Result<Vec<Operation>> {
        sqlx::query("SELECT * FROM operations ORDER BY created_at DESC LIMIT 100")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(operation_row)
            .collect()
    }
    pub async fn register(
        &self,
        actor: &str,
        name: &str,
        provider: ProviderKind,
        role_arn: &str,
    ) -> anyhow::Result<Account> {
        ensure!(
            !name.trim().is_empty() && name.len() <= 120,
            "Account name must contain 1–120 characters"
        );
        ensure!(role_arn.len() <= 2048, "Role reference is too long");
        ensure!(
            provider == ProviderKind::Fake && role_arn.starts_with("fake:"),
            "Only fake account registration is enabled; AWS onboarding is not implemented"
        );
        let account = Account {
            id: id(),
            name: name.into(),
            provider,
            role_arn: role_arn.into(),
            revision: 1,
        };
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO accounts(id,body) VALUES ($1,$2)")
            .bind(&account.id)
            .bind(encode(&account)?)
            .execute(&mut *tx)
            .await?;
        audit(&mut tx, actor, "account_registered", &account.id).await?;
        tx.commit().await?;
        Ok(account)
    }
    pub async fn discover(&self, actor: &str, account_id: &str) -> anyhow::Result<Inventory> {
        let mut tx = self.pool.begin().await?;
        let account: Account = decode(
            sqlx::query_scalar("SELECT body FROM accounts WHERE id=$1 FOR UPDATE")
                .bind(account_id)
                .fetch_one(&mut *tx)
                .await?,
        )?;
        let mut inventory = provider::discover(&account)?;
        let previous: Option<Value> =
            sqlx::query_scalar("SELECT body FROM inventory WHERE account_id=$1")
                .bind(account_id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(previous) = previous {
            inventory.revision = decode::<Inventory>(previous)?.revision + 1;
        }
        sqlx::query("INSERT INTO inventory(account_id,body) VALUES ($1,$2) ON CONFLICT(account_id) DO UPDATE SET body=excluded.body").bind(account_id).bind(encode(&inventory)?).execute(&mut *tx).await?;
        audit(&mut tx, actor, "inventory_discovered", account_id).await?;
        tx.commit().await?;
        Ok(inventory)
    }
    pub async fn create_demo_network(
        &self,
        actor: &str,
        name: &str,
    ) -> anyhow::Result<RegionalNetwork> {
        ensure!(
            !name.trim().is_empty() && name.len() <= 120,
            "Network name must contain 1–120 characters"
        );
        let (_, mut network, _) = fixture();
        network.id = id();
        network.name = name.into();
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO networks(id,body) VALUES ($1,$2)")
            .bind(&network.id)
            .bind(encode(&network)?)
            .execute(&mut *tx)
            .await?;
        audit(&mut tx, actor, "regional_network_created", &network.id).await?;
        tx.commit().await?;
        Ok(network)
    }
    pub async fn create_plan(
        &self,
        actor: &str,
        mut request: ConnectionRequest,
    ) -> anyhow::Result<Plan> {
        request.subnet_ids.sort();
        let mut tx = self.pool.begin().await?;
        // Common lock order: regional network, inventory, scope, operation.
        let network: RegionalNetwork = decode(
            sqlx::query_scalar("SELECT body FROM networks WHERE id=$1 FOR SHARE")
                .bind(&request.network_id)
                .fetch_one(&mut *tx)
                .await?,
        )?;
        let inventory: Inventory = decode(
            sqlx::query_scalar("SELECT body FROM inventory WHERE account_id=$1 FOR SHARE")
                .bind(&request.account_id)
                .fetch_one(&mut *tx)
                .await
                .context("Discover this account first")?,
        )?;
        let scope = format!("{}:{}", request.account_id, request.vpc_id);
        sqlx::query("INSERT INTO scopes(id) VALUES ($1) ON CONFLICT DO NOTHING")
            .bind(&scope)
            .execute(&mut *tx)
            .await?;
        let version: i32 = sqlx::query_scalar("SELECT version FROM scopes WHERE id=$1 FOR SHARE")
            .bind(&scope)
            .fetch_one(&mut *tx)
            .await?;
        verify_connection_intent(&mut tx, &scope, &request).await?;
        let actions = crate::domain::plan(&inventory, &network, &request)?;
        let mut plan = Plan {
            id: id(),
            scope,
            scope_version: version,
            inventory_revision: inventory.revision,
            network_revision: network.revision,
            request,
            actions,
            digest: String::new(),
        };
        plan.digest = Sha256::digest(serde_json::to_vec(&plan)?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        sqlx::query("INSERT INTO plans(id,scope,body) VALUES ($1,$2,$3)")
            .bind(&plan.id)
            .bind(&plan.scope)
            .bind(encode(&plan)?)
            .execute(&mut *tx)
            .await?;
        audit(&mut tx, actor, "plan_created", &plan.id).await?;
        tx.commit().await?;
        Ok(plan)
    }
    pub async fn plan(&self, id: &str) -> anyhow::Result<Plan> {
        decode(
            sqlx::query_scalar("SELECT body FROM plans WHERE id=$1")
                .bind(id)
                .fetch_one(&self.pool)
                .await?,
        )
    }
    pub async fn apply(
        &self,
        actor: &str,
        plan_id: &str,
        fault: Fault,
    ) -> anyhow::Result<Operation> {
        let plan = self.plan(plan_id).await?;
        let mut tx = self.pool.begin().await?;
        let network: RegionalNetwork = decode(
            sqlx::query_scalar("SELECT body FROM networks WHERE id=$1 FOR UPDATE")
                .bind(&plan.request.network_id)
                .fetch_one(&mut *tx)
                .await?,
        )?;
        let inventory: Inventory = decode(
            sqlx::query_scalar("SELECT body FROM inventory WHERE account_id=$1 FOR SHARE")
                .bind(&plan.request.account_id)
                .fetch_one(&mut *tx)
                .await?,
        )?;
        // Lock the scope before looking up an existing operation: concurrent applies return the same operation.
        let version: i32 = sqlx::query_scalar("SELECT version FROM scopes WHERE id=$1 FOR UPDATE")
            .bind(&plan.scope)
            .fetch_one(&mut *tx)
            .await?;
        if let Some(row) = sqlx::query("SELECT * FROM operations WHERE plan_id=$1")
            .bind(plan_id)
            .fetch_optional(&mut *tx)
            .await?
        {
            tx.commit().await?;
            return operation_row(row);
        }
        ensure!(
            version == plan.scope_version,
            "Stale plan: scope changed; create a new plan"
        );
        verify_connection_intent(&mut tx, &plan.scope, &plan.request).await?;
        ensure!(
            inventory.revision == plan.inventory_revision
                && network.revision == plan.network_revision,
            "Stale plan: discovery or policy changed"
        );
        let occupied: Vec<Value> = sqlx::query_scalar("SELECT DISTINCT i.body FROM operations o JOIN plans p ON p.id=o.plan_id JOIN inventory i ON i.account_id=p.body->'request'->>'account_id' WHERE p.body->'request'->>'network_id'=$1 AND o.scope<>$2 AND o.status NOT IN ('failed')").bind(&network.id).bind(&plan.scope).fetch_all(&mut *tx).await?;
        let mut checked_network = network;
        for body in occupied {
            checked_network
                .application_cidrs
                .push(decode::<Inventory>(body)?.cidr);
        }
        crate::domain::plan(&inventory, &checked_network, &plan.request)?;
        sqlx::query("INSERT INTO desired_connections(scope,request,plan_id) VALUES ($1,$2,$3) ON CONFLICT(scope) DO NOTHING")
            .bind(&plan.scope).bind(encode(&plan.request)?).bind(&plan.id).execute(&mut *tx).await?;
        sqlx::query("UPDATE scopes SET version=version+1 WHERE id=$1")
            .bind(&plan.scope)
            .execute(&mut *tx)
            .await?;
        let operation_id = id();
        let row = sqlx::query("INSERT INTO operations(id,plan_id,scope,status,fault) VALUES ($1,$2,$3,'queued',$4) RETURNING *").bind(&operation_id).bind(plan_id).bind(&plan.scope).bind(encode(&fault)?).fetch_one(&mut *tx).await?;
        audit(&mut tx, actor, "plan_applied", plan_id).await?;
        tx.commit().await?;
        operation_row(row)
    }
    pub async fn operation(&self, id: &str) -> anyhow::Result<Operation> {
        operation_row(
            sqlx::query("SELECT * FROM operations WHERE id=$1")
                .bind(id)
                .fetch_one(&self.pool)
                .await?,
        )
    }
    pub async fn claim(&self) -> anyhow::Result<Option<Claim>> {
        let row = sqlx::query("UPDATE operations SET status='running', fence=fence+1, lease_until=clock_timestamp()+interval '15 seconds',updated_at=clock_timestamp() WHERE id=(SELECT id FROM operations WHERE status IN ('queued','running','retrying') AND lease_until<clock_timestamp() AND next_attempt<=clock_timestamp() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *").fetch_optional(&self.pool).await?;
        row.map(|r| {
            let fence = r.try_get("fence")?;
            Ok(Claim {
                operation: operation_row(r)?,
                fence,
            })
        })
        .transpose()
    }
    pub async fn observe(&self, operation_id: &str) -> anyhow::Result<Observation> {
        let op = self.operation(operation_id).await?;
        let plan = self.plan(&op.plan_id).await?;
        let effects: Vec<Value> =
            sqlx::query_scalar("SELECT body FROM fake_effects WHERE scope=$1")
                .bind(&op.scope)
                .fetch_all(&self.pool)
                .await?;
        let drift = plan.actions.iter().take(op.step as usize).any(|a| {
            !effects
                .iter()
                .any(|e| *e == encode(&a.effect()).unwrap_or(Value::Null))
        }) || effects.iter().any(|effect| {
            !plan
                .actions
                .iter()
                .any(|a| encode(&a.effect()).is_ok_and(|expected| *effect == expected))
        });
        let network: RegionalNetwork = decode(
            sqlx::query_scalar("SELECT body FROM networks WHERE id=$1")
                .bind(&plan.request.network_id)
                .fetch_one(&self.pool)
                .await?,
        )?;
        Ok(Observation { operation_id: op.id, configuration: if drift { "drift" } else if op.status == "succeeded" { "simulated_converged" } else { "not_converged" }.into(), calculated_path: format!("{} → regional transit → {} → same-AZ managed NAT → Internet (calculated simulation)",plan.request.vpc_id,network.name), public_ips: network.public_ips, connectivity: "Application VPC isolation; no shared-service permission".into(), active_probe: "Not tested; no probe deployed; fake provider does not prove connectivity".into(), drift, recovery: "Inspect the immutable plan and completed step events; resolve conflicts, rediscover, and create a new plan. No automatic repair or rollback.".into() })
    }
    pub async fn inject_drift(&self, actor: &str, operation_id: &str) -> anyhow::Result<()> {
        let op = self.operation(operation_id).await?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT id FROM scopes WHERE id=$1 FOR UPDATE")
            .bind(&op.scope)
            .execute(&mut *tx)
            .await?;
        let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM operations WHERE scope=$1 AND status IN ('queued','running','retrying'))").bind(&op.scope).fetch_one(&mut *tx).await?;
        ensure!(!active, "Cannot inject drift while an operation is active");
        sqlx::query("DELETE FROM fake_effects WHERE scope=$1 AND action_key=(SELECT action_key FROM fake_effects WHERE scope=$1 ORDER BY action_key LIMIT 1)").bind(&op.scope).execute(&mut *tx).await?;
        sqlx::query("UPDATE scopes SET version=version+1 WHERE id=$1")
            .bind(&op.scope)
            .execute(&mut *tx)
            .await?;
        audit(&mut tx, actor, "demo_drift_injected", operation_id).await?;
        tx.commit().await?;
        Ok(())
    }
    #[doc(hidden)]
    pub async fn expire_lease_for_test(&self, operation_id: &str) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        )
        .bind(operation_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

async fn verify_connection_intent(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    scope: &str,
    request: &ConnectionRequest,
) -> anyhow::Result<()> {
    let previous: Option<Value> =
        sqlx::query_scalar("SELECT request FROM desired_connections WHERE scope=$1")
            .bind(scope)
            .fetch_optional(&mut **tx)
            .await?;
    ensure!(
        previous.is_none_or(|body| body == encode(request).unwrap_or(Value::Null)),
        "Changing an existing connection requires an explicit safe migration; network/subnet replacement is not supported"
    );
    Ok(())
}

pub(crate) async fn audit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    actor: &str,
    event: &str,
    target: &str,
) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO audit(actor,event,target) VALUES ($1,$2,$3)")
        .bind(actor)
        .bind(event)
        .bind(target)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
