//! AWS-only read boundary; injected fixtures cannot silently invoke the ambient credential chain.
use super::{
    RoleRegistration, VerifiedAccount, ec2::Ec2ReadOnly, observation::AwsTopology,
    persistence::epoch, session::SessionFactory,
};
use anyhow::ensure;
use std::{future::Future, pin::Pin};

pub type AwsFuture<'a, T> = Pin<Box<dyn Future<Output = anyhow::Result<T>> + Send + 'a>>;
pub struct VerifiedIdentity {
    pub account_id: String,
    pub session_name: String,
}
pub trait ReadOnlyAws: Send + Sync {
    fn regions(&self) -> Vec<String>;
    fn verify<'a>(
        &'a self,
        request: &'a RoleRegistration,
        actor: &'a str,
    ) -> AwsFuture<'a, VerifiedIdentity>;
    fn discover<'a>(
        &'a self,
        request: &'a RoleRegistration,
        account: &'a VerifiedAccount,
        actor: &'a str,
    ) -> AwsFuture<'a, AwsTopology>;
}
impl ReadOnlyAws for SessionFactory {
    fn regions(&self) -> Vec<String> {
        SessionFactory::regions(self)
    }
    fn verify<'a>(
        &'a self,
        request: &'a RoleRegistration,
        actor: &'a str,
    ) -> AwsFuture<'a, VerifiedIdentity> {
        Box::pin(async move {
            let _permit = self.operation_permit().await?;
            let session = self.session(request, actor).await?;
            Ok(VerifiedIdentity {
                account_id: session.aws_account_id,
                session_name: session.session_name,
            })
        })
    }
    fn discover<'a>(
        &'a self,
        request: &'a RoleRegistration,
        account: &'a VerifiedAccount,
        actor: &'a str,
    ) -> AwsFuture<'a, AwsTopology> {
        Box::pin(async move {
            let started_at = epoch()?;
            let _permit = self.operation_permit().await?;
            ensure!(
                request.role_arn == account.role_arn && request.region == account.region,
                "Stored AWS role/region configuration changed"
            );
            let session = self.session(request, actor).await?;
            ensure!(
                session.aws_account_id == account.aws_account_id,
                "AWS discovery caller account changed"
            );
            let (mut resources, mut request_ids) = Ec2ReadOnly::new(&session)?.discover().await?;
            let (sharing, sharing_requests) = super::ram::discover(&session).await?;
            resources.extend(sharing);
            request_ids.extend(sharing_requests);
            ensure!(
                resources.len() <= 10_000,
                "Combined AWS observation exceeds the resource budget"
            );
            Ok(AwsTopology {
                id: uuid::Uuid::new_v4().to_string(),account_id:account.id.clone(),aws_account_id:session.aws_account_id,region:session.region,started_at,completed_at:epoch()?,session_name:session.session_name,resources,request_ids,
                complete_for_supported_queries:true,
                limitations:vec![
                    "TGW static/propagated route-search observations do not resolve prefix-list entries or establish a full effective path, SG/NACL policy, egress or isolation".into(),
                    "Resources remain unmanaged; metadata consent does not grant route-management permission".into(),
                    "No active connectivity, isolation or egress-address measurements have been performed".into()
                ],execution_enabled:false,connectivity_tested:false
            })
        })
    }
}

pub fn configure(
    enabled: Option<&str>,
    regions: Option<&str>,
    demo: bool,
) -> anyhow::Result<Option<SessionFactory>> {
    match enabled {
        None | Some("false") => Ok(None),
        Some("true") => {
            ensure!(
                !demo,
                "AWS read-only access requires production OIDC authentication, not demo tokens"
            );
            let regions = regions.ok_or_else(|| {
                anyhow::anyhow!("NAVARCHNET_AWS_REGIONS must explicitly allow AWS regions")
            })?;
            Ok(Some(SessionFactory::new(
                regions.split(',').map(str::to_owned).collect(),
            )?))
        }
        Some(_) => anyhow::bail!("NAVARCHNET_AWS_READ_ONLY must be exactly true or false"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_off_and_rejects_demo_bad_flags_and_missing_or_malformed_regions_without_sdk_loading()
     {
        assert!(configure(None, None, true).unwrap().is_none());
        assert!(configure(Some("false"), None, false).unwrap().is_none());
        assert!(configure(Some("true"), Some("eu-west-1"), true).is_err());
        assert!(configure(Some("true"), None, false).is_err());
        assert!(configure(Some("true"), Some(" eu-west-1"), false).is_err());
        assert!(configure(Some("yes"), Some("eu-west-1"), false).is_err());
        assert_eq!(
            configure(Some("true"), Some("eu-west-1,eu-west-3"), false)
                .unwrap()
                .unwrap()
                .regions(),
            vec!["eu-west-1", "eu-west-3"]
        );
    }
}
