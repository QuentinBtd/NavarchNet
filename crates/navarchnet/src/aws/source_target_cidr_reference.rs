//! Bounded intersection of two existing saved-reference partitions, never an executable/full path.
//! Both child envelopes are retained verbatim. Their network captures are equal by construction,
//! not a fresh/contemporaneous second read. Aggregate configured allowances may refuse conservatively.
use super::{
    cidr_partition::{address, ordinal},
    route_lookup::TgwLookupResult,
    saved_observation::SavedObservation,
    source_handoff::{SourceHandoffLookup, SourceHandoffResult},
    source_handoff_cidr_coverage::{
        self as source, SourceHandoffCidrBudget, SourceHandoffCidrCoverage, SourceHandoffCidrError,
        SourceHandoffCidrQuery, check, checked, encoded_len,
    },
    target_attachment_cidr_coverage::{
        self as target, TargetAttachmentCidrBudget, TargetAttachmentCidrCoverage,
        TargetAttachmentCidrQuery,
    },
};
use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
type Result<T> = std::result::Result<T, SourceHandoffCidrError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceTargetCidrQuery {
    pub source_account_id: String,
    pub network_account_id: String,
    pub subnet_id: String,
    pub transit_gateway_id: String,
    pub target_attachment_id: String,
    pub destination_cidr: String,
}
/// Trusted local limits, not HTTP overrides or CPU/RSS/deadline/cloud quotas.
#[derive(Debug, Clone, Copy)]
pub struct SourceTargetCidrBudget {
    pub source: SourceHandoffCidrBudget,
    pub target: TargetAttachmentCidrBudget,
    pub segments: usize,
    pub network_copy_bytes: usize,
    pub work_units: usize,
    pub clone_payload_bytes: usize,
    pub response_bytes: usize,
}
impl Default for SourceTargetCidrBudget {
    fn default() -> Self {
        Self {
            source: SourceHandoffCidrBudget::default(),
            target: TargetAttachmentCidrBudget::default(),
            segments: 512,
            network_copy_bytes: 2_097_152,
            work_units: 2_000_000_000,
            clone_payload_bytes: 25_165_824,
            response_bytes: 12_582_912,
        }
    }
}
#[derive(Debug, Serialize)]
pub struct DecisionReferenceInterval<S = String> {
    pub start: S,
    pub end_inclusive: S,
    pub source_segment_index: usize,
    pub target_segment_index: usize,
    /// Exact unique reported gateway/attachment equality, NOT usable traffic or connectivity.
    pub selected_reference_matches: bool,
}
#[derive(Debug, Serialize)]
pub struct ReferenceEnvelope<Q, S, T, C> {
    pub query: Q,
    pub source: S,
    pub target: T,
    pub segments: C,
    pub reference_only: bool,
    pub partition_complete: bool,
    pub execution_enabled: bool,
    pub connectivity_tested: bool,
    pub simultaneous_snapshots: bool,
}
pub type SourceTargetCidrReference = ReferenceEnvelope<
    SourceTargetCidrQuery,
    SourceHandoffCidrCoverage,
    TargetAttachmentCidrCoverage,
    Vec<DecisionReferenceInterval>,
