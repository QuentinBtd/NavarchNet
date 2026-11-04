use super::*;
use crate::aws::{
    observation::{ObservedRoute, RouteAssociation},
    routing::RouteSelectionReason,
    vpc_lookup::{VpcLookupReason, VpcLookupResult},
};
use proptest::prelude::*;

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
fn fixture(routes: Vec<ObservedRoute>) -> AwsTopology {
    let mut vpc = AwsResource::new(ResourceKind::Vpc, "vpc-a".into());
    vpc.owner_account_id = Some("123456789012".into());
    vpc.state = Some("available".into());
    let mut subnet = AwsResource::new(ResourceKind::Subnet, "subnet-a".into());
    subnet.owner_account_id = vpc.owner_account_id.clone();
    subnet.state = vpc.state.clone();
    subnet.vpc_id = Some(vpc.id.clone());
    let mut table = AwsResource::new(ResourceKind::RouteTable, "rtb-a".into());
    table.owner_account_id = vpc.owner_account_id.clone();
    table.vpc_id = Some(vpc.id.clone());
    table.routes = routes;
    // VPC point semantics deliberately do not require table.state == available.
    table.associations.push(RouteAssociation {
        id: Some("association".into()),
        main: true,
        subnet_id: None,
        gateway_id: None,
        state: Some("associated".into()),
    });
    AwsTopology {
        id: "saved-a".into(),
        account_id: "registration-a".into(),
        aws_account_id: "123456789012".into(),
        region: "eu-west-1".into(),
        started_at: "1".into(),
        completed_at: "2".into(),
        session_name: "offline".into(),
        resources: vec![vpc, subnet, table],
        request_ids: vec![],
        complete_for_supported_queries: true,
        limitations: vec!["Not a packet path".into()],
        execution_enabled: false,
        connectivity_tested: false,
    }
}
fn result(cell: &VpcDecisionInterval) -> &VpcLookupResult {
    match &cell.result {
        VpcSubnetLookupResult::Reported { lookup, .. } => lookup,
        other => panic!("Not selected: {other:?}"),
    }
}
fn partition(topology: &AwsTopology, cidr: &str, exhaustive: bool) -> VpcCidrCoverage {
    let before = serde_json::to_value(topology).unwrap();
    let query: IpNet = cidr.parse().unwrap();
    let output = analyze(topology, "subnet-a", cidr, CoverageBudget::default()).unwrap();
    assert!(output.partition_complete && !output.segments.is_empty());
    let (lo, hi) = (ordinal(query.network()), ordinal(query.broadcast()));
    let ipv4 = query.addr().is_ipv4();
    let mut expected = lo;
    for (index, cell) in output.segments.iter().enumerate() {
        let first: IpAddr = cell.start.parse().unwrap();
        let last: IpAddr = cell.end_inclusive.parse().unwrap();
        assert_eq!(first.is_ipv4(), ipv4);
        assert_eq!(last.is_ipv4(), ipv4);
        let (start, end) = (ordinal(first), ordinal(last));
        assert_eq!(start, expected);
        assert!(start <= end && end <= hi);
        for endpoint in [&cell.start, &cell.end_inclusive] {
            assert_eq!(
                cell.result,
                vpc_lookup::lookup(topology, "subnet-a", endpoint)
            );
        }
        // Independent interval containment oracle: no route/service membership may partly overlap a
        // selected cell, even if BOTH endpoints were outside a hidden smaller network.
        if output.table_evidence.is_some() {
            for network in topology
                .resources
                .iter()
                .filter(|row| row.kind == ResourceKind::RouteTable)
                .flat_map(|table| &table.routes)
                .filter_map(|row| vpc_lookup::destination_network(row).ok())
                .chain(vpc_lookup::reserved_service_networks())
            {
                if network.addr().is_ipv4() != ipv4 {
                    continue;
                }
                let (nlo, nhi) = (ordinal(network.network()), ordinal(network.broadcast()));
                if start <= nhi && nlo <= end {
                    assert!(nlo <= start && end <= nhi);
                }
            }
        }
        if index + 1 < output.segments.len() {
            expected = end.checked_add(1).unwrap();
        } else {
            assert_eq!(end, hi);
        }
    }
    if exhaustive {
        assert!(hi - lo <= 15, "Enumeration is a tiny TEST oracle only");
        for point in lo..=hi {
            let cells: Vec<_> = output
                .segments
                .iter()
                .filter(|cell| {
                    ordinal(cell.start.parse().unwrap()) <= point
                        && point <= ordinal(cell.end_inclusive.parse().unwrap())
                })
                .collect();
            assert_eq!(cells.len(), 1);
            assert_eq!(
                cells[0].result,
                vpc_lookup::lookup(topology, "subnet-a", &address(point, ipv4).unwrap())
            );
        }
    }
    assert_eq!(before, serde_json::to_value(topology).unwrap());
    output
}
#[test]
fn full_family_extrema_services_and_singletons_are_exact_without_max_plus_one() {
    let topology = fixture(vec![
        route("0.0.0.0/0", "gatewayId", "local"),
        route("::/0", "gatewayId", "local"),
    ]);
    for cidr in [
        "0.0.0.0/0",
        "::/0",
        "0.0.0.0/32",
        "255.255.255.255/32",
        "::/128",
        "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128",
        "0.0.0.0/1",
        "8000::/1",
        "255.255.255.254/31",
        "ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe/127",
    ] {
        let output = partition(
            &topology,
            cidr,
            cidr.ends_with("/128")
                || cidr.ends_with("/32")
                || cidr.ends_with("/31")
                || cidr.ends_with("/127"),
        );
        if cidr.ends_with("/0") {
            assert_eq!(output.segments.len(), 3);
            let reserved = vpc_lookup::reserved_service_networks()
                .into_iter()
                .find(|net| net.addr().is_ipv4() == cidr.contains('.'))
                .unwrap();
            assert_eq!(output.segments[1].start, reserved.network().to_string());
            assert_eq!(
                output.segments[1].end_inclusive,
                reserved.broadcast().to_string()
            );
            assert_eq!(
                result(&output.segments[1]),
                &VpcLookupResult::Unresolved {
                    reason: VpcLookupReason::ReservedServiceDestination
                }
            );
        }
    }
    for net in vpc_lookup::reserved_service_networks() {
        partition(&topology, &net.to_string(), false);
        for endpoint in [net.network(), net.broadcast()] {
            partition(
                &topology,
                &format!("{endpoint}/{}", if endpoint.is_ipv4() { 32 } else { 128 }),
                true,
            );
        }
        let ipv4 = net.addr().is_ipv4();
        for neighbor in [
            ordinal(net.network()).checked_sub(1).unwrap(),
            ordinal(net.broadcast()).checked_add(1).unwrap(),
        ] {
            let output = partition(
                &topology,
                &format!(
                    "{}/{}",
                    address(neighbor, ipv4).unwrap(),
                    if ipv4 { 32 } else { 128 }
                ),
                true,
            );
            assert!(matches!(
                result(&output.segments[0]),
                VpcLookupResult::ReportedRoute { .. }
            ));
        }
    }
}
#[test]
fn poison_precedence_keeps_reserved_cells_and_every_original_literal() {
    for mode in ["prefix", "malformed", "both", "opposite-malformed"] {
        let mut rows = vec![
            route("0.0.0.0/0", "gatewayId", "local"),
            route("::/0", "gatewayId", "local"),
        ];
        if mode != "prefix" {
            let mut bad = route("10.1.0.1/16", "gatewayId", "local");
            if mode == "opposite-malformed" {
                bad.ipv4_destination = None;
                bad.ipv6_destination = Some("2001:db8::1/32".into());
            }
            rows.push(bad);
        }
        if mode == "prefix" || mode == "both" {
            let mut prefix = route("198.51.100.0/24", "gatewayId", "local");
            prefix.prefix_list_destination = Some(String::new());
            rows.push(prefix);
        }
        let topology = fixture(rows);
        for cidr in ["0.0.0.0/0", "::/0"] {
            let output = partition(&topology, cidr, false);
            let expected = if mode == "prefix" || mode == "both" {
                VpcLookupReason::PrefixListUnresolved
            } else {
                VpcLookupReason::MalformedRoute
            };
            for cell in &output.segments {
                assert!(
                    matches!(result(cell), VpcLookupResult::Unresolved { reason } if *reason == expected || *reason == VpcLookupReason::ReservedServiceDestination)
                );
            }
            assert_eq!(
                serde_json::to_value(&output.table_evidence.unwrap().original_table).unwrap(),
                serde_json::to_value(&topology.resources[2]).unwrap()
            );
        }
    }
}
#[test]
fn destination_independent_scope_failures_preserve_actual_point_precedence_even_over_services() {
    for mode in [
        "missing",
        "incomplete",
        "duplicate-subnet",
        "duplicate-vpc",
        "duplicate-table",
        "foreign",
        "unready",
        "association",
        "wrong-vpc",
    ] {
        let mut topology = fixture(vec![route("0.0.0.0/0", "gatewayId", "local")]);
        match mode {
            "missing" => {
                topology.resources.remove(1);
            }
            "incomplete" => topology.complete_for_supported_queries = false,
            "duplicate-subnet" => topology.resources.push(topology.resources[1].clone()),
            "duplicate-vpc" => topology.resources.push(topology.resources[0].clone()),
            "duplicate-table" => topology.resources.push(topology.resources[2].clone()),
            "foreign" => topology.resources[0].owner_account_id = None,
            "unready" => topology.resources[1].state = None,
            "association" => topology.resources[2].associations[0].state = None,
            "wrong-vpc" => {
                topology.resources[2].associations[0].main = false;
                topology.resources[2].associations[0].subnet_id = Some("subnet-a".into());
                topology.resources[2].vpc_id = Some("different".into());
            }
            _ => unreachable!(),
        }
        let output = partition(&topology, "0.0.0.0/0", false);
        assert!(output.table_evidence.is_none());
        assert_eq!(output.segments.len(), 1);
        if mode == "incomplete" {
            assert_eq!(
                output.segments[0].result,
                VpcSubnetLookupResult::AssociationUnresolved {
                    reason: RouteSelectionReason::IncompleteObservation
                }
            );
        }
    }
}
#[test]
fn known_static_unknown_origin_duplicates_blackholes_and_order_keep_point_semantics() {
    for mode in [
        "static",
        "unknown",
        "lower-unknown",
        "duplicate",
        "blackhole",
        "not-ready",
        "empty",
        "opposite",
    ] {
        let mut rows = vec![route("203.0.113.0/29", "gatewayId", "local")];
        let mut other = route("203.0.113.0/29", "transitGatewayId", "tgw-other");
        other.origin = Some("EnableVgwRoutePropagation".into());
        match mode {
            "static" => rows.push(other),
            "unknown" => {
                other.origin = None;
                rows.push(other);
            }
            "lower-unknown" => {
                other.ipv4_destination = Some("0.0.0.0/0".into());
                other.origin = None;
                rows.push(other);
            }
            "duplicate" => rows.push(rows[0].clone()),
            "blackhole" => {
                rows[0].state = Some("blackhole".into());
                rows[0].targets.clear();
            }
            "not-ready" => rows[0].state = Some("future".into()),
            "empty" => rows.clear(),
            "opposite" => rows = vec![route("::/0", "gatewayId", "local")],
            _ => unreachable!(),
        }
        let mut topology = fixture(rows);
        let before = partition(&topology, "203.0.113.0/29", true);
        topology.resources[2].routes.reverse();
        topology.resources.reverse();
        let after = partition(&topology, "203.0.113.0/29", true);
        assert_eq!(before.segments, after.segments);
        let expected = match mode {
            "unknown" => Some(VpcLookupReason::UnknownOrigin),
            "duplicate" => Some(VpcLookupReason::AmbiguousRoute),
            "not-ready" => Some(VpcLookupReason::RouteNotReady),
            "empty" | "opposite" => Some(VpcLookupReason::NoMatchingRoute),
            _ => None,
        };
        if let Some(reason) = expected {
            assert_eq!(
                result(&before.segments[0]),
                &VpcLookupResult::Unresolved { reason }
            );
        } else if mode == "blackhole" {
            assert!(matches!(
                result(&before.segments[0]),
                VpcLookupResult::ReportedBlackhole { .. }
            ));
        } else {
            assert!(matches!(
                result(&before.segments[0]),
                VpcLookupResult::ReportedRoute { .. }
            ));
        }
    }
}
#[test]
fn new_query_canonical_policy_does_not_repair_inputs_or_rewrite_historical_route_literals() {
    let topology = fixture(vec![route(
        "2001:0DB8:0000:0000:0000:0000:0000:0000/32",
        "gatewayId",
        "local",
    )]);
    for invalid in [
        "",
        "192.0.2.1/24",
        "192.0.2.0",
        "192.0.2.0/024",
        " 192.0.2.0/24",
        "192.0.2.0/24 ",
        "2001:0DB8::/32",
        "2001:0db8::/32",
        "fe80::%eth0/64",
        "[::]/0",
        "::/129",
    ] {
        assert_eq!(
            analyze(&topology, "subnet-a", invalid, CoverageBudget::default()).unwrap_err(),
            VpcCidrCoverageError::InvalidDestinationCidr
        );
    }
    let output = partition(&topology, "2001:db8::/124", true);
    assert!(
        matches!(result(&output.segments[0]), VpcLookupResult::ReportedRoute { destination_cidr, .. } if destination_cidr == "2001:0DB8:0000:0000:0000:0000:0000:0000/32")
    );
    let mapped: IpNet = "::ffff:192.0.2.0/124".parse().unwrap();
    partition(&topology, &mapped.to_string(), true);
    for subnet in ["", "bad\nsubnet"] {
        assert_eq!(
            analyze(&topology, subnet, "::/0", CoverageBudget::default()).unwrap_err(),
            VpcCidrCoverageError::InvalidSubnetInput
        );
    }
    assert!(matches!(
        analyze(
            &topology,
            &"x".repeat(2049),
            "::/0",
            CoverageBudget::default()
        ),
        Err(VpcCidrCoverageError::InputTooLarge { .. })
    ));
    assert!(matches!(
        analyze(
            &topology,
            "subnet-a",
            &"x".repeat(65),
            CoverageBudget::default()
        ),
        Err(VpcCidrCoverageError::InputTooLarge { .. })
    ));
}
#[test]
fn every_local_budget_rejects_before_any_success_prefix_including_unselected_poison() {
    let topology = fixture(vec![route("203.0.113.0/29", "gatewayId", "local")]);
    for dimension in [
        "resources",
        "associations",
        "route_rows",
        "target_entries",
        "route_field_bytes",
        "raw_cuts",
        "segments",
        "row_visits",
        "response_bytes",
    ] {
        let mut budget = CoverageBudget::default();
        match dimension {
            "resources" => budget.resources = 0,
            "associations" => budget.associations = 0,
            "route_rows" => budget.route_rows = 0,
            "target_entries" => budget.target_entries = 0,
            "route_field_bytes" => budget.route_field_bytes = 0,
            "raw_cuts" => budget.raw_cuts = 0,
            "segments" => budget.segments = 0,
            "row_visits" => budget.row_visits = 0,
            "response_bytes" => budget.response_bytes = 0,
            _ => unreachable!(),
        }
        assert_eq!(
            analyze(&topology, "subnet-a", "203.0.113.0/29", budget).unwrap_err(),
            exceeded(dimension, 0)
        );
    }
    // This case exactly charges preflight 2R + initial 16R + boundary/clone 2R + interval 16R.
    let baseline = analyze(
        &topology,
        "subnet-a",
        "203.0.113.0/29",
        CoverageBudget::default(),
    )
    .unwrap();
    let bytes = serde_json::to_vec(&baseline).unwrap().len();
    let field_bytes = topology.resources[2].routes[0]
        .ipv4_destination
        .as_ref()
        .unwrap()
        .len()
        + "active".len()
        + "CreateRoute".len()
        + "gatewayId".len()
        + "local".len();
    let exact = CoverageBudget {
        resources: 3,
        associations: 1,
        route_rows: 1,
        target_entries: 1,
        route_field_bytes: field_bytes,
        raw_cuts: 2,
        segments: 1,
        row_visits: 36,
        response_bytes: bytes,
    };
    analyze(&topology, "subnet-a", "203.0.113.0/29", exact).unwrap();
    for budget in [
        CoverageBudget {
            raw_cuts: 1,
            ..exact
        },
        CoverageBudget {
            row_visits: 35,
            ..exact
        },
        CoverageBudget {
            response_bytes: bytes - 1,
            ..exact
        },
        CoverageBudget {
            route_field_bytes: field_bytes - 1,
            ..exact
        },
    ] {
        assert!(matches!(
            analyze(&topology, "subnet-a", "203.0.113.0/29", budget),
            Err(VpcCidrCoverageError::BudgetExceeded { .. })
        ));
    }
    let mut huge = topology.clone();
    let mut unrelated = topology.resources[2].clone();
    unrelated.id = "unselected".into();
    unrelated.associations.clear();
    unrelated.routes.resize(1025, unrelated.routes[0].clone());
    huge.resources.push(unrelated);
    assert!(
        matches!(analyze(&huge, "missing", "::/0", CoverageBudget::default()), Err(VpcCidrCoverageError::BudgetExceeded { dimension, .. }) if dimension == "route_rows")
    );
    let mut count = usize::MAX;
    assert!(add(&mut count, 1, usize::MAX, "overflow").is_err());
    assert!(check_serialized(&serde_json::json!({"metadata": "large"}), 1).is_err());
}
proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn small_ipv4_ipv6_domains_exhaustively_agree_with_point_and_membership_boundaries(seed in any::<u8>(), offset in 0u8..16, ipv6 in any::<bool>(), poison in 0u8..4) {
        let base = if ipv6 { ordinal("2001:db8::".parse().unwrap()) + (u128::from(seed) << 4) } else { ordinal("198.51.100.0".parse().unwrap()) + (u128::from(seed % 16) << 4) };
        let family_prefix = if ipv6 { 128 } else { 32 };
        let name = |value| address(value, !ipv6).unwrap();
        let cidr = format!("{}/{}", name(base), family_prefix - 4);
        let mut rows = vec![route(if ipv6 { "::/0" } else { "0.0.0.0/0" }, "gatewayId", "local")];
        let mut blackhole = route(&format!("{}/{}", name(base + u128::from(offset)), family_prefix), "gatewayId", "local"); blackhole.state = Some("blackhole".into()); rows.push(blackhole);
        rows.push(route(&format!("{}/{}", name(base + u128::from(offset & !1)), family_prefix - 1), "networkInterfaceId", "eni-unsupported"));
        let mut equal = rows[1].clone(); equal.origin = Some("EnableVgwRoutePropagation".into()); rows.push(equal);
        if poison == 1 { rows[0].prefix_list_destination = Some("unexpanded".into()); }
        if poison == 2 { rows[0].ipv4_destination = Some("broken".into()); rows[0].ipv6_destination = None; }
        if poison == 3 { rows[1].origin = Some("future".into()); }
        let mut topology = fixture(rows); let before = partition(&topology, &cidr, true);
        topology.resources[2].routes.reverse(); topology.resources.reverse(); let after = partition(&topology, &cidr, true);
        prop_assert_eq!(before.segments, after.segments);
    }
}
