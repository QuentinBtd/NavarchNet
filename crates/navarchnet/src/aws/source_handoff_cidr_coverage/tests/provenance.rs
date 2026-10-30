use super::*;

#[test]
fn every_raw_origin_resolves_to_the_exact_side_row_route_policy_and_clipped_edge() {
    let (mut s, mut n) = multi_gateway();
    // Same table identifier on opposite sides must not conflate original indices or route parsers.
    n.resources[2].id = s.resources[3].id.clone();
    s.resources[3].routes[0].ipv4_destination = Some("203.0.113.0/28".into());
    let output = uniform(&s, &n, "203.0.113.0/29", true);
    let net: IpNet = "203.0.113.0/29".parse().unwrap();
    let (lo, hi) = (ordinal(net.network()), ordinal(net.broadcast()));
    let mut expected = vec![(lo, CutPredicate::Query, CutEdge::QueryStart, false)];
    let mut push = |value: IpNet, predicate: CutPredicate| {
        if value.addr().is_ipv4() != net.addr().is_ipv4() {
            return;
        }
        let (nlo, nhi) = (ordinal(value.network()), ordinal(value.broadcast()));
        let (start, end) = (nlo.max(lo), nhi.min(hi));
        if start <= end {
            expected.push((start, predicate, CutEdge::Enter, start != nlo));
            if end < hi {
                expected.push((
                    end.checked_add(1).unwrap(),
                    predicate,
                    CutEdge::Leave,
                    false,
                ));
            }
        }
    };
    for (resource_index, row) in s
        .resources
        .iter()
        .enumerate()
        .filter(|(_, r)| r.kind == ResourceKind::RouteTable)
    {
        for (route_index, row) in row.routes.iter().enumerate() {
            if let Ok(value) = vpc_lookup::destination_network(row) {
                push(
                    value,
                    CutPredicate::SourceVpcRoute {
                        resource_index,
                        route_index,
                    },
                );
            }
        }
    }
    for (policy_index, value) in vpc_lookup::reserved_service_networks()
        .into_iter()
        .enumerate()
    {
        push(value, CutPredicate::VpcService { policy_index });
    }
    for (resource_index, row) in n
        .resources
        .iter()
        .enumerate()
        .filter(|(_, r)| r.kind == ResourceKind::TransitGatewayRouteTable)
    {
        for (route_index, row) in row.tgw_routes.iter().flatten().enumerate() {
            if let Some(value) = row
                .destination_cidr
                .as_ref()
                .and_then(|s| s.parse::<IpNet>().ok())
            {
                push(
                    value,
                    CutPredicate::NetworkTgwRoute {
                        resource_index,
                        route_index,
                    },
                );
            }
        }
    }
    assert_eq!(output.origins.len(), expected.len());
    // Quadratic multiset matching ONLY in this bounded test oracle, never the production collector.
    for origin in &output.origins {
        let at = ordinal(output.segments[origin.cut_index].start.parse().unwrap());
        let record = (at, origin.predicate, origin.edge, origin.clipped);
        let found = expected
            .iter()
            .position(|value| *value == record)
            .expect("No matching original predicate/edge");
        expected.remove(found);
    }
    assert!(expected.is_empty());
    assert!(output.origins.iter().any(|o| o.clipped && o.cut_index == 0));
}
#[test]
fn region_split_and_individual_utf8_admission_are_charged_before_any_point() {
    let (mut s, mut n) = fixture();
    s.region = "-".repeat(32);
    n.region = s.region.clone();
    POINT_CALLS.with(|c| c.set(0));
    assert!(matches!(
        run(
            &s,
            &n,
            "203.0.113.1/32",
            SourceHandoffCidrBudget {
                work_units: 3584,
                ..SourceHandoffCidrBudget::default()
            }
        ),
        Err(SourceHandoffCidrError::BudgetExceeded {
            dimension: "work_units",
            ..
        })
    ));
    assert_eq!(POINT_CALLS.with(|c| c.get()), 0);
    s.region = "-".repeat(65);
    n.region = s.region.clone();
    assert!(matches!(
        run(&s, &n, "203.0.113.1/32", SourceHandoffCidrBudget::default()),
        Err(SourceHandoffCidrError::BudgetExceeded {
            dimension: "region_bytes",
            ..
        })
    ));
    let (mut s, n) = fixture();
    s.request_ids.push("x".repeat(2048));
    run(&s, &n, "203.0.113.1/32", SourceHandoffCidrBudget::default()).unwrap();
    s.request_ids[0].push('同');
    assert!(matches!(
        run(&s, &n, "203.0.113.1/32", SourceHandoffCidrBudget::default()),
        Err(SourceHandoffCidrError::BudgetExceeded {
            dimension: "string_bytes",
            ..
        })
    ));
}