>;
fn envelope<Q, S, T, C>(
    query: Q,
    source: S,
    target: T,
    segments: C,
) -> ReferenceEnvelope<Q, S, T, C> {
    ReferenceEnvelope {
        query,
        source,
        target,
        segments,
        reference_only: true,
        partition_complete: true,
        execution_enabled: false,
        connectivity_tested: false,
        simultaneous_snapshots: false,
    }
}
fn validate(q: &SourceTargetCidrQuery) -> Result<(IpNet, usize)> {
    let mut bytes = 0usize;
    for (field, value, limit) in [
        ("source_account_id", &q.source_account_id, 2048),
        ("network_account_id", &q.network_account_id, 2048),
        ("subnet_id", &q.subnet_id, 2048),
        ("transit_gateway_id", &q.transit_gateway_id, 2048),
        ("target_attachment_id", &q.target_attachment_id, 2048),
        ("destination_cidr", &q.destination_cidr, 64),
    ] {
        if value.is_empty() || value.len() > limit || value.chars().any(char::is_control) {
            return Err(SourceHandoffCidrError::InvalidQuery { field });
        }
        bytes = checked(bytes.checked_add(value.len()), usize::MAX, "query_bytes")?;
    }
    let net: IpNet =
        q.destination_cidr
            .parse()
            .map_err(|_| SourceHandoffCidrError::InvalidQuery {
                field: "destination_cidr",
            })?;
    if net.addr() != net.network() {
        return Err(SourceHandoffCidrError::InvalidQuery {
            field: "destination_cidr",
        });
    }
    Ok((net, bytes))
}
fn add(total: &mut usize, amount: usize, limit: usize, dimension: &'static str) -> Result<()> {
    *total = checked(total.checked_add(amount), limit, dimension)?;
    Ok(())
}
fn copy_network(saved: &SavedObservation) -> SavedObservation {
    SavedObservation {
        registration: saved.registration.clone(),
        saved_row_id: saved.saved_row_id.clone(),
        generation: saved.generation,
        topology: saved.topology.clone(),
        admitted_bytes: saved.admitted_bytes,
    }
}
fn selected(value: &SourceHandoffLookup, q: &SourceTargetCidrQuery) -> bool {
    match &value.handoff {
        SourceHandoffResult::ReportedCandidate {
            transit_gateway_id,
            lookup: TgwLookupResult::ReportedForward { attachment_ids, .. },
            ..
        } => {
            transit_gateway_id == &q.transit_gateway_id
                && matches!(attachment_ids.as_slice(), [id] if id == &q.target_attachment_id)
        }
        _ => false,
    }
}
fn bounds(start: &str, end: &str, v4: bool, lo: u128, hi: u128) -> Result<(u128, u128)> {
    let a: IpAddr = start
        .parse()
        .map_err(|_| SourceHandoffCidrError::PartitionProofUnavailable)?;
    let b: IpAddr = end
        .parse()
        .map_err(|_| SourceHandoffCidrError::PartitionProofUnavailable)?;
    let pair = (ordinal(a), ordinal(b));
    if a.is_ipv4() != v4 || b.is_ipv4() != v4 || pair.0 < lo || pair.0 > pair.1 || pair.1 > hi {
        return Err(SourceHandoffCidrError::PartitionProofUnavailable);
    }
    Ok(pair)
}
/// Reuses the two complete child proofs. The intersection introduces no destination predicate:
/// each pair's raw decisions and exact reference-equality predicate are constant in its intersection.
/// Root reservations include BOTH configured child allowances before either analyzer or input clone.
/// Original errors, all child evidence and every target subnet survive; no selected traffic AZ,
/// source-host membership, NAT health, permission, contemporaneity or whole-path claim is added.
pub fn analyze(
    source_saved: SavedObservation,
    network_saved: SavedObservation,
    query: SourceTargetCidrQuery,
    b: SourceTargetCidrBudget,
) -> Result<SourceTargetCidrReference> {
    let (net, query_bytes) = validate(&query)?;
    let cells = checked(
        b.source.segments.checked_add(b.target.segments),
        b.segments,
        "aggregate_segments",
    )?;
    let mut work = 1024usize;
    for value in [
        b.source.work_units,
        b.target.work_units,
        // Three additional full-child counting passes below. Concrete derived child schemas
        // have at most 64 local field/variant visits per emitted byte, including skipped fields.
        // Do not reuse a child's allowance to pay for our extra traversals.
        checked(
            b.source
                .response_bytes
                .checked_add(b.target.response_bytes)
                .and_then(|n| n.checked_mul(64))
                .and_then(|n| n.checked_mul(3)),
            b.work_units,
            "aggregate_work_units",
        )?,
        checked(
            b.network_copy_bytes.checked_mul(64),
            b.work_units,
            "aggregate_work_units",
        )?,
        checked(cells.checked_mul(128), b.work_units, "aggregate_work_units")?,
        checked(
            query_bytes.checked_mul(64),
            b.work_units,
            "aggregate_work_units",
        )?,
    ] {
        add(&mut work, value, b.work_units, "aggregate_work_units")?;
    }
    let mut clones = 0usize;
    for value in [
        b.source.clone_payload_bytes,
        b.target.clone_payload_bytes,
        b.network_copy_bytes,
        checked(
            query_bytes.checked_mul(2),
            b.clone_payload_bytes,
            "aggregate_clone_payload_bytes",
        )?,
        checked(
            cells.checked_mul(78),
            b.clone_payload_bytes,
            "aggregate_clone_payload_bytes",
        )?,
    ] {
        add(
            &mut clones,
            value,
            b.clone_payload_bytes,
            "aggregate_clone_payload_bytes",
        )?;
    }
    // This is a compiler-checked actual row shape, not a guessed per-cell framing constant.
    let longest = "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff";
    let row_max = encoded_len(
        &DecisionReferenceInterval {
            start: longest,
            end_inclusive: longest,
            source_segment_index: usize::MAX,
            target_segment_index: usize::MAX,
            selected_reference_matches: false,
        },
        b.response_bytes,
        "aggregate_response_bytes",
    )?;
    let rows_max = checked(
        row_max.checked_add(1).and_then(|v| v.checked_mul(cells)),
        b.response_bytes,
        "aggregate_response_bytes",
    )?;
    let mut reservation = encoded_len(
        &envelope(&query, &(), &(), &[] as &[DecisionReferenceInterval]),
        b.response_bytes,
        "aggregate_response_bytes",
    )?;
    for value in [b.source.response_bytes, b.target.response_bytes, rows_max] {
        add(
            &mut reservation,
            value,
            b.response_bytes,
            "aggregate_response_bytes",
        )?;
    }
    // Bounded compact bytes dominate copied UTF8 payload; collection/allocator overhead is not a byte quota.
    encoded_len(&network_saved, b.network_copy_bytes, "network_copy_bytes")?;
    let network_copy = copy_network(&network_saved);
    let source_query = SourceHandoffCidrQuery {
        source_account_id: query.source_account_id.clone(),
        network_account_id: query.network_account_id.clone(),
        subnet_id: query.subnet_id.clone(),
        destination_cidr: query.destination_cidr.clone(),
    };
    let target_query = TargetAttachmentCidrQuery {
        network_account_id: query.network_account_id.clone(),
        transit_gateway_id: query.transit_gateway_id.clone(),
        target_attachment_id: query.target_attachment_id.clone(),
        destination_cidr: query.destination_cidr.clone(),
    };
    #[cfg(test)]
    CHILD_ANALYSES.with(|n| n.set(n.get() + 1));
    let source = source::analyze(source_saved, network_copy, source_query, b.source)?;
    #[cfg(test)]
    CHILD_ANALYSES.with(|n| n.set(n.get() + 1));
    let target = target::analyze(network_saved, target_query, b.target)?;
    let mut total = encoded_len(
        &envelope(
            &query,
            &source,
            &target,
            &[] as &[DecisionReferenceInterval],
        ),
        b.response_bytes,
        "aggregate_response_bytes",
    )?;
    checked(
        total.checked_add(rows_max),
        b.response_bytes,
        "aggregate_response_bytes",
    )?;
    let (lo, hi) = (ordinal(net.network()), ordinal(net.broadcast()));
    let v4 = net.addr().is_ipv4();
    let mut next = lo;
    let (mut i, mut j) = (0usize, 0usize);
    let mut complete = false;
    let mut segments = Vec::new();
    while let (Some(a), Some(z)) = (source.segments.get(i), target.segments.get(j)) {
        let (al, ah) = bounds(&a.start, &a.end_inclusive, v4, lo, hi)?;
        let (zl, zh) = bounds(&z.start, &z.end_inclusive, v4, lo, hi)?;
        let (start, end) = (al.max(zl), ah.min(zh));
        if start != next || start > end {
            return Err(SourceHandoffCidrError::PartitionProofUnavailable);
        }
        check(
            segments
                .len()
                .checked_add(1)
                .ok_or(SourceHandoffCidrError::PartitionProofUnavailable)?,
            b.segments,
            "aggregate_segments",
        )?;
        let row = DecisionReferenceInterval {
            start: address(start, v4)?,
            end_inclusive: address(end, v4)?,
            source_segment_index: i,
            target_segment_index: j,
            selected_reference_matches: selected(&a.result, &query),
        };
        add(
            &mut total,
            encoded_len(&row, b.response_bytes, "aggregate_response_bytes")?,
            b.response_bytes,
            "aggregate_response_bytes",
        )?;
        if !segments.is_empty() {
            add(&mut total, 1, b.response_bytes, "aggregate_response_bytes")?;
        }
        segments.push(row);
        if ah == end {
            i += 1;
        }
        if zh == end {
            j += 1;
        }
        if end == hi {
            complete = true;
            break;
        }
        next = end
            .checked_add(1)
            .ok_or(SourceHandoffCidrError::PartitionProofUnavailable)?;
    }
    if !complete || i != source.segments.len() || j != target.segments.len() {
        return Err(SourceHandoffCidrError::PartitionProofUnavailable);
    }
    let preview = encoded_len(
        &envelope(&query, &source, &target, &segments[..]),
        b.response_bytes,
        "aggregate_response_bytes",
    )?;
    if preview != total {
        return Err(SourceHandoffCidrError::PartitionProofUnavailable);
    }
    let output = envelope(query, source, target, segments);
    if encoded_len(&output, b.response_bytes, "aggregate_response_bytes")? != preview {
        return Err(SourceHandoffCidrError::PartitionProofUnavailable);
    }
    Ok(output)
}

#[cfg(test)]
std::thread_local! { pub(super) static CHILD_ANALYSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
