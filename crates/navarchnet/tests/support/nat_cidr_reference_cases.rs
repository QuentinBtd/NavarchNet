//! New single-capture reader cases; original source/target test bodies stay unchanged.
use super::*;
use navarchnet::aws::nat_cidr_reference::{
    self as core, NatCidrReferenceBudget, NatCidrReferenceQuery,
};
fn path(account: &str, subnet: &str, cidr: &str) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("subnet_id", subnet)
        .append_pair("destination_cidr", cidr)
        .finish();
    format!("/api/v1/aws/accounts/{account}/nat-cidr-reference?{query}")
}
#[tokio::test]
async fn nat_reader_auth_strict_extraction_and_all_validation_precede_closed_pool()
-> anyhow::Result<()> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://disposable:***@127.0.0.1:1/disposable")?;
    pool.close().await;
    let app = app(Store { pool });
    let reader = "r".repeat(32);
    let admin = "a".repeat(32);
    let valid = path("registration", "subnet", "::/0");
    for suffix in [
        "",
        "&extra=x",
        "&account_id=override",
        "&network_account_id=other",
        "&budget=1",
        "&subnet_id=subnet",
        "&%73ubnet_id=subnet",
        "&destination_cidr=::%2F0",
    ] {
        for who in [None, Some("invalid")] {
            assert_eq!(
                get(&app, &format!("{valid}{suffix}"), who).await?.0,
                StatusCode::UNAUTHORIZED
            );
        }
        if !suffix.is_empty() {
            assert_eq!(
                get(&app, &format!("{valid}{suffix}"), Some(&reader))
                    .await?
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
    }
    for query in ["subnet_id=subnet", "destination_cidr=::%2F0", ""] {
        assert_eq!(
            get(
                &app,
                &format!("/api/v1/aws/accounts/registration/nat-cidr-reference?{query}"),
                Some(&reader)
            )
            .await?
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    for invalid in ["", "subnet\u{85}", &"同".repeat(683)] {
        assert_eq!(
            get(&app, &path("registration", invalid, "::/0"), Some(&reader))
                .await?
                .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    for cidr in [
        "bad",
        "8.8.8.1/30",
        "2001:DB8::/32",
        " ::/0",
        "::/0\n",
        &"1".repeat(65),
    ] {
        for who in [&reader, &admin] {
            assert_eq!(
                get(&app, &path("registration", "subnet", cidr), Some(who))
                    .await?
                    .0,
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
    }
    assert_eq!(
        get(&app, &path("bad%0A", "subnet", "::/0"), Some(&reader))
            .await?
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (status, body) = get(&app, &valid, Some(&reader)).await?;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        serde_json::from_slice::<Value>(&body)?,
        json!({"error":"saved_observation_read_failed"})
    );
    Ok(())
}
#[tokio::test]
async fn nat_reader_single_capture_refusals_are_atomic_redacted_and_nonmutating()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let pair = accounts(&store).await?;
    let app = app(store.clone());
    let uri = path(&pair[0].id, "subnet", "192.0.2.0/29");
    assert_eq!(
        checked(&store, &app, &uri, StatusCode::NOT_FOUND).await?,
        json!({"error":"saved_observation_unavailable"})
    );
    for mode in 0..7 {
        let mut body = serde_json::to_value(topology(&pair[0]))?;
        let (status, expected) = match mode {
            0 => {
                body = json!([]);
                (StatusCode::CONFLICT, "saved_observation_malformed")
            }
            1 => {
                body["aws_account_id"] = json!("999999999999");
                (
                    StatusCode::CONFLICT,
                    "saved_observation_identity_unavailable",
                )
            }
            2 => {
                body["connectivity_tested"] = json!(true);
                (
                    StatusCode::CONFLICT,
                    "saved_observation_identity_unavailable",
                )
            }
            3 => {
                body.as_object_mut().unwrap().remove("execution_enabled");
                (StatusCode::CONFLICT, "saved_observation_malformed")
            }
            4 => {
                body = json!({"ignored":"x".repeat(1_048_577)});
                (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "saved_observation_budget_exceeded",
                )
            }
            5 => {
                body["request_ids"] = json!(["x".repeat(2049)]);
                (StatusCode::PAYLOAD_TOO_LARGE, "admission")
            }
            _ => {
                let mut t = topology(&pair[0]);
                t.resources = (0..1001)
                    .map(|i| AwsResource::new(ResourceKind::Vpc, format!("vpc-{i}")))
                    .collect();
                body = serde_json::to_value(t)?;
                (StatusCode::PAYLOAD_TOO_LARGE, "admission")
            }
        };
        append(&store, &pair[0], body).await?;
        let rejected = checked(&store, &app, &uri, status).await?;
        assert_eq!(rejected["error"], expected);
        assert!(rejected.get("saved").is_none() && rejected.get("references").is_none());
        if mode >= 5 {
            assert_eq!(rejected["cause"]["error"], "budget_exceeded");
        }
    }
    Ok(())
}
#[tokio::test]
async fn nat_reader_preserves_positive_metadata_large_exact_json_and_latest_pending_without_private_role()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let pair = accounts(&store).await?;
    let a = &pair[0];
    let mut t = topology(a);
    t.complete_for_supported_queries = true;
    let mut vpc = AwsResource::new(ResourceKind::Vpc, "vpc-nat".into());
    vpc.owner_account_id = Some(a.aws_account_id.clone());
    vpc.state = Some("available".into());
    let mut subnet = AwsResource::new(ResourceKind::Subnet, "subnet-nat".into());
    subnet.owner_account_id = vpc.owner_account_id.clone();
    subnet.state = vpc.state.clone();
    subnet.vpc_id = Some(vpc.id.clone());
    let mut table = AwsResource::new(ResourceKind::RouteTable, "rtb-nat".into());
    table.owner_account_id = vpc.owner_account_id.clone();
    table.vpc_id = Some(vpc.id.clone());
    table.associations.push(RouteAssociation {
        id: Some("association".into()),
        state: Some("associated".into()),
        main: true,
        subnet_id: None,
        gateway_id: None,
    });
    table.routes.push(ObservedRoute {
        ipv4_destination: Some("0.0.0.0/0".into()),
        ipv6_destination: None,
        prefix_list_destination: None,
        state: Some("active".into()),
        origin: Some("CreateRoute".into()),
        targets: [("natGatewayId".into(), "nat-literal".into())].into(),
    });
    table.tags = (0..600)
        .map(|i| (format!("metadata-{i}"), "x".repeat(1000)))
        .collect();
    let mut nat = AwsResource::new(ResourceKind::NatGateway, "nat-literal".into());
    nat.state = Some("failed".into());
    nat.owner_account_id = Some("999999999999".into());
    nat.vpc_id = Some("vpc-other".into());
    t.resources = vec![vpc, subnet, table, nat];
    append(&store, a, serde_json::to_value(&t)?).await?;
    sqlx::query("UPDATE aws_accounts SET role_configuration='null'::jsonb WHERE id=$1")
        .bind(&a.id)
        .execute(&store.pool)
        .await?;
    let app = app(store.clone());
    let uri = path(&a.id, "subnet-nat", "192.0.2.0/29");
    for generation in 0..2 {
        if generation == 1 {
            t.completed_at = "9".into();
            append(&store, a, serde_json::to_value(&t)?).await?;
        }
        // New pending fence does not replace the latest saved capture, and account2 has no capture.
        sqlx::query("UPDATE aws_accounts SET discovery_fence=discovery_fence+1 WHERE id=$1")
            .bind(&a.id)
            .execute(&store.pool)
            .await?;
        let capture = store
            .aws_saved_observation_bounded(&a.id, SavedObservationReadBudget::default())
            .await?;
        let output = core::analyze(
            capture,
            NatCidrReferenceQuery {
                account_id: a.id.clone(),
                subnet_id: "subnet-nat".into(),
                destination_cidr: "192.0.2.0/29".into(),
            },
            NatCidrReferenceBudget::default(),
        )?;
        let before = state(&store).await?;
        let (status, bytes) = get(&app, &uri, Some(&"r".repeat(32))).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, serde_json::to_vec(&output)?);
        assert!(bytes.len() > 1_048_576);
        assert_eq!(before, state(&store).await?);
        let value: Value = serde_json::from_slice(&bytes)?;
        assert_eq!(value["saved"]["registration"]["id"], a.id);
        assert_eq!(value["references"][0]["reference"]["resource_index"], 3);
        assert_eq!(
            value["references"][0]["reference"]["owner_scope"],
            "reported_different"
        );
        assert_eq!(
            value["saved"]["topology"]["resources"][3]["state"],
            "failed"
        );
        assert_eq!(value["execution_enabled"], false);
        assert_eq!(value["connectivity_tested"], false);
        assert_eq!(
            get(&app, &uri, Some(&"a".repeat(32))).await?.0,
            StatusCode::OK
        );
    }
    Ok(())
}
