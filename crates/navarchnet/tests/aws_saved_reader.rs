mod support;
use navarchnet::{
    aws::{RoleRegistration, VerifiedAccount, observation::*, saved_observation::*},
    store::Store,
};
use serde_json::{Value, json};

async fn fixture() -> anyhow::Result<(Store, VerifiedAccount, AwsTopology, i64)> {
    let (store, _) = support::isolated().await?;
    let role = RoleRegistration {
        name: "Bounded reader fixture".into(),
        role_arn: "arn:aws:iam::123456789012:role/Reader".into(),
        region: "eu-west-1".into(),
        external_id: Some("fixture-private".into()),
    };
    let account = store
        .register_aws_verified("fixture", &role, "123456789012", "fixture")
        .await?;
    let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
    let mut resource = AwsResource::new(ResourceKind::Vpc, "vpc-fixture".into());
    resource.owner_account_id = Some(account.aws_account_id.clone());
    let topology = AwsTopology {
        id: uuid::Uuid::new_v4().to_string(),
        account_id: account.id.clone(),
        aws_account_id: account.aws_account_id.clone(),
        region: account.region.clone(),
        started_at: "1".into(),
        completed_at: "2".into(),
        session_name: "fixture".into(),
        resources: vec![resource],
        request_ids: vec![],
        limitations: vec![],
        complete_for_supported_queries: true,
        execution_enabled: false,
        connectivity_tested: false,
    };
    store
        .finish_aws_discovery("fixture", generation, &topology)
        .await?;
    Ok((store, account, topology, generation))
}
async fn checked(
    store: &Store,
    id: &str,
    budget: SavedObservationReadBudget,
) -> anyhow::Result<SavedObservation> {
    let state = || {
        sqlx::query_scalar::<_, Value>(r#"
        SELECT jsonb_build_object(
            'registrations',(SELECT jsonb_agg(to_jsonb(a) - 'role_configuration' ORDER BY id) FROM aws_accounts a),
            'private_hashes',(SELECT jsonb_agg(md5(role_configuration::text) ORDER BY id) FROM aws_accounts),
            'observations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM aws_topologies t),
            'adoptions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM aws_adoptions d),
            'audit',(SELECT count(*) FROM audit), 'plans',(SELECT count(*) FROM plans),
            'operations',(SELECT count(*) FROM operations), 'inventory',(SELECT count(*) FROM inventory))
    "#).fetch_one(&store.pool)
    };
    let before = state().await?;
    let result = store.aws_saved_observation_bounded(id, budget).await;
    assert_eq!(
        before,
        state().await?,
        "Success and refusal must not mutate saved state"
    );
    result
}
#[tokio::test]
async fn latest_saved_reads_are_independent_of_attempts_and_auxiliary_records() -> anyhow::Result<()>
{
    let (store, account, mut snapshot, generation) = fixture().await?;
    let budget = SavedObservationReadBudget::default();
    let read = checked(&store, &account.id, budget).await?;
    let (_, _, newer) = store.begin_aws_discovery("fixture", &account.id).await?;
    let pending = checked(&store, &account.id, budget).await?;
    assert_eq!(
        pending.generation, generation,
        "A newer attempt does not hide the last saved observation"
    );
    snapshot.id = uuid::Uuid::new_v4().to_string();
    snapshot.completed_at = "3".into();
    store
        .finish_aws_discovery("fixture", newer, &snapshot)
        .await?;
    // Malformed synthetic auxiliary/private records must not be deserialized by this reader.
    sqlx::query("UPDATE aws_accounts SET role_configuration='null'::jsonb WHERE id=$1")
        .bind(&account.id)
        .execute(&store.pool)
        .await?;
    sqlx::query("INSERT INTO aws_adoptions(id,account_id,resource_kind,resource_id,topology_id,body) VALUES($1,$2,'vpc',$3,$4,'null'::jsonb)")
        .bind(uuid::Uuid::new_v4().to_string()).bind(&account.id).bind(&snapshot.resources[0].id).bind(&snapshot.id).execute(&store.pool).await?;
    let latest = checked(&store, &account.id, budget).await?;
    assert_eq!(latest.saved_row_id, snapshot.id);
    assert_eq!(latest.generation, newer);
    assert_eq!(latest.topology.completed_at, "3");
    assert_eq!(read.topology.completed_at, "2");
    assert!(!serde_json::to_string(&latest)?.contains("fixture-private"));
    Ok(())
}
#[tokio::test]
async fn sql_payload_gates_precede_decoding_and_charge_remaining_multi_read_allowance()
-> anyhow::Result<()> {
    let (store, account, mut snapshot, _) = fixture().await?;
    let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
    snapshot.id = uuid::Uuid::new_v4().to_string();
    snapshot.resources[0]
        .tags
        .insert("multibyte".into(), "同".repeat(10000));
    store
        .finish_aws_discovery("fixture", generation, &snapshot)
        .await?;
    let sizes: (i64,i64,i64) = sqlx::query_as("SELECT octet_length(t.body::text)::bigint, octet_length(a.public_view::text)::bigint, octet_length(a.id)::bigint+octet_length(a.aws_account_id)+octet_length(a.region)+octet_length(t.id)+octet_length(t.account_id) FROM aws_accounts a JOIN aws_topologies t ON t.account_id=a.id WHERE t.id=$1")
        .bind(&snapshot.id).fetch_one(&store.pool).await?;
    let (body, registration, metadata) = (
        usize::try_from(sizes.0)?,
        usize::try_from(sizes.1)?,
        usize::try_from(sizes.2)?,
    );
    let exact = SavedObservationReadBudget {
        topology_bytes: body,
        registration_bytes: registration,
        total_bytes: body + registration + metadata,
    };
    let read = checked(&store, &account.id, exact).await?;
    assert_eq!(read.admitted_bytes, exact.total_bytes);
    for (dimension, budget) in [
        (
            "topology_bytes",
            SavedObservationReadBudget {
                topology_bytes: body - 1,
                ..exact
            },
        ),
        (
            "registration_bytes",
            SavedObservationReadBudget {
                registration_bytes: registration - 1,
                ..exact
            },
        ),
        (
            "total_bytes",
            SavedObservationReadBudget {
                total_bytes: exact.total_bytes - 1,
                ..exact
            },
        ),
    ] {
        let error = checked(&store, &account.id, budget).await.unwrap_err();
        assert!(
            matches!(error.downcast_ref::<SavedObservationReadError>(), Some(SavedObservationReadError::BudgetExceeded { dimension: actual, .. }) if *actual == dimension)
        );
    }
    let aggregate = read.admitted_bytes * 2 - 1;
    let remainder = SavedObservationReadBudget {
        total_bytes: aggregate - read.admitted_bytes,
        ..exact
    };
    assert!(matches!(
        checked(&store, &account.id, remainder)
            .await
            .unwrap_err()
            .downcast_ref::<SavedObservationReadError>(),
        Some(SavedObservationReadError::BudgetExceeded {
            dimension: "total_bytes",
            ..
        })
    ));
    // Oversized AND malformed JSON is a size refusal; the executed reader checks all payloads NULL.
    sqlx::query("UPDATE aws_accounts SET public_view=$2 WHERE id=$1")
        .bind(&account.id)
        .bind(json!({"unparsed": "x".repeat(20000)}))
        .execute(&store.pool)
        .await?;
    assert!(matches!(
        checked(&store, &account.id, SavedObservationReadBudget::default())
            .await
            .unwrap_err()
            .downcast_ref::<SavedObservationReadError>(),
        Some(SavedObservationReadError::BudgetExceeded {
            dimension: "registration_bytes",
            ..
        })
    ));
    sqlx::query("UPDATE aws_accounts SET public_view=$2 WHERE id=$1")
        .bind(&account.id)
        .bind(serde_json::to_value(&account)?)
        .execute(&store.pool)
        .await?;
    let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
    sqlx::query("INSERT INTO aws_topologies(id,account_id,generation,body) VALUES($1,$2,$3,$4)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&account.id)
        .bind(generation)
        .bind(json!({"unparsed": "x".repeat(SavedObservationReadBudget::default().topology_bytes)}))
        .execute(&store.pool)
        .await?;
    assert!(matches!(
        checked(&store, &account.id, SavedObservationReadBudget::default())
            .await
            .unwrap_err()
            .downcast_ref::<SavedObservationReadError>(),
        Some(SavedObservationReadError::BudgetExceeded {
            dimension: "topology_bytes",
            ..
        })
    ));
    // Scalar metadata is gated too, not transferred unbounded beside the JSON budget.
    let mut other = account.clone();
    other.id = "a".repeat(2048);
    other.region = "r".repeat(2048);
    sqlx::query("INSERT INTO aws_accounts(id,aws_account_id,region,role_configuration,public_view) VALUES($1,$2,$3,'null'::jsonb,$4)")
        .bind(&other.id).bind(&other.aws_account_id).bind(&other.region).bind(serde_json::to_value(&other)?).execute(&store.pool).await?;
    let mut other_snapshot = snapshot.clone();
    other_snapshot.id = "t".repeat(2048);
    other_snapshot.account_id = other.id.clone();
    other_snapshot.region = other.region.clone();
    sqlx::query("INSERT INTO aws_topologies(id,account_id,generation,body) VALUES($1,$2,1,$3)")
        .bind(&other_snapshot.id)
        .bind(&other.id)
        .bind(serde_json::to_value(other_snapshot)?)
        .execute(&store.pool)
        .await?;
    assert!(matches!(
        checked(&store, &other.id, SavedObservationReadBudget::default())
            .await
            .unwrap_err()
            .downcast_ref::<SavedObservationReadError>(),
        Some(SavedObservationReadError::BudgetExceeded {
            dimension: "metadata_bytes",
            ..
        })
    ));
    Ok(())
}
#[tokio::test]
async fn identity_schema_and_false_markers_are_required_without_repairing_evidence()
-> anyhow::Result<()> {
    use SavedObservationReadError::*;
    let (store, account, initial, _) = fixture().await?;
    let budget = SavedObservationReadBudget::default();
    for id in ["", "bad\n", "bad\u{85}", &"x".repeat(2049)] {
        assert_eq!(
            checked(&store, id, budget)
                .await
                .unwrap_err()
                .downcast_ref::<SavedObservationReadError>(),
            Some(&InvalidRegistrationInput)
        );
    }
    assert_eq!(
        checked(&store, "missing", budget)
            .await
            .unwrap_err()
            .downcast_ref::<SavedObservationReadError>(),
        Some(&MissingObservation)
    );
    if i64::try_from(usize::MAX).is_err() {
        assert_eq!(
            checked(
                &store,
                &account.id,
                SavedObservationReadBudget {
                    total_bytes: usize::MAX,
                    ..budget
                }
            )
            .await
            .unwrap_err()
            .downcast_ref::<SavedObservationReadError>(),
            Some(&InvalidBudget)
        );
    }
    for (key, value) in [
        ("id", json!("wrong")),
        ("account_id", json!("wrong")),
        ("aws_account_id", json!("999999999999")),
        ("region", json!("us-east-1")),
        ("execution_enabled", json!(true)),
        ("connectivity_tested", json!(true)),
        ("execution_enabled", Value::Null),
    ] {
        let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut forged = serde_json::to_value(&initial)?;
        forged["id"] = json!(id);
        forged[key] = value;
        sqlx::query(
            "INSERT INTO aws_topologies(id,account_id,generation,body) VALUES($1,$2,$3,$4)",
        )
        .bind(&id)
        .bind(&account.id)
        .bind(generation)
        .bind(&forged)
        .execute(&store.pool)
        .await?;
        let error = checked(&store, &account.id, budget).await.unwrap_err();
        assert_eq!(
            error.downcast_ref::<SavedObservationReadError>(),
            Some(&if forged[key].is_null() {
                MalformedObservation
            } else {
                IdentityUnavailable
            })
        );
    }
    let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
    let mut snapshot = initial;
    snapshot.id = uuid::Uuid::new_v4().to_string();
    snapshot.complete_for_supported_queries = false;
    sqlx::query("INSERT INTO aws_topologies(id,account_id,generation,body) VALUES($1,$2,$3,$4)")
        .bind(&snapshot.id)
        .bind(&account.id)
        .bind(generation)
        .bind(serde_json::to_value(&snapshot)?)
        .execute(&store.pool)
        .await?;
    assert!(
        !checked(&store, &account.id, budget)
            .await?
            .topology
            .complete_for_supported_queries
    );
    for (key, value) in [
        ("id", json!("wrong")),
        ("aws_account_id", json!("999999999999")),
        ("region", json!("us-east-1")),
        ("execution_enabled", json!(true)),
        ("execution_enabled", Value::Null),
    ] {
        let mut forged = serde_json::to_value(&account)?;
        forged[key] = value;
        sqlx::query("UPDATE aws_accounts SET public_view=$2 WHERE id=$1")
            .bind(&account.id)
            .bind(&forged)
            .execute(&store.pool)
            .await?;
        let error = checked(&store, &account.id, budget).await.unwrap_err();
        assert_eq!(
            error.downcast_ref::<SavedObservationReadError>(),
            Some(&if forged[key].is_null() {
                MalformedObservation
            } else {
                IdentityUnavailable
            })
        );
    }
    Ok(())
}

#[tokio::test]
async fn target_attachment_cidr_saved_capture_retains_all_declared_subnets() -> anyhow::Result<()> {
    use navarchnet::aws::{
        target_attachment_cidr_coverage::{
            self, TargetAttachmentCidrBudget, TargetAttachmentCidrQuery,
        },
        target_lookup::{self, TargetAzSelection, TargetVpcLookup},
    };
    let (store, account, mut topology, _) = fixture().await?;
    let (_, _, generation) = store.begin_aws_discovery("fixture", &account.id).await?;
    topology.id = uuid::Uuid::new_v4().to_string();
    topology.completed_at = "saved-target-generation".into();
    let row = |kind, id: &str| {
        let mut r = AwsResource::new(kind, id.into());
        r.owner_account_id = Some(account.aws_account_id.clone());
        r.state = Some("available".into());
        r
    };
    let gateway = row(ResourceKind::TransitGateway, "tgw-target");
    let mut attachment = row(ResourceKind::VpcAttachment, "tgw-attach-target");
    attachment.vpc_id = Some("vpc-target".into());
    attachment.related_ids = vec!["tgw-target".into(), "subnet-b".into(), "subnet-a".into()];
    let mut vpc = row(ResourceKind::Vpc, "vpc-target");
    vpc.cidrs = vec!["10.0.0.0/16".into()];
    let mut a = row(ResourceKind::Subnet, "subnet-a");
    a.vpc_id = Some(vpc.id.clone());
    a.az_id = Some("euw1-az1".into());
    a.cidrs = vec!["10.0.1.0/24".into()];
    let mut b = a.clone();
    b.id = "subnet-b".into();
    b.az_id = Some("euw1-az2".into());
    b.cidrs = vec!["10.0.2.0/24".into()];
    let mut main = row(ResourceKind::RouteTable, "rtb-main");
    main.vpc_id = Some(vpc.id.clone());
    main.associations = vec![RouteAssociation {
        id: Some("assoc-main".into()),
        main: true,
        subnet_id: None,
        gateway_id: None,
        state: Some("associated".into()),
    }];
    main.routes = vec![ObservedRoute {
        ipv4_destination: Some("0.0.0.0/0".into()),
        ipv6_destination: None,
        prefix_list_destination: None,
        state: Some("active".into()),
        origin: Some("CreateRoute".into()),
        targets: [("gatewayId".into(), "local".into())].into(),
    }];
    let mut second = main.clone();
    second.id = "rtb-second".into();
    second.associations[0].main = false;
    second.associations[0].subnet_id = Some(b.id.clone());
    second.associations[0].id = Some("assoc-second".into());
    let mut hidden = main.routes[0].clone();
    hidden.ipv4_destination = Some("203.0.113.3/32".into());
    hidden.state = Some("blackhole".into());
    hidden.targets.clear();
    second.routes.push(hidden);
    topology.resources = vec![gateway, attachment, vpc, b, main, a, second];
    store
        .finish_aws_discovery("fixture", generation, &topology)
        .await?;
    let (_, _, pending) = store.begin_aws_discovery("fixture", &account.id).await?;
    assert!(pending > generation);
    // The analysis reader must not need private or adoption decoding.
    sqlx::query("UPDATE aws_accounts SET role_configuration='null'::jsonb WHERE id=$1")
        .bind(&account.id)
        .execute(&store.pool)
        .await?;
    sqlx::query("INSERT INTO aws_adoptions(id,account_id,resource_kind,resource_id,topology_id,body) VALUES($1,$2,'vpc','vpc-target',$3,'null'::jsonb)").bind(uuid::Uuid::new_v4().to_string()).bind(&account.id).bind(&topology.id).execute(&store.pool).await?;
    let fingerprint = || async {
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
    };
    let before = fingerprint().await?;
    let saved = store
        .aws_saved_observation_bounded(&account.id, SavedObservationReadBudget::default())
        .await?;
    assert_eq!(saved.generation, generation);
    assert_eq!(saved.saved_row_id, topology.id);
    assert_eq!(saved.topology.completed_at, topology.completed_at);
    let result = target_attachment_cidr_coverage::analyze(
        saved,
        TargetAttachmentCidrQuery {
            network_account_id: account.id.clone(),
            transit_gateway_id: "tgw-target".into(),
            target_attachment_id: "tgw-attach-target".into(),
            destination_cidr: "203.0.113.0/29".into(),
        },
        TargetAttachmentCidrBudget::default(),
    )?;
    // Exercise the actual protected HTTP boundary against this independently analyzed capture.
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use navarchnet::{
        api::{self, AppState},
        auth::Auth,
    };
    use std::sync::Arc;
    use tower::ServiceExt;
    let app = api::router(AppState {
        store: store.clone(),
        auth: Arc::new(Auth::demo("a".repeat(32), "r".repeat(32))?),
        aws: None,
    });
    let response = app.oneshot(Request::builder()
        .uri(format!("/api/v1/aws/accounts/{}/tgw-target-cidr-coverage?transit_gateway_id=tgw-target&target_attachment_id=tgw-attach-target&destination_cidr=203.0.113.0%2F29", account.id))
        .header("authorization", format!("Bearer {}", "r".repeat(32)))
        .body(Body::empty())?).await?;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024).await?;
    assert_eq!(bytes.as_ref(), serde_json::to_vec(&result)?);
    assert_eq!(result.az_selection, TargetAzSelection::NotInferred);
    assert!(result.reference_only && result.partition_complete);
    assert!(!result.execution_enabled && !result.connectivity_tested);
    assert_eq!(
        serde_json::to_value(&result.network_saved.topology)?,
        serde_json::to_value(&topology)?
    );
    assert_eq!(
        serde_json::to_value(&result.network_saved.registration)?,
        serde_json::to_value(&account)?
    );
    assert_eq!(result.network_saved.generation, generation);
    assert_eq!(result.query.network_account_id, account.id);
    assert!(
        result
            .origins
            .iter()
            .any(|o| serde_json::to_value(o).unwrap()["predicate"]["resource_index"] == 6)
    );
    assert_eq!(result.segments.len(), 3);
    for octet in 0..8 {
        let ip: std::net::IpAddr = format!("203.0.113.{octet}").parse()?;
        let cells: Vec<_> = result
            .segments
            .iter()
            .filter(|c| {
                c.start.parse::<std::net::IpAddr>().unwrap() <= ip
                    && ip <= c.end_inclusive.parse::<std::net::IpAddr>().unwrap()
            })
            .collect();
        assert_eq!(cells.len(), 1);
        assert_eq!(
            cells[0].result,
            target_lookup::lookup(
                &topology,
                "tgw-target",
                "tgw-attach-target",
                &ip.to_string()
            )
        );
        let TargetVpcLookup::ReportedSubnets { subnets, .. } = &cells[0].result else {
            panic!("all declared subnets required")
        };
        assert_eq!(subnets.len(), 2);
        assert_eq!(subnets[0].subnet_id, "subnet-a");
        assert_eq!(subnets[1].subnet_id, "subnet-b");
        assert_eq!(
            serde_json::to_value(&subnets[0])?["lookup"]["source"],
            "implicit_main"
        );
        let body = serde_json::to_value(&subnets[1])?;
        assert_eq!(body["lookup"]["source"], "explicit_subnet");
        assert_eq!(
            body["lookup"]["lookup"]["status"],
            if octet == 3 {
                "reported_blackhole"
            } else {
                "reported_route"
            }
        );
    }
    assert_eq!(
        before,
        fingerprint().await?,
        "read and analysis preserve full raw state, fences, private/adoptions/audit and catalog"
    );
    Ok(())
}
