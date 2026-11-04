//! Exact partition of the saved VPC point interpreter, not packet forwarding or reachability.
use super::{
    observation::{AwsResource, AwsTopology, ResourceKind},
    routing::AssociationSource,
    vpc_lookup::{self, VpcSubnetLookupResult},
};
use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "error", rename_all = "snake_case")]
pub enum VpcCidrCoverageError {
    InvalidDestinationCidr,
    InvalidSubnetInput,
    InputTooLarge { field: String, limit: usize },
    BudgetExceeded { dimension: String, limit: usize },
    PartitionProofUnavailable,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct VpcDecisionInterval {
    pub start: String,
    pub end_inclusive: String,
    pub result: VpcSubnetLookupResult,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct VpcCoverageTableEvidence {
    pub route_table_resource_index: usize,
    pub route_table_id: String,
    pub source: AssociationSource,
    pub original_table: AwsResource,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct VpcCidrCoverage {
    pub destination_cidr: String,
    pub partition_complete: bool,
    pub segments: Vec<VpcDecisionInterval>,
    pub table_evidence: Option<VpcCoverageTableEvidence>,
}
/// Trusted, per-analysis local work/output limits, never AWS quotas or caller query overrides.
/// Conservative all-VPC-table preflight precedes the existing scope+point interpreter. Its storage
/// reader's earlier deserialization/indexing is outside these limits, not retroactively bounded.
#[derive(Debug, Clone, Copy)]
pub struct CoverageBudget {
    pub resources: usize,
    pub associations: usize,
    pub route_rows: usize,
    pub target_entries: usize,
    pub route_field_bytes: usize,
    pub raw_cuts: usize,
    pub segments: usize,
    pub row_visits: usize,
    pub response_bytes: usize,
}
impl Default for CoverageBudget {
    fn default() -> Self {
        Self {
            resources: 10_000,
            associations: 10_000,
            route_rows: 1024,
            target_entries: 4096,
            route_field_bytes: 1_048_576,
            raw_cuts: 4096,
            segments: 2048,
            row_visits: 1_000_000,
            response_bytes: 2_097_152,
        }
    }
}
fn exceeded(dimension: &str, limit: usize) -> VpcCidrCoverageError {
    VpcCidrCoverageError::BudgetExceeded {
        dimension: dimension.into(),
        limit,
    }
}
fn check(value: usize, limit: usize, dimension: &str) -> Result<(), VpcCidrCoverageError> {
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
) -> Result<(), VpcCidrCoverageError> {
    *total = total
        .checked_add(value)
        .ok_or_else(|| exceeded(dimension, limit))?;
    check(*total, limit, dimension)
}
pub(crate) fn validate_query(subnet: &str, cidr: &str) -> Result<IpNet, VpcCidrCoverageError> {
    for (field, value, limit) in [("subnet_id", subnet, 2048), ("destination_cidr", cidr, 64)] {
        if value.len() > limit {
            return Err(VpcCidrCoverageError::InputTooLarge {
                field: field.into(),
                limit,
            });
        }
    }
    if subnet.is_empty() || subnet.chars().any(char::is_control) {
        return Err(VpcCidrCoverageError::InvalidSubnetInput);
    }
    let parsed = cidr
        .parse::<IpNet>()
        .map_err(|_| VpcCidrCoverageError::InvalidDestinationCidr)?;
    // A stricter NEW query contract; never impose textual normalization on old route literals.
    if parsed.addr() != parsed.network() || parsed.to_string() != cidr {
        return Err(VpcCidrCoverageError::InvalidDestinationCidr);
    }
    Ok(parsed)
}
fn tables(topology: &AwsTopology) -> impl Iterator<Item = &AwsResource> {
    topology
        .resources
        .iter()
        .filter(|row| row.kind == ResourceKind::RouteTable)
}
fn preflight(
    topology: &AwsTopology,
    budget: CoverageBudget,
) -> Result<usize, VpcCidrCoverageError> {
    check(topology.resources.len(), budget.resources, "resources")?;
    let (mut associations, mut rows, mut targets, mut bytes) = (0, 0, 0, 0);
    // Establish aggregate collection bounds before traversing any route field/target map.
    for table in tables(topology) {
        add(
            &mut associations,
            table.associations.len(),
            budget.associations,
            "associations",
        )?;
        add(
            &mut rows,
            table.routes.len(),
            budget.route_rows,
            "route_rows",
        )?;
    }
    for row in tables(topology).flat_map(|table| &table.routes) {
        add(
            &mut targets,
            row.targets.len(),
            budget.target_entries,
            "target_entries",
        )?;
    }
    for row in tables(topology).flat_map(|table| &table.routes) {
        for field in [
            &row.ipv4_destination,
            &row.ipv6_destination,
            &row.prefix_list_destination,
            &row.state,
            &row.origin,
        ]
        .into_iter()
        .flatten()
        {
            add(
                &mut bytes,
                field.len(),
                budget.route_field_bytes,
                "route_field_bytes",
            )?;
        }
        for (key, value) in &row.targets {
            add(
                &mut bytes,
                key.len(),
                budget.route_field_bytes,
                "route_field_bytes",
            )?;
            add(
                &mut bytes,
                value.len(),
                budget.route_field_bytes,
                "route_field_bytes",
            )?;
        }
    }
    // Two preflight row passes plus a conservative factor 16 for the initial point evaluator.
    let initial = rows
        .checked_mul(18)
        .ok_or_else(|| exceeded("row_visits", budget.row_visits))?;
    check(initial, budget.row_visits, "row_visits")?;
    Ok(initial)
}
fn ordinal(address: IpAddr) -> u128 {
    match address {
        IpAddr::V4(value) => u128::from(u32::from(value)),
        IpAddr::V6(value) => u128::from(value),
    }
}
fn address(value: u128, ipv4: bool) -> Result<String, VpcCidrCoverageError> {
    Ok(if ipv4 {
        Ipv4Addr::from(
            u32::try_from(value).map_err(|_| VpcCidrCoverageError::PartitionProofUnavailable)?,
        )
        .to_string()
    } else {
        Ipv6Addr::from(value).to_string()
    })
}
fn push_cut(
    cuts: &mut Vec<u128>,
    count: &mut usize,
    value: u128,
    budget: CoverageBudget,
) -> Result<(), VpcCidrCoverageError> {
    add(count, 1, budget.raw_cuts, "raw_cuts")?;
    cuts.push(value);
    Ok(())
}
fn transitions(
    network: IpNet,
    query: IpNet,
    cuts: &mut Vec<u128>,
    count: &mut usize,
    budget: CoverageBudget,
) -> Result<(), VpcCidrCoverageError> {
    if network.addr().is_ipv4() != query.addr().is_ipv4() {
        return Ok(());
    }
    let start = ordinal(network.network()).max(ordinal(query.network()));
    let end = ordinal(network.broadcast()).min(ordinal(query.broadcast()));
    if start <= end {
        push_cut(cuts, count, start, budget)?;
        // Query U is the implicit final endpoint: NEVER represent U+1, including IPv6 MAX.
        if end < ordinal(query.broadcast()) {
            push_cut(
                cuts,
                count,
                end.checked_add(1)
                    .ok_or(VpcCidrCoverageError::PartitionProofUnavailable)?,
                budget,
            )?;
        }
    }
    Ok(())
}
/// Count actual serialized bytes without retaining or streaming an output prefix. The API also
/// invokes this on its WHOLE response, including provenance/limitations/evidence, before emission.
pub(crate) fn check_serialized<T: Serialize>(
    value: &T,
    limit: usize,
) -> Result<(), VpcCidrCoverageError> {
    serialized_size(value, limit).map(|_| ())
}
/// Exact bounded byte count, also used for nonquadratic composed response accounting.
pub(crate) fn serialized_size<T: Serialize>(
    value: &T,
    limit: usize,
) -> Result<usize, VpcCidrCoverageError> {
    struct Counter {
        bytes: usize,
        limit: usize,
        exceeded: bool,
    }
    impl Write for Counter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            if let Some(next) = self.bytes.checked_add(data.len())
                && next <= self.limit
            {
                self.bytes = next;
                return Ok(data.len());
            }
            self.exceeded = true;
            Err(std::io::Error::other("coverage response bound"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter {
        bytes: 0,
        limit,
        exceeded: false,
    };
    serde_json::to_writer(&mut counter, value).map_err(|_| {
        if counter.exceeded {
            exceeded("response_bytes", limit)
        } else {
            VpcCidrCoverageError::PartitionProofUnavailable
        }
    })?;
    Ok(counter.bytes)
}
/// Uniformity proof (for this VPC interpreter ONLY): fixed scope/readiness/owner/association and
/// table poison are destination-independent. All varying predicates are membership in each valid
/// route network and each shared service network, with address family fixed. Every membership
/// transition is a cut. Consequently every cell has an identical candidate set; LPM, origin/static
/// precedence, ambiguity, state and target classification are fixed functions of that set/row data.
/// Evaluating the LEFT END is thus a witness of a proved constant cell, NOT arbitrary IP sampling.
/// Invalid/prefix-list rows remain in the evaluator and original evidence: poison outside service
/// cells, reserved-service precedence inside. Scope failures precede services and are constant.
/// Future destination predicates MUST add their complete boundaries here or disable this proof.
pub fn analyze(
    topology: &AwsTopology,
    subnet: &str,
    cidr: &str,
    budget: CoverageBudget,
) -> Result<VpcCidrCoverage, VpcCidrCoverageError> {
    let query = validate_query(subnet, cidr)?;
    let initial_work = preflight(topology, budget)?;
    let lo = ordinal(query.network());
    let hi = ordinal(query.broadcast());
    let first = vpc_lookup::lookup(topology, subnet, &query.network().to_string());
    let mut coverage = VpcCidrCoverage {
        destination_cidr: cidr.into(),
        partition_complete: true,
        segments: vec![],
        table_evidence: None,
    };
    if let VpcSubnetLookupResult::Reported {
        route_table_id,
        source,
        ..
    } = first
    {
        let mut matches =
            topology.resources.iter().enumerate().filter(|(_, row)| {
                row.kind == ResourceKind::RouteTable && row.id == route_table_id
            });
        let (index, table) = matches
            .next()
            .ok_or(VpcCidrCoverageError::PartitionProofUnavailable)?;
        if matches.next().is_some() {
            return Err(VpcCidrCoverageError::PartitionProofUnavailable);
        }
        let mut cuts = Vec::new();
        let mut count = 0;
        push_cut(&mut cuts, &mut count, lo, budget)?;
        for row in &table.routes {
            if let Ok(network) = vpc_lookup::destination_network(row) {
                transitions(network, query, &mut cuts, &mut count, budget)?;
            }
        }
        for network in vpc_lookup::reserved_service_networks() {
            transitions(network, query, &mut cuts, &mut count, budget)?;
        }
        cuts.sort_unstable();
        cuts.dedup();
        check(cuts.len(), budget.segments, "segments")?;
        // Reserve every fixed evaluator pass before any interval evaluation. Also charge boundary
        // parsing and the later original-table clone; collection/byte bounds are independent.
        let work = cuts
            .len()
            .checked_mul(16)
            .and_then(|n| n.checked_add(2))
            .and_then(|n| n.checked_mul(table.routes.len()))
            .and_then(|n| n.checked_add(initial_work))
            .ok_or_else(|| exceeded("row_visits", budget.row_visits))?;
        check(work, budget.row_visits, "row_visits")?;
        for (position, start) in cuts.iter().copied().enumerate() {
            let end = match cuts.get(position + 1) {
                Some(next) => next
                    .checked_sub(1)
                    .ok_or(VpcCidrCoverageError::PartitionProofUnavailable)?,
                None => hi,
            };
            if start < lo || start > end || end > hi {
                return Err(VpcCidrCoverageError::PartitionProofUnavailable);
            }
            let start = address(start, query.addr().is_ipv4())?;
            coverage.segments.push(VpcDecisionInterval {
                result: VpcSubnetLookupResult::Reported {
                    route_table_id: route_table_id.clone(),
                    source: source.clone(),
                    lookup: vpc_lookup::lookup_routes(table, &start),
                },
                start,
                end_inclusive: address(end, query.addr().is_ipv4())?,
            });
        }
        coverage.table_evidence = Some(VpcCoverageTableEvidence {
            route_table_resource_index: index,
            route_table_id,
            source,
            original_table: table.clone(),
        });
    } else {
        check(1, budget.segments, "segments")?;
        coverage.segments.push(VpcDecisionInterval {
            start: query.network().to_string(),
            end_inclusive: query.broadcast().to_string(),
            result: first,
        });
    }
    if coverage.segments.is_empty()
        || coverage.segments[0].start != query.network().to_string()
        || coverage
            .segments
            .last()
            .is_none_or(|cell| cell.end_inclusive != query.broadcast().to_string())
    {
        return Err(VpcCidrCoverageError::PartitionProofUnavailable);
    }
    check_serialized(&coverage, budget.response_bytes)?;
    Ok(coverage)
}

#[cfg(test)]
mod tests;
