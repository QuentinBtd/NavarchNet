use super::{
    VerifiedAccount,
    nat_cidr_reference::{
        self, NatCidrRecordReference, NatCidrReferenceBudget, NatCidrReferenceQuery,
    },
    nat_reference::{self, NatReferenceResult},
    observation::{AwsResource, AwsTopology, ObservedRoute, ResourceKind, RouteAssociation},
    saved_observation::SavedObservation,
    vpc_cidr_coverage,
};
mod qualification;

fn fixture() -> SavedObservation {
    let mut vpc = AwsResource::new(ResourceKind::Vpc, "vpc-source".into());
    vpc.owner_account_id = Some("123456789012".into());
    vpc.state = Some("available".into());
    let mut subnet = AwsResource::new(ResourceKind::Subnet, "subnet-source".into());
    subnet.vpc_id = Some(vpc.id.clone());
    subnet.owner_account_id = vpc.owner_account_id.clone();
    subnet.state = vpc.state.clone();
    let mut table = AwsResource::new(ResourceKind::RouteTable, "rtb-source".into());
    table.vpc_id = Some(vpc.id.clone());
    table.owner_account_id = vpc.owner_account_id.clone();
    table.associations.push(RouteAssociation {
        id: Some("association".into()),
        state: Some("associated".into()),
        main: true,
        subnet_id: None,
        gateway_id: None,
    });
    table.routes = [
        ("0.0.0.0/0", "nat-a", "active"),
        ("192.0.2.2/31", "nat-a", "blackhole"),
        ("192.0.2.4/30", "nat-b", "active"),
    ]
    .into_iter()
    .map(|(cidr, id, state)| ObservedRoute {
        ipv4_destination: Some(cidr.into()),
        ipv6_destination: None,
        prefix_list_destination: None,
        state: Some(state.into()),
        origin: Some("CreateRoute".into()),
        targets: [("natGatewayId".into(), id.into())].into(),
    })
    .collect();
    let mut a = AwsResource::new(ResourceKind::NatGateway, "nat-a".into());
    a.state = Some("failed".into());
    a.owner_account_id = Some("999999999999".into());
    a.vpc_id = Some("vpc-other".into());
    let b = AwsResource::new(ResourceKind::NatGateway, "nat-b".into());
    let topology = AwsTopology {
        id: "saved".into(),
        account_id: "registration".into(),
        aws_account_id: "123456789012".into(),
        region: "eu-west-1".into(),
        started_at: "1".into(),
        completed_at: "2".into(),
        session_name: "offline".into(),
        resources: vec![vpc, subnet, table, a, b],
        request_ids: vec![],
        limitations: vec!["Not a path".into()],
        complete_for_supported_queries: true,
        execution_enabled: false,
        connectivity_tested: false,
    };
    SavedObservation {
        registration: VerifiedAccount {
            id: topology.account_id.clone(),
            name: "Offline".into(),
            role_arn: "arn:aws:iam::123456789012:role/Reader".into(),
            aws_account_id: topology.aws_account_id.clone(),
            region: topology.region.clone(),
            verified_at: "0".into(),
            verified_session_name: "offline".into(),
            execution_enabled: false,
        },
        saved_row_id: topology.id.clone(),
        generation: 1,
        topology,
        admitted_bytes: 0,
    }
}
fn query(cidr: &str) -> NatCidrReferenceQuery {
    NatCidrReferenceQuery {
        account_id: "registration".into(),
        subnet_id: "subnet-source".into(),
        destination_cidr: cidr.into(),
    }
}
#[test]
fn nat_cidr_keeps_complete_child_and_original_record_indexes_without_inferring_health() {
    let saved = fixture();
    let original = serde_json::to_value(&saved).unwrap();
    let budget = NatCidrReferenceBudget::default();
    let child =
        vpc_cidr_coverage::analyze(&saved.topology, "subnet-source", "192.0.2.0/29", budget.vpc)
            .unwrap();
    let output = nat_cidr_reference::analyze(saved, query("192.0.2.0/29"), budget).unwrap();
    assert_eq!(serde_json::to_value(&output.saved).unwrap(), original);
    assert_eq!(
        serde_json::to_value(&output.vpc_coverage).unwrap(),
        serde_json::to_value(child).unwrap()
    );
    assert_eq!(output.references.len(), 3);
    assert!(output.reference_only && output.partition_complete);
    assert!(!output.execution_enabled && !output.connectivity_tested);
    qualification::assert_all_points(&output, "192.0.2.0/29");
    for (index, row) in output.references.iter().enumerate() {
        assert_eq!(row.vpc_segment_index, index);
        let cell = &output.vpc_coverage.segments[index];
        for address in [&cell.start, &cell.end_inclusive] {
            let point = nat_reference::lookup(&output.saved.topology, "subnet-source", address);
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
    }
}
