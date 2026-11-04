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
        target_attachment_cidr_coverage::{
            self as core, TargetAttachmentCidrBudget, TargetAttachmentCidrQuery,
        },
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
fn url(network: &str, gateway: &str, attachment: &str, cidr: &str) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("transit_gateway_id", gateway)
        .append_pair("target_attachment_id", attachment)
        .append_pair("destination_cidr", cidr)
        .finish();
    format!("/api/v1/aws/accounts/{network}/tgw-target-cidr-coverage?{query}")
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
    // Fingerprint every raw test-schema table, not merely record counts or selected columns.
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
async fn account(store: &Store) -> anyhow::Result<VerifiedAccount> {
    let role = RoleRegistration {
        name: "Target CIDR HTTP \" \\ 同".into(),
        role_arn: "arn:aws:iam::123456789012:role/Reader".into(),
        region: "eu-west-1".into(),
        external_id: Some("fixture-private".into()),
    };
    store
        .register_aws_verified("fixture", &role, "123456789012", "network")
        .await
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
async fn auth_extraction_and_literal_validation_precede_database_use() -> anyhow::Result<()> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://disposable:disposable@127.0.0.1:1/disposable")?;
    pool.close().await;
    let app = app(Store { pool });
    let reader = "r".repeat(32);
    let admin = "a".repeat(32);
    let valid = url("network", "gateway", "attachment", "203.0.113.0/29");
    for suffix in [
        "",
        "&unknown=x",
        "&network_account_id=other",
        "&source_account_id=other",
        "&budget=1",
        "&response_bytes=1",
        "&work_units=1",
        "&topology_bytes=1",
        "&transit_gateway_id=gateway",
        "&%74ransit_gateway_id=gateway",
        "&target_attachment_id=attachment",
        "&%74arget_attachment_id=attachment",
        "&destination_cidr=203.0.113.0%2F29",
        "&%64estination_cidr=203.0.113.0%2F29",
    ] {
        let path = format!("{valid}{suffix}");
        for auth in [None, Some("invalid")] {
            assert_eq!(get(&app, &path, auth).await?.0, StatusCode::UNAUTHORIZED);
        }
        if !suffix.is_empty() {
            for who in [&reader, &admin] {
                assert_eq!(
                    get(&app, &path, Some(who)).await?.0,
                    StatusCode::BAD_REQUEST
                );
            }
        }
    }
    for missing in [
        "transit_gateway_id",
        "target_attachment_id",
        "destination_cidr",
    ] {
        let mut query = form_urlencoded::Serializer::new(String::new());
        for (key, value) in [
            ("transit_gateway_id", "gateway"),
            ("target_attachment_id", "attachment"),
            ("destination_cidr", "::/0"),
        ] {
            if key != missing {
                query.append_pair(key, value);
            }
        }
        let path = format!(
            "/api/v1/aws/accounts/network/tgw-target-cidr-coverage?{}",
            query.finish()
        );
        assert_eq!(get(&app, &path, None).await?.0, StatusCode::UNAUTHORIZED);
        assert_eq!(
            get(&app, &path, Some(&reader)).await?.0,
            StatusCode::BAD_REQUEST
        );
    }
    // The first invalid field wins in exactly the core validator's order, even on a closed pool.
    let mut cases = vec![
        (
            "bad%0A".into(),
            "".into(),
            "".into(),
            "bad".into(),
            "network_account_id",
        ),
        (
            "bad%C2%85".into(),
            "gateway".into(),
            "attachment".into(),
            "::/0".into(),
            "network_account_id",
        ),
    ];
    for (gateway, attachment, cidr, field) in [
        ("", "", "bad", "transit_gateway_id"),
        ("bad\u{85}", "attachment", "::/0", "transit_gateway_id"),
        ("gateway", "", "bad", "target_attachment_id"),
        ("gateway", "bad\n", "::/0", "target_attachment_id"),
        ("gateway", "attachment", "", "destination_cidr"),
        (
            "gateway",
            "attachment",
            "203.0.113.1/29",
            "destination_cidr",
        ),
        ("gateway", "attachment", "2001:DB8::/32", "destination_cidr"),
        (
            "gateway",
            "attachment",
            "2001:0db8::/32",
            "destination_cidr",
        ),
        ("gateway", "attachment", " ::/0", "destination_cidr"),
        ("gateway", "attachment", "::/129", "destination_cidr"),
        ("gateway", "attachment", "0.0.0.0/33", "destination_cidr"),
    ] {
        cases.push((
            "network".into(),
            gateway.into(),
            attachment.into(),
            cidr.into(),
            field,
        ));
    }
    for (network, gateway, attachment, field) in [
        (
            "x".repeat(2049),
            "gateway".into(),
            "attachment".into(),
            "network_account_id",
        ),
        (
            "network".into(),
            "同".repeat(683),
            "attachment".into(),
            "transit_gateway_id",
        ),
        (
            "network".into(),
            "gateway".into(),
            "x".repeat(2049),
            "target_attachment_id",
        ),
    ] {
        cases.push((network, gateway, attachment, "::/0".into(), field));
    }
    cases.push((
        "network".into(),
        "gateway".into(),
        "attachment".into(),
        "x".repeat(65),
        "destination_cidr",
    ));
    for (network, gateway, attachment, cidr, field) in cases {
        for who in [&reader, &admin] {
            let (status, bytes) = get(
                &app,
                &url(&network, &gateway, &attachment, &cidr),
                Some(who),
            )
            .await?;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(
                serde_json::from_slice::<Value>(&bytes)?,
                json!({"error":"invalid_query","field":field})
            );
        }
    }
    // Literal identifiers are not trimmed, repaired or restricted to ASCII.
    for (network, gateway, attachment, cidr) in [
        (
            "network".into(),
            "gateway 同 ".into(),
            "attachment".into(),
            "0.0.0.0/0",
        ),
        (
            "network".into(),
            "x".repeat(2048),
            "attachment".into(),
            "::/0",
        ),
        (
            "x".repeat(2048),
            "gateway".into(),
            "x".repeat(2048),
            "255.255.255.255/32",
        ),
        (
            "network".into(),
            "gateway".into(),
            "attachment".into(),
            "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128",
        ),
    ] {
        for who in [&reader, &admin] {
            let (status, bytes) =
                get(&app, &url(&network, &gateway, &attachment, cidr), Some(who)).await?;
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(
                serde_json::from_slice::<Value>(&bytes)?,
                json!({"error":"saved_observation_read_failed"})
            );
        }
    }
    Ok(())
}

