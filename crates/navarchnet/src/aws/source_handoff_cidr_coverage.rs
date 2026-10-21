//! Exact saved source-to-TGW point-decision composition, not a usable or complete packet path.
use super::{
    observation::ResourceKind,
    saved_observation::SavedObservation,
    source_handoff::{self, SourceHandoffLookup},
    vpc_cidr_coverage, vpc_lookup,
};
use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use ts_rs::TS;
mod admission;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SourceHandoffCidrQuery {
    pub source_account_id: String,
    pub network_account_id: String,
    pub subnet_id: String,
    pub destination_cidr: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "error", rename_all = "snake_case")]
pub enum SourceHandoffCidrError {
    InvalidQuery {
        field: &'static str,
    },
    IdentityUnavailable,
    BudgetExceeded {
        dimension: &'static str,
        limit: usize,
    },
    PartitionProofUnavailable,
}
impl std::fmt::Display for SourceHandoffCidrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Saved CIDR composition refused: {self:?}")
    }
}
impl std::error::Error for SourceHandoffCidrError {}
type Result<T> = std::result::Result<T, SourceHandoffCidrError>;
/// Trusted finite logical admission policy; no HTTP overrides, CPU/RSS/deadline or cloud quota.
#[derive(Debug, Clone, Copy)]
pub struct SourceHandoffCidrBudget {
    pub source_resources: usize,
    pub network_resources: usize,
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
    pub raw_origins: usize,
    pub segments: usize,
    pub work_units: usize,
    pub clone_payload_bytes: usize,
    pub response_bytes: usize,
}
impl Default for SourceHandoffCidrBudget {
    fn default() -> Self {
        Self {
            source_resources: 1000,
            network_resources: 1000,
            resources: 2000,
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
            raw_origins: 2048,
            segments: 256,
            work_units: 16_000_000,
            clone_payload_bytes: 8_388_608,
            response_bytes: 4_194_304,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CutPredicate {
    Query,
    SourceVpcRoute {
        resource_index: usize,
        route_index: usize,
    },
    NetworkTgwRoute {
        resource_index: usize,
        route_index: usize,
    },
    VpcService {
        policy_index: usize,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CutEdge {
    QueryStart,
    Enter,
    Leave,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
pub struct CutOrigin {
    /// Index of the segment START at this transition. Coincident raw origins are all retained.
    pub cut_index: usize,
    pub predicate: CutPredicate,
    pub edge: CutEdge,
    pub clipped: bool,
}
#[derive(Debug, Serialize, TS)]
pub struct SourceHandoffDecisionInterval {
    pub start: String,
    pub end_inclusive: String,
    pub result: SourceHandoffLookup,
}
/// The same serialized shape serves borrowed previews and owned results. No late response wrapper.
#[derive(Debug, Serialize, TS)]
pub struct SourceHandoffCidrEnvelope<Q, S, N, O, C> {
    pub query: Q,
    pub source_saved: S,
    pub network_saved: N,
    pub origins: O,
    pub segments: C,
    pub reference_only: bool,
    pub partition_complete: bool,
    pub execution_enabled: bool,
    pub connectivity_tested: bool,
    pub simultaneous_snapshots: bool,
}
pub type SourceHandoffCidrCoverage = SourceHandoffCidrEnvelope<
    SourceHandoffCidrQuery,
    SavedObservation,
    SavedObservation,
    Vec<CutOrigin>,
    Vec<SourceHandoffDecisionInterval>,
>;
fn envelope<Q, S, N, O, C>(
    query: Q,
    source_saved: S,
    network_saved: N,
    origins: O,
    segments: C,
) -> SourceHandoffCidrEnvelope<Q, S, N, O, C> {
    SourceHandoffCidrEnvelope {
        query,
        source_saved,
        network_saved,
        origins,
        segments,
        reference_only: true,
        partition_complete: true,
        execution_enabled: false,
        connectivity_tested: false,
        simultaneous_snapshots: false,
    }
}
fn exceeded(dimension: &'static str, limit: usize) -> SourceHandoffCidrError {
    SourceHandoffCidrError::BudgetExceeded { dimension, limit }
}
fn check(value: usize, limit: usize, dimension: &'static str) -> Result<()> {
    if value > limit {
        Err(exceeded(dimension, limit))
    } else {
        Ok(())
    }
}
fn checked(value: Option<usize>, limit: usize, dimension: &'static str) -> Result<usize> {
    let value = value.ok_or_else(|| exceeded(dimension, limit))?;
    check(value, limit, dimension)?;
    Ok(value)
}
fn add(total: &mut usize, value: usize, limit: usize, dimension: &'static str) -> Result<()> {
    *total = checked(total.checked_add(value), limit, dimension)?;
    Ok(())
}
fn encoded_len<T: Serialize>(value: &T, limit: usize, dimension: &'static str) -> Result<usize> {
    vpc_cidr_coverage::serialized_size(value, limit).map_err(|e| match e {
        vpc_cidr_coverage::VpcCidrCoverageError::BudgetExceeded { .. } => {
            exceeded(dimension, limit)
        }
        _ => SourceHandoffCidrError::PartitionProofUnavailable,
    })
}
fn ordinal(ip: IpAddr) -> u128 {
    match ip {
        IpAddr::V4(v) => u128::from(u32::from(v)),
        IpAddr::V6(v) => u128::from(v),
    }
}
fn address(value: u128, v4: bool) -> Result<String> {
    Ok(if v4 {
        Ipv4Addr::from(
            u32::try_from(value).map_err(|_| SourceHandoffCidrError::PartitionProofUnavailable)?,
        )
        .to_string()
    } else {
        Ipv6Addr::from(value).to_string()
    })
}
pub(crate) fn validate_query(q: &SourceHandoffCidrQuery) -> Result<IpNet> {
    for (field, value) in [
        ("source_account_id", q.source_account_id.as_str()),
        ("network_account_id", q.network_account_id.as_str()),
        ("subnet_id", q.subnet_id.as_str()),
    ] {
        if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
            return Err(SourceHandoffCidrError::InvalidQuery { field });
        }
    }
    if q.destination_cidr.len() > 64 {
        return Err(SourceHandoffCidrError::InvalidQuery {
            field: "destination_cidr",
        });
    }
    let net =
        q.destination_cidr
            .parse::<IpNet>()
            .map_err(|_| SourceHandoffCidrError::InvalidQuery {
                field: "destination_cidr",
            })?;
    if net.addr() != net.network() || net.to_string() != q.destination_cidr {
        return Err(SourceHandoffCidrError::InvalidQuery {
            field: "destination_cidr",
        });
    }
    Ok(net)
}
fn identity(saved: &SavedObservation, expected: &str) -> Result<()> {
    let a = &saved.registration;
    let t = &saved.topology;
    if a.id != expected
        || t.account_id != expected
        || t.id != saved.saved_row_id
        || saved.generation <= 0
        || a.aws_account_id != t.aws_account_id
        || a.region != t.region
        || a.execution_enabled
        || t.execution_enabled
        || t.connectivity_tested
    {
        return Err(SourceHandoffCidrError::IdentityUnavailable);
    }
    // Internal consistency only: public fields are constructible; this is not proof of DB origin.
    Ok(())
}
fn collect_origins(
    source: &SavedObservation,
    network: &SavedObservation,
    net: IpNet,
    b: SourceHandoffCidrBudget,
) -> Result<(Vec<u128>, Vec<CutOrigin>)> {
    let (lo, hi) = (ordinal(net.network()), ordinal(net.broadcast()));
    let mut raw = Vec::new();
    let mut push = |at, predicate, edge, clipped| -> Result<()> {
        check(
            raw.len()
                .checked_add(1)
                .ok_or_else(|| exceeded("raw_origins", b.raw_origins))?,
            b.raw_origins,
            "raw_origins",
        )?;
        raw.push((
            at,
            raw.len(),
            CutOrigin {
                cut_index: 0,
                predicate,
                edge,
                clipped,
            },
        ));
        Ok(())
    };
    push(lo, CutPredicate::Query, CutEdge::QueryStart, false)?;
    let mut membership = |value: IpNet, predicate: CutPredicate| -> Result<()> {
        if value.addr().is_ipv4() != net.addr().is_ipv4() {
            return Ok(());
        }
        let (nlo, nhi) = (ordinal(value.network()), ordinal(value.broadcast()));
        let (start, end) = (nlo.max(lo), nhi.min(hi));
        if start <= end {
            push(start, predicate, CutEdge::Enter, start != nlo)?;
            if end < hi {
                push(
                    end.checked_add(1)
                        .ok_or(SourceHandoffCidrError::PartitionProofUnavailable)?,
                    predicate,
                    CutEdge::Leave,
                    false,
                )?;
            }
        }
        Ok(())
    };
    for (resource_index, row) in source
        .topology
        .resources
        .iter()
        .enumerate()
        .filter(|(_, r)| r.kind == ResourceKind::RouteTable)
    {
        for (route_index, route) in row.routes.iter().enumerate() {
            if let Ok(value) = vpc_lookup::destination_network(route) {
                membership(
                    value,
                    CutPredicate::SourceVpcRoute {
                        resource_index,
                        route_index,
                    },
                )?;
            }
        }
    }
    for (policy_index, value) in vpc_lookup::reserved_service_networks()
        .into_iter()
        .enumerate()
    {
        membership(value, CutPredicate::VpcService { policy_index })?;
    }
    for (resource_index, row) in network
        .topology
        .resources
        .iter()
        .enumerate()
        .filter(|(_, r)| r.kind == ResourceKind::TransitGatewayRouteTable)
    {
        for (route_index, route) in row.tgw_routes.iter().flatten().enumerate() {
            // EXACT existing TGW parsing; unlike VPC, historical host bits/spelling remain accepted.
            if let Some(value) = route
                .destination_cidr
                .as_ref()
                .and_then(|s| s.parse::<IpNet>().ok())
            {
                membership(
                    value,
                    CutPredicate::NetworkTgwRoute {
                        resource_index,
                        route_index,
                    },
                )?;
            }
        }
    }
    raw.sort_unstable_by_key(|(at, sequence, _)| (*at, *sequence));
    let mut cuts = Vec::new();
    let mut origins = Vec::new();
    for (at, _, mut origin) in raw {
        if cuts.last() != Some(&at) {
            check(cuts.len() + 1, b.segments, "segments")?;
            cuts.push(at);
        }
        origin.cut_index = cuts.len() - 1;
        origins.push(origin);
    }
    Ok((cuts, origins))
}
/// Uniformity BEFORE witnesses: fixed family and ALL source VPC/service/network TGW membership
/// transitions fix the source winner (including alternate TGWs). For that fixed winner every ordered
/// owner/attachment/declared-subnet/AZ/ingress-table check is destination-independent. Every possible
/// selected table's TGW memberships are already fixed, so nested LPM/type/state/attachment errors are
/// constant too. Poison/literal/order semantics remain in the unchanged complete point interpreter.
/// Future destination predicates MUST extend this proof or disable coverage. No first-point pruning,
/// separately sampled/unaligned partitions, enumeration, usable-path or source-host claim.
pub fn analyze(
    source: SavedObservation,
    network: SavedObservation,
    query: SourceHandoffCidrQuery,
    b: SourceHandoffCidrBudget,
) -> Result<SourceHandoffCidrCoverage> {
    let net = validate_query(&query)?;
    let census = admission::census(&source, &network, b)?;
    let base = checked(census.base()?.checked_mul(64), b.work_units, "work_units")?;
    admission::strings(&source, b)?;
    admission::strings(&network, b)?;
    for s in [
        &query.source_account_id,
        &query.network_account_id,
        &query.subnet_id,
        &query.destination_cidr,
    ] {
        check(s.len(), b.string_bytes, "string_bytes")?;
    }
    identity(&source, &query.source_account_id)?;
    identity(&network, &query.network_account_id)?;
    encoded_len(&(&source, &network), b.evidence_bytes, "evidence_bytes")?;
    let (cuts, origins) = collect_origins(&source, &network, net, b)?;
    census.reserve(&source, cuts.len(), origins.len(), base, b)?;
    let mut segments = Vec::<SourceHandoffDecisionInterval>::new();
    let mut total = encoded_len(
        &envelope(
            &query,
            &source,
            &network,
            &[] as &[CutOrigin],
            &segments[..],
        ),
        b.response_bytes,
        "response_bytes",
    )?;
    for (i, origin) in origins.iter().enumerate() {
        add(
            &mut total,
            encoded_len(origin, b.response_bytes, "response_bytes")?,
            b.response_bytes,
            "response_bytes",
        )?;
        if i > 0 {
            add(&mut total, 1, b.response_bytes, "response_bytes")?;
        }
    }
    let (lo, hi) = (ordinal(net.network()), ordinal(net.broadcast()));
    if cuts.first() != Some(&lo) {
        return Err(SourceHandoffCidrError::PartitionProofUnavailable);
    }
    for (index, start) in cuts.iter().copied().enumerate() {
        let end = match cuts.get(index + 1) {
            Some(next) => next
                .checked_sub(1)
                .ok_or(SourceHandoffCidrError::PartitionProofUnavailable)?,
            None => hi,
        };
        if start < lo || start > end || end > hi {
            return Err(SourceHandoffCidrError::PartitionProofUnavailable);
        }
        let start = address(start, net.addr().is_ipv4())?;
        #[cfg(test)]
        POINT_CALLS.with(|count| count.set(count.get() + 1));
        let cell = SourceHandoffDecisionInterval {
            result: source_handoff::lookup(
                &source.topology,
                &network.topology,
                &query.subnet_id,
                &start,
            ),
            start,
            end_inclusive: address(end, net.addr().is_ipv4())?,
        };
        add(
            &mut total,
            encoded_len(&cell, b.response_bytes, "response_bytes")?,
            b.response_bytes,
            "response_bytes",
        )?;
        if index > 0 {
            add(&mut total, 1, b.response_bytes, "response_bytes")?;
        }
        segments.push(cell);
    }
    let preview = encoded_len(
        &envelope(&query, &source, &network, &origins[..], &segments[..]),
        b.response_bytes,
        "response_bytes",
    )?;
    if preview != total {
        return Err(SourceHandoffCidrError::PartitionProofUnavailable);
    }
    // Move each complete observation ONCE; no evidence or result cloning, and no uncounted wrapper.
    let result = envelope(query, source, network, origins, segments);
    if encoded_len(&result, b.response_bytes, "response_bytes")? != preview {
        return Err(SourceHandoffCidrError::PartitionProofUnavailable);
    }
    Ok(result)
}

#[cfg(test)]
std::thread_local! { static POINT_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
#[cfg(test)]
mod tests;
