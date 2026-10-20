//! Explicit offline test seeder; never an application endpoint or a live AWS onboarding path.
#[path = "../tests/support/mod.rs"]
mod support;
use navarchnet::aws::{RoleRegistration, observation::*};

fn validate_fixture_database(url: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        url.starts_with("postgres://") || url.starts_with("postgresql://"),
        "Fixture requires PostgreSQL"
    );
    anyhow::ensure!(
        !url.contains('#'),
        "Fixture database fragments are unsupported"
    );
    // Reject missing credentials before SQLx can consult a default pgpass file.
    let authority = url
        .split_once("://")
        .map(|(_, tail)| tail)
        .unwrap_or("")
        .split(['/', '?'])
        .next()
        .unwrap_or("");
    let credentials = authority
        .rsplit_once('@')
        .and_then(|(userinfo, _)| userinfo.split_once(':'));
    anyhow::ensure!(
        credentials.is_some_and(|(user, password)| !user.is_empty() && !password.is_empty()),
        "Fixture requires explicit disposable database credentials"
    );
    let mut seen_sslmode = false;
    if let Some((_, query)) = url.split_once('?') {
        for (key, value) in form_urlencoded::parse(query.as_bytes()) {
            anyhow::ensure!(
                key == "sslmode" && !seen_sslmode,
                "Unsupported or duplicate fixture database parameter"
            );
            anyhow::ensure!(
                [
                    "disable",
                    "allow",
                    "prefer",
                    "require",
                    "verify-ca",
                    "verify-full"
                ]
                .contains(&value.as_ref()),
                "Invalid fixture database parameter"
            );
            seen_sslmode = true;
        }
    }
    let raw_database = url
        .split_once("://")
        .and_then(|(_, tail)| tail.split_once('/'))
        .map(|(_, path)| path.split('?').next().unwrap_or("").trim_start_matches('/'));
    anyhow::ensure!(
        raw_database.is_some_and(|database| !database.is_empty()),
        "Fixture requires an explicit database path"
    );
    let parsed: sqlx::postgres::PgConnectOptions = url
        .parse()
        .map_err(|_| anyhow::anyhow!("Invalid fixture database configuration"))?;
    anyhow::ensure!(
        matches!(parsed.get_host(), "127.0.0.1" | "::1" | "[::1]") && parsed.get_socket().is_none(),
        "Fixture driver endpoint must be loopback TCP"
    );
    anyhow::ensure!(
        parsed.get_options().is_none(),
        "Fixture driver startup options must be absent before isolation"
    );
    anyhow::ensure!(
        parsed
            .get_database()
            .is_some_and(|database| !database.is_empty()),
        "Fixture requires an explicit driver database"
    );
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    anyhow::ensure!(
        std::env::args().nth(1).as_deref() == Some("--isolated-browser-fixture"),
        "Explicit isolated browser fixture argument required"
    );
    anyhow::ensure!(
        !std::env::vars_os().any(|(key, _)| key.to_string_lossy().starts_with("PG")),
        "Fixture seeder refuses ambient PostgreSQL settings"
    );
    validate_fixture_database(&std::env::var("DATABASE_URL")?)?;
    let (store, _) = support::isolated().await?;
    for (suffix, account_id) in [("a", "123456789012"), ("b", "210987654321")] {
        let role = RoleRegistration {
            name: format!("Browser saved TGW {}", suffix.to_uppercase()),
            role_arn: format!("arn:aws:iam::{account_id}:role/OfflineBrowserFixture"),
            region: "eu-west-1".into(),
            external_id: None,
        };
        let account = store
            .register_aws_verified(
                "offline-browser-fixture",
                &role,
                account_id,
                "offline-fixture-no-sdk",
            )
            .await?;
        let (_, _, generation) = store
            .begin_aws_discovery("offline-browser-fixture", &account.id)
            .await?;
        let mut parent = AwsResource::new(
            ResourceKind::TransitGateway,
            format!("tgw-browser-{suffix}"),
        );
        parent.owner_account_id = Some(account_id.into());
        parent.state = Some("available".into());
        let mut table = AwsResource::new(
            ResourceKind::TransitGatewayRouteTable,
            format!("tgw-rtb-browser-{suffix}"),
        );
        table.state = Some("available".into());
        table.related_ids.push(parent.id.clone());
        table
            .tags
            .insert("Name".into(), "<img src=x onerror=alert(1)>".into());
        table.tgw_associations = Some(vec![]);
        table.tgw_propagations = Some(vec![]);
        table.tgw_routes = Some(vec![
            TransitGatewayRoute {
                destination_cidr: Some("0.0.0.0/0".into()),
                prefix_list_id: None,
                state: Some("active".into()),
                route_type: Some("static".into()),
                route_table_announcement_id: None,
                attachments: vec![TransitGatewayRouteAttachment {
                    attachment_id: Some(format!("tgw-attach-browser-egress-{suffix}")),
                    resource_id: None,
                    resource_type: Some("vpc".into()),
                }],
            },
            TransitGatewayRoute {
                destination_cidr: Some("10.2.0.0/16".into()),
                prefix_list_id: None,
                state: Some("blackhole".into()),
                route_type: Some("static".into()),
                route_table_announcement_id: None,
                attachments: vec![],
            },
        ]);
        let topology = AwsTopology {
            id: uuid::Uuid::new_v4().to_string(),
            account_id: account.id,
            aws_account_id: account_id.into(),
            region: role.region,
            started_at: "1".into(),
            completed_at: "2".into(),
            session_name: "offline-fixture-no-sdk".into(),
            resources: vec![parent, table],
            request_ids: vec!["offline-browser-fixture".into()],
            complete_for_supported_queries: true,
            limitations: vec![
                "Synthetic saved browser fixture, not live AWS or connectivity evidence".into(),
            ],
            execution_enabled: false,
            connectivity_tested: false,
        };
        store
            .finish_aws_discovery("offline-browser-fixture", generation, &topology)
            .await?;
    }
    let schema: String = sqlx::query_scalar("SELECT current_schema()")
        .fetch_one(&store.pool)
        .await?;
    // Only the generated nonsecret schema identifier leaves this process, never a database URL.
    println!("{}", serde_json::json!({"schema":schema}));
    store.pool.close().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_implicit_or_empty_database_paths_before_connecting() {
        for url in [
            "postgres://fixture:dummy@127.0.0.1",
            "postgres://fixture:dummy@127.0.0.1/",
            "postgres://fixture:dummy@127.0.0.1/?sslmode=disable",
            "postgres://fixture:dummy@127.0.0.1///",
        ] {
            assert!(
                validate_fixture_database(url).is_err(),
                "An explicit database must be selected before connection"
            );
        }
    }
    #[test]
    fn canonical_base_and_generated_schema_match_actual_sqlx_driver_options() {
        let base = "postgres://fixture:dummy@127.0.0.1:55432/postgres?sslmode=disable";
        validate_fixture_database(base).unwrap();
        let schema = format!("test_{}", "a".repeat(32));
        let scoped = format!("{base}&options=-csearch_path%3D{schema}");
        let parsed: sqlx::postgres::PgConnectOptions = scoped.parse().unwrap();
        assert_eq!(parsed.get_host(), "127.0.0.1");
        assert_eq!(parsed.get_port(), 55432);
        assert_eq!(
            parsed.get_options(),
            Some(format!("-csearch_path={schema}").as_str())
        );
    }
    #[test]
    fn refuses_driver_routing_and_option_overrides_before_connecting() {
        for query in [
            "host=remote.example",
            "hostaddr=192.0.2.1",
            "h%6fst=remote.example",
            "host=127.0.0.1&host=remote.example",
            "port=1234",
            "dbname=other",
            "options=-csearch_path%3Dpublic",
            "options%5Bsearch_path%5D=public",
            "options=first&options%5Bsearch_path%5D=public",
            "opt%69ons%5Bsearch_path%5D=public",
            "sslmode=disable&sslmode=require",
        ] {
            assert!(
                validate_fixture_database(&format!(
                    "postgres://fixture:dummy@127.0.0.1:55432/postgres?{query}"
                ))
                .is_err(),
                "Unexpected accepted parameter case"
            );
        }
    }
    #[test]
    fn refuses_non_loopback_or_socket_endpoints_before_connecting() {
        for host in [
            "remote.example",
            "192.0.2.1",
            "%2Fvar%2Frun%2Fpostgresql",
            "localhost",
        ] {
            assert!(
                validate_fixture_database(&format!("postgres://fixture:dummy@{host}/postgres"))
                    .is_err()
            );
        }
        assert!(validate_fixture_database("postgres://fixture@127.0.0.1/postgres").is_err());
    }
}
