use super::{
    VerifiedAccount,
    observation::*,
    saved_observation::SavedObservation,
    source_handoff,
    source_target_cidr_reference::{SourceTargetCidrBudget, SourceTargetCidrQuery, analyze},
    target_lookup,
};
use proptest::prelude::*;
use serde_json::to_value;

fn saved(topology: AwsTopology) -> SavedObservation {
    SavedObservation {
        registration: VerifiedAccount {
            id: topology.account_id.clone(),
            name: "Reference fixture".into(),
            role_arn: format!("arn:aws:iam::{}:role/Reader", topology.aws_account_id),
            aws_account_id: topology.aws_account_id.clone(),
            region: topology.region.clone(),
            verified_at: "0".into(),
            verified_session_name: "fixture".into(),
            execution_enabled: false,
        },
        saved_row_id: topology.id.clone(),
        generation: 1,
        topology,
        admitted_bytes: 0,
    }
}
fn query() -> SourceTargetCidrQuery {
    SourceTargetCidrQuery {
        source_account_id: "source".into(),
        network_account_id: "network".into(),
        subnet_id: "subnet-source".into(),
        transit_gateway_id: "tgw-handoff".into(),
        target_attachment_id: "tgw-attach-egress".into(),
        destination_cidr: "8.8.8.0/30".into(),
    }
}
fn fixture() -> (AwsTopology, AwsTopology) {
    let (source, mut network) = source_handoff::tests::fixture();
    let mut alternative = network.resources[2].tgw_routes.as_ref().unwrap()[0].clone();
    alternative.destination_cidr = Some("8.8.8.1/32".into());
    alternative.attachments[0].attachment_id = Some("tgw-attach-other".into());
    network.resources[2]
        .tgw_routes
        .as_mut()
        .unwrap()
        .push(alternative);
    let row = |kind, id: &str| {
        let mut value = AwsResource::new(kind, id.into());
        value.owner_account_id = Some(network.aws_account_id.clone());
        value.state = Some("available".into());
        value
    };
    let mut vpc = row(ResourceKind::Vpc, "vpc-egress");
    vpc.cidrs.push("10.2.0.0/16".into());
    let mut attachment = row(ResourceKind::VpcAttachment, "tgw-attach-egress");
    attachment.vpc_id = Some(vpc.id.clone());
    attachment.related_ids = vec![
        "tgw-handoff".into(),
        "subnet-egress-a".into(),
        "subnet-egress-b".into(),
    ];
    let mut entries = vec![vpc, attachment];
    for (suffix, zone, cidr) in [
        ("a", "euw1-az1", "10.2.1.0/24"),
        ("b", "euw1-az2", "10.2.2.0/24"),
    ] {
        let mut subnet = row(ResourceKind::Subnet, &format!("subnet-egress-{suffix}"));
        subnet.vpc_id = Some("vpc-egress".into());
        subnet.az_id = Some(zone.into());
        subnet.cidrs.push(cidr.into());
        let mut table = row(ResourceKind::RouteTable, &format!("rtb-egress-{suffix}"));
        table.vpc_id = Some("vpc-egress".into());
        table.associations.push(RouteAssociation {
            id: Some(format!("assoc-{suffix}")),
            subnet_id: Some(subnet.id.clone()),
            gateway_id: None,
            main: false,
            state: Some("associated".into()),
        });
        let route = ObservedRoute {
            ipv4_destination: Some("0.0.0.0/0".into()),
            ipv6_destination: None,
            prefix_list_destination: None,
            origin: Some("CreateRoute".into()),
            state: Some("active".into()),
            targets: [("natGatewayId".into(), format!("nat-egress-{suffix}"))].into(),
        };
        table.routes.push(route.clone());
        if suffix == "b" {
            let mut blackhole = route;
            blackhole.ipv4_destination = Some("8.8.8.2/32".into());
            blackhole.state = Some("blackhole".into());
            table.routes.push(blackhole);
        }
        entries.extend([subnet, table]);
    }
    network.resources.extend(entries);
    (source, network)
}
#[test]
fn source_target_intersection_preserves_original_children_and_an_internal_second_az_blackhole() {
    let (source, network) = fixture();
    let original_source = to_value(&source).unwrap();
    let original_network = to_value(&network).unwrap();
    let result = analyze(
        saved(source.clone()),
        saved(network.clone()),
        query(),
        SourceTargetCidrBudget::default(),
    )
    .unwrap();
    assert!(result.reference_only && result.partition_complete);
    assert!(
        !result.execution_enabled && !result.connectivity_tested && !result.simultaneous_snapshots
    );
    assert_eq!(
        to_value(&result.source.source_saved.topology).unwrap(),
        original_source
    );
    assert_eq!(
        to_value(&result.source.network_saved.topology).unwrap(),
        original_network
    );
    assert_eq!(
        to_value(&result.target.network_saved.topology).unwrap(),
        original_network
    );
    assert_eq!(
        result
            .segments
            .iter()
            .map(|v| v.selected_reference_matches)
            .collect::<Vec<_>>(),
        vec![true, false, true, true]
    );
    for cell in &result.segments {
        let first: std::net::Ipv4Addr = cell.start.parse().unwrap();
        let last: std::net::Ipv4Addr = cell.end_inclusive.parse().unwrap();
        for address in u32::from(first)..=u32::from(last) {
            let ip = std::net::Ipv4Addr::from(address).to_string();
            assert_eq!(
                to_value(&result.source.segments[cell.source_segment_index].result).unwrap(),
                to_value(source_handoff::lookup(
                    &source,
                    &network,
                    "subnet-source",
                    &ip
                ))
                .unwrap()
            );
            assert_eq!(
                to_value(&result.target.segments[cell.target_segment_index].result).unwrap(),
                to_value(target_lookup::lookup(
                    &network,
                    "tgw-handoff",
                    "tgw-attach-egress",
                    &ip
                ))
                .unwrap()
            );
        }
    }
    assert_eq!(
        to_value(&result.target.az_selection).unwrap(),
        serde_json::json!("not_inferred")
    );
    assert!(result.target.segments.iter().any(|v| {
        to_value(&v.result)
            .unwrap()
            .to_string()
            .contains("blackhole")
    }));
}

