//! Bounded raw saved reads for offline analysis; no derived routing or adoption lookup.
use super::{VerifiedAccount, observation::AwsTopology};
use crate::store::Store;
use serde::Serialize;
use sqlx::Row;
use std::fmt;
use ts_rs::TS;

/// Trusted local admission limits, not HTTP options, memory limits or query deadlines.
#[derive(Debug, Clone, Copy)]
pub struct SavedObservationReadBudget {
    pub topology_bytes: usize,
    pub registration_bytes: usize,
    /// Combined UTF-8 text payload, including scalar identity metadata (not wire framing).
    pub total_bytes: usize,
}
impl Default for SavedObservationReadBudget {
    fn default() -> Self {
        Self {
            topology_bytes: 1_048_576,
            registration_bytes: 16_384,
            total_bytes: 2_097_152,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SavedObservationReadError {
    InvalidRegistrationInput,
    InvalidBudget,
    MissingObservation,
    BudgetExceeded {
        dimension: &'static str,
        limit: usize,
    },
    MalformedObservation,
    IdentityUnavailable,
}
impl fmt::Display for SavedObservationReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Saved observation read refused: {self:?}")
    }
}
impl std::error::Error for SavedObservationReadError {}
#[derive(Debug, Serialize, TS)]
pub struct SavedObservation {
    pub registration: VerifiedAccount,
    pub saved_row_id: String,
    #[ts(type = "number")]
    pub generation: i64,
    pub topology: AwsTopology,
    /// Charge this against any remaining multi-read text allowance. Not a response-byte count.
    pub admitted_bytes: usize,
}
// All variable-length fields are NULL on any admission failure. Lengths use decoded JSONB text,
// never compressed pg_column_size. PostgreSQL still pays the size-inspection work; no CPU bound.
const QUERY: &str = r#"
WITH latest AS (
    SELECT a.id AS registration_id, a.aws_account_id, a.region,
           t.id AS saved_row_id, t.account_id AS topology_account_id, t.generation,
           a.public_view, t.body
    FROM aws_accounts a
    JOIN LATERAL (
        SELECT id, account_id, generation, body FROM aws_topologies
        WHERE account_id=a.id ORDER BY generation DESC LIMIT 1
    ) t ON TRUE WHERE a.id=$1
), sized AS (
    SELECT *, octet_length(body::text)::bigint AS topology_bytes,
           octet_length(public_view::text)::bigint AS registration_bytes,
           octet_length(registration_id)::bigint + octet_length(aws_account_id)
           + octet_length(region) + octet_length(saved_row_id)
           + octet_length(topology_account_id) AS metadata_bytes
    FROM latest
), gated AS (
    SELECT *, topology_bytes <= $2 AND registration_bytes <= $3
           AND metadata_bytes <= 8192
           AND topology_bytes + registration_bytes + metadata_bytes <= $4 AS admitted
    FROM sized
)
SELECT topology_bytes, registration_bytes, metadata_bytes, generation,
       CASE WHEN admitted THEN registration_id END AS registration_id,
       CASE WHEN admitted THEN aws_account_id END AS aws_account_id,
       CASE WHEN admitted THEN region END AS region,
       CASE WHEN admitted THEN saved_row_id END AS saved_row_id,
       CASE WHEN admitted THEN topology_account_id END AS topology_account_id,
       CASE WHEN admitted THEN public_view::text END AS registration_body,
       CASE WHEN admitted THEN body::text END AS topology_body
FROM gated
"#;
impl Store {
    /// Capture one latest saved row and its public registration in one read-only snapshot.
    /// Separate calls are independent; a newer attempted discovery does not hide the last saved row.
    pub async fn aws_saved_observation_bounded(
        &self,
        id: &str,
        budget: SavedObservationReadBudget,
    ) -> anyhow::Result<SavedObservation> {
        use SavedObservationReadError::*;
        if id.is_empty() || id.len() > 2048 || id.chars().any(char::is_control) {
            return Err(InvalidRegistrationInput.into());
        }
        let limits = [
            budget.topology_bytes,
            budget.registration_bytes,
            budget.total_bytes,
        ]
        .map(|value| i64::try_from(value).map_err(|_| InvalidBudget));
        let [topology_limit, registration_limit, total_limit] = limits;
        let (topology_limit, registration_limit, total_limit) =
            (topology_limit?, registration_limit?, total_limit?);
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await?;
        let row = sqlx::query(QUERY)
            .bind(id)
            .bind(topology_limit)
            .bind(registration_limit)
            .bind(total_limit)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(MissingObservation)?;
        let size = |name| -> anyhow::Result<usize> {
            Ok(usize::try_from(row.try_get::<i64, _>(name)?).map_err(|_| IdentityUnavailable)?)
        };
        let (topology_bytes, registration_bytes, metadata_bytes) = (
            size("topology_bytes")?,
            size("registration_bytes")?,
            size("metadata_bytes")?,
        );
        let total = topology_bytes
            .checked_add(registration_bytes)
            .and_then(|n| n.checked_add(metadata_bytes))
            .ok_or(IdentityUnavailable)?;
        let excess = [
            ("topology_bytes", topology_bytes, budget.topology_bytes),
            (
                "registration_bytes",
                registration_bytes,
                budget.registration_bytes,
            ),
            ("metadata_bytes", metadata_bytes, 8192),
            ("total_bytes", total, budget.total_bytes),
        ]
        .into_iter()
        .find(|(_, size, limit)| size > limit);
        if let Some((dimension, _, limit)) = excess {
            // Also verify the executed SQL gate, not just a Rust check after payload transfer.
            for name in [
                "registration_id",
                "aws_account_id",
                "region",
                "saved_row_id",
                "topology_account_id",
                "registration_body",
                "topology_body",
            ] {
                if row.try_get::<Option<&str>, _>(name)?.is_some() {
                    return Err(IdentityUnavailable.into());
                }
            }
            return Err(BudgetExceeded { dimension, limit }.into());
        }
        let registration: VerifiedAccount = serde_json::from_str(
            row.try_get::<Option<&str>, _>("registration_body")?
                .ok_or(IdentityUnavailable)?,
        )
        .map_err(|_| MalformedObservation)?;
        let topology: AwsTopology = serde_json::from_str(
            row.try_get::<Option<&str>, _>("topology_body")?
                .ok_or(IdentityUnavailable)?,
        )
        .map_err(|_| MalformedObservation)?;
        let saved_row_id: String = row.try_get("saved_row_id")?;
        let generation: i64 = row.try_get("generation")?;
        if registration.id != id
            || row.try_get::<&str, _>("registration_id")? != id
            || row.try_get::<&str, _>("topology_account_id")? != id
            || topology.account_id != id
            || topology.id != saved_row_id
            || generation <= 0
            || registration.aws_account_id != row.try_get::<&str, _>("aws_account_id")?
            || topology.aws_account_id != registration.aws_account_id
            || registration.region != row.try_get::<&str, _>("region")?
            || topology.region != registration.region
            || registration.execution_enabled
            || topology.execution_enabled
            || topology.connectivity_tested
        {
            return Err(IdentityUnavailable.into());
        }
        tx.commit().await?;
        Ok(SavedObservation {
            registration,
            saved_row_id,
            generation,
            topology,
            admitted_bytes: total,
        })
    }
}
