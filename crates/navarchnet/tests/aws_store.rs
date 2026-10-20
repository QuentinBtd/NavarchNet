mod support;
use navarchnet::{
    aws::{observation::*, *},
    store::Store,
};
fn role() -> RoleRegistration {
    RoleRegistration {
        name: "Fixture network account".into(),
        role_arn: "arn:aws:iam::123456789012:role/team/Reader".into(),
        region: "eu-west-1".into(),
        external_id: Some("fixture-external-private".into()),
    }
}
fn topology(account: &VerifiedAccount) -> AwsTopology {
    let mut vpc = AwsResource::new(ResourceKind::Vpc, "vpc-01111111111111111".into());
    vpc.owner_account_id = Some(account.aws_account_id.clone());
    vpc.cidrs = vec!["10.1.0.0/16".into()];
    vpc.tags.insert("navarchnet:managed".into(), "true".into());
    AwsTopology {
        id: uuid::Uuid::new_v4().to_string(),
        account_id: account.id.clone(),
        aws_account_id: account.aws_account_id.clone(),
        region: account.region.clone(),
        started_at: "1".into(),
        completed_at: "2".into(),
        session_name: "navarchnet-fixture".into(),
        resources: vec![vpc],
        request_ids: vec!["fixture".into()],
        complete_for_supported_queries: true,
        limitations: vec!["TGW routing contents are not discovered".into()],
        execution_enabled: false,
        connectivity_tested: false,
    }
}
async fn account(store: &Store) -> anyhow::Result<VerifiedAccount> {
    store
        .register_aws_verified("operator", &role(), "123456789012", "navarchnet-fixture")
        .await
}
#[tokio::test]
async fn derives_subnet_table_selection_from_immutable_rows_and_reads_legacy_associations()
-> anyhow::Result<()> {
    use navarchnet::aws::routing::{AssociationSource, RouteSelectionReason, RouteTableSelection};
    let (store, _) = support::isolated().await?;
    let account = account(&store).await?;
    let (_, _, generation) = store.begin_aws_discovery("operator", &account.id).await?;
    let mut snapshot = topology(&account);
    let vpc = snapshot.resources[0].id.clone();
    let mut subnet = AwsResource::new(ResourceKind::Subnet, "subnet-fixture".into());
    subnet.vpc_id = Some(vpc.clone());
    subnet.owner_account_id = Some(account.aws_account_id.clone());
    let mut table = AwsResource::new(ResourceKind::RouteTable, "rtb-fixture".into());
    table.vpc_id = Some(vpc);
    table.owner_account_id = Some(account.aws_account_id.clone());
    table.associations.push(RouteAssociation {
        id: Some("rtbassoc-main".into()),
        subnet_id: None,
        gateway_id: None,
        main: true,
        state: Some("associated".into()),
    });
    snapshot.resources.extend([subnet, table]);
    store
        .finish_aws_discovery("operator", generation, &snapshot)
        .await?;
    let view = store.aws_topology(&account.id).await?;
    assert_eq!(
        view.subnet_route_tables[0].selection,
        RouteTableSelection::Selected {
            route_table_id: "rtb-fixture".into(),
            source: AssociationSource::ImplicitMain
        }
    );
    // Simulate an older stored JSON body, without rewriting an immutable prior snapshot.
    let (_, _, generation) = store.begin_aws_discovery("operator", &account.id).await?;
    snapshot.id = uuid::Uuid::new_v4().to_string();
    let mut legacy = serde_json::to_value(&snapshot)?;
    legacy["resources"][2]["associations"][0]
        .as_object_mut()
        .unwrap()
        .remove("state");
    sqlx::query("INSERT INTO aws_topologies(id,account_id,generation,body) VALUES($1,$2,$3,$4)")
        .bind(&snapshot.id)
        .bind(&account.id)
        .bind(generation)
        .bind(&legacy)
        .execute(&store.pool)
        .await?;
    let view = store.aws_topology(&account.id).await?;
    assert_eq!(
        view.subnet_route_tables[0].selection,
        RouteTableSelection::Unresolved {
            reason: RouteSelectionReason::AssociationNotReady
        }
    );
    let stored: serde_json::Value =
        sqlx::query_scalar("SELECT body FROM aws_topologies WHERE id=$1")
            .bind(&snapshot.id)
            .fetch_one(&store.pool)
            .await?;
    assert_eq!(stored, legacy);
    assert!(!view.topology.execution_enabled && !view.topology.connectivity_tested);
    Ok(())
}
#[tokio::test]
async fn bounds_nested_tgw_relationships_and_preserves_typed_observation_fields()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let account = account(&store).await?;
    let (_, _, generation) = store.begin_aws_discovery("operator", &account.id).await?;
    let mut snapshot = topology(&account);
    let mut table = AwsResource::new(
        ResourceKind::TransitGatewayRouteTable,
        "tgw-rtb-fixture".into(),
    );
    let link = TransitGatewayTableLink {
        attachment_id: Some("tgw-attach-fixture".into()),
        resource_id: Some("vpc-fixture".into()),
        resource_type: Some("vpc".into()),
        state: Some("associated".into()),
        route_table_announcement_id: None,
    };
    table.tgw_associations = Some(vec![link; 10_001]);
    snapshot.resources.push(table);
    assert!(
        store
            .finish_aws_discovery("operator", generation, &snapshot)
            .await
            .is_err()
    );
    snapshot
        .resources
        .last_mut()
        .unwrap()
        .tgw_associations
        .as_mut()
        .unwrap()
        .truncate(1);
    snapshot.resources.last_mut().unwrap().tgw_propagations = Some(vec![]);
    store
        .finish_aws_discovery("operator", generation, &snapshot)
        .await?;
    let view = store.aws_topology(&account.id).await?;
    let table = view.topology.resources.last().unwrap();
    assert_eq!(
        table.tgw_associations.as_ref().unwrap()[0].state.as_deref(),
        Some("associated")
    );
    assert!(table.tgw_propagations.as_ref().unwrap().is_empty());
    assert!(!view.topology.execution_enabled && !view.topology.connectivity_tested);
    Ok(())
}
#[tokio::test]
async fn bounds_tgw_routes_and_attachments_and_preserves_legacy_unknown_without_rewriting()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let account = account(&store).await?;
    let (_, _, generation) = store.begin_aws_discovery("operator", &account.id).await?;
    let mut snapshot = topology(&account);
    let route = TransitGatewayRoute {
        destination_cidr: Some("::/0".into()),
        prefix_list_id: None,
        state: Some("blackhole".into()),
        route_type: Some("static".into()),
        route_table_announcement_id: None,
        attachments: vec![],
    };
    let mut table = AwsResource::new(
        ResourceKind::TransitGatewayRouteTable,
        "tgw-rtb-fixture".into(),
    );
    table.tgw_routes = Some(vec![route; 10_001]);
    snapshot.resources.push(table);
    assert!(
        store
            .finish_aws_discovery("operator", generation, &snapshot)
            .await
            .is_err()
    );
    let routes = snapshot.resources[1].tgw_routes.as_mut().unwrap();
    routes.truncate(1);
    routes[0].attachments = vec![
        TransitGatewayRouteAttachment {
            attachment_id: Some("tgw-attach-fixture".into()),
            resource_id: None,
            resource_type: None,
        };
        10_001
    ];
    assert!(
        store
            .finish_aws_discovery("operator", generation, &snapshot)
            .await
            .is_err()
    );
    snapshot.resources[1].tgw_routes.as_mut().unwrap()[0]
        .attachments
        .truncate(1);
    store
        .finish_aws_discovery("operator", generation, &snapshot)
        .await?;
    let read = store.aws_topology(&account.id).await?;
    assert_eq!(
        read.topology.resources[1].tgw_routes.as_ref().unwrap()[0]
            .state
            .as_deref(),
        Some("blackhole")
    );
    let (_, _, legacy_generation) = store.begin_aws_discovery("operator", &account.id).await?;
    let mut legacy = serde_json::to_value(&snapshot)?;
    let id = uuid::Uuid::new_v4().to_string();
    legacy["id"] = id.clone().into();
    legacy["resources"][1]
        .as_object_mut()
        .unwrap()
        .remove("tgw_routes");
    sqlx::query("INSERT INTO aws_topologies(id,account_id,generation,body) VALUES($1,$2,$3,$4)")
        .bind(&id)
        .bind(&account.id)
        .bind(legacy_generation)
        .bind(&legacy)
        .execute(&store.pool)
        .await?;
    assert!(
        store.aws_topology(&account.id).await?.topology.resources[1]
            .tgw_routes
            .is_none()
    );
    let stored: serde_json::Value =
        sqlx::query_scalar("SELECT body FROM aws_topologies WHERE id=$1")
            .bind(&id)
            .fetch_one(&store.pool)
            .await?;
    assert_eq!(stored, legacy);
    Ok(())
}
#[tokio::test]
async fn verifies_registration_identity_and_keeps_private_role_configuration_out_of_views()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    assert!(
        store
            .register_aws_verified("operator", &role(), "999999999999", "navarchnet-fixture")
            .await
            .is_err()
    );
    let registered = account(&store).await?;
    assert!(!registered.execution_enabled);
    let view = store.aws_accounts().await?;
    assert_eq!(view.len(), 1);
    assert!(!serde_json::to_string(&view)?.contains("fixture-external-private"));
    assert!(account(&store).await.is_err());
    assert!(store.accounts().await?.is_empty());
    let (private, _, _) = store
        .begin_aws_discovery("operator", &registered.id)
        .await?;
    assert_eq!(private.external_id, role().external_id);
    Ok(())
}
#[tokio::test]
async fn fences_late_discovery_retains_last_complete_snapshot_and_preserves_immutability()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let account = account(&store).await?;
    let (_, _, first) = store.begin_aws_discovery("operator", &account.id).await?;
    let initial = topology(&account);
    store
        .finish_aws_discovery("operator", first, &initial)
        .await?;
    let (_, _, old) = store.begin_aws_discovery("old", &account.id).await?;
    let (_, _, fresh) = store.begin_aws_discovery("fresh", &account.id).await?;
    assert!(
        store
            .finish_aws_discovery("old", old, &topology(&account))
            .await
            .is_err()
    );
    let mut invalid = topology(&account);
    invalid.complete_for_supported_queries = false;
    assert!(
        store
            .finish_aws_discovery("fresh", fresh, &invalid)
            .await
            .is_err()
    );
    assert_eq!(
        store.aws_topology(&account.id).await?.topology.id,
        initial.id
    );
    let snapshot = topology(&account);
    store
        .finish_aws_discovery("fresh", fresh, &snapshot)
        .await?;
    assert_eq!(
        store.aws_topology(&account.id).await?.topology.id,
        snapshot.id
    );
    assert!(
        sqlx::query("UPDATE aws_topologies SET body=body")
            .execute(&store.pool)
            .await
            .is_err()
    );
    assert!(store.inventories().await?.is_empty());
    Ok(())
}
#[tokio::test]
async fn adoption_is_explicit_current_owned_and_audited_without_cloud_execution()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let account = account(&store).await?;
    let (_, _, generation) = store.begin_aws_discovery("operator", &account.id).await?;
    let snapshot = topology(&account);
    store
        .finish_aws_discovery("operator", generation, &snapshot)
        .await?;
    assert!(store.aws_topology(&account.id).await?.adoptions.is_empty());
    let consent = AdoptionConsent {
        topology_id: snapshot.id.clone(),
        resource_kind: ResourceKind::Vpc,
        resource_id: snapshot.resources[0].id.clone(),
        reason: "Explicit fixture metadata consent; no route or resource mutations".into(),
    };
    let mut missing = consent.clone();
    missing.resource_id = "vpc-unknown".into();
    assert!(
        store
            .adopt_aws_resource("operator", &account.id, &missing)
            .await
            .is_err()
    );
    let accepted = store
        .adopt_aws_resource("operator", &account.id, &consent)
        .await?;
    assert!(!accepted.execution_enabled);
    assert_eq!(accepted.actor, "operator");
    assert_eq!(
        store
            .adopt_aws_resource("operator", &account.id, &consent)
            .await?
            .id,
        accepted.id
    );
    assert_eq!(store.aws_topology(&account.id).await?.adoptions.len(), 1);
    assert!(!store.aws_topology(&account.id).await?.topology.resources[0].managed);
    store.begin_aws_discovery("operator", &account.id).await?;
    assert!(
        store
            .adopt_aws_resource("operator", &account.id, &consent)
            .await
            .is_err()
    );
    let events: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit WHERE event='aws_resource_adopted'")
            .fetch_one(&store.pool)
            .await?;
    assert_eq!(events, 1);
    assert!(
        sqlx::query("DELETE FROM aws_adoptions")
            .execute(&store.pool)
            .await
            .is_err()
    );
    Ok(())
}
