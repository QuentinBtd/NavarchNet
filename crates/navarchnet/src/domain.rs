use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Fake,
    Aws,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Account {
    pub id: String,
    pub name: String,
    pub provider: ProviderKind,
    pub role_arn: String,
    pub revision: i32,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Subnet {
    pub id: String,
    pub az_id: String,
    pub route_table: String,
    pub default_route_managed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Inventory {
    pub account_id: String,
    pub vpc_id: String,
    pub region: String,
    pub cidr: String,
    pub revision: i32,
    pub subnets: Vec<Subnet>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RegionalNetwork {
    pub id: String,
    pub name: String,
    pub region: String,
    pub revision: i32,
    pub egress_cidr: String,
    pub az_ids: Vec<String>,
    pub public_ips: Vec<String>,
    pub application_cidrs: Vec<String>,
    pub managed_nat: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ConnectionRequest {
    pub account_id: String,
    pub vpc_id: String,
    pub subnet_ids: Vec<String>,
    pub network_id: String,
    pub allow_application_traffic: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    Attachment,
    Isolation,
    ReturnRoute,
    NatRoute,
    SpokeDefaultRoute,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Action {
    pub kind: ActionKind,
    pub target: String,
    pub requires: Vec<u32>,
    pub postcondition: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceEffect {
    pub kind: ActionKind,
    pub target: String,
    pub postcondition: String,
}
impl Action {
    pub fn effect(&self) -> ResourceEffect {
        ResourceEffect {
            kind: self.kind.clone(),
            target: self.target.clone(),
            postcondition: self.postcondition.clone(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Plan {
    pub id: String,
    pub scope: String,
    pub scope_version: i32,
    pub inventory_revision: i32,
    pub network_revision: i32,
    pub request: ConnectionRequest,
    pub actions: Vec<Action>,
    pub digest: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Fault {
    None,
    Throttle,
    PersistentThrottle,
    EventualConsistency,
    CredentialExpiry,
    Permission,
    PartialFailure,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Operation {
    pub id: String,
    pub plan_id: String,
    pub scope: String,
    pub status: String,
    pub step: i32,
    pub attempts: i32,
    pub error: Option<String>,
    pub fault: Fault,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Observation {
    pub operation_id: String,
    pub configuration: String,
    pub calculated_path: String,
    pub public_ips: Vec<String>,
    pub connectivity: String,
    pub active_probe: String,
    pub drift: bool,
    pub recovery: String,
}

pub fn fixture() -> (Inventory, RegionalNetwork, ConnectionRequest) {
    let inventory = Inventory {
        account_id: "demo-app".into(),
        vpc_id: "vpc-demo".into(),
        region: "eu-west-1".into(),
        cidr: "10.10.0.0/16".into(),
        revision: 1,
        subnets: vec![
            Subnet {
                id: "subnet-a".into(),
                az_id: "euw1-az1".into(),
                route_table: "rtb-a".into(),
                default_route_managed: true,
            },
            Subnet {
                id: "subnet-b".into(),
                az_id: "euw1-az2".into(),
                route_table: "rtb-b".into(),
                default_route_managed: true,
            },
        ],
    };
    let network = RegionalNetwork {
        id: "demo-network".into(),
        name: "Regional demo egress".into(),
        region: "eu-west-1".into(),
        revision: 1,
        egress_cidr: "10.254.0.0/16".into(),
        az_ids: vec!["euw1-az1".into(), "euw1-az2".into()],
        public_ips: vec!["192.0.2.10".into(), "192.0.2.11".into()],
        application_cidrs: vec![],
        managed_nat: true,
    };
    let request = ConnectionRequest {
        account_id: inventory.account_id.clone(),
        vpc_id: inventory.vpc_id.clone(),
        subnet_ids: inventory.subnets.iter().map(|s| s.id.clone()).collect(),
        network_id: network.id.clone(),
        allow_application_traffic: false,
    };
    (inventory, network, request)
}

pub fn plan(
    inventory: &Inventory,
    network: &RegionalNetwork,
    request: &ConnectionRequest,
) -> anyhow::Result<Vec<Action>> {
    use anyhow::{Context, ensure};
    use ipnet::Ipv4Net;
    use std::collections::HashSet;
    ensure!(
        request.account_id == inventory.account_id
            && request.vpc_id == inventory.vpc_id
            && request.network_id == network.id,
        "Resource identity mismatch"
    );
    ensure!(
        inventory.region == network.region,
        "Cross-region egress is unsupported"
    );
    ensure!(network.managed_nat, "Only managed NAT is supported");
    ensure!(
        !request.allow_application_traffic,
        "Application connectivity requires a separately reviewed policy; unsupported in this version"
    );
    let cidr: Ipv4Net = inventory
        .cidr
        .parse()
        .context("Only IPv4 VPCs are supported")?;
    for other in std::iter::once(&network.egress_cidr).chain(network.application_cidrs.iter()) {
        let other: Ipv4Net = other.parse().context("Invalid IPv4 network")?;
        ensure!(
            !other.contains(&cidr.network()) && !cidr.contains(&other.network()),
            "Overlapping CIDRs prevent safe routing"
        );
    }
    ensure!(!request.subnet_ids.is_empty(), "Select at least one subnet");
    let mut ids = HashSet::new();
    let mut zones = HashSet::new();
    let mut selected = Vec::new();
    for id in &request.subnet_ids {
        ensure!(ids.insert(id), "Duplicate subnet");
        let mut candidates = inventory.subnets.iter().filter(|s| &s.id == id);
        let subnet = candidates
            .next()
            .context("Subnet was not discovered in the selected VPC")?;
        ensure!(
            candidates.next().is_none(),
            "Selected subnet identity is ambiguous in discovered VPC inventory"
        );
        ensure!(
            zones.insert(&subnet.az_id),
            "Only one attachment subnet per AZ is allowed"
        );
        ensure!(
            network.az_ids.contains(&subnet.az_id),
            "No same-AZ egress capacity"
        );
        ensure!(
            subnet.default_route_managed,
            "Default route is not explicitly managed; adoption required"
        );
        selected.push(subnet);
    }
    selected.sort_by(|a, b| a.id.cmp(&b.id));
    let mut actions = vec![
        Action { kind: ActionKind::Attachment, target: inventory.vpc_id.clone(), requires: vec![], postcondition: "Attachment available in selected AZ IDs".into() },
        Action { kind: ActionKind::Isolation, target: network.id.clone(), requires: vec![0], postcondition: "Spoke association excludes spoke propagation; private destination blackholes installed".into() },
        Action { kind: ActionKind::ReturnRoute, target: inventory.cidr.clone(), requires: vec![0,1], postcondition: "Egress TGW table and NAT subnet return routes point to spoke attachment".into() }
    ];
    for subnet in &selected {
        actions.push(Action {
            kind: ActionKind::NatRoute,
            target: subnet.az_id.clone(),
            requires: vec![0, 1, 2],
            postcondition:
                "Same-AZ managed NAT ready; public subnet Internet gateway route verified".into(),
        });
    }
    let prerequisites = (0..actions.len() as u32).collect::<Vec<_>>();
    for subnet in selected {
        actions.push(Action {
            kind: ActionKind::SpokeDefaultRoute,
            target: subnet.route_table.clone(),
            requires: prerequisites.clone(),
            postcondition: "Explicitly owned IPv4 default route points to regional TGW".into(),
        });
    }
    Ok(actions)
}
