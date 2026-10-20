//! Offline recovery journal, deliberately not connected to an AWS executor or HTTP admission.
//! A durable dispatch marker is not proof of an external effect. Once dispatched, takeovers may
//! only observe; missing/ambiguous evidence never authorizes a blind mutation retry.
use crate::store::Store;
use anyhow::{Context, ensure};
use sqlx::{Row, postgres::PgRow};
use std::future::Future;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalEffectIntent {
    pub id: String,
    pub scope: String,
    pub action_key: String,
    pub desired_sha256: String,
    pub client_token: String,
    pub state: String,
    pub external_id: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectDirective {
    DispatchOnce,
    ObserveOnly,
}
#[derive(Debug)]
pub struct ExternalEffectClaim {
    intent_id: String,
    fence: i64,
    directive: EffectDirective,
}
impl ExternalEffectClaim {
    pub fn fence(&self) -> i64 {
        self.fence
    }
    pub fn directive(&self) -> EffectDirective {
        self.directive
    }
}
/// An in-process handoff only. It cannot fence a remote provider or make its calls atomic.
/// Future adapters must enforce provider-specific token/ownership/precondition semantics.
pub struct DispatchPermit {
    client_token: String,
    desired_sha256: String,
}
impl DispatchPermit {
    pub fn client_token(&self) -> &str {
        &self.client_token
    }
    pub fn desired_sha256(&self) -> &str {
        &self.desired_sha256
    }
}
/// Trusted adapter evidence, not a user-supplied API assertion. No live adapter exists yet.
pub struct ObservedExternalEffect {
    pub client_token: String,
    pub desired_sha256: String,
    pub external_id: String,
}
/// Complete coverage is a trusted reader assertion, not a user/API field or cloud proof.
/// Readers must retain every candidate and report incomplete pagination/timeouts as such.
pub struct ExternalEffectObservation {
    pub complete: bool,
    pub candidates: Vec<ObservedExternalEffect>,
}
#[derive(Debug, PartialEq, Eq)]
pub enum RecoveryOutcome {
    NotDispatched,
    AlreadyConfirmed { external_id: String },
    NotClaimed,
    ObservationIncomplete,
    NotObserved,
    AmbiguousObservation,
    ObservationMismatch,
    Confirmed { external_id: String },
}
fn text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 2048 && !value.chars().any(char::is_control)
}
fn intent(row: PgRow) -> anyhow::Result<ExternalEffectIntent> {
    Ok(ExternalEffectIntent {
        id: row.try_get("id")?,
        scope: row.try_get("scope")?,
        action_key: row.try_get("action_key")?,
        desired_sha256: row.try_get("desired_sha256")?,
        client_token: row.try_get("client_token")?,
        state: row.try_get("state")?,
        external_id: row.try_get("external_id")?,
    })
}
impl Store {
    /// One observe-only recovery attempt, with no dispatch callback or AWS/HTTP admission.
    /// Missing/incomplete/ambiguous evidence leaves dispatch uncertain; it never authorizes retry.
    /// The callback must independently read the exact intent's external scope. Token/hash equality
    /// alone does not prove real-provider identity, ownership, freshness or exactly-once execution.
    pub async fn recover_external_effect<F, Fut>(
        &self,
        id: &str,
        lease_seconds: u32,
        observe: F,
    ) -> anyhow::Result<RecoveryOutcome>
    where
        F: FnOnce(ExternalEffectIntent) -> Fut,
        Fut: Future<Output = anyhow::Result<ExternalEffectObservation>>,
    {
        ensure!(
            (1..=300).contains(&lease_seconds),
            "External effect lease must be 1–300 seconds"
        );
        let saved = self.external_effect(id).await?;
        match saved.state.as_str() {
            "prepared" => return Ok(RecoveryOutcome::NotDispatched),
            "confirmed" => {
                return Ok(RecoveryOutcome::AlreadyConfirmed {
                    external_id: saved
                        .external_id
                        .context("Confirmed intent lacks external identity")?,
                });
            }
            "dispatched" => {}
            _ => anyhow::bail!("Unsupported external journal state"),
        }
        let Some(claim) = self.claim_external_effect(id, lease_seconds).await? else {
            // Includes a concurrent confirmation after the earlier read; refresh to distinguish.
            return Ok(RecoveryOutcome::NotClaimed);
        };
        ensure!(
            claim.directive() == EffectDirective::ObserveOnly,
            "Recovery is observe-only"
        );
        let mut observation = observe(saved.clone()).await?;
        if !observation.complete {
            return Ok(RecoveryOutcome::ObservationIncomplete);
        }
        let Some(candidate) = observation.candidates.pop() else {
            return Ok(RecoveryOutcome::NotObserved);
        };
        if !observation.candidates.is_empty() {
            return Ok(RecoveryOutcome::AmbiguousObservation);
        }
        if candidate.client_token != saved.client_token
            || candidate.desired_sha256 != saved.desired_sha256
        {
            return Ok(RecoveryOutcome::ObservationMismatch);
        }
        self.confirm_external_effect(&claim, &candidate).await?;
        Ok(RecoveryOutcome::Confirmed {
            external_id: candidate.external_id,
        })
    }
    /// Reserves one immutable action per scope. Replacement/deletion is deliberately unsupported,
    /// even after confirmation: an unresolved old request must never race a different desired action.
    pub async fn prepare_external_effect(
        &self,
        scope: &str,
        action_key: &str,
        desired_sha256: &str,
    ) -> anyhow::Result<ExternalEffectIntent> {
        ensure!(
            text(scope) && text(action_key),
            "Invalid external effect scope or action key"
        );
        ensure!(
            desired_sha256.len() == 64
                && desired_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "Expected an exact lowercase SHA-256 fingerprint"
        );
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO external_effect_intents(id,scope,action_key,desired_sha256,client_token) VALUES($1,$2,$3,$4,$5) ON CONFLICT(scope) DO NOTHING")
            .bind(uuid::Uuid::new_v4().to_string()).bind(scope).bind(action_key).bind(desired_sha256).bind(uuid::Uuid::new_v4().to_string())
            .execute(&mut *tx).await?;
        let saved = intent(
            sqlx::query("SELECT * FROM external_effect_intents WHERE scope=$1")
                .bind(scope)
                .fetch_one(&mut *tx)
                .await?,
        )?;
        ensure!(
            saved.action_key == action_key && saved.desired_sha256 == desired_sha256,
            "Scope already has a different immutable external intent; manual recovery required"
        );
        tx.commit().await?;
        Ok(saved)
    }
    pub async fn external_effect(&self, id: &str) -> anyhow::Result<ExternalEffectIntent> {
        intent(
            sqlx::query("SELECT * FROM external_effect_intents WHERE id=$1")
                .bind(id)
                .fetch_one(&self.pool)
                .await?,
        )
    }
    pub async fn claim_external_effect(
        &self,
        id: &str,
        lease_seconds: u32,
    ) -> anyhow::Result<Option<ExternalEffectClaim>> {
        ensure!(
            (1..=300).contains(&lease_seconds),
            "External effect lease must be 1–300 seconds"
        );
        let row = sqlx::query("UPDATE external_effect_intents SET fence=fence+1,lease_until=clock_timestamp()+make_interval(secs=>$2),updated_at=clock_timestamp() WHERE id=$1 AND state<>'confirmed' AND lease_until<clock_timestamp() RETURNING *")
            .bind(id).bind(f64::from(lease_seconds)).fetch_optional(&self.pool).await?;
        row.map(|row| {
            Ok(ExternalEffectClaim {
                intent_id: row.try_get("id")?,
                fence: row.try_get("fence")?,
                directive: if row.try_get::<String, _>("state")? == "prepared" {
                    EffectDirective::DispatchOnce
                } else {
                    EffectDirective::ObserveOnly
                },
            })
        })
        .transpose()
    }
    /// Commits dispatch intent before handing anything to a provider. A crash after this marker but
    /// before the request leaves the process intentionally requires observation/manual recovery.
    pub async fn begin_external_dispatch(
        &self,
        claim: &ExternalEffectClaim,
    ) -> anyhow::Result<DispatchPermit> {
        ensure!(
            claim.directive == EffectDirective::DispatchOnce,
            "Uncertain external effect is observe-only"
        );
        let row = sqlx::query("UPDATE external_effect_intents SET state='dispatched',updated_at=clock_timestamp() WHERE id=$1 AND fence=$2 AND state='prepared' AND lease_until>clock_timestamp() RETURNING client_token,desired_sha256")
            .bind(&claim.intent_id).bind(claim.fence).fetch_optional(&self.pool).await?.context("Stale/expired claim or dispatch already recorded")?;
        Ok(DispatchPermit {
            client_token: row.try_get("client_token")?,
            desired_sha256: row.try_get("desired_sha256")?,
        })
    }
    pub async fn confirm_external_effect(
        &self,
        claim: &ExternalEffectClaim,
        observed: &ObservedExternalEffect,
    ) -> anyhow::Result<()> {
        ensure!(
            text(&observed.external_id),
            "Invalid observed external identity"
        );
        let changed = sqlx::query("UPDATE external_effect_intents SET state='confirmed',external_id=$3,lease_until='-infinity',updated_at=clock_timestamp() WHERE id=$1 AND fence=$2 AND state='dispatched' AND lease_until>clock_timestamp() AND client_token=$4 AND desired_sha256=$5")
            .bind(&claim.intent_id).bind(claim.fence).bind(&observed.external_id).bind(&observed.client_token).bind(&observed.desired_sha256)
            .execute(&self.pool).await?.rows_affected();
        ensure!(
            changed == 1,
            "Unconfirmed effect: stale/expired claim, missing dispatch, or mismatched observation; preserve intent and inspect"
        );
        Ok(())
    }
}
