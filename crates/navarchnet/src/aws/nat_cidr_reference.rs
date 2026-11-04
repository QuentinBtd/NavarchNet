//! Complete saved VPC decisions with literal NAT metadata indexes, never a usable egress path.
use super::{
    nat_reference::{self, NatRecordReference, NatReferenceReason, NatReferenceScope},
    saved_cidr_admission::{self, Census},
    saved_observation::SavedObservation,
    source_handoff_cidr_coverage::{
        SourceHandoffCidrBudget, SourceHandoffCidrError, check, checked, encoded_len, identity,
    },
    target_lookup::TargetAzSelection,
    vpc_cidr_coverage::{self, CoverageBudget, VpcCidrCoverage, VpcCidrCoverageError},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NatCidrReferenceQuery {
    pub account_id: String,
    pub subnet_id: String,
    pub destination_cidr: String,
}
#[derive(Debug, Serialize)]
#[serde(tag = "error", rename_all = "snake_case")]
pub enum NatCidrReferenceError {
    Admission { cause: SourceHandoffCidrError },
    VpcCoverage { cause: VpcCidrCoverageError },
}
impl From<SourceHandoffCidrError> for NatCidrReferenceError {
    fn from(error: SourceHandoffCidrError) -> Self {
        Self::Admission { cause: error }
    }
}
impl From<VpcCidrCoverageError> for NatCidrReferenceError {
    fn from(error: VpcCidrCoverageError) -> Self {
        Self::VpcCoverage { cause: error }
    }
}
impl std::fmt::Display for NatCidrReferenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Saved NAT reference refused: {self:?}")
    }
}
impl std::error::Error for NatCidrReferenceError {}
type Result<T> = std::result::Result<T, NatCidrReferenceError>;
/// Trusted local structural, attempted-copy, logical-work and compact-output caps; not HTTP knobs,
/// allocator/RSS/CPU/deadline or cloud quota guarantees. Conservative refusals are intentional.
#[derive(Debug, Clone, Copy)]
pub struct NatCidrReferenceBudget {
    pub resources: usize,
    pub associations: usize,
    pub related_ids: usize,
    pub links: usize,
    pub routes: usize,
    pub targets: usize,
    pub attachments: usize,
    pub cidrs: usize,
    pub other_entries: usize,
    pub string_bytes: usize,
    pub region_bytes: usize,
    pub evidence_bytes: usize,
    pub segments: usize,
    pub work_units: usize,
    pub clone_payload_bytes: usize,
    pub response_bytes: usize,
    pub vpc: CoverageBudget,
}
impl Default for NatCidrReferenceBudget {
    fn default() -> Self {
        Self {
            resources: 1000,
            associations: 4096,
            related_ids: 4096,
            links: 4096,
            routes: 512,
            targets: 2048,
            attachments: 2048,
            cidrs: 4096,
            other_entries: 8192,
            string_bytes: 2048,
            region_bytes: 64,
            evidence_bytes: 2_097_152,
            segments: 256,
            work_units: 512_000_000,
            clone_payload_bytes: 8_388_608,
            response_bytes: 4_194_304,
            vpc: CoverageBudget {
                segments: 256,
                ..CoverageBudget::default()
            },
        }
    }
}
impl From<NatCidrReferenceBudget> for SourceHandoffCidrBudget {
    fn from(b: NatCidrReferenceBudget) -> Self {
        Self {
            source_resources: b.resources,
            network_resources: b.resources,
            resources: b.resources,
            associations: b.associations,
            related_ids: b.related_ids,
            links: b.links,
            routes: b.routes,
            targets: b.targets,
            attachments: b.attachments,
            cidrs: b.cidrs,
            other_entries: b.other_entries,
            string_bytes: b.string_bytes,
            region_bytes: b.region_bytes,
            evidence_bytes: b.evidence_bytes,
            raw_origins: b.vpc.raw_cuts,
            segments: b.segments,
            work_units: b.work_units,
            clone_payload_bytes: b.clone_payload_bytes,
            response_bytes: b.response_bytes,
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum NatCidrRecordReference {
    ReportedRecord {
        /// Index into this envelope's original saved.topology.resources, not an authority token.
        resource_index: usize,
        owner_scope: NatReferenceScope,
        vpc_scope: NatReferenceScope,
    },
    Unresolved {
        reason: NatReferenceReason,
    },
}
#[derive(Debug, Serialize)]
pub struct NatCidrSegmentReference {
    pub vpc_segment_index: usize,
    pub reference: NatCidrRecordReference,
}
/// One shape is counted borrowed and moved owned; no per-cell resource copy or late wrapper.
#[derive(Debug, Serialize)]
pub struct NatCidrReferenceEnvelope<Q, S, V, R> {
    pub query: Q,
    pub saved: S,
    pub vpc_coverage: V,
    pub references: R,
    pub reference_only: bool,
    pub partition_complete: bool,
    pub execution_enabled: bool,
    pub connectivity_tested: bool,
    pub az_selection: TargetAzSelection,
}
pub type NatCidrReferenceCoverage = NatCidrReferenceEnvelope<
    NatCidrReferenceQuery,
    SavedObservation,
    VpcCidrCoverage,
    Vec<NatCidrSegmentReference>,
>;
fn envelope<Q, S, V, R>(
    query: Q,
    saved: S,
    vpc_coverage: V,
    references: R,
) -> NatCidrReferenceEnvelope<Q, S, V, R> {
    NatCidrReferenceEnvelope {
        query,
        saved,
        vpc_coverage,
        references,
        reference_only: true,
        partition_complete: true,
        execution_enabled: false,
        connectivity_tested: false,
        az_selection: TargetAzSelection::NotInferred,
    }
}
fn reference_row_bound(limit: usize) -> std::result::Result<usize, SourceHandoffCidrError> {
    use NatReferenceReason as Reason;
    use NatReferenceScope as Scope;
    // Exhaustive guards make new variants a mandatory framing-ledger review.
    let _reason_guard = |r: &Reason| match r {
        Reason::NoReportedNatReference
        | Reason::MissingOrAmbiguousRecord
        | Reason::IncompleteObservation
        | Reason::UnsupportedRegion => (),
    };
    let _scope_guard = |r: &Scope| match r {
        Scope::ReportedSame | Scope::NotReported | Scope::ReportedDifferent => (),
    };
    let scopes = [
        Scope::ReportedSame,
        Scope::NotReported,
        Scope::ReportedDifferent,
    ];
    let mut maximum = 0;
    let mut count = |reference| -> std::result::Result<(), SourceHandoffCidrError> {
        maximum = maximum.max(encoded_len(
            &NatCidrSegmentReference {
                vpc_segment_index: usize::MAX,
                reference,
            },
            limit,
            "response_bytes",
        )?);
        Ok(())
    };
    for owner_scope in &scopes {
        for vpc_scope in &scopes {
            count(NatCidrRecordReference::ReportedRecord {
                resource_index: usize::MAX,
                owner_scope: owner_scope.clone(),
                vpc_scope: vpc_scope.clone(),
            })?;
        }
    }
    for reason in [
        Reason::NoReportedNatReference,
        Reason::MissingOrAmbiguousRecord,
        Reason::IncompleteObservation,
        Reason::UnsupportedRegion,
    ] {
        count(NatCidrRecordReference::Unresolved { reason })?;
    }
    Ok(maximum)
}
#[cfg(test)]
thread_local! {
    pub(super) static CHILD_ANALYSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    pub(super) static RESERVED_WORK: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    pub(super) static RESERVED_CLONES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    pub(super) static RESERVED_RESPONSE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
pub(crate) fn validate_query(query: &NatCidrReferenceQuery) -> Result<()> {
    if query.account_id.is_empty()
        || query.account_id.len() > 2048
        || query.account_id.chars().any(char::is_control)
    {
        return Err(SourceHandoffCidrError::InvalidQuery {
            field: "account_id",
        }
        .into());
    }
    vpc_cidr_coverage::validate_query(&query.subnet_id, &query.destination_cidr)?;
    Ok(())
}
/// Uniformity follows from the unchanged child's complete VPC decision partition. Correlation has
/// no destination predicate: fixed capture/subnet/completeness/region plus an unchanged VPC result
/// fixes literal record identity and scopes. No new witnesses, pruning, coalescing or NAT state rule.
pub fn analyze(
    saved: SavedObservation,
    query: NatCidrReferenceQuery,
    b: NatCidrReferenceBudget,
) -> Result<NatCidrReferenceCoverage> {
    validate_query(&query)?;
    check(saved.topology.resources.len(), b.resources, "resources")?;
    check(b.vpc.segments, b.segments, "segments")?;
    let mut census = Census {
        work_limit: b.work_units,
        ..Census::default()
    };
    saved_cidr_admission::admit_capture(&mut census, &saved.topology, false, b.into())?;
    checked(census.base()?.checked_mul(64), b.work_units, "work_units")?;
    saved_cidr_admission::strings(&saved, b.into())?;
    for s in [&query.account_id, &query.subnet_id, &query.destination_cidr] {
        check(s.len(), b.string_bytes, "string_bytes")?;
    }
    identity(&saved, &query.account_id)?;
    let evidence = encoded_len(&saved, b.evidence_bytes, "evidence_bytes")?;
    let query_bytes = encoded_len(&query, b.response_bytes, "response_bytes")?;
    let row = reference_row_bound(b.response_bytes)?;
    let framing = encoded_len(
        &envelope(
            &query,
            &saved,
            None::<&VpcCidrCoverage>,
            &[] as &[NatCidrSegmentReference],
        ),
        b.response_bytes,
        "response_bytes",
    )?;
    let s = b.vpc.segments;
    let region_parts = saved
        .topology
        .region
        .bytes()
        .filter(|c| *c == b'-')
        .count()
        .checked_add(1);
    // Scalar/schema/evidence passes are charged separately from collection/index/clone/sort slots.
    // Evidence/query are counted3x (direct/framing/final); child output2x (child/final). 64 bounds current
    // concrete serde shapes/enum fields; audit on schema change. Excludes comparisons/writer calls.
    let work = checked(
        census
            .base()?
            .checked_add(region_parts.ok_or(SourceHandoffCidrError::PartitionProofUnavailable)?)
            .and_then(|v| v.checked_mul(s.checked_add(2)?))
            .and_then(|v| v.checked_add(evidence.checked_mul(3)?))
            .and_then(|v| v.checked_add(b.vpc.response_bytes.checked_mul(2)?))
            .and_then(|v| v.checked_add(query_bytes.checked_mul(3)?))
            .and_then(|v| v.checked_add(row.checked_mul(s)?.checked_mul(2)?))
            .and_then(|v| v.checked_add(b.vpc.raw_cuts))
            .and_then(|v| v.checked_add(8192))
            .and_then(|v| v.checked_mul(64))
            .and_then(|v| v.checked_add(b.vpc.row_visits)),
        b.work_units,
        "work_units",
    )?;
    let clones = checked(
        census
            .us
            .checked_mul(3)
            .and_then(|v| v.checked_add(5))
            .and_then(|v| v.checked_add(s.checked_mul(4)?))
            .and_then(|v| v.checked_mul(b.string_bytes))
            .and_then(|v| v.checked_add(s.checked_mul(78)?))
            .and_then(|v| v.checked_add(evidence))
            .and_then(|v| v.checked_add(64)),
        b.clone_payload_bytes,
        "clone_payload_bytes",
    )?;
    let response = checked(
        framing
            .checked_sub(4)
            .and_then(|v| v.checked_add(b.vpc.response_bytes))
            .and_then(|v| v.checked_add(row.checked_mul(s)?))
            .and_then(|v| v.checked_add(s.saturating_sub(1))),
        b.response_bytes,
        "response_bytes",
    )?;
    #[cfg(test)]
    {
        RESERVED_WORK.with(|v| v.set(work));
        RESERVED_CLONES.with(|v| v.set(clones));
        RESERVED_RESPONSE.with(|v| v.set(response));
    }
    check(work, b.work_units, "work_units")?;
    check(clones, b.clone_payload_bytes, "clone_payload_bytes")?;
    check(response, b.response_bytes, "response_bytes")?;
    #[cfg(test)]
    CHILD_ANALYSES.with(|v| v.set(v.get() + 1));
    let coverage = vpc_cidr_coverage::analyze(
        &saved.topology,
        &query.subnet_id,
        &query.destination_cidr,
        b.vpc,
    )?;
    if !coverage.partition_complete
        || coverage.segments.is_empty()
        || coverage.destination_cidr != query.destination_cidr
    {
        return Err(SourceHandoffCidrError::PartitionProofUnavailable.into());
    }
    let references = coverage
        .segments
        .iter()
        .enumerate()
        .map(|(vpc_segment_index, cell)| {
            let reference =
                match nat_reference::correlate(&saved.topology, &query.subnet_id, &cell.result) {
                    NatRecordReference::ReportedRecord {
                        resource_index,
                        owner_scope,
                        vpc_scope,
                    } => NatCidrRecordReference::ReportedRecord {
                        resource_index,
                        owner_scope,
                        vpc_scope,
                    },
                    NatRecordReference::Unresolved { reason } => {
                        NatCidrRecordReference::Unresolved { reason }
                    }
                };
            NatCidrSegmentReference {
                vpc_segment_index,
                reference,
            }
        })
        .collect::<Vec<_>>();
    let output = envelope(query, saved, coverage, references);
    encoded_len(&output, b.response_bytes, "response_bytes")?;
    Ok(output)
}
