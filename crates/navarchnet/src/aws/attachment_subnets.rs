//! Shared declared-subnet evidence policy; callers verify attachment/gateway identity and readiness.
use super::observation::{AwsResource, AwsTopology, ResourceKind};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn declared_subnets<'a>(
    topology: &'a AwsTopology,
    attachment: &AwsResource,
) -> Option<Vec<(&'a AwsResource, &'a str)>> {
    let vpc_id = attachment.vpc_id.as_deref().filter(|id| !id.is_empty())?;
    let mut index: BTreeMap<&str, Vec<&AwsResource>> = BTreeMap::new();
    for row in topology
        .resources
        .iter()
        .filter(|row| row.kind == ResourceKind::Subnet)
    {
        index.entry(&row.id).or_default().push(row);
    }
    let mut zones = BTreeSet::new();
    let mut result = Vec::new();
    for id in attachment
        .related_ids
        .iter()
        .filter(|id| id.starts_with("subnet-"))
    {
        let rows = index.get(id.as_str()).filter(|rows| rows.len() == 1)?;
        let row = rows[0];
        let az = row.az_id.as_deref().filter(|id| standard_az_id(id))?;
        if row.vpc_id.as_deref() != Some(vpc_id)
            || row.owner_account_id.as_deref() != Some(topology.aws_account_id.as_str())
            || row.state.as_deref() != Some("available")
            || !zones.insert(az)
        {
            return None;
        }
        let mut ipv4 = 0;
        for cidr in &row.cidrs {
            let network = cidr.parse::<ipnet::IpNet>().ok()?;
            if network.addr() != network.network() {
                return None;
            }
            if network.addr().is_ipv4() {
                ipv4 += 1;
            }
        }
        // AWS does not support IPv6-only attachment subnets; missing IPv4 is not assumed.
        if ipv4 != 1 {
            return None;
        }
        result.push((row, az));
    }
    if result.is_empty() {
        return None;
    }
    result.sort_by(|left, right| left.0.id.cmp(&right.0.id));
    Some(result)
}
// Do not translate account-specific names or infer a Local Zone/Wavelength parent.
pub(super) fn standard_az_id(value: &str) -> bool {
    let Some((prefix, number)) = value.split_once("-az") else {
        return false;
    };
    value.len() <= 128
        && !prefix.is_empty()
        && !number.is_empty()
        && prefix
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && number.bytes().all(|byte| byte.is_ascii_digit())
}
