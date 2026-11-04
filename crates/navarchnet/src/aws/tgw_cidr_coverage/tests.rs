use super::*;
use crate::aws::{
    observation::{TransitGatewayRoute, TransitGatewayRouteAttachment},
    route_lookup::TgwLookupReason,
};
use proptest::prelude::*;
fn route(cidr: &str, kind: &str, state: &str) -> TransitGatewayRoute {
    TransitGatewayRoute {
        destination_cidr: Some(cidr.into()),
        prefix_list_id: None,
        state: Some(state.into()),
        route_type: Some(kind.into()),
        route_table_announcement_id: Some("literal-announcement".into()),
        attachments: vec![attachment(Some("target-unobserved"))],
    }
}
fn attachment(id: Option<&str>) -> TransitGatewayRouteAttachment {
    TransitGatewayRouteAttachment {
        attachment_id: id.map(str::to_owned),
        resource_id: Some("literal-resource".into()),
        resource_type: Some("future-type".into()),
    }
}
fn fixture(routes: Vec<TransitGatewayRoute>) -> AwsTopology {
    let mut table = AwsResource::new(ResourceKind::TransitGatewayRouteTable, "table".into());
    table.state = Some("available".into());
    table.related_ids = vec!["parent".into(), "parent".into()];
    table.tgw_routes = Some(routes);
    let mut parent = AwsResource::new(ResourceKind::TransitGateway, "parent".into());
    parent.owner_account_id = Some("123456789012".into());
    parent.state = Some("deleting".into());
    AwsTopology {
        id: "snapshot".into(),
        account_id: "registration".into(),
        aws_account_id: "123456789012".into(),
        region: "eu-west-1".into(),
        started_at: "1".into(),
        completed_at: "2".into(),
        session_name: "offline".into(),
        resources: vec![table, parent],
        request_ids: vec![],
        complete_for_supported_queries: true,
        limitations: vec![],
        execution_enabled: false,
        connectivity_tested: false,
    }
}
fn assert_partition(topology: &AwsTopology, cidr: &str, exhaustive: bool) -> TgwCidrCoverage {
    let before = serde_json::to_value(topology).unwrap();
    let query: IpNet = cidr.parse().unwrap();
    let (lo, hi) = (ordinal(query.network()), ordinal(query.broadcast()));
    let output = analyze(topology, "table", cidr, TgwCoverageBudget::default()).unwrap();
    assert!(output.partition_complete && !output.segments.is_empty());
    let mut next = lo;
    for (index, cell) in output.segments.iter().enumerate() {
        let first: IpAddr = cell.start.parse().unwrap();
        let last: IpAddr = cell.end_inclusive.parse().unwrap();
        assert_eq!(first.is_ipv4(), query.addr().is_ipv4());
        assert_eq!(last.is_ipv4(), first.is_ipv4());
        let (a, b) = (ordinal(first), ordinal(last));
        assert_eq!(a, next);
        assert!(a <= b && b <= hi);
        assert_eq!(
            cell.result,
            route_lookup::lookup(topology, "table", &cell.start)
        );
        assert_eq!(
            cell.result,
            route_lookup::lookup(topology, "table", &cell.end_inclusive)
        );
        if output.table_evidence.len() == 1 {
            for net in output.table_evidence[0]
                .original_resource
                .tgw_routes
                .iter()
                .flatten()
                .filter_map(|row| row.destination_cidr.as_ref()?.parse::<IpNet>().ok())
            {
                if net.addr().is_ipv4() != first.is_ipv4() {
                    continue;
                }
                let (nlo, nhi) = (ordinal(net.network()), ordinal(net.broadcast()));
                // Independent containment, NOT just two endpoints: an inner prefix cannot hide.
                if a <= nhi && nlo <= b {
                    assert!(nlo <= a && b <= nhi);
                }
            }
        }
        if index + 1 < output.segments.len() {
            next = b.checked_add(1).unwrap();
        } else {
            assert_eq!(b, hi);
        }
    }
    if exhaustive {
        assert!(
            hi - lo <= 15,
            "Tiny TEST oracle only, never production enumeration"
        );
        for ip in lo..=hi {
            let cells: Vec<_> = output
                .segments
                .iter()
                .filter(|cell| {
                    ordinal(cell.start.parse().unwrap()) <= ip
                        && ip <= ordinal(cell.end_inclusive.parse().unwrap())
                })
                .collect();
            assert_eq!(cells.len(), 1);
            assert_eq!(
                cells[0].result,
                route_lookup::lookup(
                    topology,
                    "table",
                    &address(ip, query.addr().is_ipv4()).unwrap()
                )
            );
        }
    }
    for entry in output.table_evidence.iter().chain(&output.parent_evidence) {
        assert_eq!(
            serde_json::to_value(&entry.original_resource).unwrap(),
            serde_json::to_value(&topology.resources[entry.resource_index]).unwrap()
        );
    }
    assert_eq!(before, serde_json::to_value(topology).unwrap());
    output
}
#[test]
fn both_family_extrema_and_vpc_service_addresses_have_exact_tgw_semantics() {
    let topology = fixture(vec![
        route("0.0.0.0/0", "static", "active"),
        route("::/0", "static", "active"),
    ]);
    for cidr in [
        "0.0.0.0/0",
        "::/0",
        "0.0.0.0/32",
        "255.255.255.255/32",
        "::/128",
        "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128",
        "255.255.255.254/31",
        "ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe/127",
        "0.0.0.0/1",
        "8000::/1",
        "169.254.168.0/22",
        "fd00:ec2::/32",
    ] {
        let output = assert_partition(&topology, cidr, false);
        assert_eq!(output.segments.len(), 1);
        assert!(matches!(
            output.segments[0].result,
            TgwLookupResult::ReportedForward { .. }
        ));
    }
    for cidr in [
        "255.255.255.254/31",
        "ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe/127",
    ] {
        assert_partition(&topology, cidr, true);
    }
}
#[test]
fn historical_host_bits_and_route_spelling_are_not_repaired_or_rejected_by_vpc_policy() {
    for (literal, query) in [
        ("203.0.113.3/30", "203.0.113.0/29"),
        (
            "2001:0DB8:0000:0000:0000:0000:0000:0001/124",
            "2001:db8::/123",
        ),
    ] {
        let output = assert_partition(
            &fixture(vec![route(literal, "static", "blackhole")]),
            query,
            false,
        );
        assert!(output.segments.iter().any(|cell| matches!(&cell.result, TgwLookupResult::ReportedBlackhole { destination_cidr } if destination_cidr == literal)));
    }
    for invalid in [
        "",
        "203.0.113.3/30",
        "203.0.113.0",
        "203.0.113.0/030",
        " 203.0.113.0/24",
        "2001:0DB8::/32",
        "::/129",
        "fe80::%eth0/64",
    ] {
        assert_eq!(
            validate_query("table", invalid),
            Err(TgwCidrCoverageError::InvalidDestinationCidr)
        );
    }
    for id in ["", "bad\nID", "bad\u{85}"] {
        assert_eq!(
            validate_query(id, "::/0"),
            Err(TgwCidrCoverageError::InvalidTableInput)
        );
    }
    assert!(matches!(
        validate_query(&"x".repeat(2049), "::/0"),
        Err(TgwCidrCoverageError::InputTooLarge { .. })
    ));
    assert!(matches!(
        validate_query("table", &"x".repeat(65)),
        Err(TgwCidrCoverageError::InputTooLarge { .. })
    ));
    let mapped: IpNet = "::ffff:192.0.2.0/124".parse().unwrap();
    assert_partition(
        &fixture(vec![route("::/0", "static", "active")]),
        &mapped.to_string(),
        true,
    );
}
#[test]
fn scope_owner_parent_multiplicity_and_unqueried_precedence_match_actual_point() {
    for mode in [
        "missing",
        "duplicate-table",
        "other-kind",
        "incomplete",
        "direct-owner",
        "foreign",
        "duplicate-parent",
        "unready-parent",
        "unready-table",
        "unqueried",
        "empty",
        "unrelated-unqueried",
    ] {
        let mut topology = fixture(vec![route("0.0.0.0/0", "static", "active")]);
        let expected = match mode {
            "missing" => {
                topology.resources.remove(0);
                Some(TgwLookupReason::MissingOrAmbiguousTable)
            }
            "duplicate-table" => {
                topology.resources.push(topology.resources[0].clone());
                Some(TgwLookupReason::MissingOrAmbiguousTable)
            }
            "other-kind" => {
                topology
                    .resources
                    .push(AwsResource::new(ResourceKind::Subnet, "table".into()));
                None
            }
            "incomplete" => {
                topology.complete_for_supported_queries = false;
                Some(TgwLookupReason::IncompleteObservation)
            }
            "direct-owner" => {
                topology.resources.pop();
                topology.resources[0].owner_account_id = Some(topology.aws_account_id.clone());
                None
            }
            "foreign" => {
                topology.resources[0].owner_account_id = Some("different".into());
                Some(TgwLookupReason::UnverifiedOwner)
            }
            "duplicate-parent" => {
                topology.resources.push(topology.resources[1].clone());
                Some(TgwLookupReason::UnverifiedOwner)
            }
            "unready-parent" => {
                topology.resources[1].state = None;
                None
            }
            "unready-table" => {
                topology.resources[0].state = None;
                topology.resources[0].tgw_routes = None;
                Some(TgwLookupReason::TableNotReady)
            }
            "unqueried" => {
                topology.resources[0].tgw_routes = None;
                Some(TgwLookupReason::RoutesNotQueried)
            }
            "empty" => {
                topology.resources[0].tgw_routes = Some(vec![]);
                Some(TgwLookupReason::NoMatchingRoute)
            }
            "unrelated-unqueried" => {
                topology.resources.push(AwsResource::new(
                    ResourceKind::TransitGatewayRouteTable,
                    "unrelated".into(),
                ));
                None
            }
            _ => unreachable!(),
        };
        let output = assert_partition(&topology, "0.0.0.0/0", false);
        for cell in output.segments {
            if let Some(reason) = &expected {
                assert_eq!(
                    cell.result,
                    TgwLookupResult::Unresolved {
                        reason: reason.clone()
                    }
                );
            } else {
                assert!(matches!(
                    cell.result,
                    TgwLookupResult::ReportedForward { .. }
                ));
            }
        }
        if mode == "duplicate-table" {
            assert_eq!(output.table_evidence.len(), 2);
        }
        if mode == "duplicate-parent" {
            assert_eq!(output.parent_evidence.len(), 2);
        }
    }
}
#[test]
fn global_poison_unknown_type_before_static_and_no_blackhole_fallback_are_preserved() {
    for mode in [
        "static",
        "unknown",
        "shorter-unknown",
        "duplicate",
        "blackhole",
        "not-ready",
        "malformed",
        "opposite-malformed",
        "prefix-and-malformed",
    ] {
        let mut rows = vec![route("203.0.113.0/29", "propagated", "active")];
        let expected = match mode {
            "static" => {
                rows.push(route("203.0.113.0/29", "static", "active"));
                None
            }
            "unknown" => {
                rows.push(route("203.0.113.0/29", "future", "blackhole"));
                rows.push(route("203.0.113.0/29", "static", "active"));
                Some(TgwLookupReason::UnknownRouteType)
            }
            "shorter-unknown" => {
                rows.push(route("0.0.0.0/0", "future", "active"));
                None
            }
            "duplicate" => {
                rows.push(rows[0].clone());
                Some(TgwLookupReason::AmbiguousRoute)
            }
            "blackhole" => {
                rows[0].state = Some("blackhole".into());
                rows[0].attachments.clear();
                None
            }
            "not-ready" => {
                rows[0].state = None;
                rows.push(route("0.0.0.0/0", "static", "active"));
                Some(TgwLookupReason::RouteNotReady)
            }
            "malformed" => {
                rows.push(route("broken", "static", "active"));
                Some(TgwLookupReason::MalformedRoute)
            }
            "opposite-malformed" => {
                rows.push(route("::/129", "static", "active"));
                Some(TgwLookupReason::MalformedRoute)
            }
            "prefix-and-malformed" => {
                let mut bad = route("broken", "static", "active");
                bad.prefix_list_id = Some(String::new());
                rows.push(bad);
                Some(TgwLookupReason::PrefixListUnresolved)
            }
            _ => unreachable!(),
        };
        let mut topology = fixture(rows);
        let before = assert_partition(&topology, "203.0.113.0/29", true);
        if let Some(reason) = expected {
            assert_eq!(
                before.segments[0].result,
                TgwLookupResult::Unresolved { reason }
            );
        } else if mode == "blackhole" {
            assert!(matches!(
                before.segments[0].result,
                TgwLookupResult::ReportedBlackhole { .. }
            ));
        } else {
            assert!(matches!(
                before.segments[0].result,
                TgwLookupResult::ReportedForward { .. }
            ));
        }
        topology.resources[0].tgw_routes.as_mut().unwrap().reverse();
        topology.resources.reverse();
        assert_eq!(
            before.segments,
            assert_partition(&topology, "203.0.113.0/29", true).segments
        );
    }
}
#[test]
fn attachment_validation_preserves_original_mixed_error_order_and_sorted_literal_success() {
    for ids in [
        vec![],
        vec![None],
        vec![Some("")],
        vec![Some("bad\n")],
        vec![Some("a"), Some("a"), Some("bad\n")],
        vec![Some("bad\n"), Some("a"), Some("a")],
        vec![Some("z"), Some("同"), Some("a")],
    ] {
        let mut entry = route("0.0.0.0/0", "static", "active");
        entry.attachments = ids.iter().copied().map(attachment).collect();
        let output = assert_partition(&fixture(vec![entry]), "0.0.0.0/0", false);
        let expected = if ids.first() == Some(&Some("a")) {
            TgwLookupResult::Unresolved {
                reason: TgwLookupReason::AmbiguousRoute,
            }
        } else if ids.first() == Some(&Some("z")) {
            TgwLookupResult::ReportedForward {
                destination_cidr: "0.0.0.0/0".into(),
                route_type: "static".into(),
                attachment_ids: vec!["a".into(), "z".into(), "同".into()],
            }
        } else {
            TgwLookupResult::Unresolved {
                reason: TgwLookupReason::AttachmentNotReported,
            }
        };
        assert_eq!(output.segments[0].result, expected);
    }
    let mut entry = route("::/0", "static", "active");
    entry.attachments[0].attachment_id = Some("x".repeat(2049));
    assert_eq!(
        assert_partition(&fixture(vec![entry]), "::/0", false).segments[0].result,
        TgwLookupResult::Unresolved {
            reason: TgwLookupReason::AttachmentNotReported
        }
    );
}
#[test]
fn every_aggregate_budget_and_exact_work_output_cut_limits_reject_without_partial_success() {
    let mut topology = fixture(vec![route("0.0.0.0/0", "static", "active")]);
    topology.resources[0].tgw_associations = Some(vec![TransitGatewayTableLink {
        attachment_id: Some("a".into()),
        resource_id: None,
        resource_type: None,
        state: None,
        route_table_announcement_id: None,
    }]);
    for dimension in [
        "resources",
        "related_ids",
        "links",
        "route_rows",
        "attachments",
        "field_bytes",
        "raw_cuts",
        "segments",
        "work_units",
        "response_bytes",
    ] {
        let mut budget = TgwCoverageBudget::default();
        match dimension {
            "resources" => budget.resources = 0,
            "related_ids" => budget.related_ids = 0,
            "links" => budget.links = 0,
            "route_rows" => budget.route_rows = 0,
            "attachments" => budget.attachments = 0,
            "field_bytes" => budget.field_bytes = 0,
            "raw_cuts" => budget.raw_cuts = 0,
            "segments" => budget.segments = 0,
            "work_units" => budget.work_units = 0,
            "response_bytes" => budget.response_bytes = 0,
            _ => unreachable!(),
        }
        assert_eq!(
            analyze(&topology, "table", "203.0.113.0/29", budget).unwrap_err(),
            exceeded(dimension, 0)
        );
    }
    let work = preflight(&topology, TgwCoverageBudget::default()).unwrap();
    assert_eq!(work.preflight, 16 * (2 + 2 + 1 + 1 + 1));
    assert_eq!(work.evaluation, 28);
    let output = analyze(
        &topology,
        "table",
        "203.0.113.0/29",
        TgwCoverageBudget::default(),
    )
    .unwrap();
    let bytes = serde_json::to_vec(&output).unwrap().len();
    let exact = TgwCoverageBudget {
        resources: 2,
        related_ids: 2,
        links: 1,
        route_rows: 1,
        attachments: 1,
        raw_cuts: 2,
        segments: 1,
        work_units: work.preflight + work.evaluation,
        response_bytes: bytes,
        ..TgwCoverageBudget::default()
    };
    analyze(&topology, "table", "203.0.113.0/29", exact).unwrap();
    for budget in [
        TgwCoverageBudget {
            raw_cuts: 1,
            ..exact
        },
        TgwCoverageBudget {
            work_units: exact.work_units - 1,
            ..exact
        },
        TgwCoverageBudget {
            response_bytes: bytes - 1,
            ..exact
        },
    ] {
        assert!(matches!(
            analyze(&topology, "table", "203.0.113.0/29", budget),
            Err(TgwCidrCoverageError::BudgetExceeded { .. })
        ));
    }
    let mut unrelated = topology.resources[0].clone();
    unrelated.id = "unselected".into();
    unrelated
        .tgw_routes
        .as_mut()
        .unwrap()
        .resize(1025, route("::/0", "static", "active"));
    topology.resources.push(unrelated);
    assert!(
        matches!(analyze(&topology, "missing", "::/0", TgwCoverageBudget::default()), Err(TgwCidrCoverageError::BudgetExceeded { dimension, .. }) if dimension == "route_rows")
    );
    let mut oversized = fixture(vec![]);
    oversized.resources[0].tags.insert(
        "large".into(),
        "x".repeat(TgwCoverageBudget::default().response_bytes),
    );
    assert!(
        matches!(analyze(&oversized, "table", "::/0", TgwCoverageBudget::default()), Err(TgwCidrCoverageError::BudgetExceeded { dimension, .. }) if dimension == "response_bytes")
    );
    let mut count = usize::MAX;
    assert!(add(&mut count, 1, usize::MAX, "overflow").is_err());
}
proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn tiny_domains_exhaustively_match_point_and_independent_containment(seed in any::<u8>(), offset in 0u8..16, v6 in any::<bool>(), mode in 0u8..5) {
        let base = if v6 { ordinal("2001:db8::".parse().unwrap()) + (u128::from(seed) << 4) } else { ordinal("198.51.100.0".parse().unwrap()) + (u128::from(seed % 16) << 4) };
        let bits = if v6 { 128 } else { 32 }; let ip = |n| address(n, !v6).unwrap(); let cidr = format!("{}/{}", ip(base), bits - 4);
        let mut rows = vec![route(if v6 { "::/0" } else { "0.0.0.0/0" }, "propagated", "active"), route(&format!("{}/{}", ip(base + u128::from(offset & !1)), bits - 1), "static", "blackhole")];
        match mode { 1 => rows[0].prefix_list_id = Some("unexpanded".into()), 2 => rows.push(route("broken", "static", "active")), 3 => rows[1].route_type = None, 4 => rows.push(rows[1].clone()), _ => {} }
        let mut topology = fixture(rows); let first = assert_partition(&topology, &cidr, true);
        topology.resources[0].tgw_routes.as_mut().unwrap().reverse(); topology.resources.reverse();
        prop_assert_eq!(first.segments, assert_partition(&topology, &cidr, true).segments);
    }
}
