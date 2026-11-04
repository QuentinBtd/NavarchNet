//! Protected two-capture reference composition; no fresh AWS reads or path claim.
use super::{
    AppState,
    source_cidr::{CoverageFailure, remaining},
};
use crate::aws::{
    saved_observation::SavedObservationReadBudget,
    source_target_cidr_reference::{
        self as core, SourceTargetCidrBudget, SourceTargetCidrQuery, SourceTargetCidrReference,
    },
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReferenceRequest {
    network_account_id: String,
    subnet_id: String,
    transit_gateway_id: String,
    target_attachment_id: String,
    destination_cidr: String,
}

pub(super) async fn reference(
    State(state): State<AppState>,
    Path(source_account_id): Path<String>,
    Query(request): Query<ReferenceRequest>,
) -> Result<Json<SourceTargetCidrReference>, CoverageFailure> {
    let query = SourceTargetCidrQuery {
        source_account_id,
        network_account_id: request.network_account_id,
        subnet_id: request.subnet_id,
        transit_gateway_id: request.transit_gateway_id,
        target_attachment_id: request.target_attachment_id,
        destination_cidr: request.destination_cidr,
    };
    core::validate(&query).map_err(CoverageFailure::Core)?;
    let budget = SavedObservationReadBudget::default();
    let source = state
        .store
        .aws_saved_observation_bounded(&query.source_account_id, budget)
        .await
        .map_err(CoverageFailure::Store)?;
    let network = state
        .store
        .aws_saved_observation_bounded(
            &query.network_account_id,
            remaining(budget, source.admitted_bytes)?,
        )
        .await
        .map_err(CoverageFailure::Store)?;
    let result = core::analyze(source, network, query, SourceTargetCidrBudget::default())
        .map_err(CoverageFailure::Core)?;
    // Exactly the counted core envelope, with no late wrapper or capture reconstruction.
    Ok(Json(result))
}
