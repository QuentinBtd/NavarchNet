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
        let mut vpc = AwsResource::new(ResourceKind::Vpc, format!("vpc-browser-{suffix}"));
        vpc.owner_account_id = Some(account_id.into());
        vpc.state = Some("available".into());
        vpc.cidrs.push("10.1.0.0/16".into());
        let mut subnet = AwsResource::new(ResourceKind::Subnet, format!("subnet-browser-{suffix}"));
        subnet.owner_account_id = Some(account_id.into());
        subnet.vpc_id = Some(vpc.id.clone());
        subnet.state = Some("available".into());
        subnet.az_id = Some("euw1-az1".into());
        subnet
            .tags
            .insert("Name".into(), "Application subnet <img src=x>".into());
        let mut vpc_table =
            AwsResource::new(ResourceKind::RouteTable, format!("rtb-browser-{suffix}"));
        vpc_table.owner_account_id = Some(account_id.into());
        vpc_table.vpc_id = Some(vpc.id.clone());
        vpc_table.associations.push(RouteAssociation {
            id: Some(format!("rtbassoc-browser-{suffix}")),
            main: true,
            subnet_id: None,
            gateway_id: None,
            state: Some("associated".into()),
        });
        let route = |cidr: &str, state: &str, targets| ObservedRoute {
            ipv4_destination: Some(cidr.into()),
            ipv6_destination: None,
            prefix_list_destination: None,
            state: Some(state.into()),
            origin: Some("CreateRoute".into()),
            targets,
        };
        let mut local = route(
            "10.1.0.0/16",
            "active",
            [("gatewayId".into(), "local".into())].into(),
        );
        local.origin = Some("CreateRouteTable".into());
        vpc_table.routes = vec![
            route(
                "0.0.0.0/0",
                "active",
                [("transitGatewayId".into(), parent.id.clone())].into(),
            ),
            route("10.2.0.0/16", "blackhole", Default::default()),
            local,
        ];
        let mut resources = vec![parent, table, vpc, subnet, vpc_table];
        if suffix == "a" {
            let mut source_vpc = AwsResource::new(ResourceKind::Vpc, "vpc-browser-source".into());
            source_vpc.owner_account_id = Some(account_id.into());
            source_vpc.state = Some("available".into());
            source_vpc.cidrs = vec!["10.10.0.0/16".into(), "2001:db8:1::/56".into()];
            resources.push(source_vpc);
            for (id, az, ipv4, ipv6) in [
                (
                    "subnet-browser-source",
                    "euw1-az1",
                    "10.10.1.0/24",
                    "2001:db8:1:3::/64",
                ),
                (
                    "subnet-browser-attachment-1",
                    "euw1-az1",
                    "10.10.254.0/24",
                    "2001:db8:1:1::/64",
                ),
                (
                    "subnet-browser-attachment-2",
                    "euw1-az2",
                    "10.10.253.0/24",
                    "2001:db8:1:2::/64",
                ),
            ] {
                let mut subnet = AwsResource::new(ResourceKind::Subnet, id.into());
                subnet.owner_account_id = Some(account_id.into());
                subnet.vpc_id = Some("vpc-browser-source".into());
                subnet.state = Some("available".into());
                subnet.az_id = Some(az.into());
                subnet.cidrs = vec![ipv4.into(), ipv6.into()];
                subnet
                    .tags
                    .insert("Name".into(), "Source subnet <img src=x>".into());
                resources.push(subnet);
            }
            let mut routes =
                AwsResource::new(ResourceKind::RouteTable, "rtb-browser-source".into());
            routes.owner_account_id = Some(account_id.into());
            routes.vpc_id = Some("vpc-browser-source".into());
            routes.associations.push(RouteAssociation {
                id: Some("rtbassoc-browser-source".into()),
                main: true,
                subnet_id: None,
                gateway_id: None,
                state: Some("associated".into()),
            });
            routes.routes.push(route(
                "0.0.0.0/0",
                "active",
                [("transitGatewayId".into(), "tgw-browser-b".into())].into(),
            ));
            let mut local = route(
                "10.10.0.0/16",
                "active",
                [("gatewayId".into(), "local".into())].into(),
            );
            local.origin = Some("CreateRouteTable".into());
            routes.routes.push(local);
            resources.push(routes);
            // Synthetic point diagnostics, not an observed return flow or whole-CIDR verdict.
            let mut attachment_routes = AwsResource::new(
                ResourceKind::RouteTable,
                "rtb-browser-source-attachment".into(),
            );
            attachment_routes.owner_account_id = Some(account_id.into());
            attachment_routes.vpc_id = Some("vpc-browser-source".into());
            attachment_routes.associations.push(RouteAssociation {
                id: Some("rtbassoc-browser-source-attachment".into()),
                main: false,
                subnet_id: Some("subnet-browser-attachment-1".into()),
                gateway_id: None,
                state: Some("associated".into()),
            });
            let mut local = route(
                "10.10.0.0/16",
                "active",
                [("gatewayId".into(), "local".into())].into(),
            );
            local.origin = Some("CreateRouteTable".into());
            attachment_routes.routes = vec![
                local,
                route(
                    "10.10.1.0/24",
                    "blackhole",
                    [("natGatewayId".into(), "nat-browser-source-deleted".into())].into(),
                ),
            ];
            resources.push(attachment_routes);
        } else {
            // Target-side metadata is synthetic and does not select a traffic AZ or prove NAT health.
            resources[3].cidrs = vec!["10.1.254.0/24".into()];
            let mut target_subnet = resources[3].clone();
            target_subnet.id = "subnet-browser-target-2".into();
            target_subnet.az_id = Some("euw1-az2".into());
            target_subnet.cidrs = vec!["10.1.253.0/24".into()];
            resources[4].routes[0].targets =
                [("natGatewayId".into(), "nat-browser-regional".into())].into();
            resources[4]
                .routes
                .push(route("198.51.100.0/24", "blackhole", Default::default()));
            let mut egress = AwsResource::new(
                ResourceKind::VpcAttachment,
                "tgw-attach-browser-egress-b".into(),
            );
            egress.owner_account_id = Some(account_id.into());
            egress.vpc_id = Some("vpc-browser-b".into());
            egress.state = Some("available".into());
            egress.related_ids = vec![
                "tgw-browser-b".into(),
                resources[3].id.clone(),
                target_subnet.id.clone(),
            ];
            let mut nat = AwsResource::new(ResourceKind::NatGateway, "nat-browser-regional".into());
            nat.owner_account_id = Some(account_id.into());
            nat.state = Some("available".into());
            nat.availability_mode = Some("regional".into());
            nat.connectivity_type = Some("public".into());
            nat.public_ips = vec![
                "203.0.113.10".into(),
                "203.0.113.20".into(),
                "203.0.113.30".into(),
            ];
            nat.nat_gateway = Some(NatGatewayMetadata {
                route_table_id: Some("nat-literal-unvalidated-table-reference".into()),
                addresses: Some(vec![
                    NatGatewayAddress {
                        allocation_id: Some("eipalloc-browser-a".into()),
                        association_id: Some("eipassoc-browser-a".into()),
                        network_interface_id: Some("eni-browser-a".into()),
                        public_ip: Some("203.0.113.10".into()),
                        private_ip: Some("10.1.50.10".into()),
                        az_name: Some("eu-west-1a".into()),
                        az_id: Some("euw1-az1".into()),
                        is_primary: Some(true),
                        status: Some("succeeded".into()),
                    },
                    NatGatewayAddress {
                        allocation_id: None,
                        association_id: None,
                        network_interface_id: None,
                        public_ip: Some("203.0.113.20".into()),
                        private_ip: None,
                        az_name: None,
                        az_id: Some("euw1-az2".into()),
                        is_primary: Some(false),
                        status: Some("failed".into()),
                    },
                    NatGatewayAddress {
                        allocation_id: None,
                        association_id: None,
                        network_interface_id: None,
                        public_ip: Some("203.0.113.30".into()),
                        private_ip: None,
                        az_name: Some("eu-west-1c".into()),
                        az_id: None,
                        is_primary: None,
                        status: Some("future-<img src=x>".into()),
                    },
                ]),
            });
            let mut legacy_nat =
                AwsResource::new(ResourceKind::NatGateway, "nat-browser-legacy".into());
            legacy_nat.state = Some("available".into());
            let mut unreported_nat = legacy_nat.clone();
            unreported_nat.id = "nat-browser-unreported".into();
            unreported_nat.nat_gateway = Some(NatGatewayMetadata {
                route_table_id: None,
                addresses: None,
            });
            let mut empty_nat = legacy_nat.clone();
            empty_nat.id = "nat-browser-empty".into();
            empty_nat.nat_gateway = Some(NatGatewayMetadata {
                route_table_id: None,
                addresses: Some(vec![]),
            });
            resources.extend([
                target_subnet,
                egress,
                nat,
                legacy_nat,
                unreported_nat,
                empty_nat,
            ]);
            let mut ingress = AwsResource::new(
                ResourceKind::VpcAttachment,
                "tgw-attach-browser-source".into(),
            );
            ingress.owner_account_id = Some("123456789012".into());
            ingress.vpc_id = Some("vpc-browser-source".into());
            ingress.state = Some("available".into());
            ingress.related_ids = vec![
                "tgw-browser-b".into(),
                "subnet-browser-attachment-1".into(),
                "subnet-browser-attachment-2".into(),
            ];
            resources[1]
                .tgw_associations
                .as_mut()
                .unwrap()
                .push(TransitGatewayTableLink {
                    attachment_id: Some(ingress.id.clone()),
                    resource_id: ingress.vpc_id.clone(),
                    resource_type: Some("vpc".into()),
                    state: Some("associated".into()),
                    route_table_announcement_id: None,
                });
            resources.push(ingress);
        }
        let topology = AwsTopology {
            id: uuid::Uuid::new_v4().to_string(),
            account_id: account.id,
            aws_account_id: account_id.into(),
            region: role.region,
            started_at: "1".into(),
            completed_at: if suffix == "a" { "2" } else { "4" }.into(),
            session_name: "offline-fixture-no-sdk".into(),
            resources,
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
