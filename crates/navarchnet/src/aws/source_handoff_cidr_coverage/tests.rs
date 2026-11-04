use super::*;
mod provenance;
use crate::aws::{
    VerifiedAccount,
    observation::*,
    route_lookup::{TgwLookupReason, TgwLookupResult},
    source_handoff::{SourceHandoffResult, tests::fixture},
};
use proptest::prelude::*;
fn saved(topology: AwsTopology) -> SavedObservation {
    SavedObservation {
        registration: VerifiedAccount {
            id: topology.account_id.clone(),
            name: "literal \" \\ \n 同".into(),
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
fn query(cidr: &str) -> SourceHandoffCidrQuery {
    SourceHandoffCidrQuery {
        source_account_id: "source".into(),
        network_account_id: "network".into(),
        subnet_id: "subnet-source".into(),
        destination_cidr: cidr.into(),
    }
}
fn run(
    s: &AwsTopology,
    n: &AwsTopology,
    cidr: &str,
    b: SourceHandoffCidrBudget,
) -> Result<SourceHandoffCidrCoverage> {
    analyze(saved(s.clone()), saved(n.clone()), query(cidr), b)
}
fn networks(s: &AwsTopology, n: &AwsTopology) -> Vec<IpNet> {
    s.resources
        .iter()
        .filter(|r| r.kind == ResourceKind::RouteTable)
        .flat_map(|r| &r.routes)
        .filter_map(|r| vpc_lookup::destination_network(r).ok())
        .chain(vpc_lookup::reserved_service_networks())
        .chain(
            n.resources
                .iter()
                .filter(|r| r.kind == ResourceKind::TransitGatewayRouteTable)
                .flat_map(|r| r.tgw_routes.iter().flatten())
                .filter_map(|r| r.destination_cidr.as_ref()?.parse().ok()),
        )
        .collect()
}
fn uniform(
    s: &AwsTopology,
    n: &AwsTopology,
    cidr: &str,
    exhaustive: bool,
) -> SourceHandoffCidrCoverage {
    let net: IpNet = cidr.parse().unwrap();
    let (lo, hi) = (ordinal(net.network()), ordinal(net.broadcast()));
    POINT_CALLS.with(|c| c.set(0));
    let output = run(s, n, cidr, SourceHandoffCidrBudget::default()).unwrap();
    assert_eq!(POINT_CALLS.with(|c| c.get()), output.segments.len());
    assert!(
        output.partition_complete
            && output.reference_only
            && !output.execution_enabled
            && !output.connectivity_tested
            && !output.simultaneous_snapshots
    );
    assert_eq!(
        serde_json::to_value(&output.source_saved.topology).unwrap(),
        serde_json::to_value(s).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&output.network_saved.topology).unwrap(),
        serde_json::to_value(n).unwrap()
    );
    let mut next = lo;
    for cell in &output.segments {
        let first: IpAddr = cell.start.parse().unwrap();
        let last: IpAddr = cell.end_inclusive.parse().unwrap();
        assert_eq!(first.is_ipv4(), net.addr().is_ipv4());
        assert_eq!(first.is_ipv4(), last.is_ipv4());
        let (a, b) = (ordinal(first), ordinal(last));
        assert_eq!(a, next);
        assert!(a <= b && b <= hi);
        for ip in [&cell.start, &cell.end_inclusive] {
            assert_eq!(
                cell.result,
                source_handoff::lookup(s, n, "subnet-source", ip)
            );
        }
        // Independent complete containment, not just endpoint comparisons: catch hidden inner prefixes.
        for route in networks(s, n) {
            if route.addr().is_ipv4() == first.is_ipv4() {
                let (x, y) = (ordinal(route.network()), ordinal(route.broadcast()));
                if a <= y && x <= b {
                    assert!(
                        x <= a && b <= y,
                        "Partial route/service overlap inside one cell"
                    );
                }
            }
        }
        if b < hi {
            next = b.checked_add(1).unwrap();
        } else {
            next = hi;
        }
    }
    assert_eq!(
        output.segments.last().unwrap().end_inclusive,
        net.broadcast().to_string()
    );
    for origin in &output.origins {
        assert!(origin.cut_index < output.segments.len());
    }
    if exhaustive {
        assert!(hi - lo <= 15);
        for ip in lo..=hi {
            let cells: Vec<_> = output
                .segments
                .iter()
                .filter(|c| {
                    ordinal(c.start.parse().unwrap()) <= ip
                        && ip <= ordinal(c.end_inclusive.parse().unwrap())
                })
                .collect();
            assert_eq!(cells.len(), 1);
            assert_eq!(
                cells[0].result,
                source_handoff::lookup(
                    s,
                    n,
                    "subnet-source",
                    &address(ip, net.addr().is_ipv4()).unwrap()
                )
            );
        }
    }
    output
}
fn multi_gateway() -> (AwsTopology, AwsTopology) {
    let (mut s, mut n) = fixture();
    let mut second = s.resources[3].routes[0].clone();
    second.ipv4_destination = Some("203.0.113.4/30".into());
    second.targets = [("transitGatewayId".into(), "tgw-second".into())].into();
    s.resources[3].routes.push(second);
    let mut gateway = n.resources[0].clone();
    gateway.id = "tgw-second".into();
    let mut attachment = n.resources[1].clone();
    attachment.id = "tgw-attach-second".into();
    attachment.related_ids[0] = gateway.id.clone();
    let mut table = n.resources[2].clone();
    table.id = "tgw-rtb-second".into();
    table.related_ids = vec![gateway.id.clone()];
    table.tgw_associations.as_mut().unwrap()[0].attachment_id = Some(attachment.id.clone());
    let mut hidden = table.tgw_routes.as_ref().unwrap()[0].clone();
    hidden.destination_cidr = Some("203.0.113.5/32".into());
    hidden.state = Some("blackhole".into());
    hidden.attachments.clear();
    table.tgw_routes.as_mut().unwrap().push(hidden);
    n.resources.extend([gateway, attachment, table]);
    (s, n)
}
#[test]
fn alternate_gateways_and_nested_hidden_prefixes_are_not_pruned_by_first_witness() {
    let (mut s, mut n) = multi_gateway();
    let output = uniform(&s, &n, "203.0.113.0/29", true);
    assert_eq!(output.segments.len(), 4);
    assert!(
        matches!(&output.segments[0].result.handoff,SourceHandoffResult::ReportedCandidate {transit_gateway_id,..} if transit_gateway_id=="tgw-handoff")
    );
    assert!(
        matches!(&output.segments[2].result.handoff,SourceHandoffResult::ReportedCandidate {transit_gateway_id,lookup:TgwLookupResult::ReportedBlackhole {..},..} if transit_gateway_id=="tgw-second")
    );
    assert!(output.origins.iter().any(|o| matches!(
        o.predicate,
        CutPredicate::NetworkTgwRoute {
            resource_index: 5,
            route_index: 1
        }
    )));
    let before = serde_json::to_value(&output.segments).unwrap();
    s.resources.reverse();
    n.resources.reverse();
    assert_eq!(
        before,
        serde_json::to_value(uniform(&s, &n, "203.0.113.0/29", true).segments).unwrap()
    );
}
#[test]
fn family_extrema_service_precedence_and_historical_tgw_literals_are_preserved() {
    let (mut s, mut n) = fixture();
    for cidr in [
        "0.0.0.0/0",
        "0.0.0.0/32",
        "255.255.255.255/32",
        "255.255.255.254/31",
    ] {
        uniform(&s, &n, cidr, false);
    }
    n.resources[2].tgw_routes.as_mut().unwrap()[0].destination_cidr = Some("203.0.113.3/30".into());
    let out = uniform(&s, &n, "203.0.113.0/29", true);
    assert!(
        matches!(&out.segments[0].result.handoff,SourceHandoffResult::ReportedCandidate {lookup:TgwLookupResult::ReportedForward {destination_cidr,..},..} if destination_cidr=="203.0.113.3/30")
    );
    s.resources[3].routes[0].prefix_list_destination = Some("unexpanded".into());
    let out = uniform(&s, &n, "169.254.168.0/21", false);
    assert_eq!(
        serde_json::to_value(&out.segments[0].result.source).unwrap()["lookup"]["reason"],
        "reserved_service_destination"
    );
    assert_eq!(
        serde_json::to_value(&out.segments.last().unwrap().result.source).unwrap()["lookup"]["reason"],
        "prefix_list_unresolved"
    );
    s.resources[3].routes[0].prefix_list_destination = None;
    s.resources[3].routes[0].ipv4_destination = None;
    s.resources[3].routes[0].ipv6_destination = Some("::/0".into());
    n.resources[2].tgw_routes.as_mut().unwrap()[0].destination_cidr = Some("::/0".into());
    for cidr in [
        "::/0",
        "::/128",
        "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128",
        "ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe/127",
        "fd00:ec2::/32",
    ] {
        uniform(&s, &n, cidr, false);
    }
}
#[test]
fn fixed_scope_poison_and_original_mixed_attachment_error_order_survive_composition() {
    for mode in [
        "incomplete-source",
        "incomplete-network",
        "bad-source",
        "bad-tgw",
        "prefix-tgw",
        "unqueried",
        "association",
        "unknown-type",
        "attachment-subnet",
    ] {
        let (mut s, mut n) = fixture();
        match mode {
            "incomplete-source" => s.complete_for_supported_queries = false,
            "incomplete-network" => n.complete_for_supported_queries = false,
            "bad-source" => {
                s.resources[3].routes[0].ipv4_destination = Some("203.0.113.3/30".into())
            }
            "bad-tgw" => {
                n.resources[2].tgw_routes.as_mut().unwrap()[0].destination_cidr =
                    Some("::/129".into())
            }
            "prefix-tgw" => {
                n.resources[2].tgw_routes.as_mut().unwrap()[0].prefix_list_id = Some(String::new())
            }
            "unqueried" => n.resources[2].tgw_routes = None,
            "association" => n.resources[2].tgw_associations = None,
            "unknown-type" => {
                let mut row = n.resources[2].tgw_routes.as_ref().unwrap()[0].clone();
                row.route_type = Some("future".into());
                n.resources[2].tgw_routes.as_mut().unwrap().push(row);
            }
            "attachment-subnet" => s.resources[2].cidrs.push("broken".into()),
            _ => unreachable!(),
        }
        uniform(&s, &n, "203.0.113.0/29", true);
    }
    for (ids, reason) in [
        (
            vec![Some("a"), Some("a"), None],
            TgwLookupReason::AmbiguousRoute,
        ),
        (
            vec![None, Some("a"), Some("a")],
            TgwLookupReason::AttachmentNotReported,
        ),
    ] {
        let (s, mut n) = fixture();
        n.resources[2].tgw_routes.as_mut().unwrap()[0].attachments = ids
            .into_iter()
            .map(|id| TransitGatewayRouteAttachment {
                attachment_id: id.map(str::to_owned),
                resource_id: None,
                resource_type: None,
            })
            .collect();
        let out = uniform(&s, &n, "203.0.113.0/29", true);
        assert!(
            matches!(&out.segments[0].result.handoff,SourceHandoffResult::ReportedCandidate {lookup:TgwLookupResult::Unresolved {reason:actual},..} if actual==&reason)
        );
    }
}
#[test]
fn every_budget_dimension_refuses_and_work_or_clone_rejection_precedes_points() {
    let (mut s, n) = fixture();
    s.resources[0]
        .tags
        .insert("metadata".into(), "inert".into());
    for dimension in [
        "source_resources",
        "network_resources",
        "resources",
        "associations",
        "related_ids",
        "links",
        "routes",
        "targets",
        "attachments",
        "cidrs",
        "other_entries",
        "string_bytes",
        "region_bytes",
        "evidence_bytes",
        "raw_origins",
        "segments",
        "work_units",
        "clone_payload_bytes",
        "response_bytes",
    ] {
        let mut b = SourceHandoffCidrBudget::default();
        match dimension {
            "source_resources" => b.source_resources = 0,
            "network_resources" => b.network_resources = 0,
            "resources" => b.resources = 0,
            "associations" => b.associations = 0,
            "related_ids" => b.related_ids = 0,
            "links" => b.links = 0,
            "routes" => b.routes = 0,
            "targets" => b.targets = 0,
            "attachments" => b.attachments = 0,
            "cidrs" => b.cidrs = 0,
            "other_entries" => b.other_entries = 0,
            "string_bytes" => b.string_bytes = 0,
            "region_bytes" => b.region_bytes = 0,
            "evidence_bytes" => b.evidence_bytes = 0,
            "raw_origins" => b.raw_origins = 0,
            "segments" => b.segments = 0,
            "work_units" => b.work_units = 0,
            "clone_payload_bytes" => b.clone_payload_bytes = 0,
            "response_bytes" => b.response_bytes = 0,
            _ => unreachable!(),
        }
        POINT_CALLS.with(|c| c.set(0));
        assert_eq!(
            run(&s, &n, "203.0.113.0/29", b).unwrap_err(),
            exceeded(dimension, 0)
        );
        assert_eq!(POINT_CALLS.with(|c| c.get()), 0);
    }
    let (s, n) = fixture();
    let b = SourceHandoffCidrBudget {
        work_units: 3584,
        clone_payload_bytes: 2048 * (3 * 2 + 10 + 1) + 117,
        ..SourceHandoffCidrBudget::default()
    };
    run(&s, &n, "203.0.113.1/32", b).unwrap();
    for less in [
        SourceHandoffCidrBudget {
            work_units: b.work_units - 1,
            ..b
        },
        SourceHandoffCidrBudget {
            clone_payload_bytes: b.clone_payload_bytes - 1,
            ..b
        },
    ] {
        POINT_CALLS.with(|c| c.set(0));
        assert!(run(&s, &n, "203.0.113.1/32", less).is_err());
        assert_eq!(POINT_CALLS.with(|c| c.get()), 0);
    }
    assert!(checked(usize::MAX.checked_add(1), usize::MAX, "overflow").is_err());
    POINT_CALLS.with(|c| c.set(0));
    assert!(matches!(
        run(
            &s,
            &n,
            "203.0.113.1/32",
            SourceHandoffCidrBudget {
                string_bytes: usize::MAX,
                ..SourceHandoffCidrBudget::default()
            }
        ),
        Err(SourceHandoffCidrError::BudgetExceeded {
            dimension: "clone_payload_bytes",
            ..
        })
    ));
    assert_eq!(POINT_CALLS.with(|c| c.get()), 0);
}
#[test]
fn large_shared_table_id_fanout_and_irrelevant_input_cannot_hide_behind_evidence_bytes() {
    let (mut s, mut n) = fixture();
    s.resources[3].id = "t".repeat(2048);
    for i in 0..100 {
        let mut row = s.resources[1].clone();
        row.id = format!("subnet-extra-{i}");
        s.resources.push(row);
    }
    for i in 0..16 {
        let mut route = n.resources[2].tgw_routes.as_ref().unwrap()[0].clone();
        route.destination_cidr = Some(format!("203.0.113.{i}/32"));
        n.resources[2].tgw_routes.as_mut().unwrap().push(route);
    }
    assert!(
        encoded_len(
            &(&saved(s.clone()), &saved(n.clone())),
            SourceHandoffCidrBudget::default().evidence_bytes,
            "evidence_bytes"
        )
        .is_ok()
    );
    POINT_CALLS.with(|c| c.set(0));
    assert!(matches!(
        run(&s, &n, "203.0.113.0/28", SourceHandoffCidrBudget::default()),
        Err(SourceHandoffCidrError::BudgetExceeded {
            dimension: "clone_payload_bytes",
            ..
        })
    ));
    assert_eq!(POINT_CALLS.with(|c| c.get()), 0);
    s.resources[0]
        .tags
        .insert("irrelevant".into(), "x".repeat(2049));
    assert!(matches!(
        run(&s, &n, "203.0.113.0/28", SourceHandoffCidrBudget::default()),
        Err(SourceHandoffCidrError::BudgetExceeded {
            dimension: "string_bytes",
            ..
        })
    ));
}
#[test]
fn exact_whole_response_bytes_include_escapes_duplicate_origins_and_once_per_side_evidence() {
    let (s, n) = multi_gateway();
    let output = run(&s, &n, "203.0.113.0/29", SourceHandoffCidrBudget::default()).unwrap();
    let bytes = serde_json::to_vec(&output).unwrap().len();
    assert_eq!(
        encoded_len(&output, bytes, "response_bytes").unwrap(),
        bytes
    );
    let exact = SourceHandoffCidrBudget {
        response_bytes: bytes,
        ..SourceHandoffCidrBudget::default()
    };
    run(&s, &n, "203.0.113.0/29", exact).unwrap();
    assert!(matches!(
        run(
            &s,
            &n,
            "203.0.113.0/29",
            SourceHandoffCidrBudget {
                response_bytes: bytes - 1,
                ..exact
            }
        ),
        Err(SourceHandoffCidrError::BudgetExceeded {
            dimension: "response_bytes",
            ..
        })
    ));
    assert!(output.origins.iter().filter(|o| o.cut_index == 0).count() >= 3);
    let json = serde_json::to_value(output).unwrap();
    assert!(
        json["segments"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c.get("source_saved").is_none() && c.get("network_saved").is_none())
    );
    struct Bad;
    impl Serialize for Bad {
        fn serialize<S: serde::Serializer>(&self, _: S) -> std::result::Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("fixture serialization error"))
        }
    }
    assert_eq!(
        encoded_len(&Bad, 100, "response_bytes"),
        Err(SourceHandoffCidrError::PartitionProofUnavailable)
    );
}
#[test]
fn pure_caller_identity_and_canonical_query_admission_do_not_authenticate_a_constructed_value() {
    let (s, n) = fixture();
    for cidr in [
        "",
        "203.0.113.1/29",
        "203.0.113.0/029",
        " 203.0.113.0/29",
        "2001:DB8::/32",
    ] {
        assert!(matches!(
            run(&s, &n, cidr, SourceHandoffCidrBudget::default()),
            Err(SourceHandoffCidrError::InvalidQuery { .. })
        ));
    }
    for mode in [
        "registration",
        "topology-account",
        "row",
        "generation",
        "aws-account",
        "region",
        "registration-flag",
        "topology-flag",
        "connectivity",
    ] {
        let mut a = saved(s.clone());
        let other = saved(n.clone());
        match mode {
            "registration" => a.registration.id = "wrong".into(),
            "topology-account" => a.topology.account_id = "wrong".into(),
            "row" => a.saved_row_id = "wrong".into(),
            "generation" => a.generation = 0,
            "aws-account" => a.topology.aws_account_id = "999999999999".into(),
            "region" => a.registration.region = "us-east-1".into(),
            "registration-flag" => a.registration.execution_enabled = true,
            "topology-flag" => a.topology.execution_enabled = true,
            "connectivity" => a.topology.connectivity_tested = true,
            _ => unreachable!(),
        }
        assert!(matches!(
            analyze(
                a,
                other,
                query("203.0.113.0/29"),
                SourceHandoffCidrBudget::default()
            ),
            Err(SourceHandoffCidrError::IdentityUnavailable)
        ));
    }
    // Reader text counts are not sealed database-origin proof and cannot bypass the typed E cap.
    let mut forged = saved(s.clone());
    forged.admitted_bytes = 0;
    assert!(matches!(
        analyze(
            forged,
            saved(n),
            query("203.0.113.0/29"),
            SourceHandoffCidrBudget {
                evidence_bytes: 1,
                ..SourceHandoffCidrBudget::default()
            }
        ),
        Err(SourceHandoffCidrError::BudgetExceeded {
            dimension: "evidence_bytes",
            ..
        })
    ));
}
proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn tiny_domains_exhaustively_match_complete_point_decisions(v6 in any::<bool>(), offset in 0u8..16, mode in 0u8..4) {
        let (mut s,mut n)=fixture();
        let (cidr,inner)=if v6 {("2001:db8::/124",format!("2001:db8::{offset:x}/128"))} else {("203.0.113.0/28",format!("203.0.113.{offset}/32"))};
        s.resources[3].routes[0].ipv4_destination=(!v6).then(||"0.0.0.0/0".into()); s.resources[3].routes[0].ipv6_destination=v6.then(||"::/0".into());
        n.resources[2].tgw_routes.as_mut().unwrap()[0].destination_cidr=Some(if v6 {"::/0"} else {"0.0.0.0/0"}.into());
        let mut hidden=n.resources[2].tgw_routes.as_ref().unwrap()[0].clone(); hidden.destination_cidr=Some(inner); hidden.state=Some("blackhole".into());
        match mode {1=>hidden.route_type=None,2=>hidden.prefix_list_id=Some("future".into()),3=>hidden.destination_cidr=Some("bad".into()),_=>{}}
        n.resources[2].tgw_routes.as_mut().unwrap().push(hidden); uniform(&s,&n,cidr,true);
    }
}
