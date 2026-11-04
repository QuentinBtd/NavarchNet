//! Conservative selection from reported associations, not packet-path or connectivity validation.
use super::observation::{AwsResource, AwsTopology, ResourceKind};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AssociationSource {
    ExplicitSubnet,
    ImplicitMain,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum RouteSelectionReason {
    IncompleteObservation,
    DuplicateSubnet,
    MissingVpc,
    UnverifiedOwner,
    MissingRouteTable,
    AmbiguousAssociation,
    AssociationNotReady,
    WrongVpc,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RouteTableSelection {
    Selected {
        route_table_id: String,
        source: AssociationSource,
    },
    Unresolved {
        reason: RouteSelectionReason,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SubnetRouteTable {
    pub subnet_id: String,
    pub vpc_id: Option<String>,
    pub selection: RouteTableSelection,
}
pub fn subnet_route_tables(topology: &AwsTopology) -> Vec<SubnetRouteTable> {
    use super::observation::RouteAssociation;
    type Associations<'a> = BTreeMap<&'a str, Vec<(&'a AwsResource, &'a RouteAssociation)>>;
    let mut subnets: BTreeMap<&str, Vec<&AwsResource>> = BTreeMap::new();
    let mut vpcs: BTreeMap<&str, Vec<&AwsResource>> = BTreeMap::new();
    let mut table_counts: BTreeMap<&str, usize> = BTreeMap::new();
    let mut explicit = Associations::new();
    let mut mains = Associations::new();
    // Index once: avoid scanning every table for every subnet on each authenticated read.
    for row in &topology.resources {
        match row.kind {
            ResourceKind::Vpc => vpcs.entry(&row.id).or_default().push(row),
            ResourceKind::Subnet => subnets.entry(&row.id).or_default().push(row),
            ResourceKind::RouteTable => {
                *table_counts.entry(&row.id).or_default() += 1;
                for association in &row.associations {
                    if let Some(subnet) = association.subnet_id.as_deref() {
                        explicit.entry(subnet).or_default().push((row, association));
                    }
                    if association.main
                        && let Some(vpc) = row.vpc_id.as_deref()
                    {
                        mains.entry(vpc).or_default().push((row, association));
                    }
                }
            }
            _ => {}
        }
    }
    subnets
        .into_values()
        .map(|rows| {
            let subnet = rows[0];
            let result = (|| -> Result<RouteTableSelection, RouteSelectionReason> {
                use RouteSelectionReason::*;
                if !topology.complete_for_supported_queries {
                    return Err(IncompleteObservation);
                }
                if rows.len() != 1 {
                    return Err(DuplicateSubnet);
                }
                let vpc = subnet.vpc_id.as_deref().ok_or(MissingVpc)?;
                let vpc_rows = vpcs.get(vpc).filter(|v| v.len() == 1).ok_or(MissingVpc)?;
                if [subnet, vpc_rows[0]].iter().any(|r| {
                    r.owner_account_id.as_deref() != Some(topology.aws_account_id.as_str())
                }) {
                    return Err(UnverifiedOwner);
                }
                let (candidates, source) = match explicit.get(subnet.id.as_str()) {
                    Some(rows) => (rows, AssociationSource::ExplicitSubnet),
                    None => (
                        mains.get(vpc).ok_or(MissingRouteTable)?,
                        AssociationSource::ImplicitMain,
                    ),
                };
                if candidates.len() != 1 {
                    return Err(AmbiguousAssociation);
                }
                let (table, association) = candidates[0];
                if table_counts.get(table.id.as_str()) != Some(&1) {
                    return Err(AmbiguousAssociation);
                }
                if table.vpc_id.as_deref() != Some(vpc) {
                    return Err(WrongVpc);
                }
                if table.owner_account_id.as_deref() != Some(topology.aws_account_id.as_str()) {
                    return Err(UnverifiedOwner);
                }
                if association.state.as_deref() != Some("associated")
                    || association.id.as_deref().is_none_or(str::is_empty)
                    || association.gateway_id.is_some()
                    || (association.main && association.subnet_id.is_some())
                {
                    return Err(AssociationNotReady);
                }
                Ok(RouteTableSelection::Selected {
                    route_table_id: table.id.clone(),
                    source,
                })
            })();
            SubnetRouteTable {
                subnet_id: subnet.id.clone(),
                vpc_id: subnet.vpc_id.clone(),
                selection: result
                    .unwrap_or_else(|reason| RouteTableSelection::Unresolved { reason }),
            }
        })
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::aws::observation::RouteAssociation;
    fn row(kind: ResourceKind, id: &str) -> AwsResource {
        let mut r = AwsResource::new(kind, id.into());
        r.owner_account_id = Some("123456789012".into());
        r.vpc_id = Some("vpc-a".into());
        r
    }
    fn assoc(main: bool, subnet: Option<&str>) -> RouteAssociation {
        RouteAssociation {
            id: Some("rtbassoc-fixture".into()),
            main,
            subnet_id: subnet.map(str::to_owned),
            gateway_id: None,
            state: Some("associated".into()),
        }
    }
    fn fixture() -> AwsTopology {
        let mut main = row(ResourceKind::RouteTable, "rtb-main");
        main.associations.push(assoc(true, None));
        AwsTopology {
            id: "snapshot".into(),
            account_id: "account".into(),
            aws_account_id: "123456789012".into(),
            region: "eu-west-1".into(),
            started_at: "1".into(),
            completed_at: "2".into(),
            session_name: "fixture".into(),
            resources: vec![
                row(ResourceKind::Vpc, "vpc-a"),
                row(ResourceKind::Subnet, "subnet-a"),
                main,
            ],
            request_ids: vec![],
            complete_for_supported_queries: true,
            limitations: vec![],
            execution_enabled: false,
            connectivity_tested: false,
        }
    }
    fn selected(id: &str, source: AssociationSource) -> RouteTableSelection {
        RouteTableSelection::Selected {
            route_table_id: id.into(),
            source,
        }
    }
    fn unresolved(reason: RouteSelectionReason) -> RouteTableSelection {
        RouteTableSelection::Unresolved { reason }
    }
    #[test]
    fn resolves_main_and_explicit_associations_without_mutation_or_connectivity_claims() {
        let mut topology = fixture();
        let before = serde_json::to_value(&topology).unwrap();
        assert_eq!(
            subnet_route_tables(&topology)[0].selection,
            selected("rtb-main", AssociationSource::ImplicitMain)
        );
        assert_eq!(before, serde_json::to_value(&topology).unwrap());
        let mut explicit = row(ResourceKind::RouteTable, "rtb-explicit");
        explicit.associations.push(assoc(false, Some("subnet-a")));
        topology.resources.push(explicit);
        assert_eq!(
            subnet_route_tables(&topology)[0].selection,
            selected("rtb-explicit", AssociationSource::ExplicitSubnet)
        );
        topology.resources.retain(|r| r.id != "rtb-main");
        assert_eq!(
            subnet_route_tables(&topology)[0].selection,
            selected("rtb-explicit", AssociationSource::ExplicitSubnet)
        );
        assert!(!topology.connectivity_tested && !topology.execution_enabled);
    }
    #[test]
    fn rejects_incomplete_ambiguous_transitioning_foreign_and_cross_vpc_observations() {
        let mut topology = fixture();
        topology.complete_for_supported_queries = false;
        assert_eq!(
            subnet_route_tables(&topology)[0].selection,
            unresolved(RouteSelectionReason::IncompleteObservation)
        );
        let mut topology = fixture();
        topology.resources[2].associations[0].state = None;
        assert_eq!(
            subnet_route_tables(&topology)[0].selection,
            unresolved(RouteSelectionReason::AssociationNotReady)
        );
        let mut topology = fixture();
        let mut explicit = row(ResourceKind::RouteTable, "rtb-explicit");
        explicit.associations.push(assoc(false, Some("subnet-a")));
        explicit.associations[0].state = Some("associating".into());
        topology.resources.push(explicit.clone());
        assert_eq!(
            subnet_route_tables(&topology)[0].selection,
            unresolved(RouteSelectionReason::AssociationNotReady)
        );
        topology.resources.last_mut().unwrap().associations[0].state = Some("associated".into());
        explicit.id = "rtb-other".into();
        topology.resources.push(explicit);
        assert_eq!(
            subnet_route_tables(&topology)[0].selection,
            unresolved(RouteSelectionReason::AmbiguousAssociation)
        );
        let mut topology = fixture();
        topology.resources[1].owner_account_id = Some("999999999999".into());
        assert_eq!(
            subnet_route_tables(&topology)[0].selection,
            unresolved(RouteSelectionReason::UnverifiedOwner)
        );
        let mut topology = fixture();
        let mut table = row(ResourceKind::RouteTable, "rtb-wrong");
        table.vpc_id = Some("vpc-other".into());
        table.associations.push(assoc(false, Some("subnet-a")));
        topology.resources.push(table);
        assert_eq!(
            subnet_route_tables(&topology)[0].selection,
            unresolved(RouteSelectionReason::WrongVpc)
        );
        let mut topology = fixture();
        topology.resources.push(topology.resources[1].clone());
        assert_eq!(subnet_route_tables(&topology).len(), 1);
        assert_eq!(
            subnet_route_tables(&topology)[0].selection,
            unresolved(RouteSelectionReason::DuplicateSubnet)
        );
    }
    #[test]
    fn legacy_snapshots_remain_readable_but_unknown_association_state_is_not_assumed_ready() {
        let old: RouteAssociation = serde_json::from_str(
            r#"{"id":"legacy","main":true,"subnet_id":null,"gateway_id":null}"#,
        )
        .unwrap();
        assert!(old.state.is_none());
        let mut topology = fixture();
        topology.resources[2].associations = vec![old];
        assert_eq!(
            subnet_route_tables(&topology)[0].selection,
            unresolved(RouteSelectionReason::AssociationNotReady)
        );
    }

    #[test]
    fn selection_is_order_independent_and_rejects_missing_or_duplicate_scope_records() {
        let original = fixture();
        let mut reordered = original.clone();
        reordered.resources.reverse();
        assert_eq!(
            subnet_route_tables(&original),
            subnet_route_tables(&reordered)
        );
        let mut explicit_main = fixture();
        explicit_main.resources[2]
            .associations
            .push(assoc(false, Some("subnet-a")));
        assert_eq!(
            subnet_route_tables(&explicit_main)[0].selection,
            selected("rtb-main", AssociationSource::ExplicitSubnet)
        );
        let mut missing = fixture();
        missing.resources.retain(|r| r.kind != ResourceKind::Vpc);
        assert_eq!(
            subnet_route_tables(&missing)[0].selection,
            unresolved(RouteSelectionReason::MissingVpc)
        );
        let mut missing = fixture();
        missing.resources[2].associations.clear();
        assert_eq!(
            subnet_route_tables(&missing)[0].selection,
            unresolved(RouteSelectionReason::MissingRouteTable)
        );
        let mut duplicate = fixture();
        let mut other = duplicate.resources[2].clone();
        other.id = "rtb-other-main".into();
        duplicate.resources.push(other);
        assert_eq!(
            subnet_route_tables(&duplicate)[0].selection,
            unresolved(RouteSelectionReason::AmbiguousAssociation)
        );
        let mut duplicate = fixture();
        let mut other = duplicate.resources[2].clone();
        other.associations.clear();
        duplicate.resources.push(other);
        assert_eq!(
            subnet_route_tables(&duplicate)[0].selection,
            unresolved(RouteSelectionReason::AmbiguousAssociation)
        );
    }
}
