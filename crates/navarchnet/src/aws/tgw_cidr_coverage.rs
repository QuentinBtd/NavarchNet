//! Exact bounded partitions of saved TGW point decisions, not a forwarding/path proof.
use super::{
    observation::{AwsResource, AwsTopology, ResourceKind, TransitGatewayTableLink},
    route_lookup::{self, TgwLookupResult},
    vpc_cidr_coverage,
};
use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "error", rename_all = "snake_case")]
pub enum TgwCidrCoverageError {
    InvalidDestinationCidr,
    InvalidTableInput,
    InputTooLarge { field: String, limit: usize },
    BudgetExceeded { dimension: String, limit: usize },
    PartitionProofUnavailable,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TgwDecisionInterval {
    pub start: String,
    pub end_inclusive: String,
    pub result: TgwLookupResult,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TgwCoverageResourceEvidence {
    pub resource_index: usize,
    pub original_resource: AwsResource,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TgwCidrCoverage {
    pub destination_cidr: String,
    pub partition_complete: bool,
    pub segments: Vec<TgwDecisionInterval>,
    pub table_evidence: Vec<TgwCoverageResourceEvidence>,
    pub parent_evidence: Vec<TgwCoverageResourceEvidence>,
}
/// Trusted local admission policy, never caller-controlled HTTP limits or cloud quotas.
#[derive(Debug, Clone, Copy)]
pub struct TgwCoverageBudget {
    pub resources: usize,
    pub related_ids: usize,
    pub links: usize,
    pub route_rows: usize,
    pub attachments: usize,
    pub field_bytes: usize,
    pub raw_cuts: usize,
    pub segments: usize,
    pub work_units: usize,
    pub response_bytes: usize,
}
impl Default for TgwCoverageBudget {
    fn default() -> Self {
        Self {
            resources: 10_000,
            related_ids: 10_000,
            links: 10_000,
            route_rows: 1024,
            attachments: 4096,
            field_bytes: 1_048_576,
            raw_cuts: 4096,
            segments: 2048,
            work_units: 1_000_000,
            response_bytes: 2_097_152,
        }
    }
}
fn exceeded(dimension: &str, limit: usize) -> TgwCidrCoverageError {
    TgwCidrCoverageError::BudgetExceeded {
        dimension: dimension.into(),
        limit,
    }
}
fn check(value: usize, limit: usize, dimension: &str) -> Result<(), TgwCidrCoverageError> {
    if value > limit {
        Err(exceeded(dimension, limit))
    } else {
        Ok(())
    }
}
fn add(
    total: &mut usize,
    value: usize,
    limit: usize,
    dimension: &str,
) -> Result<(), TgwCidrCoverageError> {
    *total = total
        .checked_add(value)
        .ok_or_else(|| exceeded(dimension, limit))?;
    check(*total, limit, dimension)
}
pub(crate) fn validate_query(table: &str, cidr: &str) -> Result<IpNet, TgwCidrCoverageError> {
    for (field, value, limit) in [
        ("route_table_id", table, 2048),
        ("destination_cidr", cidr, 64),
    ] {
        if value.len() > limit {
            return Err(TgwCidrCoverageError::InputTooLarge {
                field: field.into(),
                limit,
            });
        }
    }
    if table.is_empty() || table.chars().any(char::is_control) {
        return Err(TgwCidrCoverageError::InvalidTableInput);
    }
    let net = cidr
        .parse::<IpNet>()
        .map_err(|_| TgwCidrCoverageError::InvalidDestinationCidr)?;
    if net.addr() != net.network() || net.to_string() != cidr {
        return Err(TgwCidrCoverageError::InvalidDestinationCidr);
    }
    Ok(net)
}
fn tables(topology: &AwsTopology) -> impl Iterator<Item = &AwsResource> {
    topology
        .resources
        .iter()
        .filter(|row| row.kind == ResourceKind::TransitGatewayRouteTable)
}
fn links(table: &AwsResource) -> impl Iterator<Item = &TransitGatewayTableLink> {
    table
        .tgw_associations
        .iter()
        .flatten()
        .chain(table.tgw_propagations.iter().flatten())
}
struct Work {
    preflight: usize,
    evaluation: usize,
}
fn preflight(
    topology: &AwsTopology,
    budget: TgwCoverageBudget,
) -> Result<Work, TgwCidrCoverageError> {
    let r = topology.resources.len();
    check(r, budget.resources, "resources")?;
    let (mut l, mut k, mut n, mut a, mut bytes) = (0, 0, 0, 0, 0);
    for row in &topology.resources {
        add(
            &mut l,
            row.related_ids.len(),
            budget.related_ids,
            "related_ids",
        )?;
    }
    for table in tables(topology) {
        for collection in [&table.tgw_associations, &table.tgw_propagations]
            .into_iter()
            .flatten()
        {
            add(&mut k, collection.len(), budget.links, "links")?;
        }
        if let Some(routes) = &table.tgw_routes {
            add(&mut n, routes.len(), budget.route_rows, "route_rows")?;
            for row in routes {
                add(
                    &mut a,
                    row.attachments.len(),
                    budget.attachments,
                    "attachments",
                )?;
            }
        }
    }
    let mut field = |value: &str| add(&mut bytes, value.len(), budget.field_bytes, "field_bytes");
    for row in &topology.resources {
        field(&row.id)?;
        for value in [&row.owner_account_id, &row.state].into_iter().flatten() {
            field(value)?;
        }
        for value in &row.related_ids {
            field(value)?;
        }
    }
    for table in tables(topology) {
        for link in links(table) {
            for value in [
                &link.attachment_id,
                &link.resource_id,
                &link.resource_type,
                &link.state,
                &link.route_table_announcement_id,
            ]
            .into_iter()
            .flatten()
            {
                field(value)?;
            }
        }
        for row in table.tgw_routes.iter().flatten() {
            for value in [
                &row.destination_cidr,
                &row.prefix_list_id,
                &row.state,
                &row.route_type,
                &row.route_table_announcement_id,
            ]
            .into_iter()
            .flatten()
            {
                field(value)?;
            }
            for attachment in &row.attachments {
                for value in [
                    &attachment.attachment_id,
                    &attachment.resource_id,
                    &attachment.resource_type,
                ]
                .into_iter()
                .flatten()
                {
                    field(value)?;
                }
            }
        }
    }
    // Reserve conservative COLLECTION visits: initial passes/evidence/boundaries, then each unchanged
    // point evaluator's two resource scans, related-ID set, <=8 route passes and attachment pass.
    // Not an instruction/string-comparison/CPU/RSS/deadline counter; byte/sort inputs are capped too.
    let sum = |terms: &[(usize, usize)]| -> Result<usize, TgwCidrCoverageError> {
        terms
            .iter()
            .try_fold(0usize, |sum, (value, factor)| {
                sum.checked_add(value.checked_mul(*factor)?)
            })
            .ok_or_else(|| exceeded("work_units", budget.work_units))
    };
    let preflight = sum(&[(r, 16), (l, 16), (n, 16), (a, 16), (k, 16)])?;
    check(preflight, budget.work_units, "work_units")?;
    Ok(Work {
        preflight,
        evaluation: sum(&[(r, 4), (l, 4), (n, 8), (a, 4)])?,
    })
}
pub(crate) fn check_serialized<T: Serialize>(
    value: &T,
    limit: usize,
) -> Result<(), TgwCidrCoverageError> {
    vpc_cidr_coverage::check_serialized(value, limit).map_err(|error| match error {
        vpc_cidr_coverage::VpcCidrCoverageError::BudgetExceeded { .. } => {
            exceeded("response_bytes", limit)
        }
        _ => TgwCidrCoverageError::PartitionProofUnavailable,
    })
}
fn ordinal(ip: IpAddr) -> u128 {
    match ip {
        IpAddr::V4(ip) => u128::from(u32::from(ip)),
        IpAddr::V6(ip) => u128::from(ip),
    }
}
fn address(value: u128, v4: bool) -> Result<String, TgwCidrCoverageError> {
    Ok(if v4 {
        Ipv4Addr::from(
            u32::try_from(value).map_err(|_| TgwCidrCoverageError::PartitionProofUnavailable)?,
        )
        .to_string()
    } else {
        Ipv6Addr::from(value).to_string()
    })
}
#[derive(Serialize)]
struct ResourceRef<'a> {
    resource_index: usize,
    original_resource: &'a AwsResource,
}
#[derive(Serialize)]
struct EvidenceRef<'a> {
    table_evidence: Vec<ResourceRef<'a>>,
    parent_evidence: Vec<ResourceRef<'a>>,
}
/// For this exact TGW interpreter, ONLY route-network membership varies with destination. All
/// scope/owner/readiness/poison checks are fixed; a constant membership vector fixes LPM, unknown-type
/// precedence, static preference, ambiguity, state and attachment outcomes. Attachment errors keep
/// ORIGINAL order; only the point evaluator sorts valid reported IDs. Every membership transition
/// is a cut BEFORE any left-end witness is evaluated. No VPC service-range policy is imported.
/// Future destination predicates MUST extend the boundary proof or disable coverage.
pub fn analyze(
    topology: &AwsTopology,
    table_id: &str,
    cidr: &str,
    budget: TgwCoverageBudget,
) -> Result<TgwCidrCoverage, TgwCidrCoverageError> {
    let query = validate_query(table_id, cidr)?;
    let work = preflight(topology, budget)?;
    let table_indexes: Vec<_> = topology
        .resources
        .iter()
        .enumerate()
        .filter(|(_, row)| row.kind == ResourceKind::TransitGatewayRouteTable && row.id == table_id)
        .map(|(index, _)| index)
        .collect();
    let related: BTreeSet<_> = table_indexes
        .iter()
        .flat_map(|index| {
            topology.resources[*index]
                .related_ids
                .iter()
                .map(String::as_str)
        })
        .collect();
    let parent_indexes: Vec<_> = topology
        .resources
        .iter()
        .enumerate()
        .filter(|(_, row)| {
            row.kind == ResourceKind::TransitGateway && related.contains(row.id.as_str())
        })
        .map(|(index, _)| index)
        .collect();
    let evidence = EvidenceRef {
        table_evidence: table_indexes
            .iter()
            .map(|index| ResourceRef {
                resource_index: *index,
                original_resource: &topology.resources[*index],
            })
            .collect(),
        parent_evidence: parent_indexes
            .iter()
            .map(|index| ResourceRef {
                resource_index: *index,
                original_resource: &topology.resources[*index],
            })
            .collect(),
    };
    // Bound complete borrowed evidence BEFORE cloning; unrelated AwsResource fields may be large.
    check_serialized(&evidence, budget.response_bytes)?;
    let (lo, hi) = (ordinal(query.network()), ordinal(query.broadcast()));
    let mut cuts = Vec::new();
    let mut raw_cuts = 0;
    let mut push = |value| {
        add(&mut raw_cuts, 1, budget.raw_cuts, "raw_cuts")?;
        cuts.push(value);
        Ok::<(), TgwCidrCoverageError>(())
    };
    push(lo)?;
    if table_indexes.len() == 1 {
        for row in topology.resources[table_indexes[0]]
            .tgw_routes
            .iter()
            .flatten()
        {
            // EXACT historical TGW parsing: host bits accepted, original spelling never rewritten.
            // Bad rows remain global poison in lookup, not silently discarded semantic evidence.
            if let Some(network) = row
                .destination_cidr
                .as_ref()
                .and_then(|cidr| cidr.parse::<IpNet>().ok())
            {
                if network.addr().is_ipv4() != query.addr().is_ipv4() {
                    continue;
                }
                let start = ordinal(network.network()).max(lo);
                let end = ordinal(network.broadcast()).min(hi);
                if start <= end {
                    push(start)?;
                    if end < hi {
                        push(
                            end.checked_add(1)
                                .ok_or(TgwCidrCoverageError::PartitionProofUnavailable)?,
                        )?;
                    }
                }
            }
        }
    }
    cuts.sort_unstable();
    cuts.dedup();
    check(cuts.len(), budget.segments, "segments")?;
    let reserved = cuts
        .len()
        .checked_mul(work.evaluation)
        .and_then(|n| n.checked_add(work.preflight))
        .ok_or_else(|| exceeded("work_units", budget.work_units))?;
    check(reserved, budget.work_units, "work_units")?;
    // Complete clipped membership cuts prove uniformity. Missing/duplicate/unqueried scope is
    // destination independent and needs only [L,U]; globally poisoned tables may retain extra cuts.
    let mut segments = Vec::new();
    for (index, start) in cuts.iter().copied().enumerate() {
        let end = match cuts.get(index + 1) {
            Some(next) => next
                .checked_sub(1)
                .ok_or(TgwCidrCoverageError::PartitionProofUnavailable)?,
            None => hi,
        };
        if start < lo || start > end || end > hi {
            return Err(TgwCidrCoverageError::PartitionProofUnavailable);
        }
        let start = address(start, query.addr().is_ipv4())?;
        segments.push(TgwDecisionInterval {
            result: route_lookup::lookup(topology, table_id, &start),
            start,
            end_inclusive: address(end, query.addr().is_ipv4())?,
        });
    }
    if segments
        .first()
        .is_none_or(|cell| cell.start != query.network().to_string())
        || segments
            .last()
            .is_none_or(|cell| cell.end_inclusive != query.broadcast().to_string())
    {
        return Err(TgwCidrCoverageError::PartitionProofUnavailable);
    }
    let own = |values: Vec<ResourceRef<'_>>| {
        values
            .into_iter()
            .map(|row| TgwCoverageResourceEvidence {
                resource_index: row.resource_index,
                original_resource: row.original_resource.clone(),
            })
            .collect()
    };
    let coverage = TgwCidrCoverage {
        destination_cidr: cidr.into(),
        partition_complete: true,
        segments,
        table_evidence: own(evidence.table_evidence),
        parent_evidence: own(evidence.parent_evidence),
    };
    check_serialized(&coverage, budget.response_bytes)?;
    Ok(coverage)
}

#[cfg(test)]
mod tests;
