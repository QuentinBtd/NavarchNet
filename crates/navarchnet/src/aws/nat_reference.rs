//! Match a saved VPC entry's literal NAT reference to metadata, never to a usable packet path.
use super::{
    observation::{AwsResource, AwsTopology, ResourceKind},
    vpc_lookup::{self, VpcLookupResult, VpcRouteTarget, VpcSubnetLookupResult},
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum NatReferenceScope {
    ReportedSame,
    NotReported,
    ReportedDifferent,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum NatReferenceReason {
    NoReportedNatReference,
    MissingOrAmbiguousRecord,
    IncompleteObservation,
    UnsupportedRegion,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum NatReferenceResult {
    ReportedRecord {
        resource: Box<AwsResource>,
        // Literal field comparisons, not ownership, authority or routing validation.
        owner_scope: NatReferenceScope,
        vpc_scope: NatReferenceScope,
    },
    Unresolved {
        reason: NatReferenceReason,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct NatReferenceLookup {
    pub subnet_lookup: VpcSubnetLookupResult,
    pub reference: NatReferenceResult,
}
fn scope(observed: Option<&str>, expected: Option<&str>) -> NatReferenceScope {
    match (observed, expected) {
        (Some(a), Some(b)) if a == b => NatReferenceScope::ReportedSame,
        (Some(_), Some(_)) => NatReferenceScope::ReportedDifferent,
        _ => NatReferenceScope::NotReported,
    }
}
pub fn lookup(topology: &AwsTopology, subnet_id: &str, destination: &str) -> NatReferenceLookup {
    let subnet_lookup = vpc_lookup::lookup(topology, subnet_id, destination);
    let reference = match correlate(topology, subnet_id, &subnet_lookup) {
        NatRecordReference::ReportedRecord {
            resource_index,
            owner_scope,
            vpc_scope,
        } => NatReferenceResult::ReportedRecord {
            resource: Box::new(topology.resources[resource_index].clone()),
            owner_scope,
            vpc_scope,
        },
        NatRecordReference::Unresolved { reason } => NatReferenceResult::Unresolved { reason },
    };
    NatReferenceLookup {
        subnet_lookup,
        reference,
    }
}

/// Internal correlation only: indexes refer to the exact supplied, immutable topology.
/// The caller must supply the original VPC decision for this subnet from that same capture.
/// No independent routing decision, serialized contract, authority or health claim is added.
#[derive(Debug)]
pub(crate) enum NatRecordReference {
    ReportedRecord {
        resource_index: usize,
        owner_scope: NatReferenceScope,
        vpc_scope: NatReferenceScope,
    },
    Unresolved {
        reason: NatReferenceReason,
    },
}
pub(crate) fn correlate(
    topology: &AwsTopology,
    subnet_id: &str,
    subnet_lookup: &VpcSubnetLookupResult,
) -> NatRecordReference {
    if !topology.complete_for_supported_queries {
        return NatRecordReference::Unresolved {
            reason: NatReferenceReason::IncompleteObservation,
        };
    }
    if super::validate_region(&topology.region).is_err() {
        return NatRecordReference::Unresolved {
            reason: NatReferenceReason::UnsupportedRegion,
        };
    }
    let VpcSubnetLookupResult::Reported {
        lookup:
            VpcLookupResult::ReportedRoute {
                target: VpcRouteTarget::NatGateway { id },
                ..
            },
        ..
    } = subnet_lookup
    else {
        return NatRecordReference::Unresolved {
            reason: NatReferenceReason::NoReportedNatReference,
        };
    };
    let mut records = topology
        .resources
        .iter()
        .enumerate()
        .filter(|(_, row)| row.id == *id);
    let Some((resource_index, resource)) = records.next() else {
        return NatRecordReference::Unresolved {
            reason: NatReferenceReason::MissingOrAmbiguousRecord,
        };
    };
    if records.next().is_some() || resource.kind != ResourceKind::NatGateway {
        return NatRecordReference::Unresolved {
            reason: NatReferenceReason::MissingOrAmbiguousRecord,
        };
    }
    let vpc = topology
        .resources
        .iter()
        .find(|row| row.kind == ResourceKind::Subnet && row.id == subnet_id)
        .and_then(|row| row.vpc_id.as_deref());
    NatRecordReference::ReportedRecord {
        resource_index,
        owner_scope: scope(
            resource.owner_account_id.as_deref(),
            Some(&topology.aws_account_id),
        ),
        vpc_scope: scope(resource.vpc_id.as_deref(), vpc),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aws::observation::{ObservedRoute, RouteAssociation};
    fn fixture() -> AwsTopology {
        let mut vpc = AwsResource::new(ResourceKind::Vpc, "vpc-source".into());
        vpc.owner_account_id = Some("123456789012".into());
        vpc.state = Some("available".into());
        let mut subnet = AwsResource::new(ResourceKind::Subnet, "subnet-source".into());
        subnet.vpc_id = Some(vpc.id.clone());
        subnet.owner_account_id = vpc.owner_account_id.clone();
        subnet.state = Some("available".into());
        let mut table = AwsResource::new(ResourceKind::RouteTable, "rtb-source".into());
        table.vpc_id = Some(vpc.id.clone());
        table.owner_account_id = vpc.owner_account_id.clone();
        table.associations = vec![RouteAssociation {
            id: Some("rtbassoc-source".into()),
            state: Some("associated".into()),
            subnet_id: None,
            gateway_id: None,
            main: true,
        }];
        table.routes = vec![ObservedRoute {
            ipv4_destination: Some("0.0.0.0/0".into()),
            ipv6_destination: None,
            prefix_list_destination: None,
            state: Some("active".into()),
            origin: Some("CreateRoute".into()),
            targets: [("natGatewayId".into(), "nat-reference".into())].into(),
        }];
        let nat = AwsResource::new(ResourceKind::NatGateway, "nat-reference".into());
        AwsTopology {
            id: "snapshot".into(),
            account_id: "registration".into(),
            aws_account_id: "123456789012".into(),
            region: "eu-west-1".into(),
            started_at: "1".into(),
            completed_at: "2".into(),
            session_name: "fixture".into(),
            resources: vec![vpc, subnet, table, nat],
            request_ids: vec![],
            complete_for_supported_queries: true,
            limitations: vec![],
            execution_enabled: false,
            connectivity_tested: false,
        }
    }
    #[test]
    fn shared_record_index_keeps_literal_identity_scope_and_original_precedence() {
        let topology = fixture();
        let inspect = |capture: &AwsTopology, subnet: &str| {
            let decision = vpc_lookup::lookup(capture, subnet, "203.0.113.1");
            correlate(capture, subnet, &decision)
        };
        assert!(matches!(
            inspect(&topology, "subnet-source"),
            NatRecordReference::ReportedRecord {
                resource_index: 3,
                owner_scope: NatReferenceScope::NotReported,
                vpc_scope: NatReferenceScope::NotReported
            }
        ));
        assert_eq!(
            serde_json::to_value(lookup(&topology, "subnet-source", "203.0.113.1").reference)
                .unwrap(),
            serde_json::json!({"status":"reported_record","resource":topology.resources[3],"owner_scope":"not_reported","vpc_scope":"not_reported"})
        );
        for kind in [
            ResourceKind::NatGateway,
            ResourceKind::Vpc,
            ResourceKind::Subnet,
            ResourceKind::RouteTable,
            ResourceKind::TransitGateway,
        ] {
            let mut duplicate = fixture();
            let mut row = duplicate.resources[3].clone();
            row.kind = kind;
            duplicate.resources.push(row);
            assert!(matches!(
                inspect(&duplicate, "subnet-source"),
                NatRecordReference::Unresolved {
                    reason: NatReferenceReason::MissingOrAmbiguousRecord
                }
            ));
        }
        let mut reordered = fixture();
        reordered.resources.swap(0, 3);
        assert!(matches!(
            inspect(&reordered, "subnet-source"),
            NatRecordReference::ReportedRecord {
                resource_index: 0,
                ..
            }
        ));
        let mut scoped = fixture();
        scoped.resources[3].owner_account_id = Some("999999999999".into());
        scoped.resources[3].vpc_id = Some("vpc-other".into());
        scoped.resources[3].state = Some("failed".into());
        assert!(matches!(
            inspect(&scoped, "subnet-source"),
            NatRecordReference::ReportedRecord {
                resource_index: 3,
                owner_scope: NatReferenceScope::ReportedDifferent,
                vpc_scope: NatReferenceScope::ReportedDifferent
            }
        ));
        let mut absent = fixture();
        absent.resources.pop();
        assert!(matches!(
            inspect(&absent, "subnet-source"),
            NatRecordReference::Unresolved {
                reason: NatReferenceReason::MissingOrAmbiguousRecord
            }
        ));
        assert!(matches!(
            inspect(&topology, "missing"),
            NatRecordReference::Unresolved {
                reason: NatReferenceReason::NoReportedNatReference
            }
        ));
        let mut incomplete = fixture();
        incomplete.complete_for_supported_queries = false;
        incomplete.region = "unsupported".into();
        assert!(matches!(
            inspect(&incomplete, "missing"),
            NatRecordReference::Unresolved {
                reason: NatReferenceReason::IncompleteObservation
            }
        ));
        let mut unsupported = fixture();
        unsupported.region = "unsupported".into();
        assert!(matches!(
            inspect(&unsupported, "missing"),
            NatRecordReference::Unresolved {
                reason: NatReferenceReason::UnsupportedRegion
            }
        ));
    }
    #[test]
    fn a_nat_reference_requires_one_exact_record_identity_across_all_kinds() {
        for kind in [
            ResourceKind::NatGateway,
            ResourceKind::Vpc,
            ResourceKind::Subnet,
            ResourceKind::RouteTable,
            ResourceKind::TransitGateway,
        ] {
            let mut topology = fixture();
            let mut duplicate = topology.resources[3].clone();
            duplicate.kind = kind;
            topology.resources.push(duplicate);
            assert!(matches!(
                lookup(&topology, "subnet-source", "203.0.113.1").reference,
                NatReferenceResult::Unresolved {
                    reason: NatReferenceReason::MissingOrAmbiguousRecord
                }
            ));
        }
        for mode in 0..3 {
            let mut topology = fixture();
            match mode {
                0 => {
                    topology.resources.pop();
                }
                1 => topology.resources[3].kind = ResourceKind::Vpc,
                _ => topology.resources[3].id = "NAT-reference".into(),
            }
            assert!(matches!(
                lookup(&topology, "subnet-source", "203.0.113.1").reference,
                NatReferenceResult::Unresolved {
                    reason: NatReferenceReason::MissingOrAmbiguousRecord
                }
            ));
        }
    }
    #[test]
    fn incomplete_observations_remain_explicitly_unresolved() {
        let mut topology = fixture();
        topology.complete_for_supported_queries = false;
        let value = lookup(&topology, "subnet-source", "203.0.113.1");
        assert_eq!(
            value.subnet_lookup,
            vpc_lookup::lookup(&topology, "subnet-source", "203.0.113.1")
        );
        assert_eq!(
            serde_json::to_value(value.reference).unwrap(),
            serde_json::json!({"status":"unresolved", "reason":"incomplete_observation"})
        );
    }
    #[test]
    fn unsupported_region_observations_never_report_nat_records() {
        for region in ["", "global", "us-gov-west-1"] {
            let mut topology = fixture();
            topology.region = region.into();
            let value = lookup(&topology, "subnet-source", "203.0.113.1");
            assert_eq!(
                value.subnet_lookup,
                vpc_lookup::lookup(&topology, "subnet-source", "203.0.113.1")
            );
            assert_eq!(
                serde_json::to_value(value.reference).unwrap(),
                serde_json::json!({"status":"unresolved", "reason":"unsupported_region"})
            );
        }
    }
    #[test]
    fn scope_fields_are_literal_facts_and_failed_unknown_metadata_is_not_filtered() {
        use crate::aws::observation::NatGatewayMetadata;
        for (owner, expected_owner) in [
            (None, "not_reported"),
            (Some("123456789012"), "reported_same"),
            (Some("999999999999"), "reported_different"),
        ] {
            for (vpc, expected_vpc) in [
                (None, "not_reported"),
                (Some("vpc-source"), "reported_same"),
                (Some("vpc-other"), "reported_different"),
            ] {
                let mut topology = fixture();
                let nat = &mut topology.resources[3];
                nat.owner_account_id = owner.map(Into::into);
                nat.vpc_id = vpc.map(Into::into);
                nat.state = Some("failed".into());
                nat.availability_mode = Some("future-mode".into());
                nat.public_ips = vec!["203.0.113.10".into(), "203.0.113.20".into()];
                nat.nat_gateway = Some(NatGatewayMetadata {
                    route_table_id: Some("nat-not-a-route-table".into()),
                    addresses: None,
                });
                let expected_resource = serde_json::to_value(nat).unwrap();
                let before = serde_json::to_value(&topology).unwrap();
                let value = serde_json::to_value(lookup(&topology, "subnet-source", "203.0.113.1"))
                    .unwrap();
                assert_eq!(value["reference"]["status"], "reported_record");
                assert_eq!(value["reference"]["resource"], expected_resource);
                assert_eq!(value["reference"]["owner_scope"], expected_owner);
                assert_eq!(value["reference"]["vpc_scope"], expected_vpc);
                assert_eq!(serde_json::to_value(&topology).unwrap(), before);
                topology.resources.reverse();
                assert_eq!(
                    serde_json::to_value(lookup(&topology, "subnet-source", "203.0.113.1"))
                        .unwrap(),
                    value
                );
            }
        }
    }
    #[test]
    fn non_nat_blackhole_and_unresolved_entries_are_preserved_without_following_a_record() {
        for mode in 0..9 {
            let mut topology = fixture();
            let mut subnet = "subnet-source";
            let mut destination = "203.0.113.1";
            match mode {
                0 => topology.resources[2].routes[0].state = Some("blackhole".into()),
                1 => {
                    topology.resources[2].routes[0].targets =
                        [("gatewayId".into(), "local".into())].into()
                }
                2 => {
                    topology.resources[2].routes[0].targets =
                        [("gatewayId".into(), "igw-ref".into())].into()
                }
                3 => {
                    topology.resources[2].routes[0].targets =
                        [("transitGatewayId".into(), "tgw-ref".into())].into()
                }
                4 => destination = "invalid",
                5 => destination = "169.254.169.254",
                6 => subnet = "subnet-missing",
                7 => topology.resources[2].associations[0].state = None,
                _ => topology.resources[1].owner_account_id = None,
            }
            let value = lookup(&topology, subnet, destination);
            assert_eq!(
                value.subnet_lookup,
                vpc_lookup::lookup(&topology, subnet, destination)
            );
            assert!(matches!(
                value.reference,
                NatReferenceResult::Unresolved {
                    reason: NatReferenceReason::NoReportedNatReference
                }
            ));
        }
    }
}
