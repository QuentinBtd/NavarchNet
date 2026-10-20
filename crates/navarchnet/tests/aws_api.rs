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
                resources: vec![vpc, foreign, table, parent],
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
