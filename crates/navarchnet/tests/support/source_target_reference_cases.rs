//! Additional protected composition-reader cases; existing source-reader tests stay unchanged.
use super::*;
use navarchnet::aws::source_target_cidr_reference::{
    self as core, SourceTargetCidrBudget, SourceTargetCidrQuery,
};
fn path(source: &str, values: [&str; 5]) -> String {
    let mut encoded = form_urlencoded::Serializer::new(String::new());
    for (key, value) in [
        "network_account_id",
        "subnet_id",
        "transit_gateway_id",
        "target_attachment_id",
        "destination_cidr",
    ]
    .into_iter()
    .zip(values)
    {
        encoded.append_pair(key, value);
    }
    format!(
        "/api/v1/aws/accounts/{source}/tgw-source-target-cidr-reference?{}",
        encoded.finish()
    )
}
fn query(pair: &[VerifiedAccount; 2]) -> SourceTargetCidrQuery {
    SourceTargetCidrQuery {
        source_account_id: pair[0].id.clone(),
        network_account_id: pair[1].id.clone(),
        subnet_id: "subnet".into(),
        transit_gateway_id: "tgw".into(),
        target_attachment_id: "attachment".into(),
        destination_cidr: "::/0".into(),
    }
}
#[tokio::test]
async fn strict_extraction_auth_and_literal_validation_precede_closed_database()
-> anyhow::Result<()> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://disposable:disposable@127.0.0.1:1/disposable")?;
    pool.close().await;
    let app = app(Store { pool });
    let reader = "r".repeat(32);
    let admin = "a".repeat(32);
    let values = ["network", "subnet", "tgw", "attachment", "::/0"];
    let valid = path("source", values);
    for suffix in [
        "",
        "&unknown=x",
        "&budget=1",
        "&source_account_id=override",
        "&response_bytes=1",
        "&network_account_id=network",
        "&%73ubnet_id=subnet",
        "&transit_gateway_id=tgw",
        "&target_attachment_id=attachment",
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
    let names = [
        "network_account_id",
        "subnet_id",
        "transit_gateway_id",
        "target_attachment_id",
        "destination_cidr",
    ];
    for missing in 0..names.len() {
        let mut encoded = form_urlencoded::Serializer::new(String::new());
        for (i, (k, v)) in names.iter().zip(values).enumerate() {
            if i != missing {
                encoded.append_pair(k, v);
            }
        }
        let uri = format!(
            "/api/v1/aws/accounts/source/tgw-source-target-cidr-reference?{}",
            encoded.finish()
        );
        assert_eq!(
            get(&app, &uri, Some(&reader)).await?.0,
            StatusCode::BAD_REQUEST
        );
    }
    for i in 0..5 {
        for invalid in ["".to_string(), "bad\u{85}".into(), "同".repeat(683)] {
            let mut changed = values;
            changed[i] = &invalid;
            for who in [&reader, &admin] {
                let (status, body) = get(&app, &path("source", changed), Some(who)).await?;
                assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
                assert_eq!(
                    serde_json::from_slice::<Value>(&body)?,
                    json!({"error":"invalid_query","field":names[i]})
                );
            }
        }
    }
    for cidr in ["8.8.8.1/30", "2001:DB8::/32", " ::/0", "::/0\n", "bad"] {
        let mut changed = values;
        changed[4] = cidr;
        assert_eq!(
            get(&app, &path("source", changed), Some(&reader)).await?.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert_eq!(
        get(&app, &path("bad%0A", values), Some(&reader)).await?.0,
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
async fn both_capture_refusals_are_atomic_redacted_and_nonmutating() -> anyhow::Result<()> {
    let (store, _) = support::isolated().await?;
    let pair = accounts(&store).await?;
    let app = app(store.clone());
    let uri = path(
        &pair[0].id,
        [&pair[1].id, "subnet", "tgw", "attachment", "::/0"],
    );
    assert_eq!(
        checked(&store, &app, &uri, StatusCode::NOT_FOUND).await?,
        json!({"error":"saved_observation_unavailable"})
    );
    append(&store, &pair[0], serde_json::to_value(topology(&pair[0]))?).await?;
    assert_eq!(
        checked(&store, &app, &uri, StatusCode::NOT_FOUND).await?,
        json!({"error":"saved_observation_unavailable"})
    );
    for side in 0..2 {
        for mode in [
            "malformed",
            "identity",
            "true",
            "missing",
            "oversized",
            "leaf",
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
                "missing" => {
                    body.as_object_mut().unwrap().remove("connectivity_tested");
                    (StatusCode::CONFLICT, "saved_observation_malformed")
                }
                "oversized" => {
                    body = json!({"unparseable":"x".repeat(1_048_577)});
                    (
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "saved_observation_budget_exceeded",
                    )
                }
                "leaf" => {
                    body["request_ids"] = json!(["x".repeat(2049)]);
                    (StatusCode::PAYLOAD_TOO_LARGE, "budget_exceeded")
                }
                _ => {
                    let mut t = topology(&pair[side]);
                    t.resources = (0..1001)
                        .map(|i| AwsResource::new(ResourceKind::Vpc, format!("vpc-{i}")))
                        .collect();
                    body = serde_json::to_value(t)?;
                    (StatusCode::PAYLOAD_TOO_LARGE, "budget_exceeded")
                }
            };
            append(&store, &pair[side], body).await?;
            assert_eq!(get(&app, &uri, None).await?.0, StatusCode::UNAUTHORIZED);
            let error_body = checked(&store, &app, &uri, status).await?;
            assert_eq!(error_body["error"], error);
            for key in ["segments", "source", "target"] {
                assert!(error_body.get(key).is_none());
            }
        }
    }
    Ok(())
}
#[tokio::test]
async fn aggregate_reads_charge_both_raw_captures_before_core() -> anyhow::Result<()> {
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
    }
    let a = store
        .aws_saved_observation_bounded(&pair[0].id, SavedObservationReadBudget::default())
        .await?;
    let b = store
        .aws_saved_observation_bounded(&pair[1].id, SavedObservationReadBudget::default())
        .await?;
    core::analyze(a, b, query(&pair), SourceTargetCidrBudget::default())?;
    let app = app(store.clone());
    let uri = path(
        &pair[0].id,
        [&pair[1].id, "subnet", "tgw", "attachment", "::/0"],
    );
    assert_eq!(
        checked(&store, &app, &uri, StatusCode::PAYLOAD_TOO_LARGE).await?,
        json!({"error":"saved_observation_budget_exceeded"})
    );
    Ok(())
}
#[tokio::test]
async fn complete_large_envelope_latest_and_same_registration_are_literal_and_readonly()
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
        store.begin_aws_discovery("fixture", &a.id).await?;
    }
    sqlx::query("UPDATE aws_accounts SET role_configuration='null'::jsonb")
        .execute(&store.pool)
        .await?;
    let q = query(&pair);
    let a = store
        .aws_saved_observation_bounded(&q.source_account_id, SavedObservationReadBudget::default())
        .await?;
    let read = SavedObservationReadBudget::default();
    let b = store
        .aws_saved_observation_bounded(
            &q.network_account_id,
            SavedObservationReadBudget {
                total_bytes: read.total_bytes.checked_sub(a.admitted_bytes).unwrap(),
                ..read
            },
        )
        .await?;
    let expected = core::analyze(a, b, q, SourceTargetCidrBudget::default())?;
    let app = app(store.clone());
    let uri = path(
        &pair[0].id,
        [&pair[1].id, "subnet", "tgw", "attachment", "::/0"],
    );
    let before = state(&store).await?;
    let (status, bytes) = get(&app, &uri, Some(&"r".repeat(32))).await?;
    assert_eq!(status, StatusCode::OK);
    assert!(bytes.len() > 1024 * 1024);
    assert_eq!(bytes, serde_json::to_vec(&expected)?);
    assert_eq!(before, state(&store).await?);
    let body: Value = serde_json::from_slice(&bytes)?;
    assert_eq!(
        body["source"]["network_saved"],
        body["target"]["network_saved"]
    );
    for flag in [
        "execution_enabled",
        "connectivity_tested",
        "simultaneous_snapshots",
    ] {
        assert_eq!(body[flag], false);
    }
    assert!(!String::from_utf8(bytes)?.contains("fixture-private"));
    assert_eq!(
        get(&app, &uri, Some(&"a".repeat(32))).await?.0,
        StatusCode::OK
    );
    let same = checked(
        &store,
        &app,
        &path(
            &pair[0].id,
            [&pair[0].id, "subnet", "tgw", "attachment", "::/0"],
        ),
        StatusCode::OK,
    )
    .await?;
    assert_eq!(
        same["source"]["source_saved"]["saved_row_id"],
        same["target"]["network_saved"]["saved_row_id"]
    );
    Ok(())
}
