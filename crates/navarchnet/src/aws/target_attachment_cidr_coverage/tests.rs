use super::*;
use crate::aws::{VerifiedAccount, observation::*, target_lookup::tests::fixture};
use proptest::prelude::*;
fn saved(t: AwsTopology) -> SavedObservation {
    SavedObservation {
        registration: VerifiedAccount {
            id: t.account_id.clone(),
            name: "fixture".into(),
            role_arn: "arn:fixture".into(),
            aws_account_id: t.aws_account_id.clone(),
            region: t.region.clone(),
            verified_at: "1".into(),
            verified_session_name: "fixture".into(),
            execution_enabled: false,
        },
        saved_row_id: t.id.clone(),
        generation: 1,
        topology: t,
        admitted_bytes: 0,
    }
}
fn query(cidr: &str) -> TargetAttachmentCidrQuery {
    TargetAttachmentCidrQuery {
        network_account_id: "registered".into(),
        transit_gateway_id: "tgw-target".into(),
        target_attachment_id: "tgw-attach-target".into(),
        destination_cidr: cidr.into(),
    }
}
fn run(
    t: &AwsTopology,
    cidr: &str,
    b: TargetAttachmentCidrBudget,
) -> Result<TargetAttachmentCidrCoverage> {
    analyze(saved(t.clone()), query(cidr), b)
}
fn zero_rejection(
    t: &AwsTopology,
    q: TargetAttachmentCidrQuery,
    b: TargetAttachmentCidrBudget,
) -> TargetAttachmentCidrError {
    target_lookup::POINT_ENTRIES.with(|c| c.set(0));
    let err = analyze(saved(t.clone()), q, b).unwrap_err();
    target_lookup::POINT_ENTRIES.with(|c| assert_eq!(c.get(), 0, "prepoint refusal"));
    err
}
#[test]
fn actual_point_entries_are_zero_on_every_prepoint_reservation_refusal() {
    let t = fixture();
    let b = TargetAttachmentCidrBudget::default();
    for b in [
        TargetAttachmentCidrBudget { work_units: 0, ..b },
        TargetAttachmentCidrBudget {
            clone_payload_bytes: 0,
            ..b
        },
        TargetAttachmentCidrBudget {
            response_bytes: 0,
            ..b
        },
        TargetAttachmentCidrBudget {
            raw_origins: 0,
            ..b
        },
        TargetAttachmentCidrBudget { segments: 0, ..b },
    ] {
        assert!(matches!(
            zero_rejection(&t, query("203.0.113.0/29"), b),
            TargetAttachmentCidrError::BudgetExceeded { .. }
        ));
    }
    target_lookup::POINT_ENTRIES.with(|c| c.set(0));
    let out = run(&t, "203.0.113.0/29", b).unwrap();
    target_lookup::POINT_ENTRIES.with(|c| assert_eq!(c.get(), out.segments.len()));
}
#[test]
fn output_bound_uses_actual_variant_framing_not_a_cell_size_heuristic() {
    let b = TargetAttachmentCidrBudget::default();
    let framing = point_framing(2, b.response_bytes).unwrap();
    let t = fixture();
    let out = run(&t, "203.0.113.0/29", b).unwrap();
    for c in &out.segments {
        let point = serde_json::to_vec(&c.result).unwrap().len();
        assert!(point <= framing + 6 * b.string_bytes * (1 + 6 * 2));
    }
}

