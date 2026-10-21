use super::*;
use proptest::prelude::*;

pub(super) fn assert_all_points(output: &nat_cidr_reference::NatCidrReferenceCoverage, cidr: &str) {
    let net: ipnet::IpNet = cidr.parse().unwrap();
    let ordinal = |ip| match ip {
        std::net::IpAddr::V4(v) => u128::from(u32::from(v)),
        std::net::IpAddr::V6(v) => u128::from(v),
    };
    let lo = ordinal(net.network());
    let hi = ordinal(net.broadcast());
    assert!(hi - lo <= 15, "tiny TEST oracle only");
    assert_eq!(output.references.len(), output.vpc_coverage.segments.len());
    assert_eq!(
        serde_json::to_value(&output.az_selection).unwrap(),
        "not_inferred"
    );
    for value in lo..=hi {
        let ip = if net.addr().is_ipv4() {
            std::net::IpAddr::V4(std::net::Ipv4Addr::from(u32::try_from(value).unwrap()))
        } else {
            std::net::IpAddr::V6(std::net::Ipv6Addr::from(value))
        };
        let matches = output
            .vpc_coverage
            .segments
            .iter()
            .enumerate()
            .filter(|(_, cell)| {
                ordinal(cell.start.parse().unwrap()) <= value
                    && value <= ordinal(cell.end_inclusive.parse().unwrap())
            })
            .collect::<Vec<_>>();
        assert_eq!(matches.len(), 1);
        let (index, cell) = matches[0];
        let row = &output.references[index];
        assert_eq!(row.vpc_segment_index, index);
        let point = nat_reference::lookup(&output.saved.topology, "subnet-source", &ip.to_string());
        assert_eq!(point.subnet_lookup, cell.result);
        let actual = match &row.reference {
            NatCidrRecordReference::ReportedRecord {
                resource_index,
                owner_scope,
                vpc_scope,
            } => NatReferenceResult::ReportedRecord {
                resource: Box::new(output.saved.topology.resources[*resource_index].clone()),
                owner_scope: owner_scope.clone(),
                vpc_scope: vpc_scope.clone(),
            },
            NatCidrRecordReference::Unresolved { reason } => NatReferenceResult::Unresolved {
                reason: reason.clone(),
            },
        };
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(point.reference).unwrap()
        );
    }
    assert!(
        serde_json::to_vec(output).unwrap().len()
            <= NatCidrReferenceBudget::default().response_bytes
    );
}

#[test]
fn nat_cidr_retains_unknown_failed_metadata_duplicates_and_precedence() {
    for case in 0..10 {
        let mut saved = fixture();
        match case {
            0 => saved.topology.resources.reverse(),
            1..=5 => {
                let kind = [
                    ResourceKind::Vpc,
                    ResourceKind::Subnet,
                    ResourceKind::RouteTable,
                    ResourceKind::TransitGateway,
                    ResourceKind::NatGateway,
                ][case - 1]
                    .clone();
                saved
                    .topology
                    .resources
                    .push(AwsResource::new(kind, "nat-a".into()));
            }
            6 => saved.topology.complete_for_supported_queries = false,
            7 => {
                saved.registration.region = "unsupported".into();
                saved.topology.region = "unsupported".into();
            }
            8 => saved.topology.resources.retain(|r| r.id != "nat-a"),
            _ => {
                let a = saved
                    .topology
                    .resources
                    .iter_mut()
                    .find(|r| r.id == "nat-a")
                    .unwrap();
                a.nat_gateway = Some(crate::aws::observation::NatGatewayMetadata {
                    route_table_id: Some("literal-unverified-table".into()),
                    addresses: Some(vec![crate::aws::observation::NatGatewayAddress {
                        allocation_id: None,
                        association_id: None,
                        network_interface_id: None,
                        public_ip: Some("198.51.100.1".into()),
                        private_ip: None,
                        az_name: Some("unknown-zone".into()),
                        az_id: None,
                        is_primary: Some(false),
                        status: Some("failed".into()),
                    }]),
                });
            }
        }
        let before = serde_json::to_value(&saved).unwrap();
        let output = nat_cidr_reference::analyze(
            saved,
            query("192.0.2.0/29"),
            NatCidrReferenceBudget::default(),
        )
        .unwrap();
        assert_eq!(serde_json::to_value(&output.saved).unwrap(), before);
        assert_all_points(&output, "192.0.2.0/29");
    }
}