#[tokio::test]
async fn saved_refusals_are_atomic_redacted_and_do_not_touch_private_or_adoptions()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let account = account(&store).await?;
    let app = app(store.clone());
    let path = url(&account.id, "gateway", "attachment", "::/0");
    assert_eq!(
        checked(&store, &app, &path, StatusCode::NOT_FOUND).await?,
        json!({"error":"saved_observation_unavailable"})
    );
    let first = append(&store, &account, serde_json::to_value(topology(&account))?).await?;
    sqlx::query("UPDATE aws_accounts SET role_configuration='null'::jsonb")
        .execute(&store.pool)
        .await?;
    sqlx::query("INSERT INTO aws_adoptions(id,account_id,resource_kind,resource_id,topology_id,body) VALUES($1,$2,'vpc','vpc-fixture',$3,'null'::jsonb)")
        .bind(uuid::Uuid::new_v4().to_string()).bind(&account.id).bind(&first).execute(&store.pool).await?;
    let accepted = checked(&store, &app, &path, StatusCode::OK).await?;
    assert_eq!(accepted["partition_complete"], true);
    assert_eq!(
        accepted["network_saved"]["topology"]["complete_for_supported_queries"],
        false
    );
    assert!(!serde_json::to_string(&accepted)?.contains("fixture-private"));
    let before = state(&store).await?;
    assert_eq!(
        get(&app, &path, Some(&"a".repeat(32))).await?.0,
        StatusCode::OK
    );
    assert_eq!(before, state(&store).await?);
    for mode in [
        "malformed",
        "identity",
        "true-execution",
        "true-connectivity",
        "null-execution",
        "null-connectivity",
        "missing-execution",
        "missing-connectivity",
        "read-budget",
        "string",
        "resources",
        "routes",
        "work",
        "output",
    ] {
        let mut t = topology(&account);
        let mut body = serde_json::to_value(&t)?;
        let (status, expected) = match mode {
            "malformed" => {
                body = json!([]);
                (
                    StatusCode::CONFLICT,
                    json!({"error":"saved_observation_malformed"}),
                )
            }
            "identity" => {
                body["account_id"] = json!("other-registration");
                (
                    StatusCode::CONFLICT,
                    json!({"error":"saved_observation_identity_unavailable"}),
                )
            }
            "true-execution" | "true-connectivity" => {
                body[if mode == "true-execution" {
                    "execution_enabled"
                } else {
                    "connectivity_tested"
                }] = json!(true);
                (
                    StatusCode::CONFLICT,
                    json!({"error":"saved_observation_identity_unavailable"}),
                )
            }
            "null-execution"
            | "null-connectivity"
            | "missing-execution"
            | "missing-connectivity" => {
                let key = if mode.ends_with("execution") {
                    "execution_enabled"
                } else {
                    "connectivity_tested"
                };
                if mode.starts_with("null") {
                    body[key] = Value::Null;
                } else {
                    body.as_object_mut().unwrap().remove(key);
                }
                (
                    StatusCode::CONFLICT,
                    json!({"error":"saved_observation_malformed"}),
                )
            }
            "read-budget" => {
                body = json!({"unparseable": "private-SQL-sentinel".repeat(100_000)});
                (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    json!({"error":"saved_observation_budget_exceeded"}),
                )
            }
            "string" => {
                body["request_ids"] = json!(["x".repeat(2049)]);
                (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    json!({"error":"budget_exceeded","dimension":"string_bytes","limit":2048}),
                )
            }
            "resources" => {
                t.resources = (0..1001)
                    .map(|i| AwsResource::new(ResourceKind::Vpc, format!("vpc-{i}")))
                    .collect();
                body = serde_json::to_value(t)?;
                (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    json!({"error":"budget_exceeded","dimension":"resources","limit":1000}),
                )
            }
            "routes" | "work" | "output" => {
                let mut table = AwsResource::new(ResourceKind::RouteTable, "rtb-fixture".into());
                let count = match mode {
                    "routes" => 513,
                    "work" => 100,
                    _ => 1,
                };
                table.routes = (0..count)
                    .map(|i| ObservedRoute {
                        ipv4_destination: Some(if mode == "output" {
                            "128.0.0.0/1".into()
                        } else {
                            format!("10.0.0.{}/32", i % 256)
                        }),
                        ipv6_destination: None,
                        prefix_list_destination: None,
                        state: Some("active".into()),
                        origin: None,
                        targets: Default::default(),
                    })
                    .collect();
                if mode != "routes" {
                    table.related_ids = (0..32).map(|i| format!("subnet-{i}")).collect();
                }
                t.resources.push(table);
                if mode == "work" {
                    t.resources.extend(
                        (0..899).map(|i| AwsResource::new(ResourceKind::Vpc, format!("vpc-{i}"))),
                    );
                }
                body = serde_json::to_value(t)?;
                let (dimension, limit) = match mode {
                    "routes" => ("routes", 512),
                    "work" => ("work_units", 16_000_000),
                    _ => ("response_bytes", 4_194_304),
                };
                (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    json!({"error":"budget_exceeded","dimension":dimension,"limit":limit}),
                )
            }
            _ => unreachable!(),
        };
        append(&store, &account, body).await?;
        let path = url(&account.id, "gateway", "attachment", "0.0.0.0/0");
        let before = state(&store).await?;
        assert_eq!(get(&app, &path, None).await?.0, StatusCode::UNAUTHORIZED);
        assert_eq!(before, state(&store).await?);
        let failure = checked(&store, &app, &path, status).await?;
        assert_eq!(failure, expected, "mode {mode}");
        assert!(failure.get("segments").is_none() && failure.get("network_saved").is_none());
    }
    Ok(())
}

