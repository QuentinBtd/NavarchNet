//! Typed, unmanaged AWS observations. They are deliberately separate from fake executable inventory.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Vpc,
    Subnet,
    RouteTable,
    TransitGateway,
    VpcAttachment,
    NatGateway,
    InternetGateway,
    ElasticIp,
    TransitGatewayRouteTable,
    RamShare,
    RamResource,
    RamPrincipal,
    RamInvitation,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ObservedRoute {
    pub ipv4_destination: Option<String>,
    pub ipv6_destination: Option<String>,
    pub prefix_list_destination: Option<String>,
    pub state: Option<String>,
    pub origin: Option<String>,
    pub targets: BTreeMap<String, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RouteAssociation {
    #[serde(default)]
    pub state: Option<String>,
    pub id: Option<String>,
    pub subnet_id: Option<String>,
    pub gateway_id: Option<String>,
    pub main: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TransitGatewayTableLink {
    pub attachment_id: Option<String>,
    pub resource_id: Option<String>,
    pub resource_type: Option<String>,
    pub state: Option<String>,
    pub route_table_announcement_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AwsResource {
    pub kind: ResourceKind,
    pub id: String,
    pub owner_account_id: Option<String>,
    pub vpc_id: Option<String>,
    pub subnet_id: Option<String>,
    pub az_id: Option<String>,
    pub state: Option<String>,
    pub cidrs: Vec<String>,
    pub public_ips: Vec<String>,
    pub private_ips: Vec<String>,
    pub tags: BTreeMap<String, String>,
    pub routes: Vec<ObservedRoute>,
    pub associations: Vec<RouteAssociation>,
    // None means not queried (including legacy snapshots); Some([]) means a completed empty read.
    #[serde(default)]
    pub tgw_associations: Option<Vec<TransitGatewayTableLink>>,
    #[serde(default)]
    pub tgw_propagations: Option<Vec<TransitGatewayTableLink>>,
    pub related_ids: Vec<String>,
    pub connectivity_type: Option<String>,
    pub availability_mode: Option<String>,
    // Discovery grants no management rights, including to tagged or RAM-shared resources.
    pub managed: bool,
}
impl AwsResource {
    pub fn new(kind: ResourceKind, id: String) -> Self {
        Self {
            kind,
            id,
            owner_account_id: None,
            vpc_id: None,
            subnet_id: None,
            az_id: None,
            state: None,
            cidrs: vec![],
            public_ips: vec![],
            private_ips: vec![],
            tags: BTreeMap::new(),
            routes: vec![],
            associations: vec![],
            tgw_associations: None,
            tgw_propagations: None,
            related_ids: vec![],
            connectivity_type: None,
            availability_mode: None,
            managed: false,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AwsTopology {
    pub id: String,
    pub account_id: String,
    pub aws_account_id: String,
    pub region: String,
    pub started_at: String,
    pub completed_at: String,
    pub session_name: String,
    pub resources: Vec<AwsResource>,
    pub request_ids: Vec<String>,
    pub complete_for_supported_queries: bool,
    pub limitations: Vec<String>,
    pub execution_enabled: bool,
    pub connectivity_tested: bool,
}
