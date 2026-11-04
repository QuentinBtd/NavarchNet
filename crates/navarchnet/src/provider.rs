//! Provider capabilities are explicit. Fake observations are never AWS health.
use crate::domain::*;

#[derive(Debug, Clone, serde::Serialize)]
pub struct Capabilities {
    pub discovery: bool,
    pub execution: bool,
    pub ipv4: bool,
    pub ipv6: bool,
    pub live: bool,
}

pub fn capabilities(provider: &ProviderKind) -> Capabilities {
    match provider {
        ProviderKind::Fake => Capabilities {
            discovery: true,
            execution: true,
            ipv4: true,
            ipv6: false,
            live: false,
        },
        ProviderKind::Aws => Capabilities {
            discovery: false,
            execution: false,
            ipv4: true,
            ipv6: false,
            live: true,
        },
    }
}

pub fn discover(account: &Account) -> anyhow::Result<Inventory> {
    anyhow::ensure!(
        account.provider == ProviderKind::Fake,
        "AWS discovery is not implemented; no live credentials will be accessed"
    );
    let (mut inventory, _, _) = fixture();
    inventory.account_id.clone_from(&account.id);
    inventory.vpc_id = format!("vpc-{}", account.id);
    use sha2::{Digest, Sha256};
    let identity = Sha256::digest(account.id.as_bytes());
    inventory.cidr = format!("10.{}.{}.0/24", identity[0] % 200 + 1, identity[1]);
    for (index, subnet) in inventory.subnets.iter_mut().enumerate() {
        subnet.id = format!("subnet-{}-{index}", account.id);
        subnet.route_table = format!("rtb-{}-{index}", account.id);
    }
    // Synthetic resources are explicitly owned by this demo, not adopted AWS routes.
    Ok(inventory)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureClass {
    Retryable,
    Permission,
    Conflict,
    InvalidTopology,
}

pub fn simulated_failure(
    fault: &Fault,
    step: i32,
    attempts: i32,
) -> Option<(FailureClass, &'static str)> {
    match fault {
        Fault::PersistentThrottle => Some((
            FailureClass::Retryable,
            "Persistent provider throttling; retry budget enforced",
        )),
        Fault::Throttle if step == 0 && attempts == 0 => Some((
            FailureClass::Retryable,
            "Provider throttled; bounded retry scheduled",
        )),
        Fault::EventualConsistency if step == 1 && attempts == 0 => {
            Some((FailureClass::Retryable, "Attachment not yet observable"))
        }
        Fault::CredentialExpiry if step == 0 && attempts == 0 => Some((
            FailureClass::Retryable,
            "Temporary session expired; refresh before retry",
        )),
        Fault::Permission => Some((
            FailureClass::Permission,
            "Provider permission denied; correct role permissions and re-plan",
        )),
        Fault::PartialFailure if step == 3 => Some((
            FailureClass::Conflict,
            "Conflicting manual NAT route; inspect completed steps before re-planning",
        )),
        _ => None,
    }
}
