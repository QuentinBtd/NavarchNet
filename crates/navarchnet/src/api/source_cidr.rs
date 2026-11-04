//! Narrow protected HTTP boundary over the already bounded saved composition.
#[cfg(test)]
mod tests;
use super::{ApiError, AppState};
use crate::aws::{
    saved_observation::{SavedObservationReadBudget, SavedObservationReadError},
    source_handoff_cidr_coverage::{
        self as core, SourceHandoffCidrBudget, SourceHandoffCidrCoverage, SourceHandoffCidrError,
        SourceHandoffCidrQuery,
    },
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;

// Explicit generator enumeration is unchanged: no frontend consumer or second response DTO.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CoverageRequest {
    network_account_id: String,
    subnet_id: String,
    destination_cidr: String,
}
pub(super) enum CoverageFailure {
    Core(SourceHandoffCidrError),
    Store(anyhow::Error),
}
impl IntoResponse for CoverageFailure {
    fn into_response(self) -> Response {
        match self {
            Self::Core(error) => {
                let status = match &error {
                    SourceHandoffCidrError::InvalidQuery { .. } => StatusCode::UNPROCESSABLE_ENTITY,
                    SourceHandoffCidrError::BudgetExceeded { .. } => StatusCode::PAYLOAD_TOO_LARGE,
                    SourceHandoffCidrError::IdentityUnavailable
                    | SourceHandoffCidrError::PartitionProofUnavailable => StatusCode::CONFLICT,
                };
                (status, Json(error)).into_response()
            }
            Self::Store(error) => {
                use SavedObservationReadError::*;
                let (status, message) = match error.downcast_ref::<SavedObservationReadError>() {
                    Some(InvalidRegistrationInput) => (
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "invalid_saved_registration_input",
                    ),
                    Some(InvalidBudget) => (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "saved_observation_budget_configuration_invalid",
                    ),
                    Some(MissingObservation) => {
                        (StatusCode::NOT_FOUND, "saved_observation_unavailable")
                    }
                    Some(BudgetExceeded { .. }) => (
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "saved_observation_budget_exceeded",
                    ),
                    Some(MalformedObservation) => {
                        (StatusCode::CONFLICT, "saved_observation_malformed")
                    }
                    Some(IdentityUnavailable) => (
                        StatusCode::CONFLICT,
                        "saved_observation_identity_unavailable",
                    ),
                    None => (StatusCode::CONFLICT, "saved_observation_read_failed"),
                };
                (
                    status,
                    Json(ApiError {
                        error: message.into(),
                    }),
                )
                    .into_response()
            }
        }
    }
}
pub(super) fn remaining(
    budget: SavedObservationReadBudget,
    charged: usize,
) -> Result<SavedObservationReadBudget, CoverageFailure> {
    let total_bytes = budget
        .total_bytes
        .checked_sub(charged)
        .ok_or(CoverageFailure::Core(
            SourceHandoffCidrError::BudgetExceeded {
                dimension: "aggregate_read_bytes",
                limit: budget.total_bytes,
            },
        ))?;
    Ok(SavedObservationReadBudget {
        total_bytes,
        ..budget
    })
}
pub(super) async fn coverage(
    State(state): State<AppState>,
    Path(source_account_id): Path<String>,
    Query(request): Query<CoverageRequest>,
) -> Result<Json<SourceHandoffCidrCoverage>, CoverageFailure> {
    let query = SourceHandoffCidrQuery {
        source_account_id,
        network_account_id: request.network_account_id,
        subnet_id: request.subnet_id,
        destination_cidr: request.destination_cidr,
    };
    core::validate_query(&query).map_err(CoverageFailure::Core)?;
    let budget = SavedObservationReadBudget::default();
    let source = state
        .store
        .aws_saved_observation_bounded(&query.source_account_id, budget)
        .await
        .map_err(CoverageFailure::Store)?;
    let next = remaining(budget, source.admitted_bytes)?;
    let network = state
        .store
        .aws_saved_observation_bounded(&query.network_account_id, next)
        .await
        .map_err(CoverageFailure::Store)?;
    let result = core::analyze(source, network, query, SourceHandoffCidrBudget::default())
        .map_err(CoverageFailure::Core)?;
    // Return precisely the counted compact core envelope: no late provenance wrapper or mutation.
    Ok(Json(result))
}