#[test]
fn nat_cidr_aggregate_reservations_refuse_before_the_child_and_allow_exact_limits() {
    use nat_cidr_reference::{CHILD_ANALYSES, RESERVED_CLONES, RESERVED_RESPONSE, RESERVED_WORK};
    let baseline = NatCidrReferenceBudget::default();
    nat_cidr_reference::analyze(fixture(), query("192.0.2.0/29"), baseline).unwrap();
    let work = RESERVED_WORK.with(|v| v.get());
    let clones = RESERVED_CLONES.with(|v| v.get());
    let response = RESERVED_RESPONSE.with(|v| v.get());
    // Independent ledger oracle: query is serialized directly, in framing, and in final output.
    let sample = nat_cidr_reference::NatCidrSegmentReference {
        vpc_segment_index: usize::MAX,
        reference: NatCidrRecordReference::ReportedRecord {
            resource_index: usize::MAX,
            owner_scope: crate::aws::nat_reference::NatReferenceScope::ReportedDifferent,
            vpc_scope: crate::aws::nat_reference::NatReferenceScope::ReportedDifferent,
        },
    };
    let row_bytes = serde_json::to_vec(&sample).unwrap().len();
    let evidence_bytes = serde_json::to_vec(&fixture()).unwrap().len();
    let query_bytes = serde_json::to_vec(&query("192.0.2.0/29")).unwrap().len();
    // Fixture census:1+5 resources+1 association+3 routes+3 targets+1 limitation;3 region parts.
    let expected_work = 64
        * ((14 + 3) * (baseline.vpc.segments + 2)
            + 3 * evidence_bytes
            + 2 * baseline.vpc.response_bytes
            + 3 * query_bytes
            + 2 * row_bytes * baseline.vpc.segments
            + baseline.vpc.raw_cuts
            + 8192)
        + baseline.vpc.row_visits;
    assert_eq!(work, expected_work);
    for dimension in 0..3 {
        for exact in [true, false] {
            let mut budget = baseline;
            let (limit, required) = match dimension {
                0 => (&mut budget.work_units, work),
                1 => (&mut budget.clone_payload_bytes, clones),
                _ => (&mut budget.response_bytes, response),
            };
            *limit = required - usize::from(!exact);
            CHILD_ANALYSES.with(|v| v.set(0));
            let result = nat_cidr_reference::analyze(fixture(), query("192.0.2.0/29"), budget);
            assert_eq!(result.is_ok(), exact, "dimension{dimension}: {result:?}");
            assert_eq!(CHILD_ANALYSES.with(|v| v.get()), usize::from(exact));
        }
    }
    for dimension in 0..4 {
        let mut budget = baseline;
        match dimension {
            0 => {
                budget.segments = usize::MAX;
                budget.vpc.segments = usize::MAX;
            }
            1 => budget.vpc.response_bytes = usize::MAX,
            2 => budget.string_bytes = usize::MAX,
            _ => budget.vpc.row_visits = usize::MAX,
        }
        CHILD_ANALYSES.with(|v| v.set(0));
        let error =
            nat_cidr_reference::analyze(fixture(), query("192.0.2.0/29"), budget).unwrap_err();
        let error = serde_json::to_value(error).unwrap();
        assert_eq!(
            error["cause"]["limit"],
            if dimension == 2 {
                budget.clone_payload_bytes
            } else {
                budget.work_units
            }
        );
        assert_eq!(CHILD_ANALYSES.with(|v| v.get()), 0);
    }
}

#[test]
fn nat_cidr_query_identity_and_whole_capture_admission_are_not_repaired() {
    use nat_cidr_reference::CHILD_ANALYSES;
    for case in 0..9 {
        let mut saved = fixture();
        let mut q = query("192.0.2.0/29");
        let mut b = NatCidrReferenceBudget::default();
        match case {
            0 => q.account_id = "registration\n".into(),
            1 => q.subnet_id.clear(),
            2 => q.destination_cidr = "192.0.2.1/29".into(),
            3 => q.destination_cidr = "2001:DB8::/125".into(),
            4 => saved.saved_row_id = "different".into(),
            5 => saved.topology.connectivity_tested = true,
            6 => b.resources = 4,
            7 => b.evidence_bytes = 1,
            _ => {
                saved.topology.resources[4]
                    .tags
                    .insert("ignored".into(), "x".repeat(b.string_bytes + 1));
            }
        }
        CHILD_ANALYSES.with(|v| v.set(0));
        assert!(nat_cidr_reference::analyze(saved, q, b).is_err());
        assert_eq!(CHILD_ANALYSES.with(|v| v.get()), 0);
    }
    let mut saved = fixture();
    saved.admitted_bytes = usize::MAX;
    assert!(
        nat_cidr_reference::analyze(
            saved,
            query("192.0.2.0/29"),
            NatCidrReferenceBudget::default()
        )
        .is_ok()
    );
}

