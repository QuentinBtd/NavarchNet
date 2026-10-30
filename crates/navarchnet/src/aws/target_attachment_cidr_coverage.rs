//! Exact saved target-attachment destination decisions; no receiving AZ or usable path inference.
#[cfg(test)]
mod tests;
pub use super::source_handoff_cidr_coverage::{
    CutEdge, SourceHandoffCidrError as TargetAttachmentCidrError,
};
use super::{
    cidr_partition::{self, Transitions, VpcMembership, address, ordinal},
    saved_cidr_admission::{self, Census},
    saved_observation::SavedObservation,
    source_handoff_cidr_coverage::{
        SourceHandoffCidrBudget, add, check, checked, encoded_len, identity,
    },
    target_lookup::{self, TargetAzSelection, TargetVpcLookup},
};
use ipnet::IpNet;
use serde::{Deserialize, Serialize};
type Result<T> = std::result::Result<T, TargetAttachmentCidrError>;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetAttachmentCidrQuery {
    pub network_account_id: String,
    pub transit_gateway_id: String,
    pub target_attachment_id: String,
    pub destination_cidr: String,
}
#[derive(Debug, Clone, Copy)]
pub struct TargetAttachmentCidrBudget {
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
impl Default for TargetAttachmentCidrBudget {
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
            raw_origins: 2048,
            segments: 256,
            work_units: 16_000_000,
            clone_payload_bytes: 8_388_608,
            response_bytes: 4_194_304,
        }
    }
}
impl From<TargetAttachmentCidrBudget> for SourceHandoffCidrBudget {
    fn from(b: TargetAttachmentCidrBudget) -> Self {
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
            raw_origins: b.raw_origins,
            segments: b.segments,
            work_units: b.work_units,
            clone_payload_bytes: b.clone_payload_bytes,
            response_bytes: b.response_bytes,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CutPredicate {
    Query,
    NetworkVpcRoute {
        resource_index: usize,
        route_index: usize,
    },
    VpcService {
        policy_index: usize,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CutOrigin {
    pub cut_index: usize,
    pub predicate: CutPredicate,
    pub edge: CutEdge,
    pub clipped: bool,
}
#[derive(Debug, Serialize)]
pub struct TargetAttachmentDecisionInterval {
    pub start: String,
    pub end_inclusive: String,
    pub result: TargetVpcLookup,
}
/// One shape is counted borrowed before points and moved, without any late wrapper, into the result.
#[derive(Debug, Serialize)]
pub struct TargetAttachmentCidrEnvelope<Q, S, O, C> {
    pub query: Q,
    pub network_saved: S,
    pub origins: O,
    pub segments: C,
    pub az_selection: TargetAzSelection,
    pub reference_only: bool,
    pub partition_complete: bool,
    pub execution_enabled: bool,
    pub connectivity_tested: bool,
}
pub type TargetAttachmentCidrCoverage = TargetAttachmentCidrEnvelope<
    TargetAttachmentCidrQuery,
    SavedObservation,
    Vec<CutOrigin>,
    Vec<TargetAttachmentDecisionInterval>,
>;
fn envelope<Q, S, O, C>(
    query: Q,
    network_saved: S,
    origins: O,
    segments: C,
) -> TargetAttachmentCidrEnvelope<Q, S, O, C> {
    TargetAttachmentCidrEnvelope {
        query,
        network_saved,
        origins,
        segments,
        az_selection: TargetAzSelection::NotInferred,
        reference_only: true,
        partition_complete: true,
        execution_enabled: false,
        connectivity_tested: false,
    }
}
pub(crate) fn validate_query(q: &TargetAttachmentCidrQuery) -> Result<IpNet> {
    for (field, value) in [
        ("network_account_id", q.network_account_id.as_str()),
        ("transit_gateway_id", q.transit_gateway_id.as_str()),
        ("target_attachment_id", q.target_attachment_id.as_str()),
    ] {
        if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
            return Err(TargetAttachmentCidrError::InvalidQuery { field });
        }
    }
    let bad = || TargetAttachmentCidrError::InvalidQuery {
        field: "destination_cidr",
    };
    if q.destination_cidr.len() > 64 {
        return Err(bad());
    }
    let net = q.destination_cidr.parse::<IpNet>().map_err(|_| bad())?;
    if net.addr() != net.network() || net.to_string() != q.destination_cidr {
        return Err(bad());
    }
    Ok(net)
}
fn collect_origins(
    saved: &SavedObservation,
    net: IpNet,
    b: TargetAttachmentCidrBudget,
) -> Result<(Vec<u128>, Vec<CutOrigin>)> {
    let mut transitions = Transitions::new(net, CutPredicate::Query, b.raw_origins, b.segments)?;
    cidr_partition::visit_vpc_memberships(&saved.topology, |value, origin| {
        transitions.membership(
            value,
            match origin {
                VpcMembership::Route {
                    resource_index,
                    route_index,
                } => CutPredicate::NetworkVpcRoute {
                    resource_index,
                    route_index,
                },
                VpcMembership::Service { policy_index } => {
                    CutPredicate::VpcService { policy_index }
                }
            },
        )
    })?;
    transitions.finish(|cut_index, predicate, edge, clipped| CutOrigin {
        cut_index,
        predicate,
        edge,
        clipped,
    })
}
// A single variant list supplies both values and an exhaustive compiler-checked match.
// Adding any enum variant requires extending the framing census, not guessing a cell size.
macro_rules! variants {
    ($ty:ident; $($v:ident),+ $(,)?) => {{
        let _exhaustive = |v: $ty| match v { $($ty::$v => ()),+ };
        [$($ty::$v),+]
    }};
}
fn point_framing(d: usize, limit: usize) -> Result<usize> {
    use super::{
        routing::{AssociationSource, RouteSelectionReason},
        target_lookup::{TargetSubnetLookup, TgwTargetReason},
        vpc_lookup::{VpcLookupReason, VpcLookupResult, VpcRouteTarget, VpcSubnetLookupResult},
    };
    let mut route = 0;
    for reason in variants!(VpcLookupReason; MissingSubnet,MissingRouteTable,ScopeNotReady,InvalidDestination,ReservedServiceDestination,NoMatchingRoute,UnknownOrigin,AmbiguousRoute,RouteNotReady,PrefixListUnresolved,MalformedRoute,UnsupportedTarget)
    {
        route = route.max(encoded_len(
            &VpcLookupResult::Unresolved { reason },
            limit,
            "response_bytes",
        )?);
    }
    route = route.max(encoded_len(
        &VpcLookupResult::ReportedBlackhole {
            destination_cidr: String::new(),
        },
        limit,
        "response_bytes",
    )?);
    // Exhaustive variant matching below prevents future string-bearing alternatives escaping census.
    let targets = [
        VpcRouteTarget::TransitGateway { id: String::new() },
        VpcRouteTarget::NatGateway { id: String::new() },
        VpcRouteTarget::InternetGateway { id: String::new() },
        VpcRouteTarget::Local,
    ];
    for target in targets {
        match &target {
            VpcRouteTarget::TransitGateway { .. }
            | VpcRouteTarget::NatGateway { .. }
            | VpcRouteTarget::InternetGateway { .. }
            | VpcRouteTarget::Local => (),
        }
        route = route.max(encoded_len(
            &VpcLookupResult::ReportedRoute {
                destination_cidr: String::new(),
                origin: String::new(),
                target,
            },
            limit,
            "response_bytes",
        )?);
    }
    let empty_lookup = || VpcLookupResult::Unresolved {
        reason: VpcLookupReason::MissingSubnet,
    };
    let inner = encoded_len(&empty_lookup(), limit, "response_bytes")?;
    let mut lookup = 0;
    for source in variants!(AssociationSource;ExplicitSubnet,ImplicitMain) {
        let n = encoded_len(
            &VpcSubnetLookupResult::Reported {
                route_table_id: String::new(),
                source,
                lookup: empty_lookup(),
            },
            limit,
            "response_bytes",
        )?;
        lookup = lookup.max(checked(
            n.checked_sub(inner).and_then(|n| n.checked_add(route)),
            limit,
            "response_bytes",
        )?);
    }
    for reason in variants!(RouteSelectionReason;IncompleteObservation,DuplicateSubnet,MissingVpc,UnverifiedOwner,MissingRouteTable,AmbiguousAssociation,AssociationNotReady,WrongVpc)
    {
        lookup = lookup.max(encoded_len(
            &VpcSubnetLookupResult::AssociationUnresolved { reason },
            limit,
            "response_bytes",
        )?);
    }
    for reason in variants!(VpcLookupReason;MissingSubnet,MissingRouteTable,ScopeNotReady,InvalidDestination,ReservedServiceDestination,NoMatchingRoute,UnknownOrigin,AmbiguousRoute,RouteNotReady,PrefixListUnresolved,MalformedRoute,UnsupportedTarget)
    {
        lookup = lookup.max(encoded_len(
            &VpcSubnetLookupResult::Unresolved { reason },
            limit,
            "response_bytes",
        )?);
    }
    let empty_child = || VpcSubnetLookupResult::Unresolved {
        reason: VpcLookupReason::MissingSubnet,
    };
    let child_inner = encoded_len(&empty_child(), limit, "response_bytes")?;
    let child = encoded_len(
        &TargetSubnetLookup {
            subnet_id: String::new(),
            az_id: String::new(),
            lookup: empty_child(),
        },
        limit,
        "response_bytes",
    )?;
    let child = checked(
        child
            .checked_sub(child_inner)
            .and_then(|n| n.checked_add(lookup)),
        limit,
        "response_bytes",
    )?;
    let parent = encoded_len(
        &TargetVpcLookup::ReportedSubnets {
            vpc_id: String::new(),
            subnets: Vec::new(),
        },
        limit,
        "response_bytes",
    )?;
    let mut point = checked(
        child
            .checked_mul(d)
            .and_then(|n| n.checked_add(parent))
            .and_then(|n| n.checked_add(d.saturating_sub(1))),
        limit,
        "response_bytes",
    )?;
    for reason in variants!(TgwTargetReason;MissingOrAmbiguousAttachment,IncompleteObservation,UnsupportedRegion,MissingOrAmbiguousGateway,UnverifiedGateway,AttachmentScopeMismatch,UnverifiedAttachment,VpcScopeUnresolved,AttachmentSubnetUnresolved,TargetSubnetBudgetExceeded)
    {
        point = point.max(encoded_len(
            &TargetVpcLookup::Unresolved { reason },
            limit,
            "response_bytes",
        )?);
    }
    // Compiler-checked exhaustive shape guards complement the exhaustive reason/target lists.
    let _vpc_shape = |v: VpcLookupResult| match v {
        VpcLookupResult::ReportedBlackhole { .. }
        | VpcLookupResult::ReportedRoute { .. }
        | VpcLookupResult::Unresolved { .. } => (),
    };
    let _subnet_shape = |v: VpcSubnetLookupResult| match v {
        VpcSubnetLookupResult::Reported { .. }
        | VpcSubnetLookupResult::AssociationUnresolved { .. }
        | VpcSubnetLookupResult::Unresolved { .. } => (),
    };
    let _parent_shape = |v: TargetVpcLookup| match v {
        TargetVpcLookup::ReportedSubnets { .. } | TargetVpcLookup::Unresolved { .. } => (),
    };
    Ok(point)
}
fn cell_framing(limit: usize) -> Result<usize> {
    let empty = || TargetVpcLookup::Unresolved {
        reason: super::target_lookup::TgwTargetReason::IncompleteObservation,
    };
    let point = encoded_len(&empty(), limit, "response_bytes")?;
    let cell = encoded_len(
        &TargetAttachmentDecisionInterval {
            start: String::new(),
            end_inclusive: String::new(),
            result: empty(),
        },
        limit,
        "response_bytes",
    )?;
    checked(cell.checked_sub(point), limit, "response_bytes")
}
struct Reservation {
    work: usize,
    clones: usize,
    cells: usize,
}
fn reserve(
    c: &Census,
    saved: &SavedObservation,
    i: usize,
    o: usize,
    b: TargetAttachmentCidrBudget,
) -> Result<Reservation> {
    // ALL admitted references are an upper bound, not an optimistic first-attachment selection.
    let declared = saved
        .topology
        .resources
        .iter()
        .flat_map(|r| &r.related_ids)
        .filter(|id| id.starts_with("subnet-"))
        .count();
    let d = declared.min(32);
    let g = saved
        .topology
        .region
        .bytes()
        .filter(|v| *v == b'-')
        .count()
        .checked_add(1);
    let base = c.base()?;
    // Mechanical ledger: parent <=16R+8L+2C+G+32; each child <=32R+4A+8N+32.
    // Fixed scalar/string/evidence passes <=64B, collector/sort input/group/cell passes <=64(I+O).
    // No R*L product exists in this call graph. Internal tree/sort comparisons are not units.
    let work = checked(
        base.checked_mul(64)
            .and_then(|n| {
                n.checked_add(
                    base.checked_add(g?)?
                        .checked_mul(64)?
                        .checked_mul(1 + d)?
                        .checked_mul(i)?,
                )
            })
            .and_then(|n| n.checked_add(i.checked_add(o)?.checked_mul(64)?)),
        b.work_units,
        "work_units",
    )?;
    // Includes attempted/discarded clones: routing produces ALL U subnet rows for EVERY child.
    // 3U routing strings + subnet/AZ2 + destination/origin/target3; parent VPC1; address strings78.
    let clones = checked(
        c.us.checked_mul(3)
            .and_then(|n| n.checked_add(5))
            .and_then(|n| n.checked_mul(d))
            .and_then(|n| n.checked_add(1))
            .and_then(|n| n.checked_mul(b.string_bytes))
            .and_then(|n| n.checked_add(78))
            .and_then(|n| n.checked_mul(i)),
        b.clone_payload_bytes,
        "clone_payload_bytes",
    )?;
    // Derive fixed framing from every actual Serialize enum variant, not a cell-size heuristic.
    let fixed = checked(
        point_framing(d, b.response_bytes)?.checked_add(cell_framing(b.response_bytes)?),
        b.response_bytes,
        "response_bytes",
    )?;
    let cells = checked(
        d.checked_mul(6)
            .and_then(|n| n.checked_add(1))
            .and_then(|n| n.checked_mul(6))
            .and_then(|n| n.checked_mul(b.string_bytes))
            .and_then(|n| n.checked_add(fixed))
            .and_then(|n| n.checked_add(78))
            .and_then(|n| n.checked_mul(i))
            .and_then(|n| n.checked_add(i.saturating_sub(1))),
        b.response_bytes,
        "response_bytes",
    )?;
    Ok(Reservation {
        work,
        clones,
        cells,
    })
}
/// Uniformity is established BEFORE witnesses. Every valid network VPC route and service membership
/// is fixed per cell. Parent identity/region/readiness, every declared subnet, associations, table
/// poison and all nonmembership precedence are destination invariant. Thus all candidate sets/LPM,
/// origins, static priority, state and targets are fixed, including every second-AZ table. New point
/// destination predicates must extend the collector/proof or disable this analyzer. No enumeration,
/// sampling, first-result pruning, per-subnet zip, coalescing, truncation or successful error prefix.
pub fn analyze(
    saved: SavedObservation,
    query: TargetAttachmentCidrQuery,
    b: TargetAttachmentCidrBudget,
) -> Result<TargetAttachmentCidrCoverage> {
    let net = validate_query(&query)?;
    check(saved.topology.resources.len(), b.resources, "resources")?;
    let mut c = Census {
        work_limit: b.work_units,
        ..Census::default()
    };
    saved_cidr_admission::admit_capture(&mut c, &saved.topology, false, b.into())?;
    checked(c.base()?.checked_mul(64), b.work_units, "work_units")?;
    saved_cidr_admission::strings(&saved, b.into())?;
    for s in [
        &query.network_account_id,
        &query.transit_gateway_id,
        &query.target_attachment_id,
        &query.destination_cidr,
    ] {
        check(s.len(), b.string_bytes, "string_bytes")?;
    }
    identity(&saved, &query.network_account_id)?;
    encoded_len(&saved, b.evidence_bytes, "evidence_bytes")?;
    let (cuts, origins) = collect_origins(&saved, net, b)?;
    let reservation = reserve(&c, &saved, cuts.len(), origins.len(), b)?;
    // The complete capture, query, origins and flags are charged exactly ONCE before any witness.
    let mut total = encoded_len(
        &envelope(
            &query,
            &saved,
            &origins[..],
            &[] as &[TargetAttachmentDecisionInterval],
        ),
        b.response_bytes,
        "response_bytes",
    )?;
    checked(
        total.checked_add(reservation.cells),
        b.response_bytes,
        "response_bytes",
    )?;
    let _ = (reservation.work, reservation.clones);
    let (lo, hi) = (ordinal(net.network()), ordinal(net.broadcast()));
    if cuts.first() != Some(&lo) {
        return Err(TargetAttachmentCidrError::PartitionProofUnavailable);
    }
    let mut segments = Vec::new();
    for (index, start) in cuts.iter().copied().enumerate() {
        let end = match cuts.get(index + 1) {
            Some(next) => next
                .checked_sub(1)
                .ok_or(TargetAttachmentCidrError::PartitionProofUnavailable)?,
            None => hi,
        };
        if start < lo || start > end || end > hi {
            return Err(TargetAttachmentCidrError::PartitionProofUnavailable);
        }
        let start = address(start, net.addr().is_ipv4())?;
        let cell = TargetAttachmentDecisionInterval {
            result: target_lookup::lookup(
                &saved.topology,
                &query.transit_gateway_id,
                &query.target_attachment_id,
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
        &envelope(&query, &saved, &origins[..], &segments[..]),
        b.response_bytes,
        "response_bytes",
    )?;
    if preview != total {
        return Err(TargetAttachmentCidrError::PartitionProofUnavailable);
    }
    let result = envelope(query, saved, origins, segments);
    if encoded_len(&result, b.response_bytes, "response_bytes")? != preview {
        return Err(TargetAttachmentCidrError::PartitionProofUnavailable);
    }
    Ok(result)
}