#[tokio::test]
async fn over_one_mib_success_is_exact_within_default_prepoint_reservation() -> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let account = account(&store).await?;
    let mut t = topology(&account);
    t.request_ids = (0..500)
        .map(|i| format!("{i:03}{}", "x".repeat(2017)))
        .collect();
    let mut table = AwsResource::new(ResourceKind::RouteTable, "rtb-framing".into());
    table.routes = (0..110)
        .map(|i| ObservedRoute {
            ipv4_destination: Some(format!("10.0.0.{i}/32")),
            ipv6_destination: None,
            prefix_list_destination: None,
            state: Some("active".into()),
            origin: None,
            targets: Default::default(),
        })
        .collect();
    t.resources.push(table);
    append(&store, &account, serde_json::to_value(t)?).await?;
    let saved = store
        .aws_saved_observation_bounded(&account.id, SavedObservationReadBudget::default())
        .await?;
    let expected = core::analyze(
        saved,
        TargetAttachmentCidrQuery {
            network_account_id: account.id.clone(),
            transit_gateway_id: "gateway".into(),
            target_attachment_id: "attachment".into(),
            destination_cidr: "0.0.0.0/0".into(),
        },
        TargetAttachmentCidrBudget::default(),
    )?;
    let before = state(&store).await?;
    let (status, bytes) = get(
        &app(store.clone()),
        &url(&account.id, "gateway", "attachment", "0.0.0.0/0"),
        Some(&"r".repeat(32)),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, serde_json::to_vec(&expected)?);
    assert!(bytes.len() > 1024 * 1024);
    assert!(bytes.len() <= TargetAttachmentCidrBudget::default().response_bytes);
    assert_eq!(before, state(&store).await?);
    eprintln!(
        "Exact default-budget target response: {} compact JSON bytes",
        bytes.len()
    );
    Ok(())
}

