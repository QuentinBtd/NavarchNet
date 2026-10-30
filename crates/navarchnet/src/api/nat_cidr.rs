//! Protected single-capture NAT metadata references; no SDK, execution or usable-path claim.
#[cfg(test)]
mod tests;
use super::{AppState, source_cidr::CoverageFailure};
use crate::aws::{
    nat_cidr_reference::{
        self as core, NatCidrReferenceBudget, NatCidrReferenceCoverage, NatCidrReferenceError,
        NatCidrReferenceQuery,
    },
    saved_observation::SavedObservationReadBudget,
    source_handoff_cidr_coverage::SourceHandoffCidrError,
    vpc_cidr_coverage::VpcCidrCoverageError,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReferenceRequest {
    subnet_id: String,
    destination_cidr: String,
}
pub(super) enum ReferenceFailure {
    Core(NatCidrReferenceError),
    Store(anyhow::Error),
}
impl IntoResponse for ReferenceFailure {
    fn into_response(self) -> Response {
        match self {
            Self::Store(error) => CoverageFailure::Store(error).into_response(),
            Self::Core(error) => {
                let status = match &error {
                    NatCidrReferenceError::Admission { cause } => match cause {
                        SourceHandoffCidrError::InvalidQuery { .. } => {
                            StatusCode::UNPROCESSABLE_ENTITY
                        }
                        SourceHandoffCidrError::BudgetExceeded { .. } => {
                            StatusCode::PAYLOAD_TOO_LARGE
                        }
                        SourceHandoffCidrError::IdentityUnavailable
                        | SourceHandoffCidrError::PartitionProofUnavailable => StatusCode::CONFLICT,
                    },
                    NatCidrReferenceError::VpcCoverage { cause } => match cause {
                        VpcCidrCoverageError::InvalidDestinationCidr
                        | VpcCidrCoverageError::InvalidSubnetInput
                        | VpcCidrCoverageError::InputTooLarge { .. } => {
                            StatusCode::UNPROCESSABLE_ENTITY
                        }
                        VpcCidrCoverageError::BudgetExceeded { .. } => {
                            StatusCode::PAYLOAD_TOO_LARGE
                        }
                        VpcCidrCoverageError::PartitionProofUnavailable => StatusCode::CONFLICT,
                    },
                };
                (status, Json(error)).into_response()
            }
        }
    }
}
pub(super) async fn reference(
    State(state): State<AppState>,
    Path(account_id): Path<String>,
    Query(request): Query<ReferenceRequest>,
) -> Result<Json<NatCidrReferenceCoverage>, ReferenceFailure> {
    let query = NatCidrReferenceQuery {
        account_id,
        subnet_id: request.subnet_id,
        destination_cidr: request.destination_cidr,
    };
    core::validate_query(&query).map_err(ReferenceFailure::Core)?;
    let saved = state
        .store
        .aws_saved_observation_bounded(&query.account_id, SavedObservationReadBudget::default())
        .await
        .map_err(ReferenceFailure::Store)?;
    let result = core::analyze(saved, query, NatCidrReferenceBudget::default())
        .map_err(ReferenceFailure::Core)?;
    // Exactly the counted compact envelope, with no conversion, projection or late wrapper.
    Ok(Json(result))
}