fn route(cidr: &str, blackhole: bool) -> ObservedRoute {
    ObservedRoute {
        ipv4_destination: (!cidr.contains(':')).then(|| cidr.into()),
        ipv6_destination: cidr.contains(':').then(|| cidr.into()),
        prefix_list_destination: None,
        state: Some(if blackhole { "blackhole" } else { "active" }.into()),
        origin: Some("CreateRoute".into()),
        targets: if blackhole {
            Default::default()
        } else {
            [("gatewayId".into(), "local".into())].into()
        },
    }
}
fn second_table(t: &mut AwsTopology) {
    let mut second = t.resources[4].clone();
    second.id = "rtb-second".into();
    second.associations[0].main = false;
    second.associations[0].subnet_id = Some("subnet-target-b".into());
    t.resources.push(second);
}
// Independent full containment/provenance oracle: no endpoint-only predicate comparison.
fn oracle(t: &AwsTopology, cidr: &str, out: &TargetAttachmentCidrCoverage, tiny: bool) {
    let net = cidr.parse::<IpNet>().unwrap();
    let low = ordinal(net.network());
    let high = ordinal(net.broadcast());
    let mut predicates = Vec::new();
    for (ri, r) in t.resources.iter().enumerate() {
        if r.kind != ResourceKind::RouteTable {
            continue;
        }
        for (ni, row) in r.routes.iter().enumerate() {
            let value = match (&row.ipv4_destination, &row.ipv6_destination) {
                (Some(v), None) => v.parse::<IpNet>().ok().filter(|n| n.addr().is_ipv4()),
                (None, Some(v)) => v.parse::<IpNet>().ok().filter(|n| n.addr().is_ipv6()),
                _ => None,
            };
            if let Some(n) = value.filter(|n| n.addr() == n.network()) {
                predicates.push((
                    n,
                    CutPredicate::NetworkVpcRoute {
                        resource_index: ri,
                        route_index: ni,
                    },
                ));
            }
        }
    }
    for (policy_index, cidr) in ["169.254.168.0/22", "fd00:ec2::/32"].iter().enumerate() {
        predicates.push((
            cidr.parse().unwrap(),
            CutPredicate::VpcService { policy_index },
        ));
    }
    let mut expected = vec![(low, CutPredicate::Query, CutEdge::QueryStart, false)];
    for (p, predicate) in &predicates {
        if p.addr().is_ipv4() != net.addr().is_ipv4() {
            continue;
        }
        let first = ordinal(p.network());
        let last = ordinal(p.broadcast());
        if first <= high && last >= low {
            expected.push((first.max(low), *predicate, CutEdge::Enter, first < low));
            if last < high {
                expected.push((last + 1, *predicate, CutEdge::Leave, false));
            }
        }
    }
    expected.sort_by_key(|v| v.0); // Stable: preserves ALL coincident origins, including duplicates.
    let actual: Vec<_> = out
        .origins
        .iter()
        .map(|o| {
            (
                ordinal(out.segments[o.cut_index].start.parse().unwrap()),
                o.predicate,
                o.edge,
                o.clipped,
            )
        })
        .collect();
    assert_eq!(actual, expected);
    let mut next = low;
    for c in &out.segments {
        let a = ordinal(c.start.parse().unwrap());
        let z = ordinal(c.end_inclusive.parse().unwrap());
        assert_eq!(a, next);
        assert!(a <= z && z <= high);
        for (p, _) in &predicates {
            if p.addr().is_ipv4() != net.addr().is_ipv4() {
                continue;
            }
            let l = ordinal(p.network());
            let h = ordinal(p.broadcast());
            assert!(
                z < l || a > h || (a >= l && z <= h),
                "interior membership cut absent: {p}, {c:?}"
            );
        }
        assert_eq!(
            c.result,
            target_lookup::lookup(t, "tgw-target", "tgw-attach-target", &c.start)
        );
        if tiny {
            for n in a..=z {
                assert_eq!(
                    c.result,
                    target_lookup::lookup(
                        t,
                        "tgw-target",
                        "tgw-attach-target",
                        &address(n, net.addr().is_ipv4()).unwrap()
                    )
                );
            }
        }
        if z < high {
            next = z + 1;
        } else {
            next = z;
        }
    }
    assert_eq!(
        out.segments.last().unwrap().end_inclusive,
        net.broadcast().to_string()
    );
    assert_eq!(
        serde_json::to_vec(&out.network_saved.topology).unwrap(),
        serde_json::to_vec(t).unwrap()
    );
}
#[test]
fn both_families_zero_singletons_max_services_poison_and_all_coincident_origins() {
    let mut t = fixture();
    second_table(&mut t);
    for cidr in [
        "0.0.0.0/0",
        "::/0",
        "0.0.0.0/32",
        "255.255.255.255/32",
        "::/128",
        "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128",
        "203.0.113.0/29",
        "2001:db8::/125",
    ] {
        t.resources[4].routes = vec![
            route("0.0.0.0/0", false),
            route("::/0", false),
            route("203.0.113.3/32", true),
            route("2001:db8::3/128", true),
            route("203.0.113.3/32", true),
        ];
        t.resources[6].routes = t.resources[4].routes.clone();
        let out = run(&t, cidr, TargetAttachmentCidrBudget::default()).unwrap();
        oracle(&t, cidr, &out, !cidr.ends_with("/0"));
    }
    // Service precedence is distinct even with an otherwise poisoned table.
    for cidr in ["169.254.168.0/21", "fd00:ec2::/31"] {
        t.resources[4].routes.push(route("hostbits/invalid", false));
        t.resources[6].routes.push(route("hostbits/invalid", false));
        let out = run(&t, cidr, TargetAttachmentCidrBudget::default()).unwrap();
        oracle(&t, cidr, &out, false);
        let reasons: Vec<_> = out
            .segments
            .iter()
            .map(|c| {
                serde_json::to_value(&c.result).unwrap()["subnets"][0]["lookup"]["lookup"]["reason"]
                    .clone()
            })
            .collect();
        assert!(reasons.contains(&serde_json::json!("reserved_service_destination")));
        assert!(reasons.contains(&serde_json::json!("malformed_route")));
    }
}
proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]
    #[test]
    fn tiny_both_family_all_address_oracles_find_hidden_second_az_cells(v6 in any::<bool>(), entries in prop::collection::vec((0u8..8,0u8..4,any::<bool>()),0..8)) {
        let mut t=fixture();second_table(&mut t);
        t.resources[4].routes=vec![route(if v6 {"::/0"} else {"0.0.0.0/0"},false)];
        t.resources[6].routes=t.resources[4].routes.clone();
        for (n,bits,blackhole) in entries {
            let start=(n>>bits)<<bits;
            let cidr=if v6 {format!("2001:db8::{start:x}/{}",128-bits)} else {format!("203.0.113.{start}/{}",32-bits)};
            t.resources[6].routes.push(route(&cidr,blackhole));
        }
        let cidr=if v6 {"2001:db8::/125"} else {"203.0.113.0/29"};
        let out=run(&t,cidr,TargetAttachmentCidrBudget::default()).unwrap();oracle(&t,cidr,&out,true);
    }
}
#[test]
fn historical_literals_poison_unknown_explicit_main_duplicates_and_wrong_vpc_keep_point_precedence()
{
    for mode in 0..15 {
        let mut t = fixture();
        second_table(&mut t);
        match mode {
            0 => t.resources[6].routes = vec![route("2001:0DB8:0000::/32", false)],
            1 => t.resources[6].routes = vec![route("203.0.113.1/29", false)],
            2 => t.resources[6].routes.clear(),
            3 => t.resources[6].routes[0].origin = None,
            4 => t.resources[6].routes[0].state = None,
            5 => t.resources[6].routes[0].prefix_list_destination = Some("pl-unknown".into()),
            6 => t.resources[6].associations[0].state = None,
            7 => t.resources[6].vpc_id = Some("vpc-wrong".into()),
            8 => t.resources.push(t.resources[6].clone()),
            9 => t.resources[6].associations.clear(),
            10 => {
                let a = t.resources[4].associations[0].clone();
                t.resources[4].associations.push(a);
            }
            11 => t.resources[1]
                .related_ids
                .push("subnet-final-invalid".into()),
            12 => t.resources[5].az_id = t.resources[3].az_id.clone(),
            13 => t.complete_for_supported_queries = false,
            _ => t.region = "global".into(),
        }
        let cidr = if mode == 0 {
            "2001:db8::/125"
        } else {
            "203.0.113.0/29"
        };
        let mut cap = saved(t.clone());
        cap.registration.region = t.region.clone();
        let out = analyze(cap, query(cidr), TargetAttachmentCidrBudget::default()).unwrap();
        oracle(&t, cidr, &out, true);
        if [11, 12].contains(&mode) {
            assert_eq!(
                serde_json::to_value(&out.segments[0].result).unwrap()["reason"],
                "attachment_subnet_unresolved"
            );
        }
        if mode == 0 {
            assert_eq!(
                serde_json::to_value(&out.segments[0].result).unwrap()["subnets"][1]["lookup"]["lookup"]
                    ["destination_cidr"],
                "2001:0DB8:0000::/32"
            );
        }
    }
}
fn admission(t: &AwsTopology, b: TargetAttachmentCidrBudget) -> Census {
    let mut c = Census {
        work_limit: b.work_units,
        ..Census::default()
    };
    saved_cidr_admission::admit_capture(&mut c, t, false, b.into()).unwrap();
    c
}
#[test]
fn exact_and_one_below_work_clone_origin_interval_and_full_escaped_envelope_limits() {
    let mut t = fixture();
    second_table(&mut t);
    t.resources[6].routes.push(route("203.0.113.3/32", true));
    t.resources[4].id = "rtb-\"é\n".into();
    t.resources[0]
        .tags
        .insert("escaped\n".into(), "é\"\\\t".into());
    let b = TargetAttachmentCidrBudget::default();
    let c = admission(&t, b);
    let cap = saved(t.clone());
    let q = query("203.0.113.0/29");
    let net = validate_query(&q).unwrap();
    let (cuts, origins) = collect_origins(&cap, net, b).unwrap();
    let r = reserve(&c, &cap, cuts.len(), origins.len(), b).unwrap();
    let pre = serde_json::to_vec(&envelope(
        &q,
        &cap,
        &origins[..],
        &[] as &[TargetAttachmentDecisionInterval],
    ))
    .unwrap()
    .len();
    let required = pre + r.cells;
    for (name, exact) in [
        ("work_units", r.work),
        ("clone_payload_bytes", r.clones),
        ("raw_origins", origins.len()),
        ("segments", cuts.len()),
        ("response_bytes", required),
        ("evidence_bytes", serde_json::to_vec(&cap).unwrap().len()),
    ] {
        let set = |n| {
            let mut b = b;
            match name {
                "work_units" => b.work_units = n,
                "clone_payload_bytes" => b.clone_payload_bytes = n,
                "raw_origins" => b.raw_origins = n,
                "segments" => b.segments = n,
                "response_bytes" => b.response_bytes = n,
                "evidence_bytes" => b.evidence_bytes = n,
                _ => unreachable!(),
            }
            b
        };
        let out = run(&t, "203.0.113.0/29", set(exact)).unwrap();
        let bytes = serde_json::to_vec(&out).unwrap();
        assert_eq!(
            encoded_len(&out, usize::MAX, "response_bytes").unwrap(),
            bytes.len()
        );
        assert!(bytes.len() <= required);
        assert!(
            matches!(zero_rejection(&t,q.clone(),set(exact-1)),TargetAttachmentCidrError::BudgetExceeded {dimension,..} if dimension==name),
            "{name}"
        );
    }
    for b in [
        TargetAttachmentCidrBudget {
            string_bytes: usize::MAX,
            ..b
        },
        TargetAttachmentCidrBudget {
            work_units: usize::MAX,
            clone_payload_bytes: usize::MAX,
            string_bytes: usize::MAX,
            ..b
        },
    ] {
        assert!(matches!(
            zero_rejection(&t, q.clone(), b),
            TargetAttachmentCidrError::BudgetExceeded { .. }
        ));
    }
}
#[test]
fn all_collection_and_leaf_identity_query_limits_recount_not_admitted_bytes() {
    let mut t = fixture();
    let b = TargetAttachmentCidrBudget::default();
    t.resources[0].tgw_routes = Some(vec![TransitGatewayRoute {
        destination_cidr: None,
        prefix_list_id: None,
        state: None,
        route_type: None,
        route_table_announcement_id: None,
        attachments: vec![TransitGatewayRouteAttachment {
            attachment_id: None,
            resource_id: None,
            resource_type: None,
        }],
    }]);
    t.resources[0].tgw_associations = Some(vec![TransitGatewayTableLink {
        attachment_id: None,
        resource_id: None,
        resource_type: None,
        state: None,
        route_table_announcement_id: None,
    }]);
    t.resources[0]
        .tags
        .insert("metadata".into(), "value".into());
    let c = admission(&t, b);
    for (name, n) in [
        ("resources", c.r),
        ("associations", c.a),
        ("related_ids", c.l),
        ("links", c.k),
        ("routes", c.n),
        ("targets", c.t),
        ("attachments", c.h),
        ("cidrs", c.c),
        ("other_entries", c.m),
    ] {
        let set = |n| {
            let mut b = b;
            match name {
                "resources" => b.resources = n,
                "associations" => b.associations = n,
                "related_ids" => b.related_ids = n,
                "links" => b.links = n,
                "routes" => b.routes = n,
                "targets" => b.targets = n,
                "attachments" => b.attachments = n,
                "cidrs" => b.cidrs = n,
                "other_entries" => b.other_entries = n,
                _ => unreachable!(),
            }
            b
        };
        run(&t, "203.0.113.0/29", set(n)).unwrap();
        assert!(
            matches!(zero_rejection(&t,query("203.0.113.0/29"),set(n-1)),TargetAttachmentCidrError::BudgetExceeded {dimension,..} if dimension==name)
        );
    }
    for mode in 0..9 {
        let mut s = saved(t.clone());
        match mode {
            0 => s.registration.id = "different".into(),
            1 => s.topology.account_id = "different".into(),
            2 => s.saved_row_id = "different".into(),
            3 => s.generation = 0,
            4 => s.registration.region = "different".into(),
            5 => s.registration.aws_account_id = "different".into(),
            6 => s.registration.execution_enabled = true,
            7 => s.topology.execution_enabled = true,
            _ => s.topology.connectivity_tested = true,
        }
        target_lookup::POINT_ENTRIES.with(|c| c.set(0));
        assert_eq!(
            analyze(s, query("203.0.113.0/29"), b).unwrap_err(),
            TargetAttachmentCidrError::IdentityUnavailable
        );
        target_lookup::POINT_ENTRIES.with(|c| assert_eq!(c.get(), 0));
    }
    for cidr in [
        "203.0.113.1/29",
        "2001:0DB8::/125",
        "203.0.113.1",
        "::ffff:192.0.2.1/120",
        "",
    ] {
        assert!(matches!(
            zero_rejection(&t, query(cidr), b),
            TargetAttachmentCidrError::InvalidQuery {
                field: "destination_cidr"
            }
        ));
    }
    for field in 0..3 {
        for value in ["", "bad\n", &"x".repeat(2049)] {
            let mut q = query("203.0.113.0/29");
            match field {
                0 => q.network_account_id = value.into(),
                1 => q.transit_gateway_id = value.into(),
                _ => q.target_attachment_id = value.into(),
            };
            assert!(matches!(
                zero_rejection(&t, q, b),
                TargetAttachmentCidrError::InvalidQuery { .. }
            ));
        }
    }
    let mut q = query("203.0.113.0/29");
    q.transit_gateway_id = " tgw-target ".into();
    let out = analyze(saved(t.clone()), q, b).unwrap();
    assert_eq!(
        serde_json::to_value(&out.segments[0].result).unwrap()["reason"],
        "missing_or_ambiguous_gateway"
    );
    let mut s = saved(t.clone());
    s.admitted_bytes = usize::MAX;
    analyze(s, query("203.0.113.0/29"), b).unwrap();
    t.resources[0].id = "x".repeat(b.string_bytes + 1);
    assert!(matches!(
        zero_rejection(&t, query("203.0.113.0/29"), b),
        TargetAttachmentCidrError::BudgetExceeded {
            dimension: "string_bytes",
            ..
        }
    ));
    let mut t = fixture();
    t.region = "-".repeat(b.region_bytes + 1);
    let mut s = saved(t.clone());
    s.registration.region = t.region.clone();
    target_lookup::POINT_ENTRIES.with(|c| c.set(0));
    assert!(matches!(
        analyze(s, query("203.0.113.0/29"), b),
        Err(TargetAttachmentCidrError::BudgetExceeded {
            dimension: "region_bytes",
            ..
        })
    ));
    target_lookup::POINT_ENTRIES.with(|c| assert_eq!(c.get(), 0));
}
#[test]
fn all_subnet_rows_and_declared_references_bound_clones_and_32_versus_33_preserve_parent_reason() {
    for count in [32, 33] {
        let mut t = fixture();
        t.resources.retain(|r| r.kind != ResourceKind::Subnet);
        t.resources[1].related_ids = vec!["tgw-target".into()];
        for n in 1..=count {
            let mut row = AwsResource::new(ResourceKind::Subnet, format!("subnet-{n:02}"));
            row.vpc_id = Some("vpc-target".into());
            row.owner_account_id = Some(t.aws_account_id.clone());
            row.state = Some("available".into());
            row.az_id = Some(format!("euw1-az{n}"));
            row.cidrs = vec![format!("10.20.{n}.0/24")];
            t.resources[1].related_ids.push(row.id.clone());
            t.resources.push(row);
        }
        let out = run(&t, "203.0.113.0/29", TargetAttachmentCidrBudget::default()).unwrap();
        if count == 32 {
            assert!(
                matches!(&out.segments[0].result,TargetVpcLookup::ReportedSubnets {subnets,..} if subnets.len()==32)
            );
        } else {
            assert_eq!(
                serde_json::to_value(&out.segments[0].result).unwrap()["reason"],
                "target_subnet_budget_exceeded"
            );
        }
        let b = TargetAttachmentCidrBudget::default();
        let c = admission(&t, b);
        let s = saved(t.clone());
        let r = reserve(&c, &s, 1, 1, b).unwrap();
        assert_eq!(r.clones, (1 + 32 * (3 * count + 5)) * b.string_bytes + 78);
        for n in 0..70 {
            let mut row = t.resources.last().unwrap().clone();
            row.id = format!("subnet-unrelated-{n}");
            t.resources.push(row);
        }
        assert!(matches!(
            zero_rejection(&t, query("203.0.113.0/29"), b),
            TargetAttachmentCidrError::BudgetExceeded {
                dimension: "clone_payload_bytes",
                ..
            }
        ));
    }
}