#[tokio::test]
async fn exact_core_bytes_preserve_path_query_capture_and_pending_saved_generation()
-> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let account = account(&store).await?;
    let mut t = topology(&account);
    t.resources = (0..400)
        .map(|i| {
            let mut r = AwsResource::new(ResourceKind::Vpc, format!("vpc-{i}"));
            r.tags
                .insert("literal".into(), format!("{}\"\\\n同", "x".repeat(1800)));
            r
        })
        .collect();
    append(&store, &account, serde_json::to_value(t)?).await?;
    store.begin_aws_discovery("fixture", &account.id).await?;
    let app = app(store.clone());
    for cidr in [
        "0.0.0.0/0",
        "::/0",
        "255.255.255.255/32",
        "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128",
    ] {
        let saved = store
            .aws_saved_observation_bounded(&account.id, SavedObservationReadBudget::default())
            .await?;
        let row = saved.saved_row_id.clone();
        let query = TargetAttachmentCidrQuery {
            network_account_id: account.id.clone(),
            transit_gateway_id: "gateway 同 ".into(),
            target_attachment_id: "attachment".into(),
            destination_cidr: cidr.into(),
        };
        let expected = core::analyze(saved, query, TargetAttachmentCidrBudget::default())?;
        let before = state(&store).await?;
        let (status, bytes) = get(
            &app,
            &url(&account.id, "gateway 同 ", "attachment", cidr),
            Some(&"r".repeat(32)),
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, serde_json::to_vec(&expected)?);
        assert_eq!(before, state(&store).await?);
        assert_eq!(expected.query.network_account_id, account.id);
        assert_eq!(expected.network_saved.saved_row_id, row);
        assert_eq!(expected.network_saved.topology.completed_at, "2");
        assert!(!expected.execution_enabled && !expected.connectivity_tested);
        assert!(expected.reference_only && expected.partition_complete);
    }
    Ok(())
}
