//! Saved TGW ingress association lookup, not a complete packet path or a connectivity test.
use super::{
    observation::{AwsTopology, ResourceKind},
    route_lookup::{self, TgwLookupResult},
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum TgwIngressReason {
    IncompleteObservation,
    MissingOrAmbiguousAttachment,
    AttachmentNotReady,
    MissingOrAmbiguousGateway,
    UnverifiedGateway,
    GatewayNotReady,
    AmbiguousTableScope,
    AssociationsNotQueried,
    MissingOrAmbiguousAssociation,
    AssociationNotReady,
    AssociationScopeMismatch,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TgwIngressResult {
    Reported {
        transit_gateway_id: String,
        route_table_id: String,
        lookup: TgwLookupResult,
    },
    Unresolved {
        reason: TgwIngressReason,
    },
}

pub fn lookup(topology: &AwsTopology, ingress: &str, destination: &str) -> TgwIngressResult {
    let evaluate = || -> Result<TgwIngressResult, TgwIngressReason> {
        use TgwIngressReason::*;
        if !topology.complete_for_supported_queries {
            return Err(IncompleteObservation);
        }
        let attachments: Vec<_> = topology
            .resources
            .iter()
            .filter(|r| r.kind == ResourceKind::VpcAttachment && r.id == ingress)
            .collect();
        let [attachment] = attachments.as_slice() else {
            return Err(MissingOrAmbiguousAttachment);
        };
        if attachment.state.as_deref() != Some("available")
            || attachment.vpc_id.as_deref().is_none_or(str::is_empty)
        {
            return Err(AttachmentNotReady);
        }
        let parents: Vec<_> = topology
            .resources
            .iter()
            .filter(|r| {
                r.kind == ResourceKind::TransitGateway && attachment.related_ids.contains(&r.id)
            })
            .collect();
        let [parent] = parents.as_slice() else {
            return Err(MissingOrAmbiguousGateway);
        };
        // VPC attachment related IDs also contain subnets, but never a second gateway.
        if attachment
            .related_ids
            .iter()
            .filter(|id| id.starts_with("tgw-"))
            .count()
            != 1
        {
            return Err(MissingOrAmbiguousGateway);
        }
        if parent.owner_account_id.as_deref() != Some(topology.aws_account_id.as_str()) {
            return Err(UnverifiedGateway);
        }
        if parent.state.as_deref() != Some("available") {
            return Err(GatewayNotReady);
        }
        // Propagation does not select the ingress table. Only an actual association does.
        let tables: Vec<_> = topology
            .resources
            .iter()
            .filter(|r| r.kind == ResourceKind::TransitGatewayRouteTable)
            .collect();
        let mut counts = std::collections::BTreeMap::new();
        for table in &tables {
            *counts.entry(table.id.as_str()).or_insert(0usize) += 1;
        }
        let mut candidates = Vec::new();
        for table in tables {
            if table.related_ids.is_empty() {
                return Err(AmbiguousTableScope);
            }
            if !table.related_ids.contains(&parent.id) {
                if table
                    .tgw_associations
                    .iter()
                    .flatten()
                    .any(|link| link.attachment_id.as_deref() == Some(ingress))
                {
                    return Err(AssociationScopeMismatch);
                }
                continue;
            }
            if table.related_ids.len() != 1 || counts.get(table.id.as_str()) != Some(&1) {
                return Err(AmbiguousTableScope);
            }
            let links = table
                .tgw_associations
                .as_ref()
                .ok_or(AssociationsNotQueried)?;
            // A missing attachment ID cannot establish that this table excludes the ingress.
            if links
                .iter()
                .any(|link| link.attachment_id.as_deref().is_none_or(str::is_empty))
            {
                return Err(AssociationScopeMismatch);
            }
            for link in links
                .iter()
                .filter(|link| link.attachment_id.as_deref() == Some(ingress))
            {
                candidates.push((table, link));
            }
        }
        let [(table, link)] = candidates.as_slice() else {
            return Err(MissingOrAmbiguousAssociation);
        };
        if table.state.as_deref() != Some("available")
            || link.state.as_deref() != Some("associated")
        {
            return Err(AssociationNotReady);
        }
        if link.resource_type.as_deref() != Some("vpc")
            || link.resource_id != attachment.vpc_id
            || link.route_table_announcement_id.is_some()
            || table
                .owner_account_id
                .as_deref()
                .is_some_and(|id| id != topology.aws_account_id)
        {
            return Err(AssociationScopeMismatch);
        }
        Ok(TgwIngressResult::Reported {
            transit_gateway_id: parent.id.clone(),
            route_table_id: table.id.clone(),
            lookup: route_lookup::lookup(topology, &table.id, destination),
        })
    };
    evaluate().unwrap_or_else(|reason| TgwIngressResult::Unresolved { reason })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aws::observation::*;

    fn fixture() -> AwsTopology {
        let mut parent = AwsResource::new(ResourceKind::TransitGateway, "tgw-parent".into());
        parent.owner_account_id = Some("123456789012".into());
        parent.state = Some("available".into());
        let mut attachment = AwsResource::new(ResourceKind::VpcAttachment, "ingress".into());
        // A shared VPC can belong to another account; TGW table authority is the gateway owner's.
        attachment.owner_account_id = Some("999999999999".into());
        attachment.state = Some("available".into());
        attachment.vpc_id = Some("vpc-spoke".into());
        attachment.related_ids.push(parent.id.clone());
        let mut table = AwsResource::new(ResourceKind::TransitGatewayRouteTable, "table".into());
        table.related_ids.push(parent.id.clone());
        table.state = Some("available".into());
        table.tgw_associations = Some(vec![TransitGatewayTableLink {
            attachment_id: Some(attachment.id.clone()),
            resource_id: attachment.vpc_id.clone(),
            resource_type: Some("vpc".into()),
            state: Some("associated".into()),
            route_table_announcement_id: None,
        }]);
        table.tgw_routes = Some(vec![TransitGatewayRoute {
            destination_cidr: Some("0.0.0.0/0".into()),
            prefix_list_id: None,
            state: Some("active".into()),
            route_type: Some("static".into()),
            route_table_announcement_id: None,
            attachments: vec![TransitGatewayRouteAttachment {
                attachment_id: Some("egress".into()),
                resource_id: None,
                resource_type: Some("vpc".into()),
            }],
        }]);
        AwsTopology {
            id: "snapshot".into(),
            account_id: "account".into(),
            aws_account_id: "123456789012".into(),
            region: "eu-west-1".into(),
            started_at: "1".into(),
            completed_at: "2".into(),
            session_name: "fixture".into(),
            resources: vec![parent, attachment, table],
            request_ids: vec![],
            complete_for_supported_queries: true,
            limitations: vec![],
            execution_enabled: false,
            connectivity_tested: false,
        }
    }

    #[test]
    fn selection_uses_association_not_propagation_and_does_not_mutate_observations() {
        let mut topology = fixture();
        let mut other = topology.resources[2].clone();
        other.id = "propagation-only".into();
        other.tgw_propagations = other.tgw_associations.take();
        other.tgw_associations = Some(vec![]);
        other.tgw_routes.as_mut().unwrap()[0].state = Some("blackhole".into());
        topology.resources.push(other);
        let before = serde_json::to_value(&topology).unwrap();
        let result = lookup(&topology, "ingress", "203.0.113.1");
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["route_table_id"], "table");
        assert_eq!(value["lookup"]["status"], "reported_forward");
        assert_eq!(before, serde_json::to_value(&topology).unwrap());
        topology.resources.reverse();
        assert_eq!(result, lookup(&topology, "ingress", "203.0.113.1"));
    }

    #[test]
    fn refuses_hidden_or_contradictory_association_scope_instead_of_skipping_it() {
        let mut failures = vec![];
        for mode in 0..5 {
            let mut t = fixture();
            let expected = match mode {
                0 => {
                    let mut other = t.resources[2].clone();
                    other.id = "foreign-table".into();
                    other.related_ids = vec!["tgw-other".into()];
                    t.resources.push(other);
                    "association_scope_mismatch"
                }
                1 => {
                    let mut other = t.resources[2].clone();
                    other.id = "unknown-parent".into();
                    other.related_ids.clear();
                    other.tgw_associations = Some(vec![]);
                    t.resources.push(other);
                    "ambiguous_table_scope"
                }
                2 => {
                    let mut other = t.resources[2].clone();
                    other.id = "unknown-attachment".into();
                    other.tgw_associations.as_mut().unwrap()[0].attachment_id = None;
                    t.resources.push(other);
                    "association_scope_mismatch"
                }
                3 => {
                    t.resources[1].related_ids.push("tgw-unobserved".into());
                    "missing_or_ambiguous_gateway"
                }
                _ => {
                    t.resources[2].owner_account_id = Some("999999999999".into());
                    "association_scope_mismatch"
                }
            };
            let result = serde_json::to_value(lookup(&t, "ingress", "203.0.113.1")).unwrap();
            if result["status"] != "unresolved" || result["reason"] != expected {
                failures.push(format!("mode {mode}: expected {expected}, got {result}"));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn refuses_uncertain_ingress_scope_readiness_and_association_completeness() {
        let reasons = [
            "incomplete_observation",
            "attachment_not_ready",
            "unverified_gateway",
            "gateway_not_ready",
            "associations_not_queried",
            "association_not_ready",
            "association_scope_mismatch",
            "association_scope_mismatch",
            "association_scope_mismatch",
            "ambiguous_table_scope",
            "missing_or_ambiguous_attachment",
            "missing_or_ambiguous_gateway",
            "missing_or_ambiguous_association",
            "missing_or_ambiguous_association",
            "associations_not_queried",
            "ambiguous_table_scope",
            "attachment_not_ready",
            "association_not_ready",
        ];
        let mut failures = vec![];
        for (mode, expected) in reasons.into_iter().enumerate() {
            let mut t = fixture();
            match mode {
                0 => t.complete_for_supported_queries = false,
                1 => t.resources[1].state = Some("pendingAcceptance".into()),
                2 => t.resources[0].owner_account_id = Some("999999999999".into()),
                3 => t.resources[0].state = None,
                4 => t.resources[2].tgw_associations = None,
                5 => {
                    t.resources[2].tgw_associations.as_mut().unwrap()[0].state =
                        Some("associating".into())
                }
                6 => {
                    t.resources[2].tgw_associations.as_mut().unwrap()[0].resource_id =
                        Some("vpc-other".into())
                }
                7 => t.resources[2].tgw_associations.as_mut().unwrap()[0].resource_type = None,
                8 => {
                    t.resources[2].tgw_associations.as_mut().unwrap()[0]
                        .route_table_announcement_id = Some("announcement".into())
                }
                9 => {
                    let mut other = t.resources[2].clone();
                    other.tgw_associations = Some(vec![]);
                    t.resources.push(other);
                }
                10 => t.resources.push(t.resources[1].clone()),
                11 => t.resources.push(t.resources[0].clone()),
                12 => {
                    let link = t.resources[2].tgw_associations.as_ref().unwrap()[0].clone();
                    t.resources[2].tgw_associations.as_mut().unwrap().push(link);
                }
                13 => {
                    t.resources[2].tgw_propagations = t.resources[2].tgw_associations.take();
                    t.resources[2].tgw_associations = Some(vec![]);
                }
                14 => {
                    let mut other = t.resources[2].clone();
                    other.id = "unqueried".into();
                    other.tgw_associations = None;
                    t.resources.push(other);
                }
                15 => t.resources[2].related_ids.push("tgw-unobserved".into()),
                16 => t.resources[1].vpc_id = None,
                17 => t.resources[2].state = Some("deleting".into()),
                _ => unreachable!(),
            }
            let result = serde_json::to_value(lookup(&t, "ingress", "203.0.113.1")).unwrap();
            if result["status"] != "unresolved" || result["reason"] != expected {
                failures.push(format!("mode {mode}: expected {expected}, got {result}"));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