fn run(
    b: SourceTargetCidrBudget,
) -> Result<
    super::source_target_cidr_reference::SourceTargetCidrReference,
    super::source_handoff_cidr_coverage::SourceHandoffCidrError,
> {
    let (s, n) = fixture();
    analyze(saved(s), saved(n), query(), b)
}
fn reset_calls() {
    super::source_target_cidr_reference::CHILD_ANALYSES.with(|n| n.set(0));
}
fn calls() -> usize {
    super::source_target_cidr_reference::CHILD_ANALYSES.with(|n| n.get())
}

#[test]
fn configured_aggregate_allowances_admit_exact_and_refuse_one_less_before_children() {
    use super::source_handoff_cidr_coverage::SourceHandoffCidrError;
    use super::source_target_cidr_reference::{DecisionReferenceInterval, ReferenceEnvelope};
    let q = query();
    let b = SourceTargetCidrBudget::default();
    let cells = b.source.segments + b.target.segments;
    let query_bytes = [
        &q.source_account_id,
        &q.network_account_id,
        &q.subnet_id,
        &q.transit_gateway_id,
        &q.target_attachment_id,
        &q.destination_cidr,
    ]
    .iter()
    .map(|s| s.len())
    .sum::<usize>();
    let work = 1024
        + b.source.work_units
        + b.target.work_units
        + 3 * 64 * (b.source.response_bytes + b.target.response_bytes)
        + 64 * b.network_copy_bytes
        + 128 * cells
        + 64 * query_bytes;
    let clones = b.source.clone_payload_bytes
        + b.target.clone_payload_bytes
        + b.network_copy_bytes
        + 2 * query_bytes
        + 78 * cells;
    let empty = ReferenceEnvelope {
        query: &q,
        source: (),
        target: (),
        segments: &[] as &[DecisionReferenceInterval],
        reference_only: true,
        partition_complete: true,
        execution_enabled: false,
        connectivity_tested: false,
        simultaneous_snapshots: false,
    };
    let maximum = DecisionReferenceInterval {
        start: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
        end_inclusive: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
        source_segment_index: usize::MAX,
        target_segment_index: usize::MAX,
        selected_reference_matches: false,
    };
    let response = serde_json::to_vec(&empty).unwrap().len()
        + b.source.response_bytes
        + b.target.response_bytes
        + (serde_json::to_vec(&maximum).unwrap().len() + 1) * cells;
    for (dimension, value) in [
        ("aggregate_work_units", work),
        ("aggregate_clone_payload_bytes", clones),
        ("aggregate_response_bytes", response),
        ("aggregate_segments", cells),
    ] {
        let mut exact = b;
        match dimension {
            "aggregate_work_units" => exact.work_units = value,
            "aggregate_clone_payload_bytes" => exact.clone_payload_bytes = value,
            "aggregate_response_bytes" => exact.response_bytes = value,
            _ => exact.segments = value,
        }
        reset_calls();
        assert!(run(exact).is_ok(), "exact {dimension}");
        assert_eq!(calls(), 2);
        let mut short = exact;
        match dimension {
            "aggregate_work_units" => short.work_units -= 1,
            "aggregate_clone_payload_bytes" => short.clone_payload_bytes -= 1,
            "aggregate_response_bytes" => short.response_bytes -= 1,
            _ => short.segments -= 1,
        }
        reset_calls();
        assert!(
            matches!(run(short),Err(SourceHandoffCidrError::BudgetExceeded { dimension: found, .. }) if found==dimension),
            "short {dimension}"
        );
        assert_eq!(calls(), 0);
    }
}
#[test]
fn aggregate_overflows_are_refused_without_either_child_analysis() {
    for field in ["segments", "work", "clones", "response"] {
        let mut b = SourceTargetCidrBudget::default();
        match field {
            "segments" => b.source.segments = usize::MAX,
            "work" => b.network_copy_bytes = usize::MAX,
            "clones" => b.source.clone_payload_bytes = usize::MAX,
            _ => b.source.response_bytes = usize::MAX,
        }
        reset_calls();
        assert!(matches!(
            run(b),
            Err(super::source_handoff_cidr_coverage::SourceHandoffCidrError::BudgetExceeded { .. })
        ));
        assert_eq!(calls(), 0);
    }
}
#[test]
fn escaped_network_capture_copy_has_an_exact_preadmission_byte_boundary() {
    let (s, n) = fixture();
    let mut capture = saved(n.clone());
    capture.registration.name = "literal \" \\ \n 同".into();
    let bytes = serde_json::to_vec(&capture).unwrap().len();
    let mut b = SourceTargetCidrBudget {
        network_copy_bytes: bytes,
        ..Default::default()
    };
    reset_calls();
    let output = analyze(saved(s.clone()), capture, query(), b).unwrap();
    assert_eq!(calls(), 2);
    assert_eq!(
        to_value(&output.source.network_saved).unwrap(),
        to_value(&output.target.network_saved).unwrap()
    );
    let mut capture = saved(n);
    capture.registration.name = "literal \" \\ \n 同".into();
    b.network_copy_bytes -= 1;
    reset_calls();
    assert!(matches!(
        analyze(saved(s), capture, query(), b),
        Err(
            super::source_handoff_cidr_coverage::SourceHandoffCidrError::BudgetExceeded {
                dimension: "network_copy_bytes",
                ..
            }
        )
    ));
    assert_eq!(calls(), 0);
}
#[test]
fn both_family_extrema_are_complete_without_enumeration_or_max_successor_overflow() {
    use super::cidr_partition::ordinal;
    for cidr in [
        "0.0.0.0/0",
        "255.255.255.255/32",
        "::/0",
        "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128",
        "2001:db8::/125",
    ] {
        let (s, n) = fixture();
        let mut q = query();
        q.destination_cidr = cidr.into();
        let net: ipnet::IpNet = cidr.parse().unwrap();
        let output = analyze(
            saved(s.clone()),
            saved(n.clone()),
            q,
            SourceTargetCidrBudget::default(),
        )
        .unwrap();
        let mut next = Some(ordinal(net.network()));
        for row in &output.segments {
            let a: std::net::IpAddr = row.start.parse().unwrap();
            let z: std::net::IpAddr = row.end_inclusive.parse().unwrap();
            assert_eq!(a.is_ipv4(), net.addr().is_ipv4());
            assert_eq!(z.is_ipv4(), a.is_ipv4());
            assert_eq!(Some(ordinal(a)), next);
            assert!(ordinal(a) <= ordinal(z) && ordinal(z) <= ordinal(net.broadcast()));
            for ip in [&row.start, &row.end_inclusive] {
                assert_eq!(
                    to_value(&output.source.segments[row.source_segment_index].result).unwrap(),
                    to_value(source_handoff::lookup(&s, &n, "subnet-source", ip)).unwrap()
                );
                assert_eq!(
                    to_value(&output.target.segments[row.target_segment_index].result).unwrap(),
                    to_value(target_lookup::lookup(
                        &n,
                        "tgw-handoff",
                        "tgw-attach-egress",
                        ip
                    ))
                    .unwrap()
                );
            }
            next = if ordinal(z) == ordinal(net.broadcast()) {
                None
            } else {
                ordinal(z).checked_add(1)
            };
        }
        assert_eq!(next, None);
    }
}
#[test]
fn selected_reference_equality_is_not_a_receiving_az_or_a_usable_path() {
    let (s, mut n) = fixture();
    n.resources[2].tgw_routes.as_mut().unwrap()[0]
        .attachments
        .push(TransitGatewayRouteAttachment {
            attachment_id: Some("tgw-attach-second".into()),
            resource_id: None,
            resource_type: Some("vpc".into()),
        });
    let output = analyze(
        saved(s.clone()),
        saved(n),
        query(),
        SourceTargetCidrBudget::default(),
    )
    .unwrap();
    assert!(
        output
            .segments
            .iter()
            .all(|v| !v.selected_reference_matches)
    );
    let (_, n) = fixture();
    let mut q = query();
    q.transit_gateway_id = "tgw-handoff ".into();
    let output = analyze(saved(s), saved(n), q, SourceTargetCidrBudget::default()).unwrap();
    assert!(
        output
            .segments
            .iter()
            .all(|v| !v.selected_reference_matches)
    );
    assert_eq!(output.query.transit_gateway_id, "tgw-handoff ");
    assert!(!output.execution_enabled && !output.connectivity_tested);
}
#[test]
fn invalid_queries_precede_admission_and_original_child_refusals_remain_atomic() {
    use super::source_handoff_cidr_coverage::SourceHandoffCidrError;
    for bad in ["8.8.8.1/30", "8.8.8.0/30\n", "not-a-cidr"] {
        let (s, n) = fixture();
        let mut q = query();
        q.destination_cidr = bad.into();
        let b = SourceTargetCidrBudget {
            work_units: 0,
            ..Default::default()
        };
        reset_calls();
        assert!(matches!(
            analyze(saved(s), saved(n), q, b),
            Err(SourceHandoffCidrError::InvalidQuery {
                field: "destination_cidr"
            })
        ));
        assert_eq!(calls(), 0);
    }
    let (s, n) = fixture();
    let mut capture = saved(s);
    capture.saved_row_id = "different".into();
    reset_calls();
    assert!(matches!(
        analyze(
            capture,
            saved(n),
            query(),
            SourceTargetCidrBudget::default()
        ),
        Err(SourceHandoffCidrError::IdentityUnavailable)
    ));
    assert_eq!(calls(), 1);
    let mut b = SourceTargetCidrBudget::default();
    b.target.resources = 0;
    reset_calls();
    assert!(matches!(
        run(b),
        Err(SourceHandoffCidrError::BudgetExceeded {
            dimension: "resources",
            limit: 0
        })
    ));
    assert_eq!(calls(), 2);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]
    #[test]
    fn tiny_joint_cells_match_both_unchanged_points(
        v6 in any::<bool>(), source_offset in 0u8..8, target_offset in 0u8..8,
    ) {
        let (mut s,mut n)=fixture();
        let mut q=query();
        if v6 {
            q.destination_cidr="2001:db8:ffff::/125".into();
            for (topology,part) in [(&mut s,1),(&mut n,2)] {
                for row in &mut topology.resources {
                    if row.kind==ResourceKind::Vpc { row.cidrs.push(format!("2001:db8:{part}::/48")); }
                    if row.kind==ResourceKind::Subnet {
                        let subnet=if row.id=="subnet-source" || row.id=="subnet-egress-a" {1} else {2};
                        row.cidrs.push(format!("2001:db8:{part}:{subnet}::/64"));
                    }
                    if row.kind==ResourceKind::RouteTable {
                        for route in &mut row.routes {
                            route.ipv4_destination=None;
                            route.ipv6_destination=Some(if route.state.as_deref()==Some("blackhole") {format!("2001:db8:ffff::{target_offset:x}/128")} else {"::/0".into()});
                        }
                    }
                }
            }
            n.resources[2].tgw_routes.as_mut().unwrap()[0].destination_cidr=Some("::/0".into());
            n.resources[2].tgw_routes.as_mut().unwrap()[1].destination_cidr=Some(format!("2001:db8:ffff::{source_offset:x}/128"));
        } else {
            q.destination_cidr="8.8.8.0/29".into();
            n.resources[2].tgw_routes.as_mut().unwrap()[1].destination_cidr=Some(format!("8.8.8.{source_offset}/32"));
            n.resources.iter_mut().find(|r| r.id=="rtb-egress-b").unwrap().routes[1].ipv4_destination=Some(format!("8.8.8.{target_offset}/32"));
        }
        let net:ipnet::IpNet=q.destination_cidr.parse().unwrap();
        let output=analyze(saved(s.clone()),saved(n.clone()),q,SourceTargetCidrBudget::default()).unwrap();
        let lo=super::cidr_partition::ordinal(net.network());let hi=super::cidr_partition::ordinal(net.broadcast());
        for numeric in lo..=hi {
            let ip=super::cidr_partition::address(numeric,!v6).unwrap();
            let cells:Vec<_>=output.segments.iter().filter(|c| {
                let a:std::net::IpAddr=c.start.parse().unwrap();let z:std::net::IpAddr=c.end_inclusive.parse().unwrap();
                super::cidr_partition::ordinal(a)<=numeric && numeric<=super::cidr_partition::ordinal(z)
            }).collect();
            prop_assert_eq!(cells.len(),1);
            let point=source_handoff::lookup(&s,&n,"subnet-source",&ip);
            let expected=matches!(&point.handoff,super::source_handoff::SourceHandoffResult::ReportedCandidate {transit_gateway_id,lookup:super::route_lookup::TgwLookupResult::ReportedForward {attachment_ids,..},..} if transit_gateway_id=="tgw-handoff" && attachment_ids.as_slice()==["tgw-attach-egress"]);
            prop_assert_eq!(cells[0].selected_reference_matches,expected);
            prop_assert_eq!(to_value(&output.source.segments[cells[0].source_segment_index].result).unwrap(),to_value(point).unwrap());
            prop_assert_eq!(to_value(&output.target.segments[cells[0].target_segment_index].result).unwrap(),to_value(target_lookup::lookup(&n,"tgw-handoff","tgw-attach-egress",&ip)).unwrap());
        }
    }
}
