#[path = "support/nat_cidr_reference_cases.rs"]
mod nat_reference_cases;
#[path = "support/source_target_reference_cases.rs"]
mod reference_cases;
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
        RoleRegistration, VerifiedAccount,
        observation::*,
        saved_observation::*,
        source_handoff_cidr_coverage::{self, SourceHandoffCidrBudget, SourceHandoffCidrQuery},
    },
    store::Store,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
fn app(store: Store) -> Router {
    api::router(AppState {
        store,
        auth: Arc::new(Auth::demo("a".repeat(32), "r".repeat(32)).unwrap()),
        aws: None,
    })
}
fn url(source: &str, network: &str, subnet: &str, cidr: &str) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("network_account_id", network)
        .append_pair("subnet_id", subnet)
        .append_pair("destination_cidr", cidr)
        .finish();
    format!("/api/v1/aws/accounts/{source}/tgw-source-cidr-coverage?{query}")
}
async fn get(
    app: &Router,
    url: &str,
    bearer: Option<&str>,
) -> anyhow::Result<(StatusCode, Vec<u8>)> {
    let mut req = Request::builder().uri(url);
    if let Some(value) = bearer {
        req = req.header("authorization", format!("Bearer {value}"));
    }
    let response = app.clone().oneshot(req.body(Body::empty())?).await?;
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    if response.status() == StatusCode::OK {
        assert_eq!(response.headers()["content-type"], "application/json");
    }
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024).await?;
    Ok((status, bytes.to_vec()))
}
async fn state(store: &Store) -> anyhow::Result<Value> {
    Ok(sqlx::query_scalar(r#"SELECT jsonb_build_object(
        'registrations',(SELECT jsonb_agg(to_jsonb(a)-'role_configuration' ORDER BY id) FROM aws_accounts a),
        'private_hashes',(SELECT jsonb_agg(md5(role_configuration::text) ORDER BY id) FROM aws_accounts),
        'observations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM aws_topologies t),
        'adoptions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM aws_adoptions d),
        'audit',(SELECT count(*) FROM audit),'plans',(SELECT count(*) FROM plans),
        'operations',(SELECT count(*) FROM operations),'inventory',(SELECT count(*) FROM inventory))"#).fetch_one(&store.pool).await?)
}
async fn checked(
    store: &Store,
    app: &Router,
    path: &str,
    expected: StatusCode,
) -> anyhow::Result<Value> {
    let before = state(store).await?;
    let (status, bytes) = get(app, path, Some(&"r".repeat(32))).await?;
    assert_eq!(status, expected);
    assert_eq!(before, state(store).await?);
    Ok(serde_json::from_slice(&bytes)?)
}
async fn accounts(store: &Store) -> anyhow::Result<[VerifiedAccount; 2]> {
    let role = RoleRegistration {
        name: "CIDR HTTP \" \\ 同".into(),
        role_arn: "arn:aws:iam::123456789012:role/Reader".into(),
        region: "eu-west-1".into(),
        external_id: Some("fixture-private".into()),
    };
    let source = store
        .register_aws_verified("fixture", &role, "123456789012", "source")
        .await?;
    let mut other = role;
    other.role_arn = "arn:aws:iam::234567890123:role/Reader".into();
    let network = store
        .register_aws_verified("fixture", &other, "234567890123", "network")
        .await?;
    Ok([source, network])
}
fn topology(a: &VerifiedAccount) -> AwsTopology {
    AwsTopology {
        id: uuid::Uuid::new_v4().to_string(),
        account_id: a.id.clone(),
        aws_account_id: a.aws_account_id.clone(),
        region: a.region.clone(),
        started_at: "1".into(),
        completed_at: "2".into(),
        session_name: "literal\nfixture".into(),
        resources: vec![],
        request_ids: vec!["request".into()],
        limitations: vec!["incomplete literal".into()],
        complete_for_supported_queries: false,
        execution_enabled: false,
        connectivity_tested: false,
    }
}
async fn append(store: &Store, a: &VerifiedAccount, mut body: Value) -> anyhow::Result<String> {
    // Fixture preparation must also work after deliberately poisoning private role JSON.
    // Allocate the existing fence directly; never UPDATE an immutable topology row.
    let generation: i64 = sqlx::query_scalar("UPDATE aws_accounts SET discovery_fence=discovery_fence+1 WHERE id=$1 RETURNING discovery_fence")
        .bind(&a.id).fetch_one(&store.pool).await?;
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(object) = body.as_object_mut() {
        object.insert("id".into(), json!(id));
    }
    sqlx::query("INSERT INTO aws_topologies(id,account_id,generation,body) VALUES($1,$2,$3,$4)")
        .bind(&id)
        .bind(&a.id)
        .bind(generation)
        .bind(body)
        .execute(&store.pool)
        .await?;
    Ok(id)
}
#[tokio::test]
async fn extraction_auth_and_canonical_validation_precede_any_database_use() -> anyhow::Result<()> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://disposable:disposable@127.0.0.1:1/disposable")?;
    pool.close().await;
    let app = app(Store { pool });
    let reader = "r".repeat(32);
    let admin = "a".repeat(32);
    let valid = url("source", "network", "subnet", "203.0.113.0/29");
    for suffix in [
        "",
        "&unknown=x",
        "&source_account_id=other",
        "&budget=1",
        "&response_bytes=1",
        "&network_account_id=network",
        "&%6Eetwork_account_id=network",
        "&subnet_id=subnet",
        "&destination_cidr=203.0.113.0%2F29",
    ] {
        let path = format!("{valid}{suffix}");
        for auth in [None, Some("invalid")] {
            assert_eq!(get(&app, &path, auth).await?.0, StatusCode::UNAUTHORIZED);
        }
        if !suffix.is_empty() {
            assert_eq!(
                get(&app, &path, Some(&reader)).await?.0,
                StatusCode::BAD_REQUEST
            );
        }
    }
    for missing in ["network_account_id", "subnet_id", "destination_cidr"] {
        let pairs = [
            ("network_account_id", "network"),
            ("subnet_id", "subnet"),
            ("destination_cidr", "203.0.113.0/29"),
        ];
        let mut encoded = form_urlencoded::Serializer::new(String::new());
        for (k, v) in pairs {
            if k != missing {
                encoded.append_pair(k, v);
            }
        }
        assert_eq!(
            get(
                &app,
                &format!(
                    "/api/v1/aws/accounts/source/tgw-source-cidr-coverage?{}",
                    encoded.finish()
                ),
                Some(&reader)
            )
            .await?
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    for (network, subnet, cidr, field) in [
        ("", "subnet", "203.0.113.0/29", "network_account_id"),
        (
            "bad\u{85}",
            "subnet",
            "203.0.113.0/29",
            "network_account_id",
        ),
        ("network", "", "203.0.113.0/29", "subnet_id"),
        ("network", "subnet", "203.0.113.1/29", "destination_cidr"),
        ("network", "subnet", "2001:DB8::/32", "destination_cidr"),
        ("network", "subnet", " 203.0.113.0/29", "destination_cidr"),
    ] {
        let path = url("source", network, subnet, cidr);
        for who in [&reader, &admin] {
            let (status, bytes) = get(&app, &path, Some(who)).await?;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(
                serde_json::from_slice::<Value>(&bytes)?,
                json!({"error":"invalid_query","field":field})
            );
        }
    }
    for (network, subnet) in [
        ("x".repeat(2049), "subnet".into()),
        ("network".into(), "同".repeat(683)),
    ] {
        assert_eq!(
            get(
                &app,
                &url("source", &network, &subnet, "::/0"),
                Some(&reader)
            )
            .await?
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    for source in ["x".repeat(2049), "bad%0A".into()] {
        assert_eq!(
            get(
                &app,
                &url(&source, "network", "subnet", "::/0"),
                Some(&reader)
            )
            .await?
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    for (network, cidr) in [
        ("x".repeat(2048), "::/0"),
        ("network ".into(), "255.255.255.255/32"),
        (
            "network".into(),
            "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128",
        ),
    ] {
        let (status, bytes) = get(
            &app,
            &url("source", &network, "subnet", cidr),
            Some(&reader),
        )
        .await?;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes)?,
            json!({"error":"saved_observation_read_failed"})
        );
    }
    Ok(())
}
#[tokio::test]
async fn both_saved_sides_map_refusals_without_private_reads_or_mutation() -> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let pair = accounts(&store).await?;
    let app = app(store.clone());
    let path = url(&pair[0].id, &pair[1].id, "subnet", "203.0.113.0/29");
    assert_eq!(
        checked(&store, &app, &path, StatusCode::NOT_FOUND).await?["error"],
        "saved_observation_unavailable"
    );
    let source_id = append(&store, &pair[0], serde_json::to_value(topology(&pair[0]))?).await?;
    assert_eq!(
        checked(&store, &app, &path, StatusCode::NOT_FOUND).await?["error"],
        "saved_observation_unavailable"
    );
    append(&store, &pair[1], serde_json::to_value(topology(&pair[1]))?).await?;
    // Synthetic corrupt private/adoption rows must be ignored by this narrow route.
    sqlx::query("UPDATE aws_accounts SET role_configuration='null'::jsonb")
        .execute(&store.pool)
        .await?;
    sqlx::query("INSERT INTO aws_adoptions(id,account_id,resource_kind,resource_id,topology_id,body) VALUES($1,$2,'vpc','vpc-fixture',$3,'null'::jsonb)").bind(uuid::Uuid::new_v4().to_string()).bind(&pair[0].id).bind(&source_id).execute(&store.pool).await?;
    let accepted = checked(&store, &app, &path, StatusCode::OK).await?;
    assert_eq!(accepted["partition_complete"], true);
    assert_eq!(
        accepted["source_saved"]["topology"]["complete_for_supported_queries"],
        false
    );
    assert!(!serde_json::to_string(&accepted)?.contains("fixture-private"));
    assert_eq!(
        get(&app, &path, Some(&"a".repeat(32))).await?.0,
        StatusCode::OK
    );
    for side in 0..2 {
        for mode in [
            "malformed",
            "identity",
            "true",
            "null",
            "missing",
            "oversized",
            "individual-string",
            "collections",
        ] {
            for a in &pair {
                append(&store, a, serde_json::to_value(topology(a))?).await?;
            }
            let mut body = serde_json::to_value(topology(&pair[side]))?;
            let (status, error) = match mode {
                "malformed" => {
                    body = json!([]);
                    (StatusCode::CONFLICT, "saved_observation_malformed")
                }
                "identity" => {
                    body["aws_account_id"] = json!("999999999999");
                    (
                        StatusCode::CONFLICT,
                        "saved_observation_identity_unavailable",
                    )
                }
                "true" => {
                    body["execution_enabled"] = json!(true);
                    (
                        StatusCode::CONFLICT,
                        "saved_observation_identity_unavailable",
                    )
                }
                "null" => {
                    body["connectivity_tested"] = Value::Null;
                    (StatusCode::CONFLICT, "saved_observation_malformed")
                }
                "missing" => {
                    body.as_object_mut().unwrap().remove("execution_enabled");
                    (StatusCode::CONFLICT, "saved_observation_malformed")
                }
                "oversized" => {
                    body = json!({"unparseable": "x".repeat(1_048_577)});
                    (
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "saved_observation_budget_exceeded",
                    )
                }
                "individual-string" => {
                    body["request_ids"] = json!(["x".repeat(2049)]);
                    (StatusCode::PAYLOAD_TOO_LARGE, "budget_exceeded")
                }
                "collections" => {
                    let mut t = topology(&pair[side]);
                    t.resources = (0..1001)
                        .map(|i| AwsResource::new(ResourceKind::Vpc, format!("vpc-{i}")))
                        .collect();
                    body = serde_json::to_value(t)?;
                    (StatusCode::PAYLOAD_TOO_LARGE, "budget_exceeded")
                }
                _ => unreachable!(),
            };
            append(&store, &pair[side], body).await?;
            assert_eq!(get(&app, &path, None).await?.0, StatusCode::UNAUTHORIZED);
            let failure = checked(&store, &app, &path, status).await?;
            assert_eq!(failure["error"], error);
            assert!(failure.get("segments").is_none() && failure.get("source_saved").is_none());
        }
    }
    Ok(())
}
#[tokio::test]
async fn aggregate_reader_bytes_cannot_reset_for_second_capture() -> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let pair = accounts(&store).await?;
    for a in &pair {
        let mut body = serde_json::to_value(topology(a))?;
        body["ignored_padding"] = json!("");
        let size: i32 = sqlx::query_scalar("SELECT octet_length($1::jsonb::text)")
            .bind(&body)
            .fetch_one(&store.pool)
            .await?;
        body["ignored_padding"] = json!("x".repeat(1_048_576 - usize::try_from(size)?));
        append(&store, a, body).await?;
        let saved = store
            .aws_saved_observation_bounded(&a.id, SavedObservationReadBudget::default())
            .await?;
        assert!(saved.admitted_bytes > SavedObservationReadBudget::default().topology_bytes);
    }
    // Without remaining-allowance subtraction these individually admissible typed models succeed.
    let a = store
        .aws_saved_observation_bounded(&pair[0].id, SavedObservationReadBudget::default())
        .await?;
    let b = store
        .aws_saved_observation_bounded(&pair[1].id, SavedObservationReadBudget::default())
        .await?;
    source_handoff_cidr_coverage::analyze(
        a,
        b,
        SourceHandoffCidrQuery {
            source_account_id: pair[0].id.clone(),
            network_account_id: pair[1].id.clone(),
            subnet_id: "subnet".into(),
            destination_cidr: "::/0".into(),
        },
        SourceHandoffCidrBudget::default(),
    )?;
    let app = app(store.clone());
    assert_eq!(
        checked(
            &store,
            &app,
            &url(&pair[0].id, &pair[1].id, "subnet", "::/0"),
            StatusCode::PAYLOAD_TOO_LARGE
        )
        .await?,
        json!({"error":"saved_observation_budget_exceeded"})
    );
    Ok(())
}
#[tokio::test]
async fn exact_raw_large_json_preserves_current_captures_and_has_no_late_wrapper()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let pair = accounts(&store).await?;
    for a in &pair {
        let mut t = topology(a);
        t.resources = (0..350)
            .map(|i| {
                let mut r = AwsResource::new(ResourceKind::Vpc, format!("vpc-{i}"));
                r.tags
                    .insert("payload".into(), format!("{}\"\\\n同", "x".repeat(1800)));
                r
            })
            .collect();
        append(&store, a, serde_json::to_value(t)?).await?;
    }
    let first = store
        .aws_saved_observation_bounded(&pair[0].id, SavedObservationReadBudget::default())
        .await?;
    let read = SavedObservationReadBudget::default();
    let second = store
        .aws_saved_observation_bounded(
            &pair[1].id,
            SavedObservationReadBudget {
                total_bytes: read.total_bytes.checked_sub(first.admitted_bytes).unwrap(),
                ..read
            },
        )
        .await?;
    let q = SourceHandoffCidrQuery {
        source_account_id: pair[0].id.clone(),
        network_account_id: pair[1].id.clone(),
        subnet_id: "subnet".into(),
        destination_cidr: "::/0".into(),
    };
    let expected = source_handoff_cidr_coverage::analyze(
        first,
        second,
        q,
        SourceHandoffCidrBudget::default(),
    )?;
    let app = app(store.clone());
    let before = state(&store).await?;
    let (status, bytes) = get(
        &app,
        &url(&pair[0].id, &pair[1].id, "subnet", "::/0"),
        Some(&"r".repeat(32)),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert!(bytes.len() > 1024 * 1024);
    assert_eq!(bytes, serde_json::to_vec(&expected)?);
    assert_eq!(before, state(&store).await?);
    // A pending attempt cannot hide the last saved generation. A same-registration query is allowed.
    store.begin_aws_discovery("fixture", &pair[0].id).await?;
    let stable = checked(
        &store,
        &app,
        &url(&pair[0].id, &pair[1].id, "subnet", "::/0"),
        StatusCode::OK,
    )
    .await?;
    assert_eq!(
        stable["source_saved"]["saved_row_id"],
        expected.source_saved.saved_row_id
    );
    let same = checked(
        &store,
        &app,
        &url(&pair[0].id, &pair[0].id, "subnet", "::/0"),
        StatusCode::OK,
    )
    .await?;
    assert_eq!(
        same["source_saved"]["saved_row_id"],
        same["network_saved"]["saved_row_id"]
    );
    assert_eq!(same["simultaneous_snapshots"], false);
    assert_eq!(same["execution_enabled"], false);
    assert_eq!(same["connectivity_tested"], false);
    Ok(())
}
