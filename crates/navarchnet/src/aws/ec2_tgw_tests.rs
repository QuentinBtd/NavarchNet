//! Loopback-only scoped TGW read fixtures; no emulator or ambient credentials.
use super::*;
use aws_credential_types::{Credentials, provider::SharedCredentialsProvider};
use axum::{
    Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
};
use std::sync::{Arc, Mutex};
type Requests = Arc<Mutex<Vec<BTreeMap<String, String>>>>;
#[derive(Clone)]
struct Fixture {
    mode: u8,
    requests: Requests,
}
const TABLE: &str = "tgw-rtb-01111111111111111";
async fn handler(
    State(f): State<Fixture>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    assert!(
        headers["authorization"]
            .to_str()
            .unwrap()
            .contains("Credential=ASIAEXAMPLEONLY/")
    );
    let fields: BTreeMap<String, String> = form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect();
    f.requests.lock().unwrap().push(fields.clone());
    let action = fields["Action"].as_str();
    let content = if action == "DescribeTransitGatewayRouteTables" {
        format!(
            "<transitGatewayRouteTables><item><transitGatewayRouteTableId>{TABLE}</transitGatewayRouteTableId><ownerId>123456789012</ownerId></item></transitGatewayRouteTables>"
        )
    } else if action == "GetTransitGatewayRouteTableAssociations" {
        assert_eq!(
            fields.get("TransitGatewayRouteTableId").map(String::as_str),
            Some(TABLE)
        );
        if f.mode == 2 {
            "<associations/><nextToken>cycle</nextToken>".into()
        } else if f.mode == 3 {
            String::new()
        } else if fields.contains_key("NextToken") {
            let id = if f.mode == 4 {
                "tgw-attach-a"
            } else {
                "tgw-attach-b"
            };
            format!(
                "<associations><item><transitGatewayAttachmentId>{id}</transitGatewayAttachmentId><resourceId>vpc-b</resourceId><resourceType>future-type</resourceType><state>disassociating</state></item></associations>"
            )
        } else {
            "<associations><item><transitGatewayAttachmentId>tgw-attach-a</transitGatewayAttachmentId><resourceId>vpc-a</resourceId><resourceType>vpc</resourceType><state>associated</state></item></associations><nextToken>next+/=</nextToken>".into()
        }
    } else if action == "GetTransitGatewayRouteTablePropagations" {
        assert_eq!(
            fields.get("TransitGatewayRouteTableId").map(String::as_str),
            Some(TABLE)
        );
        if f.mode == 1 {
            return (StatusCode::FORBIDDEN,"<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>do-not-echo-fixture-message</Message></Error></Errors></Response>".into());
        }
        "<transitGatewayRouteTablePropagations><item><transitGatewayAttachmentId>tgw-attach-a</transitGatewayAttachmentId><resourceId>vpc-a</resourceId><resourceType>vpc</resourceType><state>enabled</state></item><item><transitGatewayRouteTableAnnouncementId>tgw-rtb-announcement-a</transitGatewayRouteTableAnnouncementId><resourceType>future-type</resourceType><state>enabling</state></item></transitGatewayRouteTablePropagations>".into()
    } else {
        let set = QUERIES.iter().find(|q| q.0 == action).unwrap().1;
        format!("<{set}/>")
    };
    (
        StatusCode::OK,
        format!("<{action}Response><requestId>fixture</requestId>{content}</{action}Response>"),
    )
}
async fn run(mode: u8) -> (anyhow::Result<(Vec<AwsResource>, Vec<String>)>, Requests) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route("/", post(handler)).with_state(Fixture {
        mode,
        requests: requests.clone(),
    });
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let adapter = Ec2ReadOnly {
        client: transport(false).unwrap(),
        endpoint: format!("http://{address}/"),
        region: "eu-west-1".into(),
        credentials: super::super::session::TemporaryCredentials::new(
            SharedCredentialsProvider::new(Credentials::new(
                "ASIAEXAMPLEONLY",
                "fixture-key",
                Some("fixture-session".into()),
                Some(std::time::SystemTime::now() + std::time::Duration::from_secs(3600)),
                "test",
            )),
        ),
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(3), adapter.discover()).await;
    server.abort();
    (
        result.expect("Loopback TGW fixture exceeded its deadline"),
        requests,
    )
}
#[tokio::test]
async fn discovers_scoped_paginated_tgw_associations_and_propagations_without_ownership_or_path_claims()
 {
    let (result, requests) = run(0).await;
    let (resources, ids) = result.unwrap();
    let table = resources
        .iter()
        .find(|r| r.kind == ResourceKind::TransitGatewayRouteTable)
        .unwrap();
    let associations = table
        .tgw_associations
        .as_ref()
        .expect("TGW associations were not queried");
    assert_eq!(associations.len(), 2);
    assert_eq!(
        associations[1].resource_type.as_deref(),
        Some("future-type")
    );
    assert_eq!(associations[1].state.as_deref(), Some("disassociating"));
    let propagations = table
        .tgw_propagations
        .as_ref()
        .expect("TGW propagations were not queried");
    assert_eq!(propagations.len(), 2);
    assert_eq!(
        propagations[1].route_table_announcement_id.as_deref(),
        Some("tgw-rtb-announcement-a")
    );
    assert!(!table.managed);
    assert_eq!(ids.len(), QUERIES.len() + 3);
    let requests = requests.lock().unwrap();
    let pages: Vec<_> = requests
        .iter()
        .filter(|r| r["Action"] == "GetTransitGatewayRouteTableAssociations")
        .collect();
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[1]["NextToken"], "next+/=");
}
#[tokio::test]
async fn scoped_tgw_failures_cycles_missing_collections_and_duplicate_links_abort_the_scan() {
    for mode in 1..=4 {
        let (result, requests) = run(mode).await;
        assert!(
            result.is_err(),
            "Published incomplete TGW scan for mode{mode}"
        );
        let error = result.unwrap_err().to_string();
        assert!(!error.contains("do-not-echo-fixture-message"));
        assert!(requests.lock().unwrap().len() <= QUERIES.len() + 3);
    }
}
#[test]
fn legacy_tgw_rows_distinguish_unqueried_from_a_completed_empty_read() {
    let old:AwsResource=serde_json::from_value(serde_json::json!({"kind":"transit_gateway_route_table","id":TABLE,"owner_account_id":null,"vpc_id":null,"subnet_id":null,"az_id":null,"state":null,"cidrs":[],"public_ips":[],"private_ips":[],"tags":{},"routes":[],"associations":[],"related_ids":[],"connectivity_type":null,"availability_mode":null,"managed":false})).unwrap();
    assert!(old.tgw_associations.is_none() && old.tgw_propagations.is_none());
}
