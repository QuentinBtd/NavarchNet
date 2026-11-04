//! A deliberately bounded, read-only EC2 Query protocol adapter.
#[cfg(test)]
#[path = "ec2_failure_tests.rs"]
mod failure_tests;
#[path = "ec2_tgw_routes.rs"]
mod tgw_routes;
#[cfg(test)]
#[path = "ec2_tgw_tests.rs"]
mod tgw_tests;
use super::{observation::*, session::RoleSession};
use anyhow::{Context, ensure};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Default)]
struct Node {
    name: String,
    text: String,
    children: Vec<Node>,
}
impl Node {
    fn field(&self, name: &str) -> Option<String> {
        self.children
            .iter()
            .find(|n| n.name == name)
            .map(|n| n.text.clone())
            .filter(|v| !v.is_empty())
    }
    fn items(&self, name: &str) -> Vec<&Node> {
        self.children
            .iter()
            .find(|n| n.name == name)
            .map(|n| n.children.iter().filter(|n| n.name == "item").collect())
            .unwrap_or_default()
    }
}
fn parse(body: &str, expected: &str) -> anyhow::Result<Node> {
    use quick_xml::{Reader, events::Event};
    ensure!(
        body.len() <= 8 * 1024 * 1024,
        "EC2 response exceeds the body limit"
    );
    let mut reader = Reader::from_str(body);
    reader.config_mut().expand_empty_elements = true;
    let mut stack = vec![Node::default()];
    let mut count = 0;
    loop {
        match reader.read_event().context("Invalid EC2 XML")? {
            Event::Start(e) | Event::Empty(e) => {
                // Empty events are expanded below by the reader configuration.
                count += 1;
                ensure!(
                    count <= 100_000 && stack.len() <= 32,
                    "EC2 XML structural limit exceeded"
                );
                stack.push(Node {
                    name: e.local_name().as_ref().to_owned(),
                    ..Node::default()
                });
            }
            Event::End(_) => {
                ensure!(stack.len() > 1, "Unbalanced EC2 XML");
                let node = stack.pop().context("Missing XML node")?;
                let mut names = BTreeSet::new();
                for child in &node.children {
                    ensure!(
                        child.name == "item" || names.insert(&child.name),
                        "Duplicate EC2 response field"
                    );
                }
                stack
                    .last_mut()
                    .context("Missing XML parent")?
                    .children
                    .push(node);
            }
            Event::Text(e) => stack
                .last_mut()
                .context("Missing XML text parent")?
                .text
                .push_str(&e.xml10_content()),
            Event::CData(e) => stack
                .last_mut()
                .context("Missing XML CDATA parent")?
                .text
                .push_str(e.as_ref()),
            Event::GeneralRef(e) => {
                let value = match e.resolve_char_ref()? {
                    Some(ch) => ch.to_string(),
                    None => match e.as_ref() {
                        "amp" => "&",
                        "lt" => "<",
                        "gt" => ">",
                        "quot" => "\"",
                        "apos" => "'",
                        _ => anyhow::bail!("Unsupported EC2 XML entity"),
                    }
                    .to_string(),
                };
                stack
                    .last_mut()
                    .context("Missing XML reference parent")?
                    .text
                    .push_str(&value);
            }
            Event::DocType(_) => anyhow::bail!("DTD is forbidden in EC2 responses"),
            Event::Eof => break,
            _ => {}
        }
    }
    ensure!(stack.len() == 1, "Truncated EC2 XML");
    let mut outer = stack.pop().context("Empty XML response")?;
    ensure!(
        outer.children.len() == 1 && outer.text.trim().is_empty(),
        "Expected one EC2 XML root"
    );
    let root = outer.children.pop().context("Missing EC2 root")?;
    ensure!(
        root.name == expected && root.field("requestId").is_some(),
        "Unexpected EC2 response root or missing request ID"
    );
    Ok(root)
}
fn resource(node: &Node, kind: ResourceKind, id_field: &str) -> anyhow::Result<AwsResource> {
    let id = node
        .field(id_field)
        .context("Missing EC2 resource identifier")?;
    ensure!(
        id.len() <= 2048 && !id.chars().any(char::is_control),
        "Invalid EC2 resource identifier"
    );
    let mut value = AwsResource::new(kind, id);
    value.owner_account_id = node.field("ownerId").or_else(|| node.field("vpcOwnerId"));
    value.vpc_id = node.field("vpcId");
    value.subnet_id = node.field("subnetId");
    value.az_id = node.field("availabilityZoneId");
    value.state = node.field("state");
    value.connectivity_type = node.field("connectivityType");
    value.availability_mode = node.field("availabilityMode");
    if value.kind == ResourceKind::NatGateway {
        value.nat_gateway = Some(NatGatewayMetadata {
            route_table_id: node.field("routeTableId"),
            addresses: node
                .children
                .iter()
                .find(|child| child.name == "natGatewayAddressSet")
                .map(|collection| {
                    ensure!(
                        collection.text.trim().is_empty()
                            && collection.children.iter().all(|child| child.name == "item"),
                        "Malformed NAT address collection"
                    );
                    node.items("natGatewayAddressSet")
                        .iter()
                        .map(|address| {
                            Ok(NatGatewayAddress {
                                allocation_id: address.field("allocationId"),
                                association_id: address.field("associationId"),
                                network_interface_id: address.field("networkInterfaceId"),
                                public_ip: address.field("publicIp"),
                                private_ip: address.field("privateIp"),
                                az_name: address.field("availabilityZone"),
                                az_id: address.field("availabilityZoneId"),
                                is_primary: address
                                    .field("isPrimary")
                                    .map(|value| value.parse::<bool>())
                                    .transpose()
                                    .context("Invalid NAT primary-address marker")?,
                                status: address.field("status"),
                            })
                        })
                        .collect::<anyhow::Result<Vec<_>>>()
                })
                .transpose()?,
        });
    }
    for field in ["cidrBlock", "ipv6CidrBlock"] {
        if let Some(cidr) = node.field(field) {
            value.cidrs.push(cidr);
        }
    }
    for set in ["cidrBlockAssociationSet", "ipv6CidrBlockAssociationSet"] {
        for child in node.items(set) {
            for field in ["cidrBlock", "ipv6CidrBlock"] {
                if let Some(cidr) = child.field(field) {
                    value.cidrs.push(cidr);
                }
            }
        }
    }
    for cidr in &value.cidrs {
        let _ = cidr
            .parse::<ipnet::IpNet>()
            .context("Malformed CIDR in EC2 observation")?;
    }
    value.cidrs.sort();
    value.cidrs.dedup();
    for tag in node.items("tagSet") {
        let key = tag.field("key").context("EC2 tag key is missing")?;
        let text = tag.field("value").unwrap_or_default();
        ensure!(
            value.tags.insert(key, text).is_none(),
            "Duplicate EC2 tag key"
        );
    }
    for route in node.items("routeSet") {
        value.routes.push(ObservedRoute {
            ipv4_destination: route.field("destinationCidrBlock"),
            ipv6_destination: route.field("destinationIpv6CidrBlock"),
            prefix_list_destination: route.field("destinationPrefixListId"),
            state: route.field("state"),
            origin: route.field("origin"),
            targets: route
                .children
                .iter()
                .filter(|c| {
                    (c.name.ends_with("Id") || c.name.ends_with("Arn"))
                        && !["destinationPrefixListId", "instanceOwnerId"]
                            .contains(&c.name.as_str())
                })
                .map(|c| (c.name.clone(), c.text.clone()))
                .collect::<BTreeMap<_, _>>(),
        });
    }
    for association in node.items("associationSet") {
        let main = association.field("main");
        ensure!(
            main.as_deref()
                .is_none_or(|v| ["true", "false"].contains(&v)),
            "Invalid main-route-table marker"
        );
        value.associations.push(RouteAssociation {
            state: association
                .children
                .iter()
                .find(|node| node.name == "associationState")
                .and_then(|node| node.field("state")),
            id: association.field("routeTableAssociationId"),
            subnet_id: association.field("subnetId"),
            gateway_id: association.field("gatewayId"),
            main: main.as_deref() == Some("true"),
        });
    }
    for field in [
        "transitGatewayId",
        "networkInterfaceId",
        "allocationId",
        "associationId",
    ] {
        if let Some(id) = node.field(field) {
            value.related_ids.push(id);
        }
    }
    for child in node.items("subnetIds") {
        if !child.text.is_empty() {
            value.related_ids.push(child.text.clone());
        }
    }
    for child in node.items("attachmentSet") {
        if let Some(id) = child.field("vpcId") {
            value.related_ids.push(id);
        }
    }
    for child in node.items("natGatewayAddressSet") {
        for field in ["allocationId", "networkInterfaceId"] {
            if let Some(id) = child.field(field) {
                value.related_ids.push(id);
            }
        }
        if let Some(ip) = child.field("publicIp") {
            value.public_ips.push(ip);
        }
        if let Some(ip) = child.field("privateIp") {
            value.private_ips.push(ip);
        }
    }
    if let Some(ip) = node.field("publicIp") {
        value.public_ips.push(ip);
    }
    if let Some(ip) = node.field("privateIpAddress") {
        value.private_ips.push(ip);
    }
    for ip in value.public_ips.iter().chain(&value.private_ips) {
        let _ = ip
            .parse::<std::net::IpAddr>()
            .context("Malformed IP address in EC2 observation")?;
    }
    Ok(value)
}