#[test]
fn nat_cidr_charges_all_subnet_copy_fanout_and_complete_escaped_capture() {
    use nat_cidr_reference::{CHILD_ANALYSES, RESERVED_CLONES};
    let b = NatCidrReferenceBudget::default();
    let original = fixture();
    let original_bytes = serde_json::to_vec(&original).unwrap().len();
    nat_cidr_reference::analyze(original, query("192.0.2.0/29"), b).unwrap();
    let original_clones = RESERVED_CLONES.with(|v| v.get());
    let mut saved = fixture();
    saved.topology.resources[2].id = format!("rtb-{}", "x".repeat(b.string_bytes - 4));
    let extra_subnets = 32;
    for index in 0..extra_subnets {
        let mut subnet = saved.topology.resources[1].clone();
        subnet.id = format!("subnet-extra-{index}");
        saved.topology.resources.push(subnet);
    }
    saved.topology.resources[4]
        .tags
        .insert("escaped".into(), "同\n\"".repeat(40));
    let bytes = serde_json::to_vec(&saved).unwrap().len();
    let out = nat_cidr_reference::analyze(saved, query("192.0.2.0/29"), b).unwrap();
    let clones = RESERVED_CLONES.with(|v| v.get());
    assert_eq!(
        clones - original_clones,
        3 * extra_subnets * b.string_bytes + bytes - original_bytes
    );
    assert_all_points(&out, "192.0.2.0/29");
    for exact in [true, false] {
        let mut capture = fixture();
        capture.topology.limitations.push("同\n\"".repeat(40));
        let size = serde_json::to_vec(&capture).unwrap().len();
        CHILD_ANALYSES.with(|v| v.set(0));
        let result = nat_cidr_reference::analyze(
            capture,
            query("192.0.2.0/29"),
            NatCidrReferenceBudget {
                evidence_bytes: size - usize::from(!exact),
                ..b
            },
        );
        assert_eq!(result.is_ok(), exact);
        assert_eq!(CHILD_ANALYSES.with(|v| v.get()), usize::from(exact));
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]
    #[test]
    fn nat_cidr_all_ipv4_addresses_match_unchanged_points(base in any::<u32>()) {
        let base = base & !7;
        let mut saved = fixture();
        let table = saved.topology.resources.iter_mut().find(|r| r.id == "rtb-source").unwrap();
        table.routes[1].ipv4_destination = Some(format!("{}/32", std::net::Ipv4Addr::from(base + 1)));
        table.routes[2].ipv4_destination = Some(format!("{}/30", std::net::Ipv4Addr::from(base + 4)));
        let cidr = format!("{}/29", std::net::Ipv4Addr::from(base));
        let output = nat_cidr_reference::analyze(saved, query(&cidr), NatCidrReferenceBudget::default()).unwrap();
        assert_all_points(&output, &cidr);
    }
    #[test]
    fn nat_cidr_all_ipv6_addresses_match_unchanged_points(base in any::<u128>()) {
        let base = base & !7;
        let mut saved = fixture();
        let table = saved.topology.resources.iter_mut().find(|r| r.id == "rtb-source").unwrap();
        for (route, cidr) in table.routes.iter_mut().zip(["::/0".into(), format!("{}/128", std::net::Ipv6Addr::from(base + 1)), format!("{}/126", std::net::Ipv6Addr::from(base + 4))]) {
            route.ipv4_destination = None; route.ipv6_destination = Some(cidr);
        }
        let cidr = format!("{}/125", std::net::Ipv6Addr::from(base));
        let output = nat_cidr_reference::analyze(saved, query(&cidr), NatCidrReferenceBudget::default()).unwrap();
        assert_all_points(&output, &cidr);
    }
}
