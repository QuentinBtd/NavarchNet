//! HTTP/real-PostgreSQL fixtures only: never construct the SDK or read ambient AWS credentials.
mod support;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use navarchnet::{
    api::{self, AppState},
    auth::Auth,
    aws::{
        observation::*,
        service::{AwsFuture, ReadOnlyAws, VerifiedIdentity},
        *,
    },
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tower::ServiceExt;
#[derive(Default)]
struct AwsFixture {
    verifications: AtomicUsize,
    discoveries: AtomicUsize,
    fail: AtomicBool,
}
impl ReadOnlyAws for AwsFixture {
    fn regions(&self) -> Vec<String> {
        vec!["eu-west-1".into()]
    }
    fn verify<'a>(
        &'a self,
        request: &'a RoleRegistration,
        _actor: &'a str,
    ) -> AwsFuture<'a, VerifiedIdentity> {
        Box::pin(async move {
            self.verifications.fetch_add(1, Ordering::SeqCst);
            Ok(VerifiedIdentity {
                account_id: request.validate()?.account_id,
                session_name: "navarchnet-http-fixture".into(),
            })
        })
    }
    fn discover<'a>(
        &'a self,
        _request: &'a RoleRegistration,
        account: &'a VerifiedAccount,
        _actor: &'a str,
    ) -> AwsFuture<'a, AwsTopology> {
        Box::pin(async move {
            self.discoveries.fetch_add(1, Ordering::SeqCst);
            if self.fail.load(Ordering::SeqCst) {
                return Err(session::redacted_error(
                    "Fixture discovery",
                    Some("UnauthorizedOperation"),
                ));
            }
            let mut vpc = AwsResource::new(ResourceKind::Vpc, "vpc-01111111111111111".into());
            vpc.owner_account_id = Some(account.aws_account_id.clone());
            vpc.cidrs = vec!["10.1.0.0/16".into()];
            let mut foreign = vpc.clone();
            foreign.id = "vpc-02222222222222222".into();
            foreign.owner_account_id = Some("999999999999".into());
            let mut table = AwsResource::new(
                ResourceKind::TransitGatewayRouteTable,
                "tgw-rtb-fixture".into(),
            );
            table.related_ids.push("tgw-parent".into());
            let mut parent = AwsResource::new(ResourceKind::TransitGateway, "tgw-parent".into());
            parent.owner_account_id = Some(account.aws_account_id.clone());
            table.state = Some("available".into());
            table.tgw_associations = Some(vec![TransitGatewayTableLink {
                attachment_id: Some("tgw-attach-ingress".into()),
                resource_id: Some(vpc.id.clone()),
                resource_type: Some("vpc".into()),
                state: Some("associated".into()),
                route_table_announcement_id: None,
            }]);
            let mut ingress =
                AwsResource::new(ResourceKind::VpcAttachment, "tgw-attach-ingress".into());
            ingress.vpc_id = Some(vpc.id.clone());
            ingress.state = Some("available".into());
            ingress.related_ids.push(parent.id.clone());
            parent.state = Some("available".into());
            table.tgw_routes = Some(vec![TransitGatewayRoute {
                destination_cidr: Some("0.0.0.0/0".into()),
                prefix_list_id: None,
                state: Some("active".into()),
                route_type: Some("static".into()),
                route_table_announcement_id: None,
                attachments: vec![TransitGatewayRouteAttachment {
                    attachment_id: Some("tgw-attach-fixture".into()),
                    resource_id: None,
                    resource_type: Some("vpc".into()),
                }],
            }]);
            Ok(AwsTopology {
                id: uuid::Uuid::new_v4().to_string(),
                account_id: account.id.clone(),
                aws_account_id: account.aws_account_id.clone(),
                region: account.region.clone(),
                started_at: "1".into(),
                completed_at: "2".into(),
                session_name: "navarchnet-http-fixture".into(),
                resources: vec![vpc, foreign, table, parent, ingress],
                request_ids: vec!["fixture".into()],
                complete_for_supported_queries: true,
                limitations: vec!["Fixture observations are not AWS connectivity evidence".into()],
                execution_enabled: false,
                connectivity_tested: false,
            })
        })
    }
}
async fn request(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> anyhow::Result<(StatusCode, Value)> {
    let mut request = Request::builder()
        .method(method)
        .uri(format!("/api/v1{path}"));
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let body = if let Some(body) = body {
        request = request.header("content-type", "application/json");
        Body::from(serde_json::to_vec(&body)?)
    } else {
        Body::empty()
    };
    let response = app.clone().oneshot(request.body(body)?).await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    Ok((status, value))
}
fn registration() -> Value {
    json!({"name":"Fixture AWS account","role_arn":"arn:aws:iam::123456789012:role/Reader","region":"eu-west-1","external_id":"fixture-private-external"})
}
#[tokio::test]
async fn saved_nat_reference_lookup_binds_a_subnet_entry_to_raw_metadata_without_inference()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let role: RoleRegistration = serde_json::from_value(registration())?;
    let account = store
        .register_aws_verified("fixture", &role, "123456789012", "nat-reference-fixture")
        .await?;
    let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
    let mut vpc = AwsResource::new(ResourceKind::Vpc, "vpc-reference".into());
    vpc.owner_account_id = Some(account.aws_account_id.clone());
    vpc.state = Some("available".into());
    let mut subnet = AwsResource::new(ResourceKind::Subnet, "subnet-reference".into());
    subnet.owner_account_id = vpc.owner_account_id.clone();
    subnet.vpc_id = Some(vpc.id.clone());
    subnet.state = Some("available".into());
    let mut table = AwsResource::new(ResourceKind::RouteTable, "rtb-reference".into());
    table.owner_account_id = vpc.owner_account_id.clone();
    table.vpc_id = Some(vpc.id.clone());
    table.associations.push(RouteAssociation {
        state: Some("associated".into()),
        id: Some("rtbassoc-reference".into()),
        subnet_id: None,
        gateway_id: None,
        main: true,
    });
    table.routes.push(ObservedRoute {
        ipv4_destination: Some("0.0.0.0/0".into()),
        ipv6_destination: None,
        prefix_list_destination: None,
        state: Some("active".into()),
        origin: Some("CreateRoute".into()),
        targets: [("natGatewayId".into(), "nat-reference".into())].into(),
    });
    let mut nat = AwsResource::new(ResourceKind::NatGateway, "nat-reference".into());
    nat.state = Some("failed".into());
    nat.public_ips = vec!["203.0.113.10".into()];
    nat.nat_gateway = Some(NatGatewayMetadata {
        route_table_id: Some("nat-literal-not-a-table".into()),
        addresses: None,
    });
    let expected_nat = serde_json::to_value(&nat)?;
    let topology = AwsTopology {
        id: uuid::Uuid::new_v4().to_string(),
        account_id: account.id.clone(),
        aws_account_id: account.aws_account_id.clone(),
        region: account.region.clone(),
        started_at: "3".into(),
        completed_at: "7".into(),
        session_name: "nat-reference-fixture".into(),
        resources: vec![vpc, subnet, table, nat],
        request_ids: vec!["fixture".into()],
        complete_for_supported_queries: true,
        limitations: vec!["Record reference is not routing, ownership or NAT health proof".into()],
        execution_enabled: false,
        connectivity_tested: false,
    };
    store
        .finish_aws_discovery("fixture", generation, &topology)
        .await?;
    let app = api::router(AppState {
        store: store.clone(),
        auth: Arc::new(Auth::demo("a".repeat(32), "r".repeat(32))?),
        aws: None,
    });
    let reader = "r".repeat(32);
    let path = format!(
        "/aws/accounts/{}/nat-reference-lookup?subnet_id=subnet-reference&destination=203.0.113.1",
        account.id
    );
    let before = request(&app, "GET", "/snapshot", Some(&reader), None)
        .await?
        .1;
    let body_before: Value = sqlx::query_scalar("SELECT body FROM aws_topologies WHERE id=$1")
        .bind(&topology.id)
        .fetch_one(&store.pool)
        .await?;
    let audits_before: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    assert_eq!(
        request(&app, "GET", &path, None, None).await?.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, result) = request(&app, "GET", &path, Some(&reader), None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["account_id"], account.id);
    assert_eq!(result["topology_id"], topology.id);
    assert_eq!(result["completed_at"], "7");
    assert_eq!(result["subnet_id"], "subnet-reference");
    assert_eq!(result["destination"], "203.0.113.1");
    assert_eq!(result["execution_enabled"], false);
    assert_eq!(result["connectivity_tested"], false);
    assert_eq!(result["reference_only"], true);
    assert_eq!(
        result["result"]["subnet_lookup"],
        serde_json::to_value(vpc_lookup::lookup(
            &topology,
            "subnet-reference",
            "203.0.113.1"
        ))?
    );
    assert_eq!(result["result"]["reference"]["status"], "reported_record");
    assert_eq!(result["result"]["reference"]["resource"], expected_nat);
    assert_eq!(result["result"]["reference"]["owner_scope"], "not_reported");
    assert_eq!(result["result"]["reference"]["vpc_scope"], "not_reported");
    for (field, value) in [
        (
            "subnet_id=subnet-reference",
            format!("subnet_id={}", "x".repeat(2049)),
        ),
        (
            "destination=203.0.113.1",
            format!("destination={}", "x".repeat(65)),
        ),
    ] {
        assert_eq!(
            request(
                &app,
                "GET",
                &path.replace(field, &value),
                Some(&reader),
                None
            )
            .await?
            .0,
            StatusCode::CONFLICT
        );
    }
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("{path}&nat_gateway_id=nat-unrequested"),
            Some(&reader),
            None
        )
        .await?
        .0,
        StatusCode::BAD_REQUEST
    );
    let body_after: Value = sqlx::query_scalar("SELECT body FROM aws_topologies WHERE id=$1")
        .bind(&topology.id)
        .fetch_one(&store.pool)
        .await?;
    let audits_after: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    assert_eq!(body_after, body_before);
    assert_eq!(audits_after, audits_before);
    assert_eq!(
        request(&app, "GET", "/snapshot", Some(&reader), None)
            .await?
            .1,
        before
    );
    Ok(())
}
#[tokio::test]
async fn saved_nat_metadata_survives_postgres_and_reader_http_without_sdk_or_inference()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let role: RoleRegistration = serde_json::from_value(registration())?;
    let account = store
        .register_aws_verified("fixture", &role, "123456789012", "nat-fixture")
        .await?;
    let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
    let metadata = json!({"route_table_id":"nat-literal-unvalidated-reference", "addresses":[
        {"allocation_id":"eipalloc-a", "association_id":"eipassoc-a", "network_interface_id":"eni-a", "public_ip":"203.0.113.10", "private_ip":"10.0.1.10", "az_name":"eu-west-1a", "az_id":"euw1-az1", "is_primary":true, "status":"succeeded"},
        {"allocation_id":null, "association_id":null, "network_interface_id":null, "public_ip":"203.0.113.20", "private_ip":null, "az_name":null, "az_id":null, "is_primary":null, "status":"future-status"}
    ]});
    let mut nat = AwsResource::new(ResourceKind::NatGateway, "nat-regional".into());
    nat.availability_mode = Some("regional".into());
    nat.state = Some("available".into());
    nat.nat_gateway = Some(serde_json::from_value(metadata.clone())?);
    let topology = AwsTopology {
        id: uuid::Uuid::new_v4().to_string(),
        account_id: account.id.clone(),
        aws_account_id: account.aws_account_id.clone(),
        region: account.region.clone(),
        started_at: "3".into(),
        completed_at: "7".into(),
        session_name: "nat-fixture".into(),
        resources: vec![nat],
        request_ids: vec!["fixture".into()],
        complete_for_supported_queries: true,
        limitations: vec!["NAT metadata is not a measured egress path".into()],
        execution_enabled: false,
        connectivity_tested: false,
    };
    store
        .finish_aws_discovery("fixture", generation, &topology)
        .await?;
    let before: Value = sqlx::query_scalar("SELECT body FROM aws_topologies WHERE id=$1")
        .bind(&topology.id)
        .fetch_one(&store.pool)
        .await?;
    let audits_before: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    let app = api::router(AppState {
        store: store.clone(),
        auth: Arc::new(Auth::demo("a".repeat(32), "r".repeat(32))?),
        aws: None,
    });
    let path = format!("/aws/accounts/{}/topology", account.id);
    assert_eq!(
        request(&app, "GET", &path, None, None).await?.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, view) = request(&app, "GET", &path, Some(&"r".repeat(32)), None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["topology"]["id"], topology.id);
    assert_eq!(view["topology"]["completed_at"], "7");
    assert_eq!(view["topology"]["resources"][0]["nat_gateway"], metadata);
    assert!(view["topology"]["resources"][0]["subnet_id"].is_null());
    assert!(view["topology"]["resources"][0]["az_id"].is_null());
    assert_eq!(view["topology"]["execution_enabled"], false);
    assert_eq!(view["topology"]["connectivity_tested"], false);
    assert_eq!(view["topology"]["resources"][0]["managed"], false);
    assert_eq!(view["adoptions"], json!([]));
    assert_eq!(view["subnet_route_tables"], json!([]));
    let after: Value = sqlx::query_scalar("SELECT body FROM aws_topologies WHERE id=$1")
        .bind(&topology.id)
        .fetch_one(&store.pool)
        .await?;
    assert_eq!(before, after);
    let audits_after: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    assert_eq!(audits_after, audits_before);
    // A new legacy-shaped row is read without upgrading or rewriting immutable stored JSON.
    let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
    let mut legacy = before;
    let id = uuid::Uuid::new_v4().to_string();
    legacy["id"] = json!(id);
    legacy["resources"][0]
        .as_object_mut()
        .unwrap()
        .remove("nat_gateway");
    sqlx::query("INSERT INTO aws_topologies(id,account_id,generation,body) VALUES($1,$2,$3,$4)")
        .bind(&id)
        .bind(&account.id)
        .bind(generation)
        .bind(&legacy)
        .execute(&store.pool)
        .await?;
    let (status, view) = request(&app, "GET", &path, Some(&"r".repeat(32)), None).await?;
    assert_eq!(status, StatusCode::OK);
    assert!(view["topology"]["resources"][0]["nat_gateway"].is_null());
    let after: Value = sqlx::query_scalar("SELECT body FROM aws_topologies WHERE id=$1")
        .bind(&id)
        .fetch_one(&store.pool)
        .await?;
    assert_eq!(after, legacy);
    Ok(())
}
#[tokio::test]
async fn rejects_out_of_allowlist_regions_and_permanent_key_fields_before_provider_calls()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let fixture = Arc::new(AwsFixture::default());
    let app = api::router(AppState {
        store: store.clone(),
        auth: Arc::new(Auth::demo("a".repeat(32), "r".repeat(32))?),
        aws: Some(fixture.clone()),
    });
    let mut region = registration();
    region["region"] = json!("eu-west-3");
    let mut keys = registration();
    keys["access_key_id"] = json!("fixture-key-field-must-be-rejected");
    let first = request(
        &app,
        "POST",
        "/aws/accounts",
        Some(&"a".repeat(32)),
        Some(region),
    )
    .await?
    .0;
    let second = request(
        &app,
        "POST",
        "/aws/accounts",
        Some(&"a".repeat(32)),
        Some(keys),
    )
    .await?
    .0;
    assert_eq!(
        (first, second),
        (StatusCode::CONFLICT, StatusCode::UNPROCESSABLE_ENTITY)
    );
    assert_eq!(fixture.verifications.load(Ordering::SeqCst), 0);
    assert!(store.aws_accounts().await?.is_empty());
    Ok(())
}
#[tokio::test]
async fn real_http_storage_journey_redacts_config_authorizes_writes_and_retains_prior_discovery()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let fixture = Arc::new(AwsFixture::default());
    // Demo authentication is injected only in this fixture. Production configure() rejects demo+AWS.
    let app = api::router(AppState {
        store: store.clone(),
        auth: Arc::new(Auth::demo("a".repeat(32), "r".repeat(32))?),
        aws: Some(fixture.clone()),
    });
    let admin = "a".repeat(32);
    let reader = "r".repeat(32);
    assert_eq!(
        request(
            &app,
            "POST",
            "/aws/accounts",
            Some(&reader),
            Some(registration())
        )
        .await?
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(fixture.verifications.load(Ordering::SeqCst), 0);
    let (status, account) = request(
        &app,
        "POST",
        "/aws/accounts",
        Some(&admin),
        Some(registration()),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(account["verified_session_name"], "navarchnet-http-fixture");
    let id = account["id"].as_str().unwrap();
    let (status, snapshot) = request(&app, "GET", "/snapshot", Some(&reader), None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["aws_accounts"].as_array().unwrap().len(), 1);
    assert!(!snapshot.to_string().contains("fixture-private-external"));
    assert_eq!(
        request(&app, "GET", "/aws/accounts", None, None).await?.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, accounts) = request(&app, "GET", "/aws/accounts", Some(&reader), None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(accounts, snapshot["aws_accounts"]);
    assert!(!accounts.to_string().contains("fixture-private-external"));
    let disabled = api::router(AppState {
        store: store.clone(),
        auth: Arc::new(Auth::demo(admin.clone(), reader.clone())?),
        aws: None,
    });
    assert_eq!(
        request(&disabled, "GET", "/aws/accounts", Some(&reader), None).await?,
        (StatusCode::OK, accounts)
    );
    assert!(snapshot["inventory"].as_array().unwrap().is_empty());
    let (status, topology) = request(
        &app,
        "POST",
        &format!("/aws/accounts/{id}/discover"),
        Some(&admin),
        Some(json!({})),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(topology["execution_enabled"], false);
    assert_eq!(topology["connectivity_tested"], false);
    let lookup = format!(
        "/aws/accounts/{id}/tgw-route-lookup?route_table_id=tgw-rtb-fixture&destination=203.0.113.1"
    );
    assert_eq!(
        request(&app, "GET", &lookup, None, None).await?.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, selection) = request(&app, "GET", &lookup, Some(&reader), None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(selection["topology_id"], topology["id"]);
    assert_eq!(selection["result"]["status"], "reported_forward");
    assert_eq!(
        selection["result"]["attachment_ids"][0],
        "tgw-attach-fixture"
    );
    assert_eq!(selection["connectivity_tested"], false);
    assert_eq!(selection["execution_enabled"], false);
    let path = format!("/aws/accounts/{id}/topology");
    assert_eq!(
        request(&app, "GET", &path, None, None).await?.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, saved) = request(&app, "GET", &path, Some(&reader), None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["topology"]["id"], topology["id"]);
    assert_eq!(saved["topology"]["resources"][0]["managed"], false);
    let mut consent = json!({"topology_id":topology["id"],"resource_kind":"vpc","resource_id":"vpc-02222222222222222","reason":"Fixture metadata consent, no route ownership"});
    let adoption = format!("/aws/accounts/{id}/adoptions");
    assert_eq!(
        request(&app, "POST", &adoption, Some(&admin), Some(consent.clone()))
            .await?
            .0,
        StatusCode::CONFLICT
    );
    consent["resource_id"] = json!("vpc-01111111111111111");
    assert_eq!(
        request(
            &app,
            "POST",
            &adoption,
            Some(&reader),
            Some(consent.clone())
        )
        .await?
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, record) = request(&app, "POST", &adoption, Some(&admin), Some(consent)).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(record["execution_enabled"], false);
    let saved = request(&app, "GET", &path, Some(&reader), None).await?.1;
    assert!(saved["subnet_route_tables"].is_array());
    assert_eq!(saved["adoptions"].as_array().unwrap().len(), 1);
    assert_eq!(saved["adoptions"][0]["id"], record["id"]);
    fixture.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("/aws/accounts/{id}/discover"),
            Some(&admin),
            Some(json!({}))
        )
        .await?
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(&app, "GET", &path, Some(&reader), None).await?.1["topology"]["id"],
        topology["id"]
    );
    let failures: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit WHERE event='aws_discovery_failed'")
            .fetch_one(&store.pool)
            .await?;
    assert_eq!(failures, 1);
    assert!(store.inventories().await?.is_empty());
    assert!(store.plans().await?.is_empty());
    assert_eq!(fixture.verifications.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.discoveries.load(Ordering::SeqCst), 2);
    Ok(())
}
#[tokio::test]
async fn saved_ingress_lookup_uses_reported_association_offline_without_writes()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let fixture = Arc::new(AwsFixture::default());
    let admin = "a".repeat(32);
    let reader = "r".repeat(32);
    let app = api::router(AppState {
        store: store.clone(),
        auth: Arc::new(Auth::demo(admin.clone(), reader.clone())?),
        aws: Some(fixture.clone()),
    });
    let (_, account) = request(
        &app,
        "POST",
        "/aws/accounts",
        Some(&admin),
        Some(registration()),
    )
    .await?;
    let id = account["id"].as_str().unwrap();
    let (_, topology) = request(
        &app,
        "POST",
        &format!("/aws/accounts/{id}/discover"),
        Some(&admin),
        Some(json!({})),
    )
    .await?;
    let before = serde_json::to_value(store.aws_topology(id).await?.topology)?;
    let offline = api::router(AppState {
        store: store.clone(),
        auth: Arc::new(Auth::demo(admin, reader.clone())?),
        aws: None,
    });
    let path = format!(
        "/aws/accounts/{id}/tgw-ingress-lookup?ingress_attachment_id=tgw-attach-ingress&destination=203.0.113.1"
    );
    assert_eq!(
        request(&offline, "GET", &path, None, None).await?.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, result) = request(&offline, "GET", &path, Some(&reader), None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["topology_id"], topology["id"]);
    assert_eq!(result["ingress_attachment_id"], "tgw-attach-ingress");
    assert_eq!(result["destination"], "203.0.113.1");
    assert_eq!(result["result"]["status"], "reported");
    assert_eq!(result["result"]["transit_gateway_id"], "tgw-parent");
    assert_eq!(result["result"]["route_table_id"], "tgw-rtb-fixture");
    assert_eq!(
        result["result"]["lookup"]["attachment_ids"][0],
        "tgw-attach-fixture"
    );
    assert_eq!(result["connectivity_tested"], false);
    assert_eq!(result["execution_enabled"], false);
    assert_eq!(
        request(
            &offline,
            "GET",
            &format!("{path}&unexpected=true"),
            Some(&reader),
            None
        )
        .await?
        .0,
        StatusCode::BAD_REQUEST
    );
    for (field, value) in [
        ("ingress_attachment_id", "x".repeat(2049)),
        ("destination", "x".repeat(65)),
    ] {
        let query = if field == "destination" {
            format!("ingress_attachment_id=tgw-attach-ingress&destination={value}")
        } else {
            format!("ingress_attachment_id={value}&destination=203.0.113.1")
        };
        assert_eq!(
            request(
                &offline,
                "GET",
                &format!("/aws/accounts/{id}/tgw-ingress-lookup?{query}"),
                Some(&reader),
                None
            )
            .await?
            .0,
            StatusCode::CONFLICT
        );
    }
    let invalid = path.replace("203.0.113.1", "not-an-ip");
    let (status, invalid) = request(&offline, "GET", &invalid, Some(&reader), None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(invalid["result"]["lookup"]["reason"], "invalid_destination");
    let missing = path.replace("tgw-attach-ingress", "missing");
    let (status, missing) = request(&offline, "GET", &missing, Some(&reader), None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        missing["result"]["reason"],
        "missing_or_ambiguous_attachment"
    );
    assert_eq!(
        before,
        serde_json::to_value(store.aws_topology(id).await?.topology)?
    );
    assert_eq!(fixture.discoveries.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.verifications.load(Ordering::SeqCst), 1);
    assert!(store.plans().await?.is_empty());
    assert!(store.inventories().await?.is_empty());
    Ok(())
}
#[tokio::test]
async fn saved_tgw_cidr_coverage_partitions_point_decisions_without_writes() -> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let fixture = AwsFixture::default();
    let role: RoleRegistration = serde_json::from_value(registration())?;
    let account = store
        .register_aws_verified("fixture", &role, "123456789012", "fixture")
        .await?;
    let mut topology = fixture.discover(&role, &account, "fixture").await?;
    let route = |cidr: &str, kind: &str, state: &str| TransitGatewayRoute {
        destination_cidr: Some(cidr.into()),
        prefix_list_id: None,
        state: Some(state.into()),
        route_type: Some(kind.into()),
        route_table_announcement_id: None,
        attachments: if state == "blackhole" {
            vec![]
        } else {
            vec![TransitGatewayRouteAttachment {
                attachment_id: Some("tgw-attach-literal".into()),
                resource_id: None,
                resource_type: Some("vpc".into()),
            }]
        },
    };
    topology.resources[2].tgw_routes = Some(vec![
        route("0.0.0.0/0", "static", "active"),
        route("203.0.113.2/31", "static", "blackhole"),
        route("203.0.113.4/30", "future", "active"),
    ]);
    let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
    store
        .finish_aws_discovery("fixture", generation, &topology)
        .await?;
    let before = serde_json::to_value(store.aws_topology(&account.id).await?)?;
    let audit_before: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    let reader = "r".repeat(32);
    let app = api::router(AppState {
        store: store.clone(),
        auth: Arc::new(Auth::demo("a".repeat(32), reader.clone())?),
        aws: None,
    });
    let path = format!(
        "/aws/accounts/{}/tgw-cidr-coverage?route_table_id=tgw-rtb-fixture&destination_cidr=203.0.113.0/29",
        account.id
    );
    let (status, value) = request(&app, "GET", &path, Some(&reader), None).await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "An exact saved TGW CIDR partition requires its own reader endpoint"
    );
    assert_eq!(
        request(&app, "GET", &path, None, None).await?.0,
        StatusCode::UNAUTHORIZED
    );
    for (field, expected) in [
        ("account_id", &account.id),
        ("topology_id", &topology.id),
        ("started_at", &topology.started_at),
        ("completed_at", &topology.completed_at),
        ("aws_account_id", &topology.aws_account_id),
        ("region", &topology.region),
    ] {
        assert_eq!(value[field], *expected);
    }
    assert_eq!(value["reference_only"], true);
    assert_eq!(value["execution_enabled"], false);
    assert_eq!(value["connectivity_tested"], false);
    assert_eq!(value["coverage"]["partition_complete"], true);
    assert_eq!(value["route_table_id"], "tgw-rtb-fixture");
    assert_eq!(value["destination_cidr"], "203.0.113.0/29");
    assert_eq!(value["coverage"]["destination_cidr"], "203.0.113.0/29");
    assert_eq!(value["complete_for_supported_queries"], true);
    assert_eq!(
        value["limitations"],
        serde_json::to_value(&topology.limitations)?
    );
    assert_eq!(
        value["request_ids"],
        serde_json::to_value(&topology.request_ids)?
    );
    assert_eq!(value["coverage"]["table_evidence"][0]["resource_index"], 2);
    assert_eq!(value["coverage"]["parent_evidence"][0]["resource_index"], 3);
    for invalid in [
        format!("{path}&unknown=true"),
        format!("{path}&route_table_id=tgw-rtb-fixture"),
        format!("{path}&destination_cidr=203.0.113.0/29"),
        path.replace("route_table_id=tgw-rtb-fixture&", ""),
        path.replace("&destination_cidr=203.0.113.0/29", ""),
    ] {
        assert_eq!(
            request(&app, "GET", &invalid, Some(&reader), None).await?.0,
            StatusCode::BAD_REQUEST
        );
    }
    for invalid in [
        "203.0.113.1/29",
        "203.0.113.0",
        "203.0.113.0/029",
        "%20203.0.113.0/29",
        "2001:0DB8::/32",
        "::/129",
    ] {
        let (code, error) = request(
            &app,
            "GET",
            &path.replace("203.0.113.0/29", invalid),
            Some(&reader),
            None,
        )
        .await?;
        assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error["error"], "invalid_destination_cidr");
        assert!(error.get("coverage").is_none());
    }
    for invalid in ["", "bad%0Atable"] {
        let (code, error) = request(
            &app,
            "GET",
            &path.replace("tgw-rtb-fixture", invalid),
            Some(&reader),
            None,
        )
        .await?;
        assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error["error"], "invalid_table_input");
    }
    for oversized in [
        path.replace("tgw-rtb-fixture", &"x".repeat(2049)),
        path.replace("203.0.113.0/29", &"x".repeat(65)),
    ] {
        let (code, error) = request(&app, "GET", &oversized, Some(&reader), None).await?;
        assert_eq!(code, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error["error"], "input_too_large");
        assert!(error.get("coverage").is_none());
    }
    assert_eq!(
        request(
            &app,
            "GET",
            &path.replace(&account.id, "missing"),
            Some(&reader),
            None
        )
        .await?
        .0,
        StatusCode::CONFLICT
    );
    let (code, missing) = request(
        &app,
        "GET",
        &path.replace("tgw-rtb-fixture", "missing"),
        Some(&reader),
        None,
    )
    .await?;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        missing["coverage"]["segments"][0]["result"]["reason"],
        "missing_or_ambiguous_table"
    );
    assert_eq!(missing["coverage"]["table_evidence"], json!([]));
    assert_eq!(
        value["coverage"]["table_evidence"][0]["original_resource"],
        serde_json::to_value(&topology.resources[2])?
    );
    assert_eq!(
        value["coverage"]["parent_evidence"][0]["original_resource"],
        serde_json::to_value(&topology.resources[3])?
    );
    let cells = value["coverage"]["segments"].as_array().unwrap();
    assert_eq!(cells.len(), 3);
    for (cell, (start, end, decision)) in cells.iter().zip([
        ("203.0.113.0", "203.0.113.1", "reported_forward"),
        ("203.0.113.2", "203.0.113.3", "reported_blackhole"),
        ("203.0.113.4", "203.0.113.7", "unresolved"),
    ]) {
        assert_eq!(cell["start"], start);
        assert_eq!(cell["end_inclusive"], end);
        assert_eq!(cell["result"]["status"], decision);
    }
    assert_eq!(cells[2]["result"]["reason"], "unknown_route_type");
    // Exhaustive tiny TEST oracle only, never production address enumeration.
    for host in 0..8 {
        let ip = format!("203.0.113.{host}");
        let number = u32::from(ip.parse::<std::net::Ipv4Addr>()?);
        let matching: Vec<_> = cells
            .iter()
            .filter(|cell| {
                let start = u32::from(
                    cell["start"]
                        .as_str()
                        .unwrap()
                        .parse::<std::net::Ipv4Addr>()
                        .unwrap(),
                );
                let end = u32::from(
                    cell["end_inclusive"]
                        .as_str()
                        .unwrap()
                        .parse::<std::net::Ipv4Addr>()
                        .unwrap(),
                );
                start <= number && number <= end
            })
            .collect();
        assert_eq!(matching.len(), 1);
        let (_, point) = request(
            &app,
            "GET",
            &format!(
                "/aws/accounts/{}/tgw-route-lookup?route_table_id=tgw-rtb-fixture&destination={ip}",
                account.id
            ),
            Some(&reader),
            None,
        )
        .await?;
        assert_eq!(matching[0]["result"], point["result"]);
        assert_eq!(
            point["result"],
            serde_json::to_value(route_lookup::lookup(&topology, "tgw-rtb-fixture", &ip))?
        );
    }
    assert_eq!(
        before,
        serde_json::to_value(store.aws_topology(&account.id).await?)?
    );
    assert_eq!(
        audit_before,
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit")
            .fetch_one(&store.pool)
            .await?
    );
    assert!(
        store.plans().await?.is_empty()
            && store.inventories().await?.is_empty()
            && store.operations().await?.is_empty()
    );
    assert_eq!(fixture.discoveries.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.verifications.load(Ordering::SeqCst), 0);
    // Explicit fixture generations, not API discovery; each successful or rejected GET is read-only.
    let mut latest = topology.clone();
    latest.id = uuid::Uuid::new_v4().to_string();
    latest.completed_at = "3".into();
    latest.resources[2].tgw_routes = Some(vec![route("::/0", "static", "active")]);
    let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
    store
        .finish_aws_discovery("fixture", generation, &latest)
        .await?;
    let saved_latest = serde_json::to_value(store.aws_topology(&account.id).await?)?;
    let audit_latest: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    let (code, response) = request(
        &app,
        "GET",
        &path.replace("203.0.113.0/29", "::/0"),
        Some(&reader),
        None,
    )
    .await?;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(response["topology_id"], latest.id);
    assert_eq!(response["completed_at"], latest.completed_at);
    let cells = response["coverage"]["segments"].as_array().unwrap();
    assert_eq!(
        cells.len(),
        1,
        "TGW coverage must not import VPC reserved-service cuts"
    );
    assert_eq!(cells[0]["start"], "::");
    assert_eq!(
        cells[0]["end_inclusive"],
        "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
    );
    assert_eq!(cells[0]["result"]["status"], "reported_forward");
    assert_eq!(
        saved_latest,
        serde_json::to_value(store.aws_topology(&account.id).await?)?
    );
    assert_eq!(
        audit_latest,
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit")
            .fetch_one(&store.pool)
            .await?
    );
    for dimension in [
        "route_rows",
        "table_output",
        "parent_output",
        "provenance_output",
    ] {
        let mut large = latest.clone();
        large.id = uuid::Uuid::new_v4().to_string();
        large.completed_at = "4".into();
        let limit = navarchnet::aws::tgw_cidr_coverage::TgwCoverageBudget::default().response_bytes;
        match dimension {
            "route_rows" => {
                let rows = large.resources[2].tgw_routes.as_mut().unwrap();
                rows.resize(1025, rows[0].clone());
            }
            "table_output" => {
                large.resources[2]
                    .tags
                    .insert("fixture".into(), "x".repeat(limit));
            }
            "parent_output" => {
                large.resources[3]
                    .tags
                    .insert("fixture".into(), "x".repeat(limit));
            }
            "provenance_output" => large.limitations.push("x".repeat(limit)),
            _ => unreachable!(),
        }
        let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
        store
            .finish_aws_discovery("fixture", generation, &large)
            .await?;
        let saved_before = serde_json::to_value(store.aws_topology(&account.id).await?)?;
        let audit_large: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
            .fetch_one(&store.pool)
            .await?;
        let (code, error) = request(
            &app,
            "GET",
            &path.replace("203.0.113.0/29", "::/0"),
            Some(&reader),
            None,
        )
        .await?;
        assert_eq!(code, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error["error"], "budget_exceeded");
        assert_eq!(
            error["dimension"],
            if dimension == "route_rows" {
                "route_rows"
            } else {
                "response_bytes"
            }
        );
        assert!(
            error.get("coverage").is_none()
                && error.get("segments").is_none()
                && error.get("partition_complete").is_none()
        );
        assert_eq!(
            saved_before,
            serde_json::to_value(store.aws_topology(&account.id).await?)?
        );
        assert_eq!(
            audit_large,
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit")
                .fetch_one(&store.pool)
                .await?
        );
    }
    assert_eq!(fixture.discoveries.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.verifications.load(Ordering::SeqCst), 0);
    Ok(())
}
#[tokio::test]
async fn saved_vpc_cidr_coverage_partitions_existing_point_decisions_without_writes()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let fixture = AwsFixture::default();
    let role: RoleRegistration = serde_json::from_value(registration())?;
    let account = store
        .register_aws_verified("fixture", &role, "123456789012", "fixture")
        .await?;
    let mut topology = fixture.discover(&role, &account, "fixture").await?;
    topology.resources[0].state = Some("available".into());
    let mut subnet = AwsResource::new(ResourceKind::Subnet, "subnet-coverage".into());
    subnet.vpc_id = Some(topology.resources[0].id.clone());
    subnet.owner_account_id = Some(account.aws_account_id.clone());
    subnet.state = Some("available".into());
    let mut table = AwsResource::new(ResourceKind::RouteTable, "rtb-coverage".into());
    table.owner_account_id = Some(account.aws_account_id.clone());
    table.vpc_id = subnet.vpc_id.clone();
    table.associations.push(RouteAssociation {
        id: Some("rtbassoc-coverage".into()),
        main: true,
        subnet_id: None,
        gateway_id: None,
        state: Some("associated".into()),
    });
    let route = |cidr: &str, state: &str, key: &str, id: &str| ObservedRoute {
        ipv4_destination: Some(cidr.into()),
        ipv6_destination: None,
        prefix_list_destination: None,
        state: Some(state.into()),
        origin: Some("CreateRoute".into()),
        targets: [(key.into(), id.into())].into(),
    };
    table.routes = vec![
        route("0.0.0.0/0", "active", "transitGatewayId", "tgw-egress"),
        route("203.0.113.2/31", "blackhole", "natGatewayId", "nat-deleted"),
        route(
            "203.0.113.4/30",
            "active",
            "networkInterfaceId",
            "eni-uninterpreted",
        ),
    ];
    topology.resources.extend([subnet, table.clone()]);
    let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
    store
        .finish_aws_discovery("fixture", generation, &topology)
        .await?;
    let before = serde_json::to_value(store.aws_topology(&account.id).await?)?;
    let audit_before: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    let reader = "r".repeat(32);
    let app = api::router(AppState {
        store: store.clone(),
        auth: Arc::new(Auth::demo("a".repeat(32), reader.clone())?),
        aws: None,
    });
    let path = format!(
        "/aws/accounts/{}/vpc-cidr-coverage?subnet_id=subnet-coverage&destination_cidr=203.0.113.0/29",
        account.id
    );
    let (status, body) = request(&app, "GET", &path, Some(&reader), None).await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "A saved destination CIDR needs its own exact reader partition, not sampled point queries"
    );
    assert_eq!(
        request(&app, "GET", &path, None, None).await?.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(body["account_id"], account.id);
    assert_eq!(body["topology_id"], topology.id);
    assert_eq!(body["completed_at"], topology.completed_at);
    assert_eq!(body["aws_account_id"], account.aws_account_id);
    assert_eq!(body["region"], topology.region);
    assert_eq!(body["subnet_id"], "subnet-coverage");
    assert_eq!(body["destination_cidr"], "203.0.113.0/29");
    assert_eq!(
        body["limitations"],
        serde_json::to_value(&topology.limitations)?
    );
    assert_eq!(
        body["request_ids"],
        serde_json::to_value(&topology.request_ids)?
    );
    assert_eq!(body["complete_for_supported_queries"], true);
    assert_eq!(body["reference_only"], true);
    assert_eq!(body["execution_enabled"], false);
    assert_eq!(body["connectivity_tested"], false);
    for invalid in [
        format!("{path}&unknown=true"),
        format!("{path}&subnet_id=subnet-coverage"),
        format!("{path}&destination_cidr=203.0.113.0/29"),
        path.replace("subnet_id=subnet-coverage&", ""),
        path.replace("&destination_cidr=203.0.113.0/29", ""),
    ] {
        assert_eq!(
            request(&app, "GET", &invalid, Some(&reader), None).await?.0,
            StatusCode::BAD_REQUEST
        );
    }
    for invalid in [
        "203.0.113.1/29",
        "203.0.113.0",
        "203.0.113.0/029",
        "%20203.0.113.0/29",
        "2001:0DB8::/32",
        "::/129",
    ] {
        let (code, error) = request(
            &app,
            "GET",
            &path.replace("203.0.113.0/29", invalid),
            Some(&reader),
            None,
        )
        .await?;
        assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error["error"], "invalid_destination_cidr");
        assert!(error.get("coverage").is_none());
    }
    for invalid in ["", "bad%0Asubnet"] {
        let (code, error) = request(
            &app,
            "GET",
            &path.replace("subnet-coverage", invalid),
            Some(&reader),
            None,
        )
        .await?;
        assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error["error"], "invalid_subnet_input");
    }
    for oversized in [
        path.replace("subnet-coverage", &"x".repeat(2049)),
        path.replace("203.0.113.0/29", &"x".repeat(65)),
    ] {
        let (code, error) = request(&app, "GET", &oversized, Some(&reader), None).await?;
        assert_eq!(code, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error["error"], "input_too_large");
        assert!(error.get("segments").is_none());
    }
    assert_eq!(
        request(
            &app,
            "GET",
            &path.replace(&account.id, "missing"),
            Some(&reader),
            None
        )
        .await?
        .0,
        StatusCode::CONFLICT
    );
    let coverage = &body["coverage"];
    assert_eq!(coverage["partition_complete"], true);
    assert_eq!(
        coverage["table_evidence"]["original_table"],
        serde_json::to_value(&table)?
    );
    assert_eq!(coverage["table_evidence"]["source"], "implicit_main");
    let segments = coverage["segments"].as_array().unwrap();
    assert_eq!(segments.len(), 3);
    for (segment, (first, last, decision)) in segments.iter().zip([
        ("203.0.113.0", "203.0.113.1", "reported_route"),
        ("203.0.113.2", "203.0.113.3", "reported_blackhole"),
        ("203.0.113.4", "203.0.113.7", "unresolved"),
    ]) {
        assert_eq!(segment["start"], first);
        assert_eq!(segment["end_inclusive"], last);
        assert_eq!(segment["result"]["lookup"]["status"], decision);
    }
    assert_eq!(
        segments[2]["result"]["lookup"]["reason"],
        "unsupported_target"
    );
    // Exhaustive oracle only for this tiny test range; production must never enumerate addresses.
    for host in 0..8 {
        let ip = format!("203.0.113.{host}");
        let ordinal = u32::from(ip.parse::<std::net::Ipv4Addr>()?);
        let matches: Vec<_> = segments
            .iter()
            .filter(|cell| {
                let start = u32::from(
                    cell["start"]
                        .as_str()
                        .unwrap()
                        .parse::<std::net::Ipv4Addr>()
                        .unwrap(),
                );
                let end = u32::from(
                    cell["end_inclusive"]
                        .as_str()
                        .unwrap()
                        .parse::<std::net::Ipv4Addr>()
                        .unwrap(),
                );
                start <= ordinal && ordinal <= end
            })
            .collect();
        assert_eq!(matches.len(), 1);
        let (_, point) = request(
            &app,
            "GET",
            &format!(
                "/aws/accounts/{}/vpc-route-lookup?subnet_id=subnet-coverage&destination={ip}",
                account.id
            ),
            Some(&reader),
            None,
        )
        .await?;
        assert_eq!(matches[0]["result"], point["result"]);
        assert_eq!(
            point["result"],
            serde_json::to_value(vpc_lookup::lookup(&topology, "subnet-coverage", &ip))?
        );
    }
    assert_eq!(
        before,
        serde_json::to_value(store.aws_topology(&account.id).await?)?
    );
    assert_eq!(
        audit_before,
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit")
            .fetch_one(&store.pool)
            .await?
    );
    assert!(
        store.plans().await?.is_empty()
            && store.inventories().await?.is_empty()
            && store.operations().await?.is_empty()
    );
    assert_eq!(fixture.discoveries.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.verifications.load(Ordering::SeqCst), 0);
    // Explicit fixture generations only; each coverage GET must remain an offline read.
    let mut ipv6 = topology.clone();
    ipv6.id = uuid::Uuid::new_v4().to_string();
    ipv6.completed_at = "3".into();
    ipv6.resources[0].cidrs.push("2001:db8::/56".into());
    let selected = ipv6
        .resources
        .iter_mut()
        .find(|row| row.id == "rtb-coverage")
        .unwrap();
    selected.routes = vec![ObservedRoute {
        ipv4_destination: None,
        ipv6_destination: Some("::/0".into()),
        prefix_list_destination: None,
        state: Some("active".into()),
        origin: Some("CreateRoute".into()),
        targets: [("transitGatewayId".into(), "tgw-egress".into())].into(),
    }];
    let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
    store
        .finish_aws_discovery("fixture", generation, &ipv6)
        .await?;
    let ipv6_before = serde_json::to_value(store.aws_topology(&account.id).await?)?;
    let audit_ipv6: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    let (code, response) = request(
        &app,
        "GET",
        &path.replace("203.0.113.0/29", "::/0"),
        Some(&reader),
        None,
    )
    .await?;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(response["topology_id"], ipv6.id);
    let cells = response["coverage"]["segments"].as_array().unwrap();
    assert_eq!(cells.len(), 3);
    let service: ipnet::IpNet = "fd00:ec2::/32".parse()?;
    assert_eq!(cells[0]["start"], "::");
    assert_eq!(
        cells[2]["end_inclusive"],
        "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
    );
    assert_eq!(cells[1]["start"], service.network().to_string());
    assert_eq!(cells[1]["end_inclusive"], service.broadcast().to_string());
    assert_eq!(
        cells[1]["result"]["lookup"]["reason"],
        "reserved_service_destination"
    );
    assert_eq!(
        ipv6_before,
        serde_json::to_value(store.aws_topology(&account.id).await?)?
    );
    assert_eq!(
        audit_ipv6,
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit")
            .fetch_one(&store.pool)
            .await?
    );
    for dimension in ["route_rows", "table_output", "provenance_output"] {
        let mut large = ipv6.clone();
        large.id = uuid::Uuid::new_v4().to_string();
        large.completed_at = "4".into();
        let limit = vpc_cidr_coverage::CoverageBudget::default().response_bytes;
        match dimension {
            "route_rows" => {
                let selected = large
                    .resources
                    .iter_mut()
                    .find(|row| row.id == "rtb-coverage")
                    .unwrap();
                selected.routes.resize(1025, selected.routes[0].clone());
            }
            "table_output" => {
                large
                    .resources
                    .iter_mut()
                    .find(|row| row.id == "rtb-coverage")
                    .unwrap()
                    .tags
                    .insert("fixture".into(), "x".repeat(limit));
            }
            "provenance_output" => large.limitations.push("x".repeat(limit)),
            _ => unreachable!(),
        }
        let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
        store
            .finish_aws_discovery("fixture", generation, &large)
            .await?;
        let saved_before = serde_json::to_value(store.aws_topology(&account.id).await?)?;
        let audit_large: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
            .fetch_one(&store.pool)
            .await?;
        let (code, error) = request(
            &app,
            "GET",
            &path.replace("203.0.113.0/29", "::/0"),
            Some(&reader),
            None,
        )
        .await?;
        assert_eq!(code, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error["error"], "budget_exceeded");
        assert_eq!(
            error["dimension"],
            if dimension == "route_rows" {
                "route_rows"
            } else {
                "response_bytes"
            }
        );
        assert!(
            error.get("coverage").is_none()
                && error.get("segments").is_none()
                && error.get("partition_complete").is_none()
        );
        assert_eq!(
            saved_before,
            serde_json::to_value(store.aws_topology(&account.id).await?)?
        );
        assert_eq!(
            audit_large,
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit")
                .fetch_one(&store.pool)
                .await?
        );
    }
    assert_eq!(fixture.discoveries.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.verifications.load(Ordering::SeqCst), 0);
    Ok(())
}
#[tokio::test]
async fn saved_vpc_lookup_reads_selected_subnet_routes_offline_without_writes() -> anyhow::Result<()>
{
    let (store, _) = support::isolated().await?;
    let fixture = AwsFixture::default();
    let role: RoleRegistration = serde_json::from_value(registration())?;
    let account = store
        .register_aws_verified("fixture", &role, "123456789012", "fixture")
        .await?;
    let mut topology = fixture.discover(&role, &account, "fixture").await?;
    let vpc = &mut topology.resources[0];
    vpc.state = Some("available".into());
    let mut subnet = AwsResource::new(ResourceKind::Subnet, "subnet-fixture".into());
    subnet.vpc_id = Some(vpc.id.clone());
    subnet.owner_account_id = Some(account.aws_account_id.clone());
    subnet.state = Some("available".into());
    let mut table = AwsResource::new(ResourceKind::RouteTable, "rtb-main".into());
    table.vpc_id = Some(vpc.id.clone());
    table.owner_account_id = Some(account.aws_account_id.clone());
    table.associations.push(RouteAssociation {
        id: Some("rtbassoc-main".into()),
        subnet_id: None,
        gateway_id: None,
        main: true,
        state: Some("associated".into()),
    });
    table.routes.push(ObservedRoute {
        ipv4_destination: Some("0.0.0.0/0".into()),
        ipv6_destination: None,
        prefix_list_destination: None,
        state: Some("active".into()),
        origin: Some("CreateRoute".into()),
        targets: [("transitGatewayId".into(), "tgw-egress".into())].into(),
    });
    topology.resources.extend([subnet, table]);
    let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
    store
        .finish_aws_discovery("fixture", generation, &topology)
        .await?;
    let before = serde_json::to_value(store.aws_topology(&account.id).await?)?;
    let audit_before: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    let reader = "r".repeat(32);
    let app = api::router(AppState {
        store: store.clone(),
        auth: Arc::new(Auth::demo("a".repeat(32), reader.clone())?),
        aws: None,
    });
    let path = format!(
        "/aws/accounts/{}/vpc-route-lookup?subnet_id=subnet-fixture&destination=203.0.113.1",
        account.id
    );
    assert_eq!(
        request(&app, "GET", &path, None, None).await?.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, result) = request(&app, "GET", &path, Some(&reader), None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["topology_id"], topology.id);
    assert_eq!(result["subnet_id"], "subnet-fixture");
    assert_eq!(result["destination"], "203.0.113.1");
    assert_eq!(result["result"]["status"], "reported");
    assert_eq!(result["result"]["route_table_id"], "rtb-main");
    assert_eq!(result["result"]["source"], "implicit_main");
    assert_eq!(result["result"]["lookup"]["status"], "reported_route");
    assert_eq!(result["result"]["lookup"]["destination_cidr"], "0.0.0.0/0");
    assert_eq!(
        result["result"]["lookup"]["target"],
        json!({"kind":"transit_gateway","id":"tgw-egress"})
    );
    assert_eq!(result["execution_enabled"], false);
    assert_eq!(result["connectivity_tested"], false);
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("{path}&unexpected=true"),
            Some(&reader),
            None
        )
        .await?
        .0,
        StatusCode::BAD_REQUEST
    );
    for invalid in [
        path.replace("subnet-fixture", &"x".repeat(2049)),
        path.replace("203.0.113.1", &"x".repeat(65)),
    ] {
        assert_eq!(
            request(&app, "GET", &invalid, Some(&reader), None).await?.0,
            StatusCode::CONFLICT
        );
    }
    let (_, invalid) = request(
        &app,
        "GET",
        &path.replace("203.0.113.1", "not-an-ip"),
        Some(&reader),
        None,
    )
    .await?;
    assert_eq!(invalid["result"]["lookup"]["reason"], "invalid_destination");
    let (_, missing) = request(
        &app,
        "GET",
        &path.replace("subnet-fixture", "missing"),
        Some(&reader),
        None,
    )
    .await?;
    assert_eq!(missing["result"]["reason"], "missing_subnet");
    assert_eq!(
        before,
        serde_json::to_value(store.aws_topology(&account.id).await?)?
    );
    let audit_after: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    assert_eq!(audit_before, audit_after);
    assert!(store.plans().await?.is_empty());
    assert!(store.inventories().await?.is_empty());
    assert_eq!(fixture.verifications.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.discoveries.load(Ordering::SeqCst), 1);
    Ok(())
}
#[tokio::test]
async fn saved_source_handoff_binds_two_account_snapshots_and_az_without_writes()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let source_role: RoleRegistration = serde_json::from_value(registration())?;
    let network_role = RoleRegistration {
        name: "Fixture network owner".into(),
        role_arn: "arn:aws:iam::210987654321:role/Reader".into(),
        region: "eu-west-1".into(),
        external_id: None,
    };
    let source_account = store
        .register_aws_verified("fixture", &source_role, "123456789012", "fixture")
        .await?;
    let network_account = store
        .register_aws_verified("fixture", &network_role, "210987654321", "fixture")
        .await?;
    let owned = |kind, id: &str, owner: &str| {
        let mut row = AwsResource::new(kind, id.into());
        row.owner_account_id = Some(owner.into());
        row.state = Some("available".into());
        row
    };
    let mut vpc = owned(ResourceKind::Vpc, "vpc-source", "123456789012");
    vpc.cidrs.push("10.1.0.0/16".into());
    let mut source_subnet = owned(ResourceKind::Subnet, "subnet-source", "123456789012");
    source_subnet.vpc_id = Some(vpc.id.clone());
    source_subnet.az_id = Some("euw1-az1".into());
    source_subnet.cidrs.push("10.1.1.0/24".into());
    let mut attachment_subnet = source_subnet.clone();
    attachment_subnet.id = "subnet-attachment".into();
    attachment_subnet.cidrs = vec!["10.1.254.0/24".into()];
    let mut source_table = owned(ResourceKind::RouteTable, "rtb-source", "123456789012");
    source_table.vpc_id = Some(vpc.id.clone());
    source_table.associations.push(RouteAssociation {
        id: Some("rtbassoc-source".into()),
        main: true,
        subnet_id: None,
        gateway_id: None,
        state: Some("associated".into()),
    });
    source_table.routes.push(ObservedRoute {
        ipv4_destination: Some("0.0.0.0/0".into()),
        ipv6_destination: None,
        prefix_list_destination: None,
        state: Some("active".into()),
        origin: Some("CreateRoute".into()),
        targets: [("transitGatewayId".into(), "tgw-handoff".into())].into(),
    });
    let mut non_tgw = source_table.routes[0].clone();
    non_tgw.ipv4_destination = Some("203.0.113.4/30".into());
    non_tgw.targets = [("natGatewayId".into(), "nat-literal".into())].into();
    source_table.routes.push(non_tgw);
    let gateway = owned(ResourceKind::TransitGateway, "tgw-handoff", "210987654321");
    let mut attachment = owned(
        ResourceKind::VpcAttachment,
        "tgw-attach-source",
        "123456789012",
    );
    attachment.vpc_id = Some(vpc.id.clone());
    attachment.related_ids = vec![gateway.id.clone(), attachment_subnet.id.clone()];
    let mut network_table = owned(
        ResourceKind::TransitGatewayRouteTable,
        "tgw-rtb-network",
        "210987654321",
    );
    network_table.related_ids.push(gateway.id.clone());
    network_table.tgw_associations = Some(vec![TransitGatewayTableLink {
        attachment_id: Some(attachment.id.clone()),
        resource_id: Some(vpc.id.clone()),
        resource_type: Some("vpc".into()),
        state: Some("associated".into()),
        route_table_announcement_id: None,
    }]);
    network_table.tgw_routes = Some(vec![TransitGatewayRoute {
        destination_cidr: Some("0.0.0.0/0".into()),
        prefix_list_id: None,
        state: Some("active".into()),
        route_type: Some("static".into()),
        route_table_announcement_id: None,
        attachments: vec![TransitGatewayRouteAttachment {
            attachment_id: Some("tgw-attach-egress".into()),
            resource_id: None,
            resource_type: Some("vpc".into()),
        }],
    }]);
    let mut internal = network_table.tgw_routes.as_ref().unwrap()[0].clone();
    internal.destination_cidr = Some("203.0.113.2/31".into());
    internal.state = Some("blackhole".into());
    internal.attachments.clear();
    network_table.tgw_routes.as_mut().unwrap().push(internal);
    let snapshot = |account: &VerifiedAccount, resources, completed: &str| AwsTopology {
        id: uuid::Uuid::new_v4().to_string(),
        account_id: account.id.clone(),
        aws_account_id: account.aws_account_id.clone(),
        region: account.region.clone(),
        started_at: "1".into(),
        completed_at: completed.into(),
        session_name: "offline-handoff-fixture".into(),
        resources,
        request_ids: vec![],
        complete_for_supported_queries: true,
        limitations: vec![
            "Independent saved observations, not contemporaneous or measured traffic".into(),
        ],
        execution_enabled: false,
        connectivity_tested: false,
    };
    let mut attachment_table = owned(
        ResourceKind::RouteTable,
        "rtb-source-attachment",
        "123456789012",
    );
    attachment_table.vpc_id = Some(vpc.id.clone());
    attachment_table.associations.push(RouteAssociation {
        id: Some("rtbassoc-source-attachment".into()),
        main: false,
        subnet_id: Some(attachment_subnet.id.clone()),
        gateway_id: None,
        state: Some("associated".into()),
    });
    attachment_table.routes = vec![
        ObservedRoute {
            ipv4_destination: Some("10.1.0.0/16".into()),
            ipv6_destination: None,
            prefix_list_destination: None,
            state: Some("active".into()),
            origin: Some("CreateRouteTable".into()),
            targets: [("gatewayId".into(), "local".into())].into(),
        },
        ObservedRoute {
            ipv4_destination: Some("10.1.1.0/24".into()),
            ipv6_destination: None,
            prefix_list_destination: None,
            state: Some("blackhole".into()),
            origin: Some("CreateRoute".into()),
            targets: [("natGatewayId".into(), "nat-deleted".into())].into(),
        },
    ];
    let source = snapshot(
        &source_account,
        vec![
            vpc,
            source_subnet,
            attachment_subnet,
            source_table,
            attachment_table,
        ],
        "3",
    );
    let network = snapshot(
        &network_account,
        vec![gateway, attachment, network_table],
        "7",
    );
    for (account, topology) in [(&source_account, &source), (&network_account, &network)] {
        let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
        store
            .finish_aws_discovery("fixture", generation, topology)
            .await?;
    }
    let before = [
        serde_json::to_value(store.aws_topology(&source_account.id).await?)?,
        serde_json::to_value(store.aws_topology(&network_account.id).await?)?,
    ];
    // Real saved-reader composition; the existing HTTP point assertions remain independent below.
    use navarchnet::aws::{
        saved_observation::SavedObservationReadBudget,
        source_handoff_cidr_coverage::{self, SourceHandoffCidrBudget, SourceHandoffCidrQuery},
    };
    let composition_audit: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    let read_budget = SavedObservationReadBudget::default();
    let saved_source = store
        .aws_saved_observation_bounded(&source_account.id, read_budget)
        .await?;
    let saved_network = store
        .aws_saved_observation_bounded(
            &network_account.id,
            SavedObservationReadBudget {
                total_bytes: read_budget
                    .total_bytes
                    .checked_sub(saved_source.admitted_bytes)
                    .unwrap(),
                ..read_budget
            },
        )
        .await?;
    let coverage = source_handoff_cidr_coverage::analyze(
        saved_source,
        saved_network,
        SourceHandoffCidrQuery {
            source_account_id: source_account.id.clone(),
            network_account_id: network_account.id.clone(),
            subnet_id: "subnet-source".into(),
            destination_cidr: "203.0.113.0/29".into(),
        },
        SourceHandoffCidrBudget::default(),
    )?;
    assert!(coverage.partition_complete && coverage.reference_only);
    assert!(
        !coverage.execution_enabled
            && !coverage.connectivity_tested
            && !coverage.simultaneous_snapshots
    );
    assert_eq!(coverage.source_saved.topology.id, source.id);
    assert_eq!(coverage.network_saved.topology.id, network.id);
    assert_eq!(
        serde_json::to_value(&coverage.source_saved.registration)?,
        serde_json::to_value(&source_account)?
    );
    assert_eq!(
        serde_json::to_value(&coverage.network_saved.registration)?,
        serde_json::to_value(&network_account)?
    );
    assert_eq!(coverage.source_saved.topology.completed_at, "3");
    assert_eq!(coverage.network_saved.topology.completed_at, "7");
    assert_eq!(coverage.segments.len(), 3);
    for host in 0..8 {
        let ip = format!("203.0.113.{host}");
        let ordinal = u32::from(ip.parse::<std::net::Ipv4Addr>()?);
        let cells: Vec<_> = coverage
            .segments
            .iter()
            .filter(|cell| {
                u32::from(cell.start.parse::<std::net::Ipv4Addr>().unwrap()) <= ordinal
                    && ordinal
                        <= u32::from(cell.end_inclusive.parse::<std::net::Ipv4Addr>().unwrap())
            })
            .collect();
        assert_eq!(cells.len(), 1);
        assert_eq!(
            cells[0].result,
            navarchnet::aws::source_handoff::lookup(&source, &network, "subnet-source", &ip)
        );
    }
    let audit_before: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    assert_eq!(audit_before, composition_audit);
    let reader = "r".repeat(32);
    let app = api::router(AppState {
        store: store.clone(),
        auth: Arc::new(Auth::demo("a".repeat(32), reader.clone())?),
        aws: None,
    });
    let path = format!(
        "/aws/accounts/{}/tgw-source-lookup?network_account_id={}&subnet_id=subnet-source&destination=203.0.113.1",
        source_account.id, network_account.id
    );
    let cidr_path = format!(
        "/aws/accounts/{}/tgw-source-cidr-coverage?network_account_id={}&subnet_id=subnet-source&destination_cidr=203.0.113.0/29",
        source_account.id, network_account.id
    );
    let (code, http_coverage) = request(&app, "GET", &cidr_path, Some(&reader), None).await?;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(http_coverage, serde_json::to_value(&coverage)?);
    for cell in &coverage.segments {
        let (code, point) = request(
            &app,
            "GET",
            &path.replace("203.0.113.1", &cell.start),
            Some(&reader),
            None,
        )
        .await?;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(point["result"], serde_json::to_value(&cell.result)?);
        assert_eq!(
            point["source_topology_id"],
            coverage.source_saved.topology.id
        );
        assert_eq!(
            point["network_topology_id"],
            coverage.network_saved.topology.id
        );
    }
    assert_eq!(
        request(&app, "GET", &path, None, None).await?.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, result) = request(&app, "GET", &path, Some(&reader), None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["source_topology_id"], source.id);
    assert_eq!(result["network_topology_id"], network.id);
    assert_eq!(result["source_completed_at"], "3");
    assert_eq!(result["network_completed_at"], "7");
    assert_eq!(result["network_account_id"], network_account.id);
    assert_eq!(result["result"]["source"]["route_table_id"], "rtb-source");
    let handoff = &result["result"]["handoff"];
    assert_eq!(handoff["status"], "reported_candidate");
    assert_eq!(handoff["transit_gateway_id"], "tgw-handoff");
    assert_eq!(handoff["ingress_attachment_id"], "tgw-attach-source");
    assert_eq!(handoff["attachment_subnet_id"], "subnet-attachment");
    assert_eq!(handoff["az_id"], "euw1-az1");
    assert_eq!(handoff["route_table_id"], "tgw-rtb-network");
    assert_eq!(handoff["lookup"]["status"], "reported_forward");
    // Existing SDK-off APIs compose a hypothetical point check, not a proven return route.
    for (destination, status, cidr) in [
        ("10.1.254.10", "reported_route", "10.1.0.0/16"),
        ("10.1.1.10", "reported_blackhole", "10.1.1.0/24"),
    ] {
        let child_path = format!(
            "/aws/accounts/{}/vpc-route-lookup?subnet_id=subnet-attachment&destination={destination}",
            source_account.id
        );
        let (code, child) = request(&app, "GET", &child_path, Some(&reader), None).await?;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(child["topology_id"], source.id);
        assert_eq!(child["subnet_id"], handoff["attachment_subnet_id"]);
        assert_eq!(child["destination"], destination);
        assert_eq!(child["result"]["route_table_id"], "rtb-source-attachment");
        assert_eq!(child["result"]["source"], "explicit_subnet");
        assert_eq!(child["result"]["lookup"]["status"], status);
        assert_eq!(child["result"]["lookup"]["destination_cidr"], cidr);
        assert_eq!(child["execution_enabled"], false);
        assert_eq!(child["connectivity_tested"], false);
        assert!(child.get("completed_at").is_none() && child.get("account_id").is_none());
    }
    assert_eq!(result["execution_enabled"], false);
    assert_eq!(result["connectivity_tested"], false);
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("{path}&unexpected=true"),
            Some(&reader),
            None
        )
        .await?
        .0,
        StatusCode::BAD_REQUEST
    );
    for oversized in [
        path.replace("subnet-source", &"x".repeat(2049)),
        path.replace(&network_account.id, &"x".repeat(2049)),
        path.replace("203.0.113.1", &"x".repeat(65)),
    ] {
        assert_eq!(
            request(&app, "GET", &oversized, Some(&reader), None)
                .await?
                .0,
            StatusCode::CONFLICT
        );
    }
    let (_, invalid) = request(
        &app,
        "GET",
        &path.replace("203.0.113.1", "not-an-ip"),
        Some(&reader),
        None,
    )
    .await?;
    assert_eq!(
        invalid["result"]["source"]["lookup"]["reason"],
        "invalid_destination"
    );
    assert_eq!(
        invalid["result"]["handoff"]["reason"],
        "source_route_unresolved"
    );
    assert_eq!(
        before,
        [
            serde_json::to_value(store.aws_topology(&source_account.id).await?)?,
            serde_json::to_value(store.aws_topology(&network_account.id).await?)?
        ]
    );
    let audit_after: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    assert_eq!(audit_before, audit_after);
    assert!(store.plans().await?.is_empty());
    assert!(store.inventories().await?.is_empty());
    // An independently completed generation changes latest GET identity; consumers must refresh.
    let refreshed = snapshot(&source_account, source.resources.clone(), "8");
    let (_, _, generation) = store
        .begin_aws_discovery("fixture", &source_account.id)
        .await?;
    store
        .finish_aws_discovery("fixture", generation, &refreshed)
        .await?;
    let refreshed_before = serde_json::to_value(store.aws_topology(&source_account.id).await?)?;
    let audit_refreshed: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    let (code, child) = request(
        &app,
        "GET",
        &format!(
            "/aws/accounts/{}/vpc-route-lookup?subnet_id=subnet-attachment&destination=10.1.254.10",
            source_account.id
        ),
        Some(&reader),
        None,
    )
    .await?;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(child["topology_id"], refreshed.id);
    assert_ne!(child["topology_id"], result["source_topology_id"]);
    assert_eq!(
        refreshed_before,
        serde_json::to_value(store.aws_topology(&source_account.id).await?)?
    );
    assert_eq!(
        audit_refreshed,
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit")
            .fetch_one(&store.pool)
            .await?
    );
    // Additional acceptance of the already implemented reference GET. All original
    // assertions above finish before a new immutable network generation is prepared.
    let mut egress_vpc = owned(
        ResourceKind::Vpc,
        "vpc-egress",
        &network_account.aws_account_id,
    );
    egress_vpc.cidrs = vec!["10.2.0.0/16".into()];
    let mut egress_attachment = owned(
        ResourceKind::VpcAttachment,
        "tgw-attach-egress",
        &network_account.aws_account_id,
    );
    egress_attachment.vpc_id = Some(egress_vpc.id.clone());
    egress_attachment.related_ids = vec![
        "tgw-handoff".into(),
        "subnet-egress-b".into(),
        "subnet-egress-a".into(),
    ];
    let mut egress_a = owned(
        ResourceKind::Subnet,
        "subnet-egress-a",
        &network_account.aws_account_id,
    );
    egress_a.vpc_id = Some(egress_vpc.id.clone());
    egress_a.az_id = Some("euw1-az1".into());
    egress_a.cidrs = vec!["10.2.1.0/24".into()];
    let mut egress_b = egress_a.clone();
    egress_b.id = "subnet-egress-b".into();
    egress_b.az_id = Some("euw1-az2".into());
    egress_b.cidrs = vec!["10.2.2.0/24".into()];
    let mut egress_main = owned(
        ResourceKind::RouteTable,
        "rtb-egress-main",
        &network_account.aws_account_id,
    );
    egress_main.vpc_id = Some(egress_vpc.id.clone());
    egress_main.associations = vec![RouteAssociation {
        id: Some("assoc-egress-main".into()),
        main: true,
        subnet_id: None,
        gateway_id: None,
        state: Some("associated".into()),
    }];
    egress_main.routes = vec![ObservedRoute {
        ipv4_destination: Some("0.0.0.0/0".into()),
        ipv6_destination: None,
        prefix_list_destination: None,
        state: Some("active".into()),
        origin: Some("CreateRoute".into()),
        targets: [("natGatewayId".into(), "nat-unknown-literal".into())].into(),
    }];
    let mut egress_second = egress_main.clone();
    egress_second.id = "rtb-egress-b".into();
    egress_second.associations[0].id = Some("assoc-egress-b".into());
    egress_second.associations[0].main = false;
    egress_second.associations[0].subnet_id = Some(egress_b.id.clone());
    for destination in ["203.0.113.1/32", "203.0.113.5/32"] {
        let mut blackhole = egress_second.routes[0].clone();
        blackhole.ipv4_destination = Some(destination.into());
        blackhole.state = Some("blackhole".into());
        blackhole.targets.clear();
        egress_second.routes.push(blackhole);
    }
    let mut resources = network.resources.clone();
    resources.extend([
        egress_vpc,
        egress_attachment,
        egress_b,
        egress_main,
        egress_a,
        egress_second,
    ]);
    let extended_network = snapshot(&network_account, resources, "9");
    let (_, _, generation) = store
        .begin_aws_discovery("fixture", &network_account.id)
        .await?;
    store
        .finish_aws_discovery("fixture", generation, &extended_network)
        .await?;
    let fingerprint = || async {
        let tables = sqlx::query_scalar::<_, String>(
            "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename",
        )
        .fetch_all(&store.pool)
        .await?;
        let mut state = serde_json::Map::new();
        for table in tables {
            let quoted = table.replace('"', "\"\"");
            let sql = format!(
                "SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM \"{quoted}\" t"
            );
            let rows = sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(sql))
                .fetch_one(&store.pool)
                .await?;
            state.insert(table, rows);
        }
        let catalog=sqlx::query_scalar::<_,Value>(r#"SELECT jsonb_build_object(
            'relations',(SELECT jsonb_agg(to_jsonb(c) ORDER BY oid) FROM pg_class c WHERE relnamespace=current_schema()::regnamespace),
            'columns',(SELECT jsonb_agg(to_jsonb(a) ORDER BY attrelid,attnum) FROM pg_attribute a WHERE attrelid IN (SELECT oid FROM pg_class WHERE relnamespace=current_schema()::regnamespace)),
            'constraints',(SELECT jsonb_agg(to_jsonb(c) ORDER BY oid) FROM pg_constraint c WHERE connamespace=current_schema()::regnamespace),
            'indexes',(SELECT jsonb_agg(to_jsonb(i) ORDER BY indexrelid) FROM pg_index i WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace=current_schema()::regnamespace)),
            'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY oid) FROM pg_trigger t WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace=current_schema()::regnamespace)),
            'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY oid) FROM pg_proc p WHERE pronamespace=current_schema()::regnamespace),
            'sequences',(SELECT jsonb_agg(to_jsonb(s) ORDER BY sequencename) FROM pg_sequences s WHERE schemaname=current_schema()))"#).fetch_one(&store.pool).await?;
        state.insert("catalog".into(), catalog);
        Ok::<Value, anyhow::Error>(Value::Object(state))
    };
    let raw_before = fingerprint().await?;
    use navarchnet::aws::{
        source_target_cidr_reference::{self, SourceTargetCidrBudget, SourceTargetCidrQuery},
        target_lookup::{self, TargetAzSelection, TargetVpcLookup},
    };
    let budget = SavedObservationReadBudget::default();
    let source_capture = store
        .aws_saved_observation_bounded(&source_account.id, budget)
        .await?;
    let network_capture = store
        .aws_saved_observation_bounded(
            &network_account.id,
            SavedObservationReadBudget {
                total_bytes: budget
                    .total_bytes
                    .checked_sub(source_capture.admitted_bytes)
                    .unwrap(),
                ..budget
            },
        )
        .await?;
    let joint = source_target_cidr_reference::analyze(
        source_capture,
        network_capture,
        SourceTargetCidrQuery {
            source_account_id: source_account.id.clone(),
            network_account_id: network_account.id.clone(),
            subnet_id: "subnet-source".into(),
            transit_gateway_id: "tgw-handoff".into(),
            target_attachment_id: "tgw-attach-egress".into(),
            destination_cidr: "203.0.113.0/29".into(),
        },
        SourceTargetCidrBudget::default(),
    )?;
    assert_eq!(joint.source.source_saved.saved_row_id, refreshed.id);
    assert_eq!(joint.target.network_saved.saved_row_id, extended_network.id);
    assert_eq!(joint.source.source_saved.topology.completed_at, "8");
    assert_eq!(joint.target.network_saved.topology.completed_at, "9");
    assert_eq!(joint.source.source_saved.registration.id, source_account.id);
    assert_eq!(
        joint.target.network_saved.registration.id,
        network_account.id
    );
    assert_ne!(source_account.id, network_account.id);
    assert_eq!(
        serde_json::to_value(&joint.source.network_saved)?,
        serde_json::to_value(&joint.target.network_saved)?
    );
    assert_eq!(joint.target.az_selection, TargetAzSelection::NotInferred);
    assert!(joint.reference_only && joint.partition_complete);
    assert!(
        !joint.execution_enabled && !joint.connectivity_tested && !joint.simultaneous_snapshots
    );
    assert_eq!(
        (
            joint.source.segments.len(),
            joint.target.segments.len(),
            joint.segments.len()
        ),
        (3, 5, 6)
    );
    for host in 0..8 {
        let ip = format!("203.0.113.{host}");
        let ordinal = u32::from(ip.parse::<std::net::Ipv4Addr>()?);
        let cells: Vec<_> = joint
            .segments
            .iter()
            .filter(|cell| {
                u32::from(cell.start.parse::<std::net::Ipv4Addr>().unwrap()) <= ordinal
                    && ordinal
                        <= u32::from(cell.end_inclusive.parse::<std::net::Ipv4Addr>().unwrap())
            })
            .collect();
        assert_eq!(cells.len(), 1);
        let cell = cells[0];
        let source_cell = &joint.source.segments[cell.source_segment_index];
        let target_cell = &joint.target.segments[cell.target_segment_index];
        for (start, end) in [
            (&source_cell.start, &source_cell.end_inclusive),
            (&target_cell.start, &target_cell.end_inclusive),
        ] {
            assert!(
                u32::from(start.parse::<std::net::Ipv4Addr>()?)
                    <= u32::from(cell.start.parse::<std::net::Ipv4Addr>()?)
            );
            assert!(
                u32::from(cell.end_inclusive.parse::<std::net::Ipv4Addr>()?)
                    <= u32::from(end.parse::<std::net::Ipv4Addr>()?)
            );
        }
        assert_eq!(
            source_cell.result,
            navarchnet::aws::source_handoff::lookup(
                &refreshed,
                &extended_network,
                "subnet-source",
                &ip
            )
        );
        assert_eq!(
            target_cell.result,
            target_lookup::lookup(&extended_network, "tgw-handoff", "tgw-attach-egress", &ip)
        );
        assert_eq!(cell.selected_reference_matches, host < 2);
        let TargetVpcLookup::ReportedSubnets { subnets, .. } = &target_cell.result else {
            panic!("both target entries required even without a source match")
        };
        assert_eq!(subnets.len(), 2);
        assert_eq!(subnets[0].subnet_id, "subnet-egress-a");
        assert_eq!(subnets[1].subnet_id, "subnet-egress-b");
        let a = serde_json::to_value(&subnets[0])?;
        let b = serde_json::to_value(&subnets[1])?;
        assert_eq!(a["lookup"]["source"], "implicit_main");
        assert_eq!(b["lookup"]["source"], "explicit_subnet");
        assert_eq!(a["lookup"]["lookup"]["status"], "reported_route");
        assert_eq!(
            b["lookup"]["lookup"]["status"],
            if host == 1 || host == 5 {
                "reported_blackhole"
            } else {
                "reported_route"
            }
        );
    }
    // The request uses the real protected router; no mocked response or new production fixture API.
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("network_account_id", &network_account.id)
        .append_pair("subnet_id", "subnet-source")
        .append_pair("transit_gateway_id", "tgw-handoff")
        .append_pair("target_attachment_id", "tgw-attach-egress")
        .append_pair("destination_cidr", "203.0.113.0/29")
        .finish();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/v1/aws/accounts/{}/tgw-source-target-cidr-reference?{query}",
                    source_account.id
                ))
                .header("authorization", format!("Bearer {reader}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let bytes = to_bytes(
        response.into_body(),
        SourceTargetCidrBudget::default().response_bytes,
    )
    .await?;
    assert_eq!(bytes.as_ref(), serde_json::to_vec(&joint)?);
    assert_eq!(
        raw_before,
        fingerprint().await?,
        "complete raw tables/catalog remain unchanged by bounded reads, core and HTTP composition"
    );
    Ok(())
}
#[tokio::test]
async fn saved_target_lookup_reports_all_declared_subnet_entries_without_selecting_an_az_or_writes()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let role: RoleRegistration = serde_json::from_value(registration())?;
    let account = store
        .register_aws_verified("fixture", &role, "123456789012", "fixture")
        .await?;
    let owned = |kind, id: &str| {
        let mut row = AwsResource::new(kind, id.into());
        row.owner_account_id = Some("123456789012".into());
        row.state = Some("available".into());
        row
    };
    let gateway = owned(ResourceKind::TransitGateway, "tgw-target");
    let mut attachment = owned(ResourceKind::VpcAttachment, "tgw-attach-target");
    attachment.vpc_id = Some("vpc-target".into());
    attachment.related_ids = vec![
        gateway.id.clone(),
        "subnet-target-b".into(),
        "subnet-target-a".into(),
    ];
    let mut vpc = owned(ResourceKind::Vpc, "vpc-target");
    vpc.cidrs = vec!["10.20.0.0/16".into()];
    let mut subnet_a = owned(ResourceKind::Subnet, "subnet-target-a");
    subnet_a.vpc_id = Some(vpc.id.clone());
    subnet_a.az_id = Some("euw1-az1".into());
    subnet_a.cidrs = vec!["10.20.1.0/24".into()];
    let mut subnet_b = subnet_a.clone();
    subnet_b.id = "subnet-target-b".into();
    subnet_b.az_id = Some("euw1-az2".into());
    subnet_b.cidrs = vec!["10.20.2.0/24".into()];
    let mut table = owned(ResourceKind::RouteTable, "rtb-target");
    table.vpc_id = Some(vpc.id.clone());
    table.associations.push(RouteAssociation {
        id: Some("rtbassoc-target".into()),
        main: true,
        subnet_id: None,
        gateway_id: None,
        state: Some("associated".into()),
    });
    table.routes.push(ObservedRoute {
        ipv4_destination: Some("0.0.0.0/0".into()),
        ipv6_destination: None,
        prefix_list_destination: None,
        state: Some("active".into()),
        origin: Some("CreateRoute".into()),
        targets: [("natGatewayId".into(), "nat-regional-target".into())].into(),
    });
    let mut nat = owned(ResourceKind::NatGateway, "nat-regional-target");
    nat.availability_mode = Some("regional".into());
    nat.connectivity_type = Some("public".into());
    // A regional NAT need not have a public subnet; this API only reports route references.
    assert!(nat.subnet_id.is_none());
    let topology = AwsTopology {
        id: uuid::Uuid::new_v4().to_string(),
        account_id: account.id.clone(),
        aws_account_id: account.aws_account_id.clone(),
        region: account.region.clone(),
        started_at: "1".into(),
        completed_at: "3".into(),
        session_name: "offline-target-fixture".into(),
        resources: vec![gateway, attachment, vpc, subnet_b, table, subnet_a, nat],
        request_ids: vec![],
        complete_for_supported_queries: true,
        limitations: vec![
            "All declared target subnet entries, no selected traffic AZ or measured path".into(),
        ],
        execution_enabled: false,
        connectivity_tested: false,
    };
    let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
    store
        .finish_aws_discovery("fixture", generation, &topology)
        .await?;
    let before = serde_json::to_value(store.aws_topology(&account.id).await?)?;
    let audit_before: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    let reader = "r".repeat(32);
    let app = api::router(AppState {
        store: store.clone(),
        auth: Arc::new(Auth::demo("a".repeat(32), reader.clone())?),
        aws: None,
    });
    let path = format!(
        "/aws/accounts/{}/tgw-target-lookup?transit_gateway_id=tgw-target&target_attachment_id=tgw-attach-target&destination=203.0.113.1",
        account.id
    );
    assert_eq!(
        request(&app, "GET", &path, None, None).await?.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, result) = request(&app, "GET", &path, Some(&reader), None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["topology_id"], topology.id);
    assert_eq!(result["completed_at"], "3");
    assert_eq!(result["transit_gateway_id"], "tgw-target");
    assert_eq!(result["target_attachment_id"], "tgw-attach-target");
    assert_eq!(result["destination"], "203.0.113.1");
    assert_eq!(result["az_selection"], "not_inferred");
    assert_eq!(result["execution_enabled"], false);
    assert_eq!(result["connectivity_tested"], false);
    assert_eq!(result["result"]["status"], "reported_subnets");
    assert_eq!(result["result"]["vpc_id"], "vpc-target");
    let subnets = result["result"]["subnets"].as_array().unwrap();
    assert_eq!(subnets.len(), 2);
    for (entry, id, az) in [
        (&subnets[0], "subnet-target-a", "euw1-az1"),
        (&subnets[1], "subnet-target-b", "euw1-az2"),
    ] {
        assert_eq!(entry["subnet_id"], id);
        assert_eq!(entry["az_id"], az);
        assert_eq!(entry["lookup"]["route_table_id"], "rtb-target");
        assert_eq!(entry["lookup"]["source"], "implicit_main");
        assert_eq!(
            entry["lookup"]["lookup"]["target"],
            json!({"kind":"nat_gateway","id":"nat-regional-target"})
        );
    }
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("{path}&unexpected=true"),
            Some(&reader),
            None
        )
        .await?
        .0,
        StatusCode::BAD_REQUEST
    );
    for oversized in [
        path.replace(
            "transit_gateway_id=tgw-target",
            &format!("transit_gateway_id={}", "x".repeat(2049)),
        ),
        path.replace("tgw-attach-target", &"x".repeat(2049)),
        path.replace("203.0.113.1", &"x".repeat(65)),
    ] {
        assert_eq!(
            request(&app, "GET", &oversized, Some(&reader), None)
                .await?
                .0,
            StatusCode::CONFLICT
        );
    }
    assert_eq!(
        before,
        serde_json::to_value(store.aws_topology(&account.id).await?)?
    );
    let audit_after: i64 = sqlx::query_scalar("SELECT count(*) FROM audit")
        .fetch_one(&store.pool)
        .await?;
    assert_eq!(audit_before, audit_after);
    assert!(store.plans().await?.is_empty());
    assert!(store.inventories().await?.is_empty());
    Ok(())
}
#[tokio::test]
async fn disabled_provider_rejects_admin_onboarding_without_sdk_or_credential_loading()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let app = api::router(AppState {
        store: store.clone(),
        auth: Arc::new(Auth::demo("a".repeat(32), "r".repeat(32))?),
        aws: None,
    });
    let (status, error) = request(
        &app,
        "POST",
        "/aws/accounts",
        Some(&"a".repeat(32)),
        Some(registration()),
    )
    .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(error["error"].as_str().unwrap().contains("disabled"));
    assert!(store.aws_accounts().await?.is_empty());
    Ok(())
}