#[test]
fn exact_leaf_utf8_and_actual_region_split_work_limits() {
    let mut t = fixture();
    t.resources[0].tags.insert("payload".into(), "é".repeat(32));
    let b = TargetAttachmentCidrBudget {
        string_bytes: 64,
        region_bytes: 9,
        ..Default::default()
    };
    run(&t, "203.0.113.0/29", b).unwrap();
    assert!(matches!(
        zero_rejection(
            &t,
            query("203.0.113.0/29"),
            TargetAttachmentCidrBudget {
                string_bytes: 63,
                ..b
            }
        ),
        TargetAttachmentCidrError::BudgetExceeded {
            dimension: "string_bytes",
            ..
        }
    ));
    assert!(matches!(
        zero_rejection(
            &t,
            query("203.0.113.0/29"),
            TargetAttachmentCidrBudget {
                region_bytes: 8,
                ..b
            }
        ),
        TargetAttachmentCidrError::BudgetExceeded {
            dimension: "region_bytes",
            ..
        }
    ));
    let c = admission(&t, b);
    let s = saved(t.clone());
    let r = reserve(&c, &s, 1, 1, b).unwrap();
    // Fixture D=2,U=2; actual region split G=3. No untraced R*L product.
    assert_eq!(
        r.work,
        64 * c.base().unwrap() + 64 * 3 * (c.base().unwrap() + 3) + 128
    );
    t.region = "--------".into();
    let c = admission(&t, b);
    let s = saved(t.clone());
    let r = reserve(&c, &s, 1, 1, b).unwrap();
    assert_eq!(
        r.work,
        64 * c.base().unwrap() + 64 * 3 * (c.base().unwrap() + 9) + 128
    );
    let out = run(&t, "203.0.113.0/29", b).unwrap();
    assert_eq!(
        serde_json::to_value(&out.segments[0].result).unwrap()["reason"],
        "unsupported_region"
    );
    let mut input = serde_json::to_value(query("203.0.113.0/29")).unwrap();
    input["unknown"] = serde_json::json!(false);
    assert!(serde_json::from_value::<TargetAttachmentCidrQuery>(input).is_err());
}
