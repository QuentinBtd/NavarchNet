//! Bounded TGW route-search observations. Completion is explicit, not inferred from an empty page.
use super::*;
#[derive(Default)]
pub(super) struct RouteBudget {
    routes: usize,
    attachments: usize,
}
fn bounded(value: Option<String>) -> anyhow::Result<Option<String>> {
    if let Some(text) = &value {
        ensure!(
            text.len() <= 2048 && !text.chars().any(char::is_control),
            "Invalid TGW route field"
        );
    }
    Ok(value)
}
fn route(node: &Node, budget: &mut RouteBudget) -> anyhow::Result<TransitGatewayRoute> {
    let destination_cidr = bounded(node.field("destinationCidrBlock"))?;
    let prefix_list_id = bounded(node.field("prefixListId"))?;
    ensure!(
        destination_cidr.is_some() || prefix_list_id.is_some(),
        "TGW route omitted its destination"
    );
    if let Some(cidr) = &destination_cidr {
        let _ = cidr
            .parse::<ipnet::IpNet>()
            .context("Malformed TGW route CIDR")?;
    }
    budget.routes = budget
        .routes
        .checked_add(1)
        .context("TGW route counter overflow")?;
    ensure!(budget.routes <= 10_000, "TGW route budget exceeded");
    let mut attachments = Vec::new();
    let mut seen = BTreeSet::new();
    for item in node.items("transitGatewayAttachments") {
        let attachment = TransitGatewayRouteAttachment {
            attachment_id: bounded(item.field("transitGatewayAttachmentId"))?,
            resource_id: bounded(item.field("resourceId"))?,
            resource_type: bounded(item.field("resourceType"))?,
        };
        ensure!(
            attachment.attachment_id.is_some() || attachment.resource_id.is_some(),
            "TGW route attachment omitted its identity"
        );
        ensure!(
            seen.insert((
                attachment.attachment_id.clone(),
                attachment.resource_id.clone()
            )),
            "Duplicate TGW route attachment"
        );
        budget.attachments = budget
            .attachments
            .checked_add(1)
            .context("TGW route attachment counter overflow")?;
        ensure!(
            budget.attachments <= 10_000,
            "TGW route attachment budget exceeded"
        );
        attachments.push(attachment);
    }
    Ok(TransitGatewayRoute {
        destination_cidr,
        prefix_list_id,
        state: bounded(node.field("state"))?,
        route_type: bounded(node.field("type"))?,
        route_table_announcement_id: bounded(node.field("transitGatewayRouteTableAnnouncementId"))?,
        attachments,
    })
}
impl Ec2ReadOnly {
    pub(super) async fn table_routes(
        &self,
        id: &str,
        bytes: &mut BodyBudget,
        budget: &mut RouteBudget,
        requests: &mut Vec<String>,
    ) -> anyhow::Result<Vec<TransitGatewayRoute>> {
        let mut result = Vec::new();
        let mut pages = Pagination::new();
        let mut token = None;
        let mut seen = BTreeSet::new();
        loop {
            let root = self
                .query_scoped(
                    "SearchTransitGatewayRoutes",
                    true,
                    token.as_deref(),
                    Some(id),
                    bytes,
                )
                .await?;
            requests.push(
                root.field("requestId")
                    .context("Missing TGW route request ID")?,
            );
            ensure!(
                root.children.iter().any(|n| n.name == "routeSet"),
                "TGW route response omitted its collection"
            );
            let additional = match root.field("additionalRoutesAvailable").as_deref() {
                Some("true") => true,
                Some("false") => false,
                _ => anyhow::bail!("TGW route response omitted a valid completion marker"),
            };
            let next = root.field("nextToken");
            ensure!(
                additional == next.is_some(),
                "TGW route search is truncated or has contradictory continuation metadata"
            );
            ensure!(
                root.items("routeSet").len() <= 1000,
                "TGW route page exceeds the requested bound"
            );
            for item in root.items("routeSet") {
                let value = route(item, budget)?;
                let destination = value.destination_cidr.as_ref().map(|cidr| {
                    cidr.parse::<ipnet::IpNet>()
                        .expect("validated CIDR")
                        .trunc()
                        .to_string()
                });
                ensure!(
                    seen.insert((
                        destination,
                        value.prefix_list_id.clone(),
                        value.route_type.clone()
                    )),
                    "Duplicate TGW route across search pages; repeat against a stable table"
                );
                result.push(value);
            }
            token = pages.next(next)?;
            if token.is_none() {
                break;
            }
        }
        Ok(result)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_route_and_nested_attachment_budget_exhaustion_and_missing_destinations() {
        let root = parse("<Response><requestId>fixture</requestId><routeSet><item><destinationCidrBlock>0.0.0.0/0</destinationCidrBlock><transitGatewayAttachments><item><transitGatewayAttachmentId>tgw-attach-a</transitGatewayAttachmentId></item></transitGatewayAttachments></item></routeSet></Response>", "Response").unwrap();
        let node = root.items("routeSet")[0];
        assert!(
            route(
                node,
                &mut RouteBudget {
                    routes: 10_000,
                    attachments: 0
                }
            )
            .is_err()
        );
        assert!(
            route(
                node,
                &mut RouteBudget {
                    routes: 0,
                    attachments: 10_000
                }
            )
            .is_err()
        );
        assert!(route(&Node::default(), &mut RouteBudget::default()).is_err());
    }
}