pub struct Ec2ReadOnly {
    client: reqwest::Client,
    endpoint: String,
    region: String,
    credentials: super::session::TemporaryCredentials,
}
#[derive(Default)]
struct BodyBudget {
    bytes: usize,
}
impl BodyBudget {
    fn consume(&mut self, bytes: usize) -> anyhow::Result<()> {
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .context("EC2 body byte counter overflow")?;
        ensure!(
            self.bytes <= 32 * 1024 * 1024,
            "EC2 discovery exceeds its aggregate body budget across pages and retries"
        );
        Ok(())
    }
}
const QUERIES: [(&str, &str, ResourceKind, &str, bool); 9] = [
    ("DescribeVpcs", "vpcSet", ResourceKind::Vpc, "vpcId", true),
    (
        "DescribeSubnets",
        "subnetSet",
        ResourceKind::Subnet,
        "subnetId",
        true,
    ),
    (
        "DescribeRouteTables",
        "routeTableSet",
        ResourceKind::RouteTable,
        "routeTableId",
        true,
    ),
    (
        "DescribeTransitGateways",
        "transitGatewaySet",
        ResourceKind::TransitGateway,
        "transitGatewayId",
        true,
    ),
    (
        "DescribeTransitGatewayVpcAttachments",
        "transitGatewayVpcAttachments",
        ResourceKind::VpcAttachment,
        "transitGatewayAttachmentId",
        true,
    ),
    (
        "DescribeNatGateways",
        "natGatewaySet",
        ResourceKind::NatGateway,
        "natGatewayId",
        true,
    ),
    (
        "DescribeInternetGateways",
        "internetGatewaySet",
        ResourceKind::InternetGateway,
        "internetGatewayId",
        true,
    ),
    (
        "DescribeAddresses",
        "addressesSet",
        ResourceKind::ElasticIp,
        "allocationId",
        false,
    ),
    (
        "DescribeTransitGatewayRouteTables",
        "transitGatewayRouteTables",
        ResourceKind::TransitGatewayRouteTable,
        "transitGatewayRouteTableId",
        true,
    ),
];
pub(crate) struct Pagination {
    seen: BTreeSet<String>,
    pages: usize,
}
impl Pagination {
    pub(crate) fn new() -> Self {
        Self {
            seen: BTreeSet::new(),
            pages: 0,
        }
    }
    pub(crate) fn next(&mut self, token: Option<String>) -> anyhow::Result<Option<String>> {
        self.pages += 1;
        ensure!(self.pages <= 100, "AWS pagination exceeded 100 pages");
        if let Some(value) = token.as_ref().filter(|v| !v.is_empty()) {
            ensure!(
                self.pages < 100 && value.len() <= 4096 && self.seen.insert(value.clone()),
                "AWS pagination is cyclic, truncated or exceeds its token budget"
            );
            return Ok(Some(value.clone()));
        }
        Ok(None)
    }
}
fn transport(https_only: bool) -> anyhow::Result<reqwest::Client> {
    // Process-local initialization; never replaces an already installed crypto provider.
    let _ = rustls::crypto::ring::default_provider().install_default();
    Ok(reqwest::Client::builder()
        .https_only(https_only)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(3))
        .timeout(std::time::Duration::from_secs(20))
        .build()?)
}
impl Ec2ReadOnly {
    pub fn new(session: &RoleSession) -> anyhow::Result<Self> {
        super::validate_region(&session.region)?;
        Ok(Self {
            client: transport(true)?,
            endpoint: format!("https://ec2.{}.amazonaws.com/", session.region),
            region: session.region.clone(),
            credentials: session.credentials.clone(),
        })
    }
    async fn query(
        &self,
        action: &str,
        paginated: bool,
        token: Option<&str>,
        budget: &mut BodyBudget,
    ) -> anyhow::Result<Node> {
        self.query_scoped(action, paginated, token, None, budget)
            .await
    }
    async fn query_scoped(
        &self,
        action: &str,
        paginated: bool,
        token: Option<&str>,
        table_id: Option<&str>,
        budget: &mut BodyBudget,
    ) -> anyhow::Result<Node> {
        ensure!(
            table_id.is_none()
                || matches!(
                    action,
                    "GetTransitGatewayRouteTableAssociations"
                        | "GetTransitGatewayRouteTablePropagations"
                        | "SearchTransitGatewayRoutes"
                ),
            "Unsupported scoped EC2 read"
        );
        use aws_credential_types::provider::ProvideCredentials;
        use aws_sigv4::{
            http_request::{SignableBody, SignableRequest, SigningSettings, sign},
            sign::v4::SigningParams,
        };
        let body = {
            // The serializer is not Send; finish its scope before awaiting credentials/HTTP.
            let mut form = form_urlencoded::Serializer::new(String::new());
            form.append_pair("Action", action)
                .append_pair("Version", "2016-11-15");
            if paginated {
                form.append_pair(
                    "MaxResults",
                    if action == "SearchTransitGatewayRoutes" {
                        "1000"
                    } else {
                        "100"
                    },
                );
            }
            if let Some(value) = token {
                form.append_pair("NextToken", value);
            }
            if let Some(value) = table_id {
                form.append_pair("TransitGatewayRouteTableId", value);
            }
            if action == "SearchTransitGatewayRoutes" {
                form.append_pair("Filter.1.Name", "type")
                    .append_pair("Filter.1.Value.1", "static")
                    .append_pair("Filter.1.Value.2", "propagated");
            }
            form.finish()
        };
        for attempt in 0..3 {
            let credentials = self
                .credentials
                .provide_credentials()
                .await
                .map_err(|_| super::session::redacted_error("AssumeRole credentials", None))?;
            let identity = credentials.into();
            let params = SigningParams::builder()
                .identity(&identity)
                .region(&self.region)
                .name("ec2")
                .time(std::time::SystemTime::now())
                .settings(SigningSettings::default())
                .build()?
                .into();
            let content_type = "application/x-www-form-urlencoded; charset=utf-8";
            let signable = SignableRequest::new(
                "POST",
                &self.endpoint,
                std::iter::once(("content-type", content_type)),
                SignableBody::Bytes(body.as_bytes()),
            )?;
            let (instructions, _) = sign(signable, &params)?.into_parts();
            let mut request = self
                .client
                .post(&self.endpoint)
                .header("content-type", content_type)
                .body(body.clone());
            for (name, value) in instructions.headers() {
                request = request.header(name, value);
            }
            let response = request.send().await;
            let mut response = match response {
                Ok(value) => value,
                Err(_) if attempt < 2 => {
                    tokio::time::sleep(std::time::Duration::from_millis(100 * (attempt + 1))).await;
                    continue;
                }
                Err(_) => return Err(super::session::redacted_error(action, None)),
            };
            let status = response.status();
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| super::session::redacted_error(action, None))?
            {
                ensure!(
                    bytes.len() + chunk.len() <= 8 * 1024 * 1024,
                    "EC2 response exceeds the body limit"
                );
                budget.consume(chunk.len())?;
                bytes.extend_from_slice(&chunk);
            }
            let text = std::str::from_utf8(&bytes).context("EC2 returned non-UTF8 XML")?;
            if status.is_success() {
                return parse(text, &format!("{action}Response"));
            }
            // Do not expose error messages, request headers or credential-provider sources.
            let expired = text.contains("<Code>ExpiredToken</Code>")
                || text.contains("<Code>ExpiredTokenException</Code>");
            let retryable = expired
                || status.as_u16() == 429
                || status.is_server_error()
                || text.contains("<Code>RequestLimitExceeded</Code>")
                || text.contains("<Code>Throttling</Code>");
            if retryable && attempt < 2 {
                if expired {
                    self.credentials.invalidate().await;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100 * (attempt + 1))).await;
                continue;
            }
            return Err(super::session::redacted_error(
                action,
                Some(if expired {
                    "ExpiredToken"
                } else if retryable {
                    "RetryBudgetExhausted"
                } else {
                    "PermissionOrRequestRejected"
                }),
            ));
        }
        anyhow::bail!("EC2 retry budget exhausted")
    }
    async fn table_links(
        &self,
        action: &str,
        set: &str,
        id: &str,
        budget: &mut BodyBudget,
        count: &mut usize,
        requests: &mut Vec<String>,
    ) -> anyhow::Result<Vec<TransitGatewayTableLink>> {
        let mut result = Vec::new();
        let mut pages = Pagination::new();
        let mut token = None;
        let mut seen = BTreeSet::new();
        loop {
            let root = self
                .query_scoped(action, true, token.as_deref(), Some(id), budget)
                .await?;
            requests.push(root.field("requestId").context("Missing TGW request ID")?);
            ensure!(
                root.children.iter().any(|n| n.name == set),
                "TGW response omitted its expected collection"
            );
            for node in root.items(set) {
                let link = TransitGatewayTableLink {
                    attachment_id: node.field("transitGatewayAttachmentId"),
                    resource_id: node.field("resourceId"),
                    resource_type: node.field("resourceType"),
                    state: node.field("state"),
                    route_table_announcement_id: node
                        .field("transitGatewayRouteTableAnnouncementId"),
                };
                for value in [
                    &link.attachment_id,
                    &link.resource_id,
                    &link.resource_type,
                    &link.state,
                    &link.route_table_announcement_id,
                ]
                .into_iter()
                .flatten()
                {
                    ensure!(
                        value.len() <= 2048 && !value.chars().any(char::is_control),
                        "Invalid TGW relationship field"
                    );
                }
                ensure!(
                    link.attachment_id.is_some()
                        || link.route_table_announcement_id.is_some()
                        || link.resource_id.is_some(),
                    "TGW relationship omitted its identity"
                );
                let fallback =
                    if link.attachment_id.is_none() && link.route_table_announcement_id.is_none() {
                        Some((link.resource_id.clone(), link.resource_type.clone()))
                    } else {
                        None
                    };
                ensure!(
                    seen.insert((
                        link.attachment_id.clone(),
                        link.route_table_announcement_id.clone(),
                        fallback
                    )),
                    "Duplicate TGW relationship across pages; repeat discovery against a stable scope"
                );
                *count = count
                    .checked_add(1)
                    .context("TGW relationship counter overflow")?;
                ensure!(*count <= 10_000, "TGW relationship budget exceeded");
                result.push(link);
            }
            token = pages.next(root.field("nextToken"))?;
            if token.is_none() {
                break;
            }
        }
        Ok(result)
    }
    pub async fn discover(&self) -> anyhow::Result<(Vec<AwsResource>, Vec<String>)> {
        let mut resources = Vec::new();
        let mut requests = Vec::new();
        let mut identities = BTreeSet::new();
        let mut budget = BodyBudget::default();
        for (action, set, kind, id, paginated) in &QUERIES {
            let mut pages = Pagination::new();
            let mut token = None;
            loop {
                let root = self
                    .query(action, *paginated, token.as_deref(), &mut budget)
                    .await?;
                requests.push(root.field("requestId").context("Missing EC2 request ID")?);
                ensure!(
                    root.children.iter().any(|n| n.name == *set),
                    "EC2 response omitted the expected collection"
                );
                for node in root.items(set) {
                    let value = resource(node, kind.clone(), id)?;
                    ensure!(
                        identities.insert((value.kind.clone(), value.id.clone())),
                        "Duplicate EC2 resource across pages; repeat discovery against a stable scope"
                    );
                    resources.push(value);
                    ensure!(resources.len() <= 10_000, "AWS resource budget exceeded");
                }
                let next = root.field("nextToken");
                ensure!(
                    *paginated || next.is_none(),
                    "Non-paginated EC2 action returned a continuation token"
                );
                token = pages.next(next)?;
                if token.is_none() {
                    break;
                }
            }
        }
        let mut links = 0;
        let mut route_budget = tgw_routes::RouteBudget::default();
        for row in resources
            .iter_mut()
            .filter(|r| r.kind == ResourceKind::TransitGatewayRouteTable)
        {
            row.tgw_associations = Some(
                self.table_links(
                    "GetTransitGatewayRouteTableAssociations",
                    "associations",
                    &row.id,
                    &mut budget,
                    &mut links,
                    &mut requests,
                )
                .await?,
            );
            row.tgw_propagations = Some(
                self.table_links(
                    "GetTransitGatewayRouteTablePropagations",
                    "transitGatewayRouteTablePropagations",
                    &row.id,
                    &mut budget,
                    &mut links,
                    &mut requests,
                )
                .await?,
            );
            row.tgw_routes = Some(
                self.table_routes(&row.id, &mut budget, &mut route_budget, &mut requests)
                    .await?,
            );
        }
        Ok((resources, requests))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_nat_table_reference_and_address_tuples_without_selecting_egress() {
        let root = parse(
            "<DescribeNatGatewaysResponse><requestId>fixture</requestId><natGatewaySet><item><natGatewayId>nat-regional</natGatewayId><availabilityMode>regional</availabilityMode><connectivityType>public</connectivityType><state>available</state><vpcId>vpc-egress</vpcId><routeTableId>rtb-nat-reported</routeTableId><natGatewayAddressSet><item><allocationId>eipalloc-a</allocationId><associationId>eipassoc-a</associationId><networkInterfaceId>eni-a</networkInterfaceId><publicIp>203.0.113.10</publicIp><privateIp>10.0.1.10</privateIp><availabilityZone>eu-west-1a</availabilityZone><availabilityZoneId>euw1-az1</availabilityZoneId><isPrimary>true</isPrimary><status>succeeded</status></item><item><publicIp>203.0.113.20</publicIp><availabilityZoneId>euw1-az2</availabilityZoneId><isPrimary>false</isPrimary><status>failed</status></item></natGatewayAddressSet></item></natGatewaySet></DescribeNatGatewaysResponse>",
            "DescribeNatGatewaysResponse",
        ).unwrap();
        let row = resource(
            root.items("natGatewaySet")[0],
            ResourceKind::NatGateway,
            "natGatewayId",
        )
        .unwrap();
        let value = serde_json::to_value(&row).unwrap();
        assert_eq!(
            value["nat_gateway"],
            serde_json::json!({
                "route_table_id": "rtb-nat-reported",
                "addresses": [
                    {"allocation_id":"eipalloc-a", "association_id":"eipassoc-a", "network_interface_id":"eni-a", "public_ip":"203.0.113.10", "private_ip":"10.0.1.10", "az_name":"eu-west-1a", "az_id":"euw1-az1", "is_primary":true, "status":"succeeded"},
                    {"allocation_id":null, "association_id":null, "network_interface_id":null, "public_ip":"203.0.113.20", "private_ip":null, "az_name":null, "az_id":"euw1-az2", "is_primary":false, "status":"failed"}
                ]
            })
        );
        // Keep the legacy aggregate, including failed-address metadata, without calling it used/healthy.
        assert_eq!(row.public_ips, ["203.0.113.10", "203.0.113.20"]);
        assert!(row.subnet_id.is_none() && row.az_id.is_none() && !row.managed);
    }
    #[test]
    fn absent_nat_addresses_remain_unknown_instead_of_becoming_a_completed_empty_list() {
        for (body, addresses) in [
            ("", serde_json::Value::Null),
            ("<natGatewayAddressSet/>", serde_json::json!([])),
        ] {
            let root = parse(&format!("<DescribeNatGatewaysResponse><requestId>fixture</requestId><natGatewaySet><item><natGatewayId>nat-legacy</natGatewayId>{body}</item></natGatewaySet></DescribeNatGatewaysResponse>"), "DescribeNatGatewaysResponse").unwrap();
            let row = resource(
                root.items("natGatewaySet")[0],
                ResourceKind::NatGateway,
                "natGatewayId",
            )
            .unwrap();
            assert_eq!(
                serde_json::to_value(&row).unwrap()["nat_gateway"]["addresses"],
                addresses
            );
            assert!(row.availability_mode.is_none() && row.subnet_id.is_none());
        }
        let root = parse("<DescribeVpcsResponse><requestId>fixture</requestId><vpcSet><item><vpcId>vpc-a</vpcId><routeTableId>rtb-unrelated</routeTableId></item></vpcSet></DescribeVpcsResponse>", "DescribeVpcsResponse").unwrap();
        let row = resource(root.items("vpcSet")[0], ResourceKind::Vpc, "vpcId").unwrap();
        assert!(serde_json::to_value(&row).unwrap()["nat_gateway"].is_null());
    }
    #[test]
    fn preserves_route_association_readiness_without_assuming_missing_state() {
        let root=parse("<DescribeRouteTablesResponse><requestId>fixture</requestId><routeTableSet><item><routeTableId>rtb-main</routeTableId><associationSet><item><main>true</main><routeTableAssociationId>rtbassoc-main</routeTableAssociationId><associationState><state>associated</state></associationState></item><item><main>false</main><subnetId>subnet-transition</subnetId><associationState><state>disassociating</state></associationState></item><item><main>false</main><subnetId>subnet-legacy</subnetId></item></associationSet></item></routeTableSet></DescribeRouteTablesResponse>","DescribeRouteTablesResponse").unwrap();
        let row = resource(
            root.items("routeTableSet")[0],
            ResourceKind::RouteTable,
            "routeTableId",
        )
        .unwrap();
        assert_eq!(row.associations[0].state.as_deref(), Some("associated"));
        assert_eq!(row.associations[1].state.as_deref(), Some("disassociating"));
        assert!(row.associations[2].state.is_none());
    }
    #[test]
    fn nat_markers_keep_unknown_values_and_existing_strict_boolean_and_ip_guards() {
        let decode = |body: &str| {
            let root = parse(
                &format!(
                    "<DescribeNatGatewaysResponse><requestId>fixture</requestId><natGatewaySet><item><natGatewayId>nat-a</natGatewayId><routeTableId>nat-literal-not-a-table</routeTableId><natGatewayAddressSet><item>{body}</item></natGatewayAddressSet></item></natGatewaySet></DescribeNatGatewaysResponse>"
                ),
                "DescribeNatGatewaysResponse",
            )?;
            resource(
                root.items("natGatewaySet")[0],
                ResourceKind::NatGateway,
                "natGatewayId",
            )
        };
        let row =
            decode("<availabilityZone>eu-west-1a</availabilityZone><status>future-status</status>")
                .unwrap();
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(
            json["nat_gateway"]["route_table_id"],
            "nat-literal-not-a-table"
        );
        let address = &json["nat_gateway"]["addresses"][0];
        assert_eq!(address["status"], "future-status");
        assert_eq!(address["az_name"], "eu-west-1a");
        assert!(address["is_primary"].is_null() && address["az_id"].is_null());
        assert!(row.az_id.is_none() && row.availability_mode.is_none());
        for value in ["TRUE", "1", "invalid-marker-do-not-echo"] {
            let error = decode(&format!("<isPrimary>{value}</isPrimary>"))
                .unwrap_err()
                .to_string();
            assert_eq!(error, "Invalid NAT primary-address marker");
        }
        for body in [
            "<publicIp>invalid</publicIp>",
            "<privateIp>invalid</privateIp>",
        ] {
            assert!(decode(body).is_err());
        }
        let mut legacy = json;
        legacy.as_object_mut().unwrap().remove("nat_gateway");
        let old: AwsResource = serde_json::from_value(legacy).unwrap();
        assert!(old.nat_gateway.is_none());
    }
    #[test]
    fn malformed_nat_address_collections_cannot_be_reported_as_empty_or_partial() {
        for body in [
            "unexpected-text",
            "<futureItem/>",
            "<item><publicIp>203.0.113.10</publicIp></item><futureItem/>",
        ] {
            let root = parse(&format!("<DescribeNatGatewaysResponse><requestId>fixture</requestId><natGatewaySet><item><natGatewayId>nat-a</natGatewayId><natGatewayAddressSet>{body}</natGatewayAddressSet></item></natGatewaySet></DescribeNatGatewaysResponse>"), "DescribeNatGatewaysResponse").unwrap();
            assert!(
                resource(
                    root.items("natGatewaySet")[0],
                    ResourceKind::NatGateway,
                    "natGatewayId"
                )
                .is_err(),
                "Published malformed/partial NAT address collection"
            );
        }
    }
    #[test]
    fn reports_public_addresses_without_claiming_they_are_tested_egress() {
        let root=parse("<DescribeAddressesResponse><requestId>fixture</requestId><addressesSet><item><allocationId>eipalloc-01111111111111111</allocationId><publicIp>203.0.113.10</publicIp></item></addressesSet></DescribeAddressesResponse>","DescribeAddressesResponse").unwrap();
        let address = resource(
            root.items("addressesSet")[0],
            ResourceKind::ElasticIp,
            "allocationId",
        )
        .unwrap();
        assert_eq!(address.public_ips, vec!["203.0.113.10"]);
        assert!(!address.managed);
    }
    #[test]
    fn bounds_aggregate_body_bytes_across_pages_and_retries() {
        let mut budget = BodyBudget::default();
        assert!(budget.consume(32 * 1024 * 1024).is_ok());
        assert!(budget.consume(1).is_err());
    }
    #[test]
    fn pagination_refuses_cycles_token_exhaustion_and_unbounded_pages() {
        let mut pages = Pagination::new();
        assert_eq!(
            pages
                .next(Some("opaque+/=&token".into()))
                .unwrap()
                .as_deref(),
            Some("opaque+/=&token")
        );
        assert!(pages.next(Some("opaque+/=&token".into())).is_err());
        assert!(Pagination::new().next(Some("x".repeat(4097))).is_err());
        let mut pages = Pagination::new();
        for value in 0..99 {
            assert!(pages.next(Some(value.to_string())).is_ok());
        }
        assert!(pages.next(Some("unfinished".into())).is_err());
    }
    #[tokio::test]
    async fn signed_local_protocol_walks_all_describe_pages_and_retries_throttling() {
        use aws_credential_types::{Credentials, provider::SharedCredentialsProvider};
        use axum::{
            Router,
            body::Bytes,
            extract::State,
            http::{HeaderMap, StatusCode},
            routing::post,
        };
        use std::sync::Arc;
        use tokio::sync::Mutex;
        type Requests = Arc<Mutex<Vec<BTreeMap<String, String>>>>;
        let requests = Arc::new(Mutex::new(Vec::<BTreeMap<String, String>>::new()));
        async fn handler(
            State(requests): State<Requests>,
            headers: HeaderMap,
            body: Bytes,
        ) -> (StatusCode, String) {
            assert_eq!(headers["x-amz-security-token"], "fixture-session");
            let auth = headers["authorization"].to_str().unwrap();
            assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=ASIAEXAMPLEONLY/"));
            assert!(auth.contains("/eu-west-1/ec2/aws4_request"));
            assert!(auth.contains("x-amz-security-token"));
            let fields: BTreeMap<_, _> = form_urlencoded::parse(&body).into_owned().collect();
            assert_eq!(fields["Version"], "2016-11-15");
            let mut requests = requests.lock().await;
            requests.push(fields.clone());
            if requests.len() == 1 {
                return (StatusCode::SERVICE_UNAVAILABLE,"<Response><Errors><Error><Code>RequestLimitExceeded</Code></Error></Errors></Response>".into());
            }
            let (action, set, _, id, paginated) =
                QUERIES.iter().find(|q| q.0 == fields["Action"]).unwrap();
            assert_eq!(
                fields.get("MaxResults").map(String::as_str),
                if *paginated { Some("100") } else { None }
            );
            let (items, next) = if *action == "DescribeVpcs" {
                if let Some(token) = fields.get("NextToken") {
                    assert_eq!(token, "opaque+/=&token");
                    (
                        format!(
                            "<item><{id}>vpc-02222222222222222</{id}><ownerId>123456789012</ownerId></item>"
                        ),
                        "",
                    )
                } else {
                    (
                        format!(
                            "<item><{id}>vpc-01111111111111111</{id}><ownerId>123456789012</ownerId></item>"
                        ),
                        "<nextToken>opaque+/=&amp;token</nextToken>",
                    )
                }
            } else if *action == "DescribeNatGateways" {
                (
                    format!(
                        "<item><{id}>nat-01111111111111111</{id}><availabilityMode>regional</availabilityMode><routeTableId>rtb-regional-reference</routeTableId><natGatewayAddressSet><item><publicIp>203.0.113.10</publicIp><availabilityZoneId>euw1-az1</availabilityZoneId><status>succeeded</status><isPrimary>true</isPrimary></item><item><publicIp>203.0.113.20</publicIp><availabilityZone>eu-west-1b</availabilityZone><status>future-state</status></item></natGatewayAddressSet><tagSet><item><key>navarchnet:managed</key><value>true</value></item></tagSet></item>"
                    ),
                    "",
                )
            } else {
                (String::new(), "")
            };
            (
                StatusCode::OK,
                format!(
                    "<{action}Response><requestId>fixture-{}</requestId><{set}>{items}</{set}>{next}</{action}Response>",
                    requests.len()
                ),
            )
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/", post(handler))
            .with_state(requests.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let credentials = super::super::session::TemporaryCredentials::new(
            SharedCredentialsProvider::new(Credentials::new(
                "ASIAEXAMPLEONLY",
                "non-secret-fixture-key",
                Some("fixture-session".into()),
                Some(std::time::SystemTime::now() + std::time::Duration::from_secs(3600)),
                "test",
            )),
        );
        let adapter = Ec2ReadOnly {
            client: transport(false).unwrap(),
            endpoint: format!("http://{address}/"),
            region: "eu-west-1".into(),
            credentials,
        };
        let (resources, request_ids) = adapter.discover().await.unwrap();
        assert_eq!(request_ids.len(), QUERIES.len() + 1);
        assert_eq!(requests.lock().await.len(), QUERIES.len() + 2);
        assert_eq!(
            resources
                .iter()
                .filter(|r| r.kind == ResourceKind::Vpc)
                .count(),
            2
        );
        let nat = resources
            .iter()
            .find(|r| r.kind == ResourceKind::NatGateway)
            .unwrap();
        assert_eq!(nat.availability_mode.as_deref(), Some("regional"));
        assert!(nat.vpc_id.is_none());
        let metadata = nat.nat_gateway.as_ref().unwrap();
        assert_eq!(
            metadata.route_table_id.as_deref(),
            Some("rtb-regional-reference")
        );
        let addresses = metadata.addresses.as_ref().unwrap();
        assert_eq!(addresses.len(), 2);
        assert_eq!(addresses[0].az_id.as_deref(), Some("euw1-az1"));
        assert_eq!(addresses[0].is_primary, Some(true));
        assert_eq!(addresses[1].az_name.as_deref(), Some("eu-west-1b"));
        assert_eq!(addresses[1].status.as_deref(), Some("future-state"));
        assert!(addresses[1].az_id.is_none() && addresses[1].is_primary.is_none());
        assert!(resources.iter().all(|r| !r.managed));
        server.abort();
    }
    #[test]
    fn rejects_foreign_roots_dtd_duplicate_fields_and_reads_escaped_tags() {
        assert!(
            parse(
                "<OtherResponse><requestId>x</requestId></OtherResponse>",
                "DescribeVpcsResponse"
            )
            .is_err()
        );
        assert!(parse("<!DOCTYPE x [<!ENTITY secret SYSTEM 'file:///etc/passwd'>]><DescribeVpcsResponse/>","DescribeVpcsResponse").is_err());
        assert!(parse("<DescribeVpcsResponse><requestId>x</requestId><requestId>y</requestId></DescribeVpcsResponse>","DescribeVpcsResponse").is_err());
        let root=parse("<DescribeVpcsResponse><requestId>fixture</requestId><vpcSet><item><vpcId>vpc-0123456789abcdef0</vpcId><ownerId>123456789012</ownerId><cidrBlock>10.1.0.0/16</cidrBlock><tagSet><item><key>Name</key><value>A&amp;B</value></item></tagSet></item></vpcSet></DescribeVpcsResponse>","DescribeVpcsResponse").unwrap();
        let value = resource(root.items("vpcSet")[0], ResourceKind::Vpc, "vpcId").unwrap();
        assert_eq!(value.tags["Name"], "A&B");
        assert!(!value.managed);
        assert_eq!(value.owner_account_id.as_deref(), Some("123456789012"));
    }
    #[test]
    fn preserves_main_table_association_unknown_targets_blackholes_and_ipv6() {
        let root=parse("<DescribeRouteTablesResponse><requestId>fixture</requestId><routeTableSet><item><routeTableId>rtb-0123456789abcdef0</routeTableId><vpcId>vpc-0123456789abcdef0</vpcId><associationSet><item><routeTableAssociationId>rtbassoc-0123456789abcdef0</routeTableAssociationId><main>true</main></item></associationSet><routeSet><item><destinationIpv6CidrBlock>::/0</destinationIpv6CidrBlock><futureGatewayId>future-1</futureGatewayId><state>blackhole</state><origin>CreateRoute</origin></item></routeSet></item></routeTableSet></DescribeRouteTablesResponse>","DescribeRouteTablesResponse").unwrap();
        let value = resource(
            root.items("routeTableSet")[0],
            ResourceKind::RouteTable,
            "routeTableId",
        )
        .unwrap();
        assert!(value.associations[0].main);
        assert!(value.associations[0].subnet_id.is_none());
        assert_eq!(value.routes[0].ipv6_destination.as_deref(), Some("::/0"));
        assert_eq!(value.routes[0].targets["futureGatewayId"], "future-1");
        assert_eq!(value.routes[0].state.as_deref(), Some("blackhole"));
        assert!(!value.managed);
    }
}
