//! Protected single-capture target coverage; return the counted core envelope unchanged.
use super::{AppState, source_cidr::CoverageFailure};
use crate::aws::{
    saved_observation::SavedObservationReadBudget,
    target_attachment_cidr_coverage::{
        self as core, TargetAttachmentCidrBudget, TargetAttachmentCidrCoverage,
        TargetAttachmentCidrQuery,
    },
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CoverageRequest {
    transit_gateway_id: String,
    target_attachment_id: String,
    destination_cidr: String,
}

pub(super) async fn coverage(
    State(state): State<AppState>,
    Path(network_account_id): Path<String>,
    Query(request): Query<CoverageRequest>,
) -> Result<Json<TargetAttachmentCidrCoverage>, CoverageFailure> {
    let query = TargetAttachmentCidrQuery {
        network_account_id,
        transit_gateway_id: request.transit_gateway_id,
        target_attachment_id: request.target_attachment_id,
        destination_cidr: request.destination_cidr,
    };
    core::validate_query(&query).map_err(CoverageFailure::Core)?;
    let saved = state
        .store
        .aws_saved_observation_bounded(
            &query.network_account_id,
            SavedObservationReadBudget::default(),
        )
        .await
        .map_err(CoverageFailure::Store)?;
    let result = core::analyze(saved, query, TargetAttachmentCidrBudget::default())
        .map_err(CoverageFailure::Core)?;
    Ok(Json(result))
}
