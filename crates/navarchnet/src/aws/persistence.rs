//! Durable AWS metadata; discovery must not overwrite newer work or grant implicit ownership.
use super::{
    AdoptionConsent, AdoptionRecord, RoleRegistration, TopologyView, VerifiedAccount,
    observation::AwsTopology,
};
use crate::store::{Store, audit};
use anyhow::{Context, ensure};
use serde_json::Value;
use sqlx::Row;

pub(crate) fn epoch() -> anyhow::Result<String> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs()
        .to_string())
}
impl Store {
    pub async fn register_aws_verified(
        &self,
        actor: &str,
        request: &RoleRegistration,
        verified_account: &str,
        verified_session_name: &str,
    ) -> anyhow::Result<VerifiedAccount> {
        let role = request.validate()?;
        ensure!(
            (2..=64).contains(&verified_session_name.len())
                && verified_session_name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_+=,.@-".contains(&b)),
            "Invalid verification session attribution"
        );
        ensure!(
            role.account_id == verified_account,
            "Verified AWS account does not match role reference"
        );
        let view = VerifiedAccount {
            id: uuid::Uuid::new_v4().to_string(),
            name: request.name.clone(),
            role_arn: request.role_arn.clone(),
            aws_account_id: verified_account.into(),
            region: request.region.clone(),
            verified_at: epoch()?,
            verified_session_name: verified_session_name.into(),
            execution_enabled: false,
        };
        let mut tx = self.pool.begin().await?;
        // Bound the catalog without racing concurrent account registrations.
        sqlx::query("SELECT pg_advisory_xact_lock(16321,1)")
            .execute(&mut *tx)
            .await?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM aws_accounts")
            .fetch_one(&mut *tx)
            .await?;
        ensure!(
            count < 500,
            "AWS catalog limit reached; explicit pagination is required before increasing it"
        );
        sqlx::query("INSERT INTO aws_accounts(id,aws_account_id,region,role_configuration,public_view) VALUES($1,$2,$3,$4,$5)").bind(&view.id).bind(verified_account).bind(&request.region).bind(serde_json::to_value(request)?).bind(serde_json::to_value(&view)?).execute(&mut *tx).await?;
        audit(&mut tx, actor, "aws_account_verified", &view.id).await?;
        tx.commit().await?;
        Ok(view)
    }
    pub async fn aws_accounts(&self) -> anyhow::Result<Vec<VerifiedAccount>> {
        sqlx::query_scalar::<_, Value>("SELECT public_view FROM aws_accounts ORDER BY id LIMIT 500")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(|v| serde_json::from_value(v).map_err(Into::into))
            .collect()
    }
    pub async fn begin_aws_discovery(
        &self,
        actor: &str,
        id: &str,
    ) -> anyhow::Result<(RoleRegistration, VerifiedAccount, i64)> {
        let mut tx = self.pool.begin().await?;
        let row=sqlx::query("UPDATE aws_accounts SET discovery_fence=discovery_fence+1 WHERE id=$1 RETURNING role_configuration,public_view,discovery_fence").bind(id).fetch_one(&mut *tx).await?;
        let request = serde_json::from_value(row.try_get("role_configuration")?)?;
        let view = serde_json::from_value(row.try_get("public_view")?)?;
        let generation = row.try_get("discovery_fence")?;
        audit(&mut tx, actor, "aws_discovery_started", id).await?;
        tx.commit().await?;
        // No transaction/row lock is held while fetching credentials or cloud pages.
        Ok((request, view, generation))
    }
    pub async fn finish_aws_discovery(
        &self,
        actor: &str,
        generation: i64,
        topology: &AwsTopology,
    ) -> anyhow::Result<()> {
        ensure!(
            generation > 0
                && topology.complete_for_supported_queries
                && !topology.execution_enabled
                && !topology.connectivity_tested
                && topology.resources.len() <= 10_000
                && topology.resources.iter().all(|r| !r.managed),
            "Only a complete supported-query read-only observation can be persisted"
        );
        ensure!(
            serde_json::to_vec(topology)?.len() <= 32 * 1024 * 1024,
            "AWS topology exceeds the persisted snapshot budget"
        );
        let links = topology.resources.iter().fold(0usize, |count, row| {
            count
                .saturating_add(row.tgw_associations.as_ref().map_or(0, Vec::len))
                .saturating_add(row.tgw_propagations.as_ref().map_or(0, Vec::len))
        });
        ensure!(
            links <= 10_000,
            "AWS topology exceeds the TGW relationship budget"
        );
        let mut routes = 0usize;
        let mut attachments = 0usize;
        for row in &topology.resources {
            if let Some(values) = &row.tgw_routes {
                routes = routes.saturating_add(values.len());
                for route in values {
                    attachments = attachments.saturating_add(route.attachments.len());
                }
            }
        }
        ensure!(
            routes <= 10_000 && attachments <= 10_000,
            "AWS topology exceeds TGW route or attachment budget"
        );
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT public_view,discovery_fence FROM aws_accounts WHERE id=$1 FOR UPDATE",
        )
        .bind(&topology.account_id)
        .fetch_one(&mut *tx)
        .await?;
        let view: VerifiedAccount = serde_json::from_value(row.try_get("public_view")?)?;
        ensure!(
            row.try_get::<i64, _>("discovery_fence")? == generation,
            "AWS discovery was superseded by a newer request"
        );
        ensure!(
            view.aws_account_id == topology.aws_account_id && view.region == topology.region,
            "AWS observation identity or region changed"
        );
        sqlx::query(
            "INSERT INTO aws_topologies(id,account_id,generation,body) VALUES($1,$2,$3,$4)",
        )
        .bind(&topology.id)
        .bind(&topology.account_id)
        .bind(generation)
        .bind(serde_json::to_value(topology)?)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut tx,
            actor,
            "aws_discovery_completed",
            &topology.account_id,
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn aws_topology(&self, id: &str) -> anyhow::Result<TopologyView> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await?;
        let body: Value = sqlx::query_scalar(
            "SELECT body FROM aws_topologies WHERE account_id=$1 ORDER BY generation DESC LIMIT 1",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        let adoptions = sqlx::query_scalar::<_, Value>(
            "SELECT body FROM aws_adoptions WHERE account_id=$1 ORDER BY id LIMIT 10000",
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(serde_json::from_value)
        .collect::<Result<Vec<AdoptionRecord>, _>>()?;
        let topology: AwsTopology = serde_json::from_value(body)?;
        tx.commit().await?;
        Ok(TopologyView {
            subnet_route_tables: super::routing::subnet_route_tables(&topology),
            topology,
            adoptions,
        })
    }
    pub async fn adopt_aws_resource(
        &self,
        actor: &str,
        id: &str,
        consent: &AdoptionConsent,
    ) -> anyhow::Result<AdoptionRecord> {
        use super::observation::ResourceKind;
        ensure!(
            !consent.reason.trim().is_empty() && consent.reason.len() <= 1000,
            "An explicit 1–1000-character adoption reason is required"
        );
        ensure!(
            matches!(
                &consent.resource_kind,
                ResourceKind::Vpc | ResourceKind::TransitGateway
            ),
            "This resource kind cannot yet be adopted; VPC/TGW metadata consent grants no route-management permission"
        );
        let mut tx = self.pool.begin().await?;
        let account = sqlx::query(
            "SELECT public_view,discovery_fence FROM aws_accounts WHERE id=$1 FOR UPDATE",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        let view: VerifiedAccount = serde_json::from_value(account.try_get("public_view")?)?;
        let current=sqlx::query("SELECT id,generation,body FROM aws_topologies WHERE account_id=$1 ORDER BY generation DESC LIMIT 1").bind(id).fetch_one(&mut *tx).await?;
        ensure!(
            current.try_get::<String, _>("id")? == consent.topology_id
                && current.try_get::<i64, _>("generation")?
                    == account.try_get::<i64, _>("discovery_fence")?,
            "Adoption requires the current completed discovery; refresh after failed or superseding discovery"
        );
        let topology: AwsTopology = serde_json::from_value(current.try_get("body")?)?;
        let resource = topology
            .resources
            .iter()
            .find(|r| r.id == consent.resource_id && r.kind == consent.resource_kind)
            .context("Resource not present in the selected observation")?;
        ensure!(
            resource.owner_account_id.as_deref() == Some(&view.aws_account_id),
            "Shared, unknown-owner or foreign resources cannot be adopted"
        );
        let kind_value = serde_json::to_value(&consent.resource_kind)?;
        let kind = kind_value
            .as_str()
            .context("Invalid adoption resource kind")?;
        let previous:Option<Value>=sqlx::query_scalar("SELECT body FROM aws_adoptions WHERE account_id=$1 AND resource_kind=$2 AND resource_id=$3").bind(id).bind(kind).bind(&consent.resource_id).fetch_optional(&mut *tx).await?;
        if let Some(previous) = previous {
            let previous: AdoptionRecord = serde_json::from_value(previous)?;
            ensure!(
                previous.topology_id == consent.topology_id
                    && previous.reason == consent.reason
                    && previous.actor == actor,
                "Existing ownership consent cannot be silently replaced"
            );
            tx.commit().await?;
            return Ok(previous);
        }
        let record = AdoptionRecord {
            id: uuid::Uuid::new_v4().to_string(),
            account_id: id.into(),
            topology_id: consent.topology_id.clone(),
            resource_kind: consent.resource_kind.clone(),
            resource_id: consent.resource_id.clone(),
            actor: actor.into(),
            reason: consent.reason.clone(),
            consented_at: epoch()?,
            execution_enabled: false,
        };
        sqlx::query("INSERT INTO aws_adoptions(id,account_id,resource_kind,resource_id,topology_id,body) VALUES($1,$2,$3,$4,$5,$6)").bind(&record.id).bind(id).bind(kind).bind(&record.resource_id).bind(&record.topology_id).bind(serde_json::to_value(&record)?).execute(&mut *tx).await?;
        audit(&mut tx, actor, "aws_resource_adopted", &record.id).await?;
        tx.commit().await?;
        Ok(record)
    }
}
