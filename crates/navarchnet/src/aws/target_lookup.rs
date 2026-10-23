//! Saved target attachment subnet entries. No traffic AZ, NAT health or full path is inferred.
use super::{
    observation::{AwsTopology, ResourceKind},
    vpc_lookup::{self, VpcSubnetLookupResult},
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

// Local analysis work budget, not an AWS service quota. Never truncate declared evidence.
const MAX_TARGET_SUBNETS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum TargetAzSelection {
    NotInferred,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum TgwTargetReason {
    MissingOrAmbiguousAttachment,
    IncompleteObservation,
    UnsupportedRegion,
    MissingOrAmbiguousGateway,
    UnverifiedGateway,
    AttachmentScopeMismatch,
    UnverifiedAttachment,
    VpcScopeUnresolved,
    AttachmentSubnetUnresolved,
    TargetSubnetBudgetExceeded,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TargetSubnetLookup {
    pub subnet_id: String,
    pub az_id: String,
    pub lookup: VpcSubnetLookupResult,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TargetVpcLookup {
    ReportedSubnets {
        vpc_id: String,
        subnets: Vec<TargetSubnetLookup>,
    },
    Unresolved {
        reason: TgwTargetReason,
    },
}
pub fn lookup(
    topology: &AwsTopology,
    gateway_id: &str,
    attachment_id: &str,
    destination: &str,
) -> TargetVpcLookup {
    #[cfg(test)]
    POINT_ENTRIES.with(|count| count.set(count.get() + 1));
    if !topology.complete_for_supported_queries {
        return TargetVpcLookup::Unresolved {
            reason: TgwTargetReason::IncompleteObservation,
        };
    }
    if super::validate_region(&topology.region).is_err() {
        return TargetVpcLookup::Unresolved {
            reason: TgwTargetReason::UnsupportedRegion,
        };
    }
    let evaluate = || -> Result<TargetVpcLookup, TgwTargetReason> {
        use TgwTargetReason::*;
        let parents: Vec<_> = topology
            .resources
            .iter()
            .filter(|row| row.kind == ResourceKind::TransitGateway && row.id == gateway_id)
            .collect();
        let [gateway] = parents.as_slice() else {
            return Err(MissingOrAmbiguousGateway);
        };
        if !gateway_id.starts_with("tgw-") {
            return Err(MissingOrAmbiguousGateway);
        }
        if gateway.owner_account_id.as_deref() != Some(topology.aws_account_id.as_str())
            || gateway.state.as_deref() != Some("available")
        {
            return Err(UnverifiedGateway);
        }
        let attachments: Vec<_> = topology
            .resources
            .iter()
            .filter(|row| row.kind == ResourceKind::VpcAttachment && row.id == attachment_id)
            .collect();
        let [attachment] = attachments.as_slice() else {
            return Err(MissingOrAmbiguousAttachment);
        };
        if attachment.owner_account_id.as_deref() != Some(topology.aws_account_id.as_str())
            || attachment.state.as_deref() != Some("available")
        {
            return Err(UnverifiedAttachment);
        }
        let mut gateways = attachment
            .related_ids
            .iter()
            .filter(|id| id.starts_with("tgw-"));
        if gateways.next() != Some(&gateway.id) || gateways.next().is_some() {
            return Err(AttachmentScopeMismatch);
        }
        if attachment
            .related_ids
            .iter()
            .any(|id| id != &gateway.id && !id.starts_with("subnet-"))
            || attachment
                .related_ids
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != attachment.related_ids.len()
        {
            return Err(AttachmentScopeMismatch);
        }
        let vpc_id = attachment
            .vpc_id
            .as_ref()
            .filter(|id| !id.is_empty())
            .ok_or(AttachmentScopeMismatch)?;
        let vpcs: Vec<_> = topology
            .resources
            .iter()
            .filter(|row| row.kind == ResourceKind::Vpc && &row.id == vpc_id)
            .collect();
        let [vpc] = vpcs.as_slice() else {
            return Err(VpcScopeUnresolved);
        };
        if vpc.owner_account_id.as_deref() != Some(topology.aws_account_id.as_str())
            || vpc.state.as_deref() != Some("available")
        {
            return Err(VpcScopeUnresolved);
        }
        if attachment
            .related_ids
            .iter()
            .filter(|id| id.starts_with("subnet-"))
            .count()
            > MAX_TARGET_SUBNETS
        {
            return Err(TargetSubnetBudgetExceeded);
        }
        let subnets = super::attachment_subnets::declared_subnets(topology, attachment)
            .ok_or(AttachmentSubnetUnresolved)?
            .into_iter()
            .map(|(row, az)| TargetSubnetLookup {
                subnet_id: row.id.clone(),
                az_id: az.into(),
                lookup: vpc_lookup::lookup(topology, &row.id, destination),
            })
            .collect();
        Ok(TargetVpcLookup::ReportedSubnets {
            vpc_id: vpc_id.clone(),
            subnets,
        })
    };
    evaluate().unwrap_or_else(|reason| TargetVpcLookup::Unresolved { reason })
}

#[cfg(test)]
std::thread_local! { pub(crate) static POINT_ENTRIES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::aws::observation::*;
    fn row(kind: ResourceKind, id: &str) -> AwsResource {
        let mut value = AwsResource::new(kind, id.into());
        value.owner_account_id = Some("123456789012".into());
        value.state = Some("available".into());
        value
    }
    pub(crate) fn fixture() -> AwsTopology {
        let gateway = row(ResourceKind::TransitGateway, "tgw-target");
        let mut attachment = row(ResourceKind::VpcAttachment, "tgw-attach-target");
        attachment.vpc_id = Some("vpc-target".into());
        attachment.related_ids = vec![
            gateway.id.clone(),
            "subnet-target-b".into(),
            "subnet-target-a".into(),
        ];
        let mut vpc = row(ResourceKind::Vpc, "vpc-target");
        vpc.cidrs = vec!["10.20.0.0/16".into()];
        let mut a = row(ResourceKind::Subnet, "subnet-target-a");
        a.vpc_id = Some(vpc.id.clone());
        a.az_id = Some("euw1-az1".into());
        a.cidrs = vec!["10.20.1.0/24".into()];
        let mut b = a.clone();
        b.id = "subnet-target-b".into();
        b.az_id = Some("euw1-az2".into());
        b.cidrs = vec!["10.20.2.0/24".into()];
        let mut table = row(ResourceKind::RouteTable, "rtb-target");
        table.vpc_id = Some(vpc.id.clone());
        table.associations.push(RouteAssociation {
            id: Some("rtbassoc-main".into()),
            main: true,
            subnet_id: None,
            gateway_id: None,
            state: Some("associated".into()),
        });
        table.routes.push(ObservedRoute {
            ipv4_destination: Some("0.0.0.0/0".into()),
            ipv6_destination: None,
            prefix_list_destination: None,
            state: Some("active".into()),
            origin: Some("CreateRoute".into()),
            targets: [("natGatewayId".into(), "nat-target".into())].into(),
        });
        AwsTopology {
            id: "snapshot".into(),
            account_id: "registered".into(),
            aws_account_id: "123456789012".into(),
            region: "eu-west-1".into(),
            started_at: "1".into(),
            completed_at: "3".into(),
            session_name: "fixture".into(),
            resources: vec![gateway, attachment, vpc, a, table, b],
            request_ids: vec![],
            complete_for_supported_queries: true,
            limitations: vec![],
            execution_enabled: false,
            connectivity_tested: false,
        }
    }
    fn unresolved(topology: &AwsTopology, reason: &str) {
        let result = serde_json::to_value(lookup(
            topology,
            "tgw-target",
            "tgw-attach-target",
            "203.0.113.1",
        ))
        .unwrap();
        assert_eq!(
            result,
            serde_json::json!({"status":"unresolved","reason":reason})
        );
    }
    #[test]
    fn preserves_each_subnet_selection_blackhole_and_unknown_without_mutating_or_picking_an_az() {
        let mut topology = fixture();
        let mut explicit = topology.resources[4].clone();
        explicit.id = "rtb-target-explicit".into();
        explicit.associations = vec![RouteAssociation {
            id: Some("rtbassoc-b".into()),
            main: false,
            subnet_id: Some("subnet-target-b".into()),
            gateway_id: None,
            state: Some("associated".into()),
        }];
        explicit.routes[0].targets = [("gatewayId".into(), "igw-reported-only".into())].into();
        topology.resources.push(explicit);
        let before = serde_json::to_value(&topology).unwrap();
        let result = lookup(&topology, "tgw-target", "tgw-attach-target", "203.0.113.1");
        assert_eq!(before, serde_json::to_value(&topology).unwrap());
        let body = serde_json::to_value(&result).unwrap();
        assert_eq!(body["subnets"][0]["lookup"]["source"], "implicit_main");
        assert_eq!(
            body["subnets"][0]["lookup"]["lookup"]["target"]["kind"],
            "nat_gateway"
        );
        assert_eq!(body["subnets"][1]["lookup"]["source"], "explicit_subnet");
        assert_eq!(
            body["subnets"][1]["lookup"]["lookup"]["target"]["kind"],
            "internet_gateway"
        );
        topology.resources[1].related_ids.reverse();
        topology.resources.reverse();
        assert_eq!(
            result,
            lookup(&topology, "tgw-target", "tgw-attach-target", "203.0.113.1")
        );
        let table = topology
            .resources
            .iter_mut()
            .find(|row| row.id == "rtb-target-explicit")
            .unwrap();
        table.routes[0].state = Some("blackhole".into());
        table.routes[0].targets.clear();
        let blackhole = serde_json::to_value(lookup(
            &topology,
            "tgw-target",
            "tgw-attach-target",
            "203.0.113.1",
        ))
        .unwrap();
        assert_eq!(
            blackhole["subnets"][1]["lookup"]["lookup"]["status"],
            "reported_blackhole"
        );
        let table = topology
            .resources
            .iter_mut()
            .find(|row| row.id == "rtb-target-explicit")
            .unwrap();
        table.associations[0].state = None;
        let unknown = serde_json::to_value(lookup(
            &topology,
            "tgw-target",
            "tgw-attach-target",
            "203.0.113.1",
        ))
        .unwrap();
        assert_eq!(
            unknown["subnets"][1]["lookup"]["status"],
            "association_unresolved"
        );
        let invalid = serde_json::to_value(lookup(
            &fixture(),
            "tgw-target",
            "tgw-attach-target",
            "invalid",
        ))
        .unwrap();
        assert!(
            invalid["subnets"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry["lookup"]["lookup"]["reason"] == "invalid_destination")
        );
        let mut dual = fixture();
        dual.resources[2].cidrs.push("2001:db8:1::/56".into());
        for (index, row) in dual
            .resources
            .iter_mut()
            .filter(|row| row.kind == ResourceKind::Subnet)
            .enumerate()
        {
            row.cidrs.push(format!("2001:db8:1:{}::/64", index + 1));
        }
        assert_eq!(
            serde_json::to_value(lookup(
                &dual,
                "tgw-target",
                "tgw-attach-target",
                "203.0.113.1"
            ))
            .unwrap()["subnets"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn target_subnet_analysis_budget_rejects_excess_instead_of_partial_or_quadratic_work() {
        // Synthetic AZ IDs exercise our analysis budget, not an AWS per-region AZ quota.
        for count in [33, 32] {
            let mut topology = fixture();
            topology
                .resources
                .retain(|row| row.kind != ResourceKind::Subnet);
            topology.resources[1].related_ids = vec!["tgw-target".into()];
            for index in 1..=count {
                let mut subnet = row(ResourceKind::Subnet, &format!("subnet-budget-{index:02}"));
                subnet.vpc_id = Some("vpc-target".into());
                subnet.az_id = Some(format!("euw1-az{index}"));
                subnet.cidrs = vec![format!("10.20.{index}.0/24")];
                topology.resources[1].related_ids.push(subnet.id.clone());
                topology.resources.push(subnet);
            }
            if count == 33 {
                unresolved(&topology, "target_subnet_budget_exceeded");
            } else {
                let result = serde_json::to_value(lookup(
                    &topology,
                    "tgw-target",
                    "tgw-attach-target",
                    "203.0.113.1",
                ))
                .unwrap();
                assert_eq!(result["status"], "reported_subnets");
                assert_eq!(result["subnets"].as_array().unwrap().len(), 32);
            }
        }
    }
    #[test]
    fn every_declared_target_subnet_needs_unique_owned_ready_vpc_ipv4_and_standard_az_evidence() {
        for mode in 0..19 {
            let mut topology = fixture();
            match mode {
                0 => {
                    topology.resources.remove(5);
                }
                1 => topology.resources[3].state = None,
                2 => topology.resources[3].owner_account_id = None,
                3 => topology.resources[3].owner_account_id = Some("210987654321".into()),
                4 => topology.resources[3].vpc_id = Some("vpc-other".into()),
                5 => topology.resources[3].az_id = None,
                6 => topology.resources[3].az_id = Some("eu-west-1a".into()),
                7 => topology.resources[3].az_id = Some("euw1-lon1-az1".into()),
                8 => topology.resources[3].az_id = Some("euw1-wl1-lon-wlz1".into()),
                9 => topology.resources[3].cidrs = vec!["2001:db8::/64".into()],
                10 => topology.resources[3].cidrs.push("malformed".into()),
                11 => topology.resources[3].cidrs = vec!["10.20.1.5/24".into()],
                12 => topology.resources.push(topology.resources[3].clone()),
                13 => topology.resources[5].az_id = Some("euw1-az1".into()),
                14 => topology.resources[1].related_ids = vec!["tgw-target".into()],
                15 => topology.resources[1]
                    .related_ids
                    .push("subnet-missing".into()),
                16 => topology.resources[3].state = Some("pending".into()),
                17 => topology.resources[3].cidrs.push("10.20.3.0/24".into()),
                _ => topology.resources[5].az_id = None,
            }
            unresolved(&topology, "attachment_subnet_unresolved");
        }
    }
    #[test]
    fn target_vpc_must_be_uniquely_observed_ready_and_owned_in_this_snapshot() {
        for mode in 0..8 {
            let mut topology = fixture();
            match mode {
                0 => {
                    topology.resources.remove(2);
                }
                1 => topology.resources[2].owner_account_id = None,
                2 => topology.resources[2].owner_account_id = Some("210987654321".into()),
                3 => topology.resources[2].state = None,
                4 => topology.resources[2].state = Some("pending".into()),
                5 => topology.resources.push(topology.resources[2].clone()),
                6 => topology.resources[1].vpc_id = Some("vpc-else".into()),
                _ => topology.resources[2].kind = ResourceKind::NatGateway,
            }
            unresolved(&topology, "vpc_scope_unresolved");
        }
    }
    #[test]
    fn target_attachment_identity_owner_readiness_and_reference_shape_are_required() {
        for mode in 0..9 {
            let mut topology = fixture();
            let reason = match mode {
                0 => {
                    topology.resources.push(topology.resources[1].clone());
                    "missing_or_ambiguous_attachment"
                }
                1 => {
                    topology.resources[1].state = None;
                    "unverified_attachment"
                }
                2 => {
                    topology.resources[1].state = Some("pending".into());
                    "unverified_attachment"
                }
                3 => {
                    topology.resources[1].owner_account_id = None;
                    "unverified_attachment"
                }
                4 => {
                    topology.resources[1].owner_account_id = Some("210987654321".into());
                    "unverified_attachment"
                }
                5 => {
                    topology.resources[1].vpc_id = None;
                    "attachment_scope_mismatch"
                }
                6 => {
                    topology.resources[1].vpc_id = Some("".into());
                    "attachment_scope_mismatch"
                }
                7 => {
                    topology.resources[1]
                        .related_ids
                        .push("vpce-unknown".into());
                    "attachment_scope_mismatch"
                }
                _ => {
                    topology.resources[1]
                        .related_ids
                        .push("subnet-target-a".into());
                    "attachment_scope_mismatch"
                }
            };
            unresolved(&topology, reason);
        }
    }
    #[test]
    fn requested_gateway_must_be_unique_owned_ready_and_the_attachment_reference() {
        for mode in 0..10 {
            let mut topology = fixture();
            let reason = match mode {
                0 => {
                    topology.resources.remove(0);
                    "missing_or_ambiguous_gateway"
                }
                1 => {
                    topology.resources[0].owner_account_id = None;
                    "unverified_gateway"
                }
                2 => {
                    topology.resources[0].owner_account_id = Some("210987654321".into());
                    "unverified_gateway"
                }
                3 => {
                    topology.resources[0].state = None;
                    "unverified_gateway"
                }
                4 => {
                    topology.resources[0].state = Some("pending".into());
                    "unverified_gateway"
                }
                5 => {
                    topology.resources.push(topology.resources[0].clone());
                    "missing_or_ambiguous_gateway"
                }
                6 => {
                    topology.resources[1].related_ids[0] = "tgw-other".into();
                    "attachment_scope_mismatch"
                }
                7 => {
                    topology.resources[1].related_ids.push("tgw-other".into());
                    "attachment_scope_mismatch"
                }
                8 => {
                    topology.resources[0].kind = ResourceKind::Vpc;
                    "missing_or_ambiguous_gateway"
                }
                _ => {
                    topology.resources[0].id = "subnet-target-a".into();
                    "missing_or_ambiguous_gateway"
                }
            };
            unresolved(&topology, reason);
        }
        let mut topology = fixture();
        topology.resources[0].id = "subnet-gateway".into();
        topology.resources[1].related_ids[0] = "subnet-gateway".into();
        let result = serde_json::to_value(lookup(
            &topology,
            "subnet-gateway",
            "tgw-attach-target",
            "203.0.113.1",
        ))
        .unwrap();
        assert_eq!(
            result,
            serde_json::json!({"status":"unresolved","reason":"missing_or_ambiguous_gateway"})
        );
    }
    #[test]
    fn incomplete_or_unknown_region_observations_do_not_report_target_subnets() {
        let mut topology = fixture();
        topology.complete_for_supported_queries = false;
        unresolved(&topology, "incomplete_observation");
        for region in ["", "global"] {
            let mut topology = fixture();
            topology.region = region.into();
            unresolved(&topology, "unsupported_region");
        }
    }
}
