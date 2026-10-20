//! Lookup reported subnet-table entries, not a full packet path or measured connectivity.
use super::{
    observation::{AwsResource, AwsTopology, ResourceKind},
    routing::{self, AssociationSource, RouteSelectionReason, RouteTableSelection},
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum VpcLookupReason {
    MissingSubnet,
    MissingRouteTable,
    ScopeNotReady,
    InvalidDestination,
    ReservedServiceDestination,
    NoMatchingRoute,
    UnknownOrigin,
    AmbiguousRoute,
    RouteNotReady,
    PrefixListUnresolved,
    MalformedRoute,
    UnsupportedTarget,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VpcRouteTarget {
    TransitGateway { id: String },
    NatGateway { id: String },
    InternetGateway { id: String },
    Local,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum VpcLookupResult {
    ReportedBlackhole {
        destination_cidr: String,
    },
    ReportedRoute {
        destination_cidr: String,
        origin: String,
        target: VpcRouteTarget,
    },
    Unresolved {
        reason: VpcLookupReason,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum VpcSubnetLookupResult {
    Reported {
        route_table_id: String,
        source: AssociationSource,
        lookup: VpcLookupResult,
    },
    AssociationUnresolved {
        reason: RouteSelectionReason,
    },
    Unresolved {
        reason: VpcLookupReason,
    },
}

pub fn lookup(topology: &AwsTopology, subnet_id: &str, destination: &str) -> VpcSubnetLookupResult {
    let Some(subnet) = routing::subnet_route_tables(topology)
        .into_iter()
        .find(|r| r.subnet_id == subnet_id)
    else {
        return VpcSubnetLookupResult::Unresolved {
            reason: VpcLookupReason::MissingSubnet,
        };
    };
    match subnet.selection {
        RouteTableSelection::Unresolved { reason } => {
            VpcSubnetLookupResult::AssociationUnresolved { reason }
        }
        RouteTableSelection::Selected {
            route_table_id,
            source,
        } => {
            let scope: Vec<_> = topology
                .resources
                .iter()
                .filter(|row| match row.kind {
                    ResourceKind::Subnet => row.id == subnet_id,
                    ResourceKind::Vpc => Some(row.id.as_str()) == subnet.vpc_id.as_deref(),
                    _ => false,
                })
                .collect();
            if scope.len() != 2
                || scope
                    .iter()
                    .any(|row| row.state.as_deref() != Some("available"))
            {
                return VpcSubnetLookupResult::Unresolved {
                    reason: VpcLookupReason::ScopeNotReady,
                };
            }
            let Some(table) = topology
                .resources
                .iter()
                .find(|r| r.kind == ResourceKind::RouteTable && r.id == route_table_id)
            else {
                return VpcSubnetLookupResult::Unresolved {
                    reason: VpcLookupReason::MissingRouteTable,
                };
            };
            VpcSubnetLookupResult::Reported {
                route_table_id,
                source,
                lookup: lookup_routes(table, destination),
            }
        }
    }
}
fn lookup_routes(table: &AwsResource, destination: &str) -> VpcLookupResult {
    let evaluate = || -> Result<VpcLookupResult, VpcLookupReason> {
        use VpcLookupReason::*;
        let address = destination
            .parse::<std::net::IpAddr>()
            .map_err(|_| InvalidDestination)?;
        // AWS service destinations are not forwarded by an overlapping broader route.
        if ["169.254.168.0/22", "fd00:ec2::/32"].iter().any(|cidr| {
            cidr.parse::<ipnet::IpNet>()
                .expect("constant reserved CIDR")
                .contains(&address)
        }) {
            return Err(ReservedServiceDestination);
        }
        // Unexpanded members or malformed rows may hide a more-specific match.
        if table
            .routes
            .iter()
            .any(|row| row.prefix_list_destination.is_some())
        {
            return Err(PrefixListUnresolved);
        }
        let mut candidates = Vec::new();
        for row in &table.routes {
            let (cidr, ipv4) = match (
                row.ipv4_destination.as_deref(),
                row.ipv6_destination.as_deref(),
            ) {
                (Some(cidr), None) => (cidr, true),
                (None, Some(cidr)) => (cidr, false),
                _ => return Err(MalformedRoute),
            };
            let network = cidr.parse::<ipnet::IpNet>().map_err(|_| MalformedRoute)?;
            if network.addr().is_ipv4() != ipv4 || network.addr() != network.network() {
                return Err(MalformedRoute);
            }
            if network.contains(&address) {
                candidates.push((network.prefix_len(), row));
            }
        }
        let longest = candidates
            .iter()
            .map(|(prefix, _)| *prefix)
            .max()
            .ok_or(NoMatchingRoute)?;
        candidates.retain(|(prefix, _)| *prefix == longest);
        if candidates.iter().any(|(_, row)| {
            !matches!(
                row.origin.as_deref(),
                Some("CreateRoute" | "CreateRouteTable" | "EnableVgwRoutePropagation")
            )
        }) {
            return Err(UnknownOrigin);
        }
        let is_static =
            |origin: Option<&str>| matches!(origin, Some("CreateRoute" | "CreateRouteTable"));
        if candidates
            .iter()
            .any(|(_, row)| is_static(row.origin.as_deref()))
        {
            candidates.retain(|(_, row)| is_static(row.origin.as_deref()));
        }
        // Saved rows do not establish BGP priority or a safe equal-prefix tie-break.
        if candidates.len() != 1 {
            return Err(AmbiguousRoute);
        }
        let row = candidates[0].1;
        let destination_cidr = row
            .ipv4_destination
            .clone()
            .or_else(|| row.ipv6_destination.clone())
            .ok_or(NoMatchingRoute)?;
        match row.state.as_deref() {
            Some("blackhole") => {
                return Ok(VpcLookupResult::ReportedBlackhole { destination_cidr });
            }
            Some("active") => {}
            _ => return Err(RouteNotReady),
        }
        if row.targets.len() != 1 {
            return Err(UnsupportedTarget);
        }
        let (key, id) = row.targets.first_key_value().ok_or(UnsupportedTarget)?;
        if id.is_empty()
            || id.len() > 2048
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(UnsupportedTarget);
        }
        let target = match key.as_str() {
            "transitGatewayId" if id.starts_with("tgw-") && id.len() > 4 => {
                VpcRouteTarget::TransitGateway { id: id.clone() }
            }
            "natGatewayId" if id.starts_with("nat-") && id.len() > 4 => {
                VpcRouteTarget::NatGateway { id: id.clone() }
            }
            "gatewayId" if id == "local" => VpcRouteTarget::Local,
            "gatewayId" if id.starts_with("igw-") && id.len() > 4 => {
                VpcRouteTarget::InternetGateway { id: id.clone() }
            }
            _ => return Err(UnsupportedTarget),
        };
        Ok(VpcLookupResult::ReportedRoute {
            destination_cidr,
            origin: row.origin.clone().ok_or(UnknownOrigin)?,
            target,
        })
    };
    evaluate().unwrap_or_else(|reason| VpcLookupResult::Unresolved { reason })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aws::observation::{ObservedRoute, RouteAssociation};
    fn route(cidr: &str, key: &str, id: &str) -> ObservedRoute {
        ObservedRoute {
            ipv4_destination: (!cidr.contains(':')).then(|| cidr.into()),
            ipv6_destination: cidr.contains(':').then(|| cidr.into()),
            prefix_list_destination: None,
            state: Some("active".into()),
            origin: Some("CreateRoute".into()),
            targets: [(key.into(), id.into())].into(),
        }
    }
    fn fixture() -> AwsTopology {
        let mut vpc = AwsResource::new(ResourceKind::Vpc, "vpc-a".into());
        vpc.owner_account_id = Some("123456789012".into());
        vpc.state = Some("available".into());
        let mut subnet = AwsResource::new(ResourceKind::Subnet, "subnet-a".into());
        subnet.owner_account_id = vpc.owner_account_id.clone();
        subnet.vpc_id = Some(vpc.id.clone());
        subnet.state = Some("available".into());
        let mut table = AwsResource::new(ResourceKind::RouteTable, "rtb-main".into());
        table.owner_account_id = vpc.owner_account_id.clone();
        table.vpc_id = Some(vpc.id.clone());
        table.associations.push(RouteAssociation {
            id: Some("rtbassoc-main".into()),
            subnet_id: None,
            gateway_id: None,
            main: true,
            state: Some("associated".into()),
        });
        table
            .routes
            .push(route("0.0.0.0/0", "transitGatewayId", "tgw-egress"));
        AwsTopology {
            id: "snapshot".into(),
            account_id: "account".into(),
            aws_account_id: "123456789012".into(),
            region: "eu-west-1".into(),
            started_at: "1".into(),
            completed_at: "2".into(),
            session_name: "fixture".into(),
            resources: vec![vpc, subnet, table],
            request_ids: vec![],
            complete_for_supported_queries: true,
            limitations: vec![],
            execution_enabled: false,
            connectivity_tested: false,
        }
    }
    fn entry(topology: &AwsTopology, destination: &str) -> VpcLookupResult {
        match lookup(topology, "subnet-a", destination) {
            VpcSubnetLookupResult::Reported { lookup, .. } => lookup,
            other => panic!("Expected selected fixture table: {other:?}"),
        }
    }
    #[test]
    fn reserved_aws_service_ranges_are_not_reported_as_default_egress_routes() {
        let mut topology = fixture();
        topology.resources[2]
            .routes
            .push(route("::/0", "transitGatewayId", "tgw-ipv6"));
        for address in [
            "169.254.168.0",
            "169.254.169.254",
            "169.254.171.255",
            "fd00:ec2::254",
            "fd00:ec2:ffff::1",
        ] {
            assert_eq!(
                serde_json::to_value(entry(&topology, address)).unwrap(),
                serde_json::json!({"status":"unresolved","reason":"reserved_service_destination"})
            );
        }
        for address in ["169.254.172.1", "fd00:ec3::1"] {
            assert!(matches!(
                entry(&topology, address),
                VpcLookupResult::ReportedRoute { .. }
            ));
        }
    }
    #[test]
    fn subnet_and_vpc_readiness_are_required_and_existing_association_guards_are_preserved() {
        for index in [0, 1] {
            let mut topology = fixture();
            topology.resources[index].state = None;
            assert_eq!(
                serde_json::to_value(lookup(&topology, "subnet-a", "203.0.113.1")).unwrap(),
                serde_json::json!({"status":"unresolved","reason":"scope_not_ready"})
            );
        }
        for mode in 0..6 {
            let mut topology = fixture();
            let reason = match mode {
                0 => {
                    topology.complete_for_supported_queries = false;
                    RouteSelectionReason::IncompleteObservation
                }
                1 => {
                    topology.resources[1].owner_account_id = None;
                    RouteSelectionReason::UnverifiedOwner
                }
                2 => {
                    topology.resources[2].vpc_id = Some("vpc-other".into());
                    topology.resources[2].associations[0].main = false;
                    topology.resources[2].associations[0].subnet_id = Some("subnet-a".into());
                    RouteSelectionReason::WrongVpc
                }
                3 => {
                    topology.resources.push(topology.resources[1].clone());
                    RouteSelectionReason::DuplicateSubnet
                }
                4 => {
                    topology.resources.push(topology.resources[2].clone());
                    RouteSelectionReason::AmbiguousAssociation
                }
                _ => {
                    topology.resources[2].associations.clear();
                    RouteSelectionReason::MissingRouteTable
                }
            };
            assert_eq!(
                lookup(&topology, "subnet-a", "203.0.113.1"),
                VpcSubnetLookupResult::AssociationUnresolved { reason }
            );
        }
        let mut topology = fixture();
        let mut explicit = topology.resources[2].clone();
        explicit.id = "rtb-explicit".into();
        explicit.associations[0].main = false;
        explicit.associations[0].subnet_id = Some("subnet-a".into());
        explicit.associations[0].state = Some("associating".into());
        topology.resources.push(explicit);
        assert_eq!(
            lookup(&topology, "subnet-a", "203.0.113.1"),
            VpcSubnetLookupResult::AssociationUnresolved {
                reason: RouteSelectionReason::AssociationNotReady
            }
        );
        topology.resources[3].associations[0].state = Some("associated".into());
        assert!(
            matches!(lookup(&topology,"subnet-a","203.0.113.1"), VpcSubnetLookupResult::Reported { route_table_id, source: AssociationSource::ExplicitSubnet, .. } if route_table_id == "rtb-explicit")
        );
    }
    #[test]
    fn unresolved_prefix_members_and_malformed_rows_cannot_be_silently_skipped() {
        for mode in 0..7 {
            let mut topology = fixture();
            let mut hidden = route("203.0.113.0/24", "transitGatewayId", "tgw-hidden");
            match mode {
                0 => {
                    hidden.ipv4_destination = None;
                    hidden.prefix_list_destination = Some("pl-unexpanded".into());
                }
                1 => hidden.ipv4_destination = Some("invalid".into()),
                2 => hidden.ipv4_destination = None,
                3 => hidden.ipv6_destination = Some("::/0".into()),
                4 => hidden.ipv4_destination = Some("::/0".into()),
                5 => hidden.ipv4_destination = Some("203.0.113.42/24".into()),
                _ => {
                    hidden.ipv4_destination = None;
                    hidden.ipv6_destination = Some("203.0.113.0/24".into());
                }
            }
            topology.resources[2].routes.push(hidden);
            let reason = if mode == 0 {
                "prefix_list_unresolved"
            } else {
                "malformed_route"
            };
            assert_eq!(
                serde_json::to_value(entry(&topology, "203.0.113.1")).unwrap(),
                serde_json::json!({"status":"unresolved","reason":reason}),
                "mode {mode}"
            );
        }
        let mut topology = fixture();
        topology.resources[2].routes.clear();
        assert_eq!(
            entry(&topology, "203.0.113.1"),
            VpcLookupResult::Unresolved {
                reason: VpcLookupReason::NoMatchingRoute
            }
        );
    }
    #[test]
    fn reports_only_supported_single_well_formed_targets_without_inferring_target_health() {
        for (key, id, expected) in [
            (
                "natGatewayId",
                "nat-egress",
                serde_json::json!({"kind":"nat_gateway","id":"nat-egress"}),
            ),
            (
                "gatewayId",
                "igw-egress",
                serde_json::json!({"kind":"internet_gateway","id":"igw-egress"}),
            ),
            ("gatewayId", "local", serde_json::json!({"kind":"local"})),
        ] {
            let mut topology = fixture();
            topology.resources[2].routes = vec![route("10.0.0.0/8", key, id)];
            if id == "local" {
                topology.resources[0].cidrs.push("10.0.0.0/8".into());
                topology.resources[2].routes[0].origin = Some("CreateRouteTable".into());
            }
            assert_eq!(
                serde_json::to_value(entry(&topology, "10.1.2.3")).unwrap()["target"],
                expected
            );
        }
        for targets in [
            std::collections::BTreeMap::new(),
            [
                ("transitGatewayId".into(), "tgw-egress".into()),
                ("natGatewayId".into(), "nat-egress".into()),
            ]
            .into(),
            [("networkInterfaceId".into(), "eni-unsupported".into())].into(),
            [("gatewayId".into(), "vgw-unsupported".into())].into(),
            [("transitGatewayId".into(), "tgw-\n".into())].into(),
            [("transitGatewayId".into(), "wrong-kind".into())].into(),
            [("transitGatewayId".into(), "tgw-".into())].into(),
            [(
                "transitGatewayId".into(),
                format!("tgw-{}", "a".repeat(2048)),
            )]
            .into(),
        ] {
            let mut topology = fixture();
            topology.resources[2].routes[0].targets = targets;
            assert_eq!(
                entry(&topology, "203.0.113.1"),
                VpcLookupResult::Unresolved {
                    reason: VpcLookupReason::UnsupportedTarget
                }
            );
        }
    }
    #[test]
    fn a_winning_blackhole_never_falls_back_and_unknown_states_are_unresolved() {
        let mut topology = fixture();
        let mut blackhole = route("10.0.0.0/8", "transitGatewayId", "tgw-gone");
        blackhole.state = Some("blackhole".into());
        blackhole.targets.clear();
        topology.resources[2].routes.push(blackhole);
        assert_eq!(
            serde_json::to_value(entry(&topology, "10.1.2.3")).unwrap(),
            serde_json::json!({"status":"reported_blackhole","destination_cidr":"10.0.0.0/8"})
        );
        for state in [None, Some("unknown".into())] {
            let mut topology = fixture();
            topology.resources[2].routes[0].state = state;
            assert_eq!(
                serde_json::to_value(entry(&topology, "203.0.113.1")).unwrap(),
                serde_json::json!({"status":"unresolved","reason":"route_not_ready"})
            );
        }
    }
    #[test]
    fn identical_prefixes_use_known_static_priority_but_never_invent_bgp_or_tie_breaks() {
        let mut topology = fixture();
        let expected = entry(&topology, "203.0.113.1");
        let mut propagated = route("0.0.0.0/0", "gatewayId", "vgw-propagated");
        propagated.origin = Some("EnableVgwRoutePropagation".into());
        topology.resources[2].routes.push(propagated.clone());
        assert_eq!(entry(&topology, "203.0.113.1"), expected);
        topology.resources[2].routes.reverse();
        assert_eq!(entry(&topology, "203.0.113.1"), expected);
        topology.resources[2].routes = vec![propagated.clone(), propagated];
        assert_eq!(
            serde_json::to_value(entry(&topology, "203.0.113.1")).unwrap(),
            serde_json::json!({"status":"unresolved","reason":"ambiguous_route"})
        );
        let mut topology = fixture();
        topology.resources[2]
            .routes
            .push(route("0.0.0.0/0", "transitGatewayId", "tgw-other"));
        assert_eq!(
            serde_json::to_value(entry(&topology, "203.0.113.1")).unwrap(),
            serde_json::json!({"status":"unresolved","reason":"ambiguous_route"})
        );
        topology.resources[2].routes[1].origin = Some("Advertisement".into());
        assert_eq!(
            entry(&topology, "203.0.113.1"),
            VpcLookupResult::Unresolved {
                reason: VpcLookupReason::UnknownOrigin
            }
        );
    }
    #[test]
    fn ipv4_and_ipv6_routes_are_independent() {
        let mut topology = fixture();
        topology.resources[2]
            .routes
            .push(route("::/0", "transitGatewayId", "tgw-ipv6"));
        assert_eq!(
            entry(&topology, "2001:db8::1"),
            VpcLookupResult::ReportedRoute {
                destination_cidr: "::/0".into(),
                origin: "CreateRoute".into(),
                target: VpcRouteTarget::TransitGateway {
                    id: "tgw-ipv6".into()
                },
            }
        );
        assert_eq!(
            entry(&topology, "203.0.113.1"),
            VpcLookupResult::ReportedRoute {
                destination_cidr: "0.0.0.0/0".into(),
                origin: "CreateRoute".into(),
                target: VpcRouteTarget::TransitGateway {
                    id: "tgw-egress".into()
                },
            }
        );
    }
    #[test]
    fn longest_prefix_is_independent_of_stored_route_order_and_does_not_mutate_observations() {
        let mut topology = fixture();
        topology.resources[2]
            .routes
            .push(route("10.0.0.0/8", "transitGatewayId", "tgw-private"));
        let before = serde_json::to_value(&topology).unwrap();
        let expected = VpcLookupResult::ReportedRoute {
            destination_cidr: "10.0.0.0/8".into(),
            origin: "CreateRoute".into(),
            target: VpcRouteTarget::TransitGateway {
                id: "tgw-private".into(),
            },
        };
        assert_eq!(entry(&topology, "10.1.2.3"), expected);
        assert_eq!(before, serde_json::to_value(&topology).unwrap());
        topology.resources[2].routes.reverse();
        topology.resources.reverse();
        assert_eq!(entry(&topology, "10.1.2.3"), expected);
        assert!(!topology.execution_enabled && !topology.connectivity_tested);
    }
}
