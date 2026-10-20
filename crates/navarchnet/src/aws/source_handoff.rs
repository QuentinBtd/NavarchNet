//! Saved source-subnet/TGW ingress candidates, not a full path or contemporaneous cloud state.
use super::{
    attachment_subnets::{declared_subnets, standard_az_id},
    ingress_lookup::{self, TgwIngressReason, TgwIngressResult},
    observation::{AwsTopology, ResourceKind},
    route_lookup::TgwLookupResult,
    vpc_lookup::{self, VpcLookupResult, VpcRouteTarget, VpcSubnetLookupResult},
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SourceHandoffReason {
    SourceRouteUnresolved,
    SourceRouteNotTransitGateway,
    RegionMismatch,
    IncompleteNetworkObservation,
    MissingSourceScope,
    UnknownSourceAz,
    MissingOrAmbiguousAttachment,
    UnverifiedAttachment,
    UnknownAttachmentScope,
    AttachmentSubnetUnresolved,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SourceHandoffResult {
    ReportedCandidate {
        transit_gateway_id: String,
        ingress_attachment_id: String,
        attachment_subnet_id: String,
        az_id: String,
        route_table_id: String,
        lookup: TgwLookupResult,
    },
    IngressUnresolved {
        reason: TgwIngressReason,
    },
    Unresolved {
        reason: SourceHandoffReason,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SourceHandoffLookup {
    pub source: VpcSubnetLookupResult,
    pub handoff: SourceHandoffResult,
}
pub fn lookup(
    source: &AwsTopology,
    network: &AwsTopology,
    subnet_id: &str,
    destination: &str,
) -> SourceHandoffLookup {
    let source_lookup = vpc_lookup::lookup(source, subnet_id, destination);
    let evaluate = || -> Result<SourceHandoffResult, SourceHandoffReason> {
        use SourceHandoffReason::*;
        let gateway = match &source_lookup {
            VpcSubnetLookupResult::Reported {
                lookup:
                    VpcLookupResult::ReportedRoute {
                        target: VpcRouteTarget::TransitGateway { id },
                        ..
                    },
                ..
            } => id,
            VpcSubnetLookupResult::Reported {
                lookup: VpcLookupResult::ReportedRoute { .. },
                ..
            } => return Err(SourceRouteNotTransitGateway),
            _ => return Err(SourceRouteUnresolved),
        };
        if !network.complete_for_supported_queries {
            return Err(IncompleteNetworkObservation);
        }
        if source.region != network.region || super::validate_region(&source.region).is_err() {
            return Err(RegionMismatch);
        }
        let subnet = source
            .resources
            .iter()
            .find(|r| r.kind == ResourceKind::Subnet && r.id == subnet_id)
            .ok_or(MissingSourceScope)?;
        let vpc_id = subnet.vpc_id.as_deref().ok_or(MissingSourceScope)?;
        let az = subnet
            .az_id
            .as_deref()
            .filter(|id| standard_az_id(id))
            .ok_or(UnknownSourceAz)?;
        let mut attachments = Vec::new();
        for row in network
            .resources
            .iter()
            .filter(|r| r.kind == ResourceKind::VpcAttachment)
        {
            let gateways: Vec<_> = row
                .related_ids
                .iter()
                .filter(|id| id.starts_with("tgw-"))
                .collect();
            let different_vpc = row
                .vpc_id
                .as_deref()
                .is_some_and(|id| !id.is_empty() && id != vpc_id);
            let different_gateway = gateways.len() == 1 && gateways[0] != gateway;
            if different_vpc || different_gateway {
                continue;
            }
            // Unknown scope might conceal a second match; never just skip it.
            if row.vpc_id.as_deref() != Some(vpc_id)
                || gateways.len() != 1
                || gateways[0] != gateway
                || row
                    .related_ids
                    .iter()
                    .any(|id| id != gateway && !id.starts_with("subnet-"))
                || row
                    .related_ids
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    != row.related_ids.len()
            {
                return Err(UnknownAttachmentScope);
            }
            attachments.push(row);
        }
        let [attachment] = attachments.as_slice() else {
            return Err(MissingOrAmbiguousAttachment);
        };
        // vpcOwnerId joins this VPC to its owner's snapshot; it grants no mutation rights.
        if attachment.owner_account_id.as_deref() != Some(source.aws_account_id.as_str()) {
            return Err(UnverifiedAttachment);
        }
        let (attachment_subnet, _) = declared_subnets(source, attachment)
            .ok_or(AttachmentSubnetUnresolved)?
            .into_iter()
            .find(|(_, attachment_az)| *attachment_az == az)
            .ok_or(AttachmentSubnetUnresolved)?;
        match ingress_lookup::lookup(network, &attachment.id, destination) {
            TgwIngressResult::Reported {
                transit_gateway_id,
                route_table_id,
                lookup,
            } => Ok(SourceHandoffResult::ReportedCandidate {
                transit_gateway_id,
                route_table_id,
                lookup,
                ingress_attachment_id: attachment.id.clone(),
                attachment_subnet_id: attachment_subnet.id.clone(),
                az_id: az.into(),
            }),
            TgwIngressResult::Unresolved { reason } => {
                Ok(SourceHandoffResult::IngressUnresolved { reason })
            }
        }
    };
    let handoff = evaluate().unwrap_or_else(|reason| SourceHandoffResult::Unresolved { reason });
    SourceHandoffLookup {
        source: source_lookup,
        handoff,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aws::observation::*;
    fn row(kind: ResourceKind, id: &str, owner: &str) -> AwsResource {
        let mut value = AwsResource::new(kind, id.into());
        value.owner_account_id = Some(owner.into());
        value.state = Some("available".into());
        value
    }
    fn fixture() -> (AwsTopology, AwsTopology) {
        let mut vpc = row(ResourceKind::Vpc, "vpc-source", "123456789012");
        vpc.cidrs.push("10.1.0.0/16".into());
        let mut subnet = row(ResourceKind::Subnet, "subnet-source", "123456789012");
        subnet.vpc_id = Some(vpc.id.clone());
        subnet.az_id = Some("euw1-az1".into());
        subnet.cidrs.push("10.1.1.0/24".into());
        let mut attachment_subnet = subnet.clone();
        attachment_subnet.id = "subnet-attachment".into();
        attachment_subnet.cidrs = vec!["10.1.254.0/24".into()];
        let mut source_table = row(ResourceKind::RouteTable, "rtb-source", "123456789012");
        source_table.vpc_id = Some(vpc.id.clone());
        source_table.associations.push(RouteAssociation {
            id: Some("rtbassoc-source".into()),
            subnet_id: None,
            gateway_id: None,
            main: true,
            state: Some("associated".into()),
        });
        source_table.routes.push(ObservedRoute {
            ipv4_destination: Some("0.0.0.0/0".into()),
            ipv6_destination: None,
            prefix_list_destination: None,
            origin: Some("CreateRoute".into()),
            state: Some("active".into()),
            targets: [("transitGatewayId".into(), "tgw-handoff".into())].into(),
        });
        let gateway = row(ResourceKind::TransitGateway, "tgw-handoff", "210987654321");
        let mut attachment = row(
            ResourceKind::VpcAttachment,
            "tgw-attach-source",
            "123456789012",
        );
        attachment.vpc_id = Some(vpc.id.clone());
        attachment.related_ids = vec![gateway.id.clone(), attachment_subnet.id.clone()];
        let mut table = row(
            ResourceKind::TransitGatewayRouteTable,
            "tgw-rtb-network",
            "210987654321",
        );
        table.related_ids.push(gateway.id.clone());
        table.tgw_associations = Some(vec![TransitGatewayTableLink {
            attachment_id: Some(attachment.id.clone()),
            resource_id: Some(vpc.id.clone()),
            resource_type: Some("vpc".into()),
            state: Some("associated".into()),
            route_table_announcement_id: None,
        }]);
        table.tgw_routes = Some(vec![TransitGatewayRoute {
            destination_cidr: Some("0.0.0.0/0".into()),
            prefix_list_id: None,
            state: Some("active".into()),
            route_type: Some("static".into()),
            route_table_announcement_id: None,
            attachments: vec![TransitGatewayRouteAttachment {
                attachment_id: Some("tgw-attach-egress".into()),
                resource_id: None,
                resource_type: Some("vpc".into()),
            }],
        }]);
        let source = AwsTopology {
            id: "source-snapshot".into(),
            account_id: "source".into(),
            aws_account_id: "123456789012".into(),
            region: "eu-west-1".into(),
            started_at: "1".into(),
            completed_at: "3".into(),
            session_name: "fixture".into(),
            resources: vec![vpc, subnet, attachment_subnet, source_table],
            request_ids: vec![],
            complete_for_supported_queries: true,
            limitations: vec![],
            execution_enabled: false,
            connectivity_tested: false,
        };
        let mut network = source.clone();
        network.id = "network-snapshot".into();
        network.account_id = "network".into();
        network.aws_account_id = "210987654321".into();
        network.completed_at = "7".into();
        network.resources = vec![gateway, attachment, table];
        (source, network)
    }
    fn unresolved(source: &AwsTopology, network: &AwsTopology, reason: &str) {
        assert_eq!(
            serde_json::to_value(lookup(source, network, "subnet-source", "203.0.113.1").handoff)
                .unwrap(),
            serde_json::json!({"status":"unresolved","reason":reason})
        );
    }
    #[test]
    fn a_gateway_kind_record_cannot_turn_an_attachment_subnet_reference_into_the_gateway() {
        let (source, mut network) = fixture();
        // Preserve the actual declared tgw-handoff reference, but corrupt the observed parent ID.
        network.resources[0].id = "subnet-attachment".into();
        network.resources[2].related_ids = vec!["subnet-attachment".into()];
        assert_eq!(
            lookup(&source, &network, "subnet-source", "203.0.113.1").handoff,
            SourceHandoffResult::IngressUnresolved {
                reason: TgwIngressReason::MissingOrAmbiguousGateway
            }
        );
    }
    #[test]
    fn composition_preserves_existing_lookup_outcomes_and_never_rewrites_either_snapshot() {
        let (mut source, mut network) = fixture();
        let before = serde_json::to_value((&source, &network)).unwrap();
        let result = lookup(&source, &network, "subnet-source", "203.0.113.1");
        assert!(matches!(
            result.handoff,
            SourceHandoffResult::ReportedCandidate { .. }
        ));
        assert_eq!(before, serde_json::to_value((&source, &network)).unwrap());
        network.resources[1].related_ids.reverse();
        network.resources.reverse();
        source.resources.reverse();
        assert_eq!(
            result,
            lookup(&source, &network, "subnet-source", "203.0.113.1")
        );
        let (source, mut network) = fixture();
        let route = &mut network.resources[2].tgw_routes.as_mut().unwrap()[0];
        route.state = Some("blackhole".into());
        route.attachments.clear();
        let result =
            serde_json::to_value(lookup(&source, &network, "subnet-source", "203.0.113.1"))
                .unwrap();
        assert_eq!(result["handoff"]["status"], "reported_candidate");
        assert_eq!(result["handoff"]["lookup"]["status"], "reported_blackhole");
        network.resources[2].tgw_routes = None;
        let result =
            serde_json::to_value(lookup(&source, &network, "subnet-source", "203.0.113.1"))
                .unwrap();
        assert_eq!(result["handoff"]["lookup"]["reason"], "routes_not_queried");
        let (mut source, mut network) = fixture();
        network.resources[1].state = None;
        assert_eq!(
            lookup(&source, &network, "subnet-source", "203.0.113.1").handoff,
            SourceHandoffResult::IngressUnresolved {
                reason: TgwIngressReason::AttachmentNotReady
            }
        );
        network.resources[1].state = Some("available".into());
        network.resources[0].owner_account_id = Some(source.aws_account_id.clone());
        assert_eq!(
            lookup(&source, &network, "subnet-source", "203.0.113.1").handoff,
            SourceHandoffResult::IngressUnresolved {
                reason: TgwIngressReason::UnverifiedGateway
            }
        );
        source.complete_for_supported_queries = false;
        unresolved(&source, &network, "source_route_unresolved");
    }
    #[test]
    fn a_valid_non_tgw_source_route_is_reported_without_inventing_a_tgw_handoff() {
        let (mut source, network) = fixture();
        source.resources[3].routes[0].targets =
            [("natGatewayId".into(), "nat-direct".into())].into();
        let result = lookup(&source, &network, "subnet-source", "203.0.113.1");
        assert!(matches!(
            result.source,
            VpcSubnetLookupResult::Reported {
                lookup: VpcLookupResult::ReportedRoute {
                    target: VpcRouteTarget::NatGateway { .. },
                    ..
                },
                ..
            }
        ));
        unresolved(&source, &network, "source_route_not_transit_gateway");
    }
    #[test]
    fn zone_names_and_unknown_ids_are_not_substituted_for_standard_az_ids() {
        for az in [
            "eu-west-1a",
            "unknown",
            "",
            "euw1-az",
            "euw1-azx",
            "Euw1-az1",
            "euw1-lon1-az1",
            "euw1-wl1-lon-wlz1",
        ] {
            let (mut source, network) = fixture();
            source.resources[1].az_id = Some(az.into());
            source.resources[2].az_id = Some(az.into());
            unresolved(&source, &network, "unknown_source_az");
        }
        let (mut source, network) = fixture();
        source.resources[1].az_id = None;
        unresolved(&source, &network, "unknown_source_az");
        let (mut source, network) = fixture();
        source.resources[2].az_id = Some("eu-west-1a".into());
        unresolved(&source, &network, "attachment_subnet_unresolved");
    }
    #[test]
    fn every_declared_attachment_subnet_needs_unique_ready_owner_vpc_ipv4_and_az_evidence() {
        for mode in 0..10 {
            let (mut source, mut network) = fixture();
            match mode {
                0 => source.resources[2].state = None,
                1 => source.resources[2].owner_account_id = Some("210987654321".into()),
                2 => source.resources[2].vpc_id = Some("vpc-other".into()),
                3 => source.resources[2].cidrs = vec!["2001:db8::/64".into()],
                4 => source.resources[2].az_id = None,
                5 => source.resources[2].cidrs.push("invalid".into()),
                6 => source.resources[2].cidrs = vec!["10.1.254.42/24".into()],
                7 => source.resources.push(source.resources[2].clone()),
                8 => {
                    let mut other = source.resources[2].clone();
                    other.id = "subnet-second-same-az".into();
                    network.resources[1].related_ids.push(other.id.clone());
                    source.resources.push(other);
                }
                _ => network.resources[1]
                    .related_ids
                    .push("subnet-unobserved".into()),
            }
            unresolved(&source, &network, "attachment_subnet_unresolved");
        }
    }
    #[test]
    fn incomplete_attachment_scope_cannot_hide_a_competing_handoff() {
        for mode in 0..5 {
            let (source, mut network) = fixture();
            match mode {
                0 | 1 => {
                    let mut hidden = network.resources[1].clone();
                    hidden.id = "tgw-attach-hidden".into();
                    if mode == 0 {
                        hidden.vpc_id = None;
                    } else {
                        hidden.related_ids = vec!["subnet-attachment".into()];
                    }
                    network.resources.push(hidden);
                }
                2 => network.resources[1]
                    .related_ids
                    .push("unknown-reference".into()),
                3 => network.resources[1]
                    .related_ids
                    .push("subnet-attachment".into()),
                _ => network.resources[1].related_ids.push("tgw-handoff".into()),
            }
            unresolved(&source, &network, "unknown_attachment_scope");
        }
        let (source, mut network) = fixture();
        let mut other = network.resources[1].clone();
        other.id = "tgw-attach-unrelated".into();
        other.related_ids = vec!["tgw-other".into(), "subnet-attachment".into()];
        network.resources.push(other);
        assert!(matches!(
            lookup(&source, &network, "subnet-source", "203.0.113.1").handoff,
            SourceHandoffResult::ReportedCandidate { .. }
        ));
    }
    #[test]
    fn attachment_identity_must_be_unique_and_its_vpc_owner_must_match_the_source_account() {
        for owner in [None, Some("210987654321".into())] {
            let (source, mut network) = fixture();
            network.resources[1].owner_account_id = owner;
            unresolved(&source, &network, "unverified_attachment");
        }
        let (source, mut network) = fixture();
        let mut other = network.resources[1].clone();
        other.id = "tgw-attach-other".into();
        network.resources.push(other);
        unresolved(&source, &network, "missing_or_ambiguous_attachment");
        network.resources.reverse();
        unresolved(&source, &network, "missing_or_ambiguous_attachment");
    }
    #[test]
    fn independent_account_snapshots_must_share_a_region_and_network_coverage_is_required() {
        let (source, mut network) = fixture();
        network.region = "eu-west-2".into();
        unresolved(&source, &network, "region_mismatch");
        network.region = source.region.clone();
        network.complete_for_supported_queries = false;
        unresolved(&source, &network, "incomplete_network_observation");
        for region in ["", "global"] {
            let (mut source, mut network) = fixture();
            source.region = region.into();
            network.region = region.into();
            unresolved(&source, &network, "region_mismatch");
        }
    }
}
