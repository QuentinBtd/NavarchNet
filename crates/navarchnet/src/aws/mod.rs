//! AWS role references and read-only observations. Never model discovery as ownership.
mod attachment_subnets;
pub mod ec2;
pub mod ingress_lookup;
pub mod nat_reference;
pub mod observation;
pub mod persistence;
pub mod ram;
pub mod route_lookup;
pub mod routing;
pub mod service;
pub mod session;
pub mod source_handoff;
pub mod target_lookup;
pub mod vpc_cidr_coverage;
pub mod vpc_lookup;
use anyhow::{Context, ensure};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RoleRegistration {
    pub name: String,
    pub role_arn: String,
    pub region: String,
    pub external_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct VerifiedAccount {
    pub id: String,
    pub name: String,
    pub role_arn: String,
    pub aws_account_id: String,
    pub region: String,
    pub verified_at: String,
    pub verified_session_name: String,
    pub execution_enabled: bool,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AdoptionConsent {
    pub topology_id: String,
    pub resource_kind: observation::ResourceKind,
    pub resource_id: String,
    pub reason: String,
}
#[derive(Clone, Serialize, Deserialize, TS)]
pub struct AdoptionRecord {
    pub id: String,
    pub account_id: String,
    pub topology_id: String,
    pub resource_kind: observation::ResourceKind,
    pub resource_id: String,
    pub actor: String,
    pub reason: String,
    pub consented_at: String,
    pub execution_enabled: bool,
}
#[derive(Serialize, TS)]
pub struct TopologyView {
    pub topology: observation::AwsTopology,
    pub adoptions: Vec<AdoptionRecord>,
    pub subnet_route_tables: Vec<routing::SubnetRouteTable>,
}

pub struct RoleIdentity {
    pub account_id: String,
    pub role_name: String,
}

impl RoleRegistration {
    pub fn validate(&self) -> anyhow::Result<RoleIdentity> {
        ensure!(
            !self.name.trim().is_empty()
                && self.name.len() <= 120
                && !self.name.chars().any(char::is_control),
            "Account name must contain 1–120 non-control characters"
        );
        ensure!(
            (20..=2048).contains(&self.role_arn.len()),
            "Invalid role ARN length"
        );
        let parts: Vec<_> = self.role_arn.splitn(6, ':').collect();
        ensure!(
            parts.len() == 6
                && parts[..4] == ["arn", "aws", "iam", ""]
                && parts[4].len() == 12
                && parts[4].bytes().all(|b| b.is_ascii_digit()),
            "An exact commercial-partition IAM role ARN with a 12-digit account is required"
        );
        let path = parts[5]
            .strip_prefix("role/")
            .context("An IAM role, not a user or root ARN, is required")?;
        ensure!(
            path.bytes().all(|b| b.is_ascii_graphic()),
            "Invalid IAM role path"
        );
        let role_name = path.rsplit('/').next().context("Role name missing")?;
        ensure!(
            !role_name.is_empty()
                && role_name.len() <= 64
                && role_name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_+=,.@-".contains(&b)),
            "Invalid IAM role name"
        );
        validate_region(&self.region)?;
        if let Some(value) = &self.external_id {
            ensure!(
                (2..=1224).contains(&value.len())
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_+=,.@:/-".contains(&b)),
                "Invalid STS external ID"
            );
        }
        Ok(RoleIdentity {
            account_id: parts[4].into(),
            role_name: role_name.into(),
        })
    }
    pub fn verify_identity(&self, account: &str, arn: &str) -> anyhow::Result<()> {
        let role = self.validate()?;
        let prefix = format!(
            "arn:aws:sts::{}:assumed-role/{}/",
            role.account_id, role.role_name
        );
        ensure!(
            account == role.account_id && arn.starts_with(&prefix) && arn.len() > prefix.len(),
            "Assumed caller identity does not match the requested account and role"
        );
        Ok(())
    }
}

pub fn validate_region(region: &str) -> anyhow::Result<()> {
    let parts: Vec<_> = region.split('-').collect();
    ensure!(
        parts.len() == 3
            && ["af", "ap", "ca", "eu", "il", "me", "mx", "sa", "us"].contains(&parts[0])
            && !parts[1].is_empty()
            && parts[1].bytes().all(|b| b.is_ascii_lowercase())
            && !parts[2].is_empty()
            && parts[2].bytes().all(|b| b.is_ascii_digit()),
        "A commercial AWS region identifier is required"
    );
    Ok(())
}
