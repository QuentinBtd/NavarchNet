//! Conservative per-table lookup from immutable observations, never a full path or measured connectivity.
use super::observation::{AwsTopology, ResourceKind};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum TgwLookupReason {
    IncompleteObservation,
    MissingOrAmbiguousTable,
    UnverifiedOwner,
    TableNotReady,
    RoutesNotQueried,
    PrefixListUnresolved,
    InvalidDestination,
    MalformedRoute,
    NoMatchingRoute,
    UnknownRouteType,
    AmbiguousRoute,
    RouteNotReady,
    AttachmentNotReported,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TgwLookupResult {
    ReportedForward {
        destination_cidr: String,
        route_type: String,
        attachment_ids: Vec<String>,
    },
    ReportedBlackhole {
        destination_cidr: String,
    },
    Unresolved {
        reason: TgwLookupReason,
    },
}
pub fn lookup(topology: &AwsTopology, table_id: &str, destination: &str) -> TgwLookupResult {
    let evaluate = || -> Result<TgwLookupResult, TgwLookupReason> {
        use TgwLookupReason::*;
        if !topology.complete_for_supported_queries {
            return Err(IncompleteObservation);
        }
        let address = destination
            .parse::<std::net::IpAddr>()
            .map_err(|_| InvalidDestination)?;
        let tables: Vec<_> = topology
            .resources
            .iter()
            .filter(|r| r.kind == ResourceKind::TransitGatewayRouteTable && r.id == table_id)
            .collect();
        if tables.len() != 1 {
            return Err(MissingOrAmbiguousTable);
        }
        let table = tables[0];
        // EC2's TGW table shape reports its parent TGW ID, not an ownerId field.
        // Derive provenance only from one matching observed parent; never rewrite the snapshot.
        let related: std::collections::BTreeSet<_> =
            table.related_ids.iter().map(String::as_str).collect();
        let parents: Vec<_> = topology
            .resources
            .iter()
            .filter(|r| r.kind == ResourceKind::TransitGateway && related.contains(r.id.as_str()))
            .collect();
        let direct = table.owner_account_id.as_deref();
        let owner_verified = match parents.as_slice() {
            [] => direct == Some(topology.aws_account_id.as_str()),
            [parent] => {
                parent.owner_account_id.as_deref() == Some(topology.aws_account_id.as_str())
                    && direct.is_none_or(|owner| owner == topology.aws_account_id)
            }
            _ => false,
        };
        if !owner_verified {
            return Err(UnverifiedOwner);
        }
        if table.state.as_deref() != Some("available") {
            return Err(TableNotReady);
        }
        let routes = table.tgw_routes.as_ref().ok_or(RoutesNotQueried)?;
        // An unresolved prefix-list member may be more specific than any visible CIDR.
        if routes.iter().any(|r| r.prefix_list_id.is_some()) {
            return Err(PrefixListUnresolved);
        }
        let mut candidates = Vec::new();
        for row in routes {
            let network = row
                .destination_cidr
                .as_ref()
                .ok_or(MalformedRoute)?
                .parse::<ipnet::IpNet>()
                .map_err(|_| MalformedRoute)?;
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
        if candidates
            .iter()
            .any(|(_, r)| !matches!(r.route_type.as_deref(), Some("static" | "propagated")))
        {
            return Err(UnknownRouteType);
        }
        if candidates
            .iter()
            .any(|(_, r)| r.route_type.as_deref() == Some("static"))
        {
            candidates.retain(|(_, r)| r.route_type.as_deref() == Some("static"));
        }
        // No BGP attachment-priority, ECMP readiness or hidden backup-route inference.
        if candidates.len() != 1 {
            return Err(AmbiguousRoute);
        }
        let row = candidates[0].1;
        let destination_cidr = row.destination_cidr.clone().ok_or(MalformedRoute)?;
        match row.state.as_deref() {
            Some("blackhole") => Ok(TgwLookupResult::ReportedBlackhole { destination_cidr }),
            Some("active") => {
                if row.attachments.is_empty() {
                    return Err(AttachmentNotReported);
                }
                let mut attachment_ids = std::collections::BTreeSet::new();
                for attachment in &row.attachments {
                    let id = attachment
                        .attachment_id
                        .as_ref()
                        .filter(|id| {
                            !id.is_empty() && id.len() <= 2048 && !id.chars().any(char::is_control)
                        })
                        .ok_or(AttachmentNotReported)?;
                    if !attachment_ids.insert(id.clone()) {
                        return Err(AmbiguousRoute);
                    }
                }
                Ok(TgwLookupResult::ReportedForward {
                    destination_cidr,
                    route_type: row.route_type.clone().ok_or(UnknownRouteType)?,
                    attachment_ids: attachment_ids.into_iter().collect(),
                })
            }
            _ => Err(RouteNotReady),
        }
    };
    evaluate().unwrap_or_else(|reason| TgwLookupResult::Unresolved { reason })
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::aws::observation::*;
    fn route(cidr: &str, kind: &str, state: &str, attachment: &str) -> TransitGatewayRoute {
        TransitGatewayRoute {
            destination_cidr: Some(cidr.into()),
            prefix_list_id: None,
            state: Some(state.into()),
            route_type: Some(kind.into()),
            route_table_announcement_id: None,
            attachments: vec![TransitGatewayRouteAttachment {
                attachment_id: Some(attachment.into()),
                resource_id: None,
                resource_type: Some("vpc".into()),
            }],
        }
    }
    fn fixture() -> AwsTopology {
        let mut table = AwsResource::new(ResourceKind::TransitGatewayRouteTable, "table".into());
        table.owner_account_id = Some("123456789012".into());
        table.state = Some("available".into());
        table.tgw_routes = Some(vec![
            route("0.0.0.0/0", "static", "active", "default"),
            route("10.0.0.0/8", "propagated", "active", "spoke"),
            route("10.2.0.0/16", "static", "blackhole", "unused"),
            route("::/0", "static", "active", "ipv6"),
        ]);
        AwsTopology {
            id: "snapshot".into(),
            account_id: "account".into(),
            aws_account_id: "123456789012".into(),
            region: "eu-west-1".into(),
            started_at: "1".into(),
            completed_at: "2".into(),
            session_name: "fixture".into(),
            resources: vec![table],
            request_ids: vec![],
            complete_for_supported_queries: true,
            limitations: vec![],
            execution_enabled: false,
            connectivity_tested: false,
        }
    }
    fn unresolved(reason: TgwLookupReason) -> TgwLookupResult {
        TgwLookupResult::Unresolved { reason }
    }
    #[test]
    fn longest_prefix_blackholes_and_address_families_are_observations_not_connectivity() {
        let topology = fixture();
        assert_eq!(
            lookup(&topology, "table", "10.1.2.3"),
            TgwLookupResult::ReportedForward {
                destination_cidr: "10.0.0.0/8".into(),
                route_type: "propagated".into(),
                attachment_ids: vec!["spoke".into()]
            }
        );
        assert_eq!(
            lookup(&topology, "table", "10.2.3.4"),
            TgwLookupResult::ReportedBlackhole {
                destination_cidr: "10.2.0.0/16".into()
            }
        );
        assert_eq!(
            lookup(&topology, "table", "2001:db8::1"),
            TgwLookupResult::ReportedForward {
                destination_cidr: "::/0".into(),
                route_type: "static".into(),
                attachment_ids: vec!["ipv6".into()]
            }
        );
        assert!(!topology.execution_enabled && !topology.connectivity_tested);
    }
    #[test]
    fn real_table_shape_uses_unique_reported_parent_ownership_without_inventing_an_owner_field() {
        let mut topology = fixture();
        topology.resources[0].owner_account_id = None;
        topology.resources[0].related_ids.push("tgw-parent".into());
        let mut parent = AwsResource::new(ResourceKind::TransitGateway, "tgw-parent".into());
        parent.owner_account_id = Some(topology.aws_account_id.clone());
        topology.resources.push(parent.clone());
        assert!(matches!(
            lookup(&topology, "table", "203.0.113.1"),
            TgwLookupResult::ReportedForward { .. }
        ));
        topology.resources.push(parent);
        assert_eq!(
            lookup(&topology, "table", "203.0.113.1"),
            unresolved(TgwLookupReason::UnverifiedOwner)
        );
        topology.resources.pop();
        topology.resources[1].owner_account_id = Some("999999999999".into());
        assert_eq!(
            lookup(&topology, "table", "203.0.113.1"),
            unresolved(TgwLookupReason::UnverifiedOwner)
        );
    }
    #[test]
    fn static_ties_win_but_equal_propagations_are_not_given_invented_bgp_priority() {
        let mut topology = fixture();
        topology.resources[0]
            .tgw_routes
            .as_mut()
            .unwrap()
            .push(route("10.0.0.0/8", "static", "blackhole", "unused"));
        assert_eq!(
            lookup(&topology, "table", "10.1.1.1"),
            TgwLookupResult::ReportedBlackhole {
                destination_cidr: "10.0.0.0/8".into()
            }
        );
        topology.resources[0].tgw_routes.as_mut().unwrap().pop();
        topology.resources[0]
            .tgw_routes
            .as_mut()
            .unwrap()
            .push(route("10.0.0.0/8", "propagated", "active", "other"));
        assert_eq!(
            lookup(&topology, "table", "10.1.1.1"),
            unresolved(TgwLookupReason::AmbiguousRoute)
        );
    }
    #[test]
    fn is_order_independent_and_refuses_malformed_unready_unknown_or_unattributed_targets() {
        let original = fixture();
        let mut reversed = original.clone();
        reversed.resources[0].tgw_routes.as_mut().unwrap().reverse();
        assert_eq!(
            lookup(&original, "table", "10.1.2.3"),
            lookup(&reversed, "table", "10.1.2.3")
        );
        for (mode, reason) in [
            TgwLookupReason::RouteNotReady,
            TgwLookupReason::UnknownRouteType,
            TgwLookupReason::AttachmentNotReported,
            TgwLookupReason::MalformedRoute,
            TgwLookupReason::NoMatchingRoute,
            TgwLookupReason::MissingOrAmbiguousTable,
        ]
        .into_iter()
        .enumerate()
        {
            let mut topology = fixture();
            let routes = topology.resources[0].tgw_routes.as_mut().unwrap();
            match mode {
                0 => routes[0].state = None,
                1 => routes[0].route_type = None,
                2 => routes[0].attachments.clear(),
                3 => routes[0].destination_cidr = Some("invalid".into()),
                4 => routes.clear(),
                _ => topology.resources.push(topology.resources[0].clone()),
            }
            assert_eq!(
                lookup(&topology, "table", "203.0.113.1"),
                unresolved(reason)
            );
        }
    }
    #[test]
    fn rejects_missing_scope_unknown_readiness_unresolved_prefix_lists_and_incomplete_scans() {
        let mut topology = fixture();
        assert_eq!(
            lookup(&topology, "missing", "203.0.113.1"),
            unresolved(TgwLookupReason::MissingOrAmbiguousTable)
        );
        assert_eq!(
            lookup(&topology, "table", "not an address"),
            unresolved(TgwLookupReason::InvalidDestination)
        );
        topology.resources[0].tgw_routes.as_mut().unwrap()[0].prefix_list_id =
            Some("pl-unresolved".into());
        assert_eq!(
            lookup(&topology, "table", "203.0.113.1"),
            unresolved(TgwLookupReason::PrefixListUnresolved)
        );
        topology.resources[0].tgw_routes = None;
        assert_eq!(
            lookup(&topology, "table", "203.0.113.1"),
            unresolved(TgwLookupReason::RoutesNotQueried)
        );
        topology.resources[0].state = None;
        assert_eq!(
            lookup(&topology, "table", "203.0.113.1"),
            unresolved(TgwLookupReason::TableNotReady)
        );
        topology.resources[0].owner_account_id = None;
        assert_eq!(
            lookup(&topology, "table", "203.0.113.1"),
            unresolved(TgwLookupReason::UnverifiedOwner)
        );
        topology.complete_for_supported_queries = false;
        assert_eq!(
            lookup(&topology, "table", "203.0.113.1"),
            unresolved(TgwLookupReason::IncompleteObservation)
        );
    }
}
