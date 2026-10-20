//! Lazy SDK sessions. Merely starting NavarchNet never evaluates ambient credentials.
use super::{RoleRegistration, validate_region};
use anyhow::{Context, ensure};
use aws_config::{BehaviorVersion, sts::AssumeRoleProvider};
use aws_credential_types::{
    Credentials,
    provider::{ProvideCredentials, SharedCredentialsProvider, error::CredentialsError, future},
};
use aws_sdk_sts::error::ProvideErrorMetadata;
use aws_types::{SdkConfig, region::Region};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::sync::Mutex;

const READ_ONLY_ACTIONS: [&str; 16] = [
    "ec2:DescribeVpcs",
    "ec2:DescribeSubnets",
    "ec2:DescribeRouteTables",
    "ec2:DescribeTransitGateways",
    "ec2:DescribeTransitGatewayVpcAttachments",
    "ec2:DescribeNatGateways",
    "ec2:DescribeInternetGateways",
    "ec2:DescribeAddresses",
    "ec2:DescribeTransitGatewayRouteTables",
    "ec2:GetTransitGatewayRouteTableAssociations",
    "ec2:GetTransitGatewayRouteTablePropagations",
    "ram:GetResourceShares",
    "ram:GetResourceShareInvitations",
    "ram:ListResources",
    "ram:ListPrincipals",
    "sts:GetCallerIdentity",
];
fn read_only_session_policy(region: &str) -> anyhow::Result<String> {
    let value=serde_json::json!({"Version":"2012-10-17","Statement":[
        {"Effect":"Allow","Action":READ_ONLY_ACTIONS,"Resource":"*","Condition":{"StringEquals":{"aws:RequestedRegion":region}}},
        {"Effect":"Deny","NotAction":READ_ONLY_ACTIONS,"Resource":"*"},
        {"Effect":"Deny","Action":READ_ONLY_ACTIONS,"Resource":"*","Condition":{"StringNotEquals":{"aws:RequestedRegion":region}}}
    ]}).to_string();
    ensure!(
        value.len() <= 2048,
        "Read-only STS session policy exceeds the inline policy budget"
    );
    Ok(value)
}

#[derive(Clone)]
pub struct TemporaryCredentials {
    inner: SharedCredentialsProvider,
    cached: Arc<Mutex<Option<Credentials>>>,
}
impl std::fmt::Debug for TemporaryCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TemporaryCredentials")
            .finish_non_exhaustive()
    }
}
impl TemporaryCredentials {
    pub(crate) fn new(inner: SharedCredentialsProvider) -> Self {
        Self {
            inner,
            cached: Arc::new(Mutex::new(None)),
        }
    }
    pub async fn invalidate(&self) {
        *self.cached.lock().await = None;
    }
}
impl ProvideCredentials for TemporaryCredentials {
    fn provide_credentials<'a>(&'a self) -> future::ProvideCredentials<'a>
    where
        Self: 'a,
    {
        future::ProvideCredentials::new(async move {
            let mut cached = self.cached.lock().await;
            let now = SystemTime::now();
            if let Some(value) = cached.as_ref()
                && value
                    .expiry()
                    .is_some_and(|expiry| expiry > now + Duration::from_secs(120))
            {
                return Ok(value.clone());
            }
            let value = self.inner.provide_credentials().await?;
            if !value
                .expiry()
                .is_some_and(|expiry| expiry > SystemTime::now())
                || value.session_token().is_none()
            {
                return Err(CredentialsError::provider_error(
                    "AssumeRole did not return an unexpired temporary session",
                ));
            }
            *cached = Some(value.clone());
            Ok(value)
        })
    }
}

#[derive(Clone)]
pub struct SessionFactory {
    regions: BTreeSet<String>,
    // Tests supply an in-process replay client and static, non-secret test credentials.
    base: Option<SdkConfig>,
    operations: Arc<tokio::sync::Semaphore>,
}
pub struct RoleSession {
    pub config: SdkConfig,
    pub credentials: TemporaryCredentials,
    pub session_name: String,
    pub aws_account_id: String,
    pub region: String,
}
pub fn redacted_error(operation: &str, code: Option<&str>) -> anyhow::Error {
    let code = code
        .filter(|v| {
            !v.is_empty()
                && v.len() <= 80
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
        .unwrap_or("transport-or-unclassified");
    anyhow::anyhow!("{operation} failed ({code}); service messages and credentials are redacted")
}
impl SessionFactory {
    pub fn new(regions: Vec<String>) -> anyhow::Result<Self> {
        ensure!(
            !regions.is_empty() && regions.len() <= 50,
            "Explicit AWS region allowlist required"
        );
        for region in &regions {
            validate_region(region)?;
        }
        Ok(Self {
            regions: regions.into_iter().collect(),
            base: None,
            operations: Arc::new(tokio::sync::Semaphore::new(1)),
        })
    }
    pub fn regions(&self) -> Vec<String> {
        self.regions.iter().cloned().collect()
    }
    pub(crate) async fn operation_permit(
        &self,
    ) -> anyhow::Result<tokio::sync::OwnedSemaphorePermit> {
        Ok(self.operations.clone().acquire_owned().await?)
    }
    pub async fn session(
        &self,
        request: &RoleRegistration,
        actor: &str,
    ) -> anyhow::Result<RoleSession> {
        request.validate()?;
        ensure!(
            self.regions.contains(&request.region),
            "AWS region is not enabled by the operator"
        );
        let digest = Sha256::digest(actor.as_bytes());
        let policy = read_only_session_policy(&request.region)?;
        let attribution = digest
            .iter()
            .take(8)
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let session_name = format!("navarchnet-{attribution}-{}", uuid::Uuid::new_v4().simple());
        let base = match &self.base {
            Some(base) => base.clone(),
            None => {
                let http = aws_smithy_http_client::Builder::new()
                    .tls_provider(aws_smithy_http_client::tls::Provider::Rustls(
                        aws_smithy_http_client::tls::rustls_provider::CryptoMode::Ring,
                    ))
                    .build_https();
                tokio::time::timeout(
                    Duration::from_secs(20),
                    aws_config::defaults(BehaviorVersion::latest())
                        .region(Region::new(request.region.clone()))
                        .http_client(http)
                        .retry_config(
                            aws_config::retry::RetryConfig::standard().with_max_attempts(3),
                        )
                        .timeout_config(
                            aws_config::timeout::TimeoutConfig::builder()
                                .connect_timeout(Duration::from_secs(3))
                                .read_timeout(Duration::from_secs(10))
                                .operation_timeout(Duration::from_secs(20))
                                .operation_attempt_timeout(Duration::from_secs(10))
                                .build(),
                        )
                        .load(),
                )
                .await
                .context("AWS configuration loading timed out")?
            }
        };
        let mut builder = AssumeRoleProvider::builder(&request.role_arn)
            .policy(policy)
            .session_name(&session_name)
            .session_length(Duration::from_secs(900))
            .region(Region::new(request.region.clone()))
            .configure(&base);
        if let Some(value) = &request.external_id {
            builder = builder.external_id(value);
        }
        let assumed = builder.build().await;
        let credentials = TemporaryCredentials::new(SharedCredentialsProvider::new(assumed));
        let config = base
            .to_builder()
            .credentials_provider(SharedCredentialsProvider::new(credentials.clone()))
            .region(Region::new(request.region.clone()))
            .build();
        let identity = aws_sdk_sts::Client::new(&config)
            .get_caller_identity()
            .send()
            .await
            .map_err(|e| {
                redacted_error(
                    "STS caller verification",
                    e.as_service_error().and_then(|e| e.code()),
                )
            })?;
        let account = identity
            .account()
            .context("STS returned no account identity")?;
        request.verify_identity(
            account,
            identity.arn().context("STS returned no caller ARN")?,
        )?;
        Ok(RoleSession {
            config,
            credentials,
            session_name,
            aws_account_id: account.into(),
            region: request.region.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cloned_factories_share_one_bounded_live_operation_without_loading_credentials() {
        let factory = SessionFactory::new(vec!["eu-west-1".into()]).unwrap();
        let clone = factory.clone();
        let permit = factory.operation_permit().await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), clone.operation_permit())
                .await
                .is_err()
        );
        drop(permit);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), clone.operation_permit())
                .await
                .unwrap()
                .is_ok()
        );
    }
    use aws_smithy_http_client::test_util::{ReplayEvent, StaticReplayClient};
    use aws_smithy_types::body::SdkBody;
    #[tokio::test]
    async fn assumes_and_verifies_exact_role_with_external_id_without_ambient_chain() {
        let assumed = "<AssumeRoleResponse xmlns=\"https://sts.amazonaws.com/doc/2011-06-15/\"><AssumeRoleResult><Credentials><AccessKeyId>ASIAEXAMPLEONLY</AccessKeyId><SecretAccessKey>non-secret-fixture-key</SecretAccessKey><SessionToken>non-secret-fixture-session</SessionToken><Expiration>2035-01-01T00:00:00Z</Expiration></Credentials><AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/Reader/test</Arn><AssumedRoleId>EXAMPLE:test</AssumedRoleId></AssumedRoleUser></AssumeRoleResult><ResponseMetadata><RequestId>fixture-assume</RequestId></ResponseMetadata></AssumeRoleResponse>";
        let caller = "<GetCallerIdentityResponse xmlns=\"https://sts.amazonaws.com/doc/2011-06-15/\"><GetCallerIdentityResult><Account>123456789012</Account><Arn>arn:aws:sts::123456789012:assumed-role/Reader/test</Arn><UserId>EXAMPLE:test</UserId></GetCallerIdentityResult><ResponseMetadata><RequestId>fixture-caller</RequestId></ResponseMetadata></GetCallerIdentityResponse>";
        let replay = StaticReplayClient::new(
            [assumed, caller]
                .into_iter()
                .map(|body| {
                    ReplayEvent::new(
                        http::Request::builder()
                            .uri("https://sts.eu-west-1.amazonaws.com/")
                            .body(SdkBody::empty())
                            .unwrap(),
                        http::Response::builder()
                            .status(200)
                            .body(SdkBody::from(body))
                            .unwrap(),
                    )
                })
                .collect(),
        );
        let base = SdkConfig::builder()
            .time_source(aws_smithy_async::time::SystemTimeSource::new())
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("eu-west-1"))
            .credentials_provider(SharedCredentialsProvider::new(Credentials::for_tests()))
            .http_client(replay.clone())
            .build();
        let mut factory = SessionFactory::new(vec!["eu-west-1".into()]).unwrap();
        factory.base = Some(base);
        let request = RoleRegistration {
            name: "Test".into(),
            role_arn: "arn:aws:iam::123456789012:role/team/Reader".into(),
            region: "eu-west-1".into(),
            external_id: Some("fixture-external".into()),
        };
        let session = factory
            .session(&request, "operator@example.invalid")
            .await
            .unwrap();
        assert_eq!(session.aws_account_id, "123456789012");
        assert!(session.session_name.starts_with("navarchnet-"));
        assert!(session.session_name.len() <= 64);
        let requests: Vec<_> = replay
            .actual_requests()
            .map(|r| r.body().bytes().unwrap().to_vec())
            .collect();
        assert_eq!(requests.len(), 2);
        let fields: std::collections::HashMap<_, _> =
            form_urlencoded::parse(&requests[0]).into_owned().collect();
        assert_eq!(fields["Action"], "AssumeRole");
        assert_eq!(fields["RoleArn"], request.role_arn);
        assert_eq!(fields["ExternalId"], "fixture-external");
        assert_eq!(fields["RoleSessionName"], session.session_name);
        assert!(
            fields.contains_key("Policy"),
            "Every assumed session must carry the read-only downscoping policy"
        );
        let policy: serde_json::Value = serde_json::from_str(&fields["Policy"]).unwrap();
        assert!(fields["Policy"].len() <= 2048);
        assert_eq!(policy["Statement"][0]["Effect"], "Allow");
        let actions = policy["Statement"][0]["Action"].as_array().unwrap();
        assert_eq!(actions.len(), 16);
        assert!(
            actions
                .iter()
                .any(|a| a == "ec2:GetTransitGatewayRouteTableAssociations")
        );
        assert!(
            actions
                .iter()
                .any(|a| a == "ec2:GetTransitGatewayRouteTablePropagations")
        );
        assert!(actions.iter().all(|a| {
            let a = a.as_str().unwrap();
            !a.contains('*')
                && (a.starts_with("ec2:Describe")
                    || matches!(
                        a,
                        "ec2:GetTransitGatewayRouteTableAssociations"
                            | "ec2:GetTransitGatewayRouteTablePropagations"
                            | "ram:GetResourceShares"
                            | "ram:GetResourceShareInvitations"
                            | "ram:ListResources"
                            | "ram:ListPrincipals"
                            | "sts:GetCallerIdentity"
                    ))
        }));
        assert_eq!(
            policy["Statement"][0]["Condition"]["StringEquals"]["aws:RequestedRegion"],
            request.region
        );
        assert_eq!(policy["Statement"][1]["Effect"], "Deny");
        assert_eq!(
            policy["Statement"][1]["NotAction"],
            policy["Statement"][0]["Action"]
        );
        assert_eq!(policy["Statement"][2]["Effect"], "Deny");
        assert_eq!(
            policy["Statement"][2]["Action"],
            policy["Statement"][0]["Action"]
        );
        assert_eq!(
            policy["Statement"][2]["Condition"]["StringNotEquals"]["aws:RequestedRegion"],
            request.region
        );
        assert!(String::from_utf8_lossy(&requests[1]).contains("GetCallerIdentity"));
        let signed: Vec<_> = replay
            .actual_requests()
            .map(|request| {
                (
                    request.headers().get("authorization").unwrap().to_owned(),
                    request
                        .headers()
                        .get("x-amz-security-token")
                        .map(str::to_owned),
                )
            })
            .collect();
        assert!(signed[1].0.contains("Credential=ASIAEXAMPLEONLY/"));
        assert_eq!(signed[1].1.as_deref(), Some("non-secret-fixture-session"));
        // Calls share the cached temporary role session, not the controller identity.
        session.credentials.provide_credentials().await.unwrap();
        assert_eq!(replay.actual_requests().count(), 2);
        let denied = RoleRegistration {
            region: "eu-west-3".into(),
            ..request
        };
        assert!(factory.session(&denied, "operator").await.is_err());
        assert_eq!(replay.actual_requests().count(), 2);
    }
    #[tokio::test]
    async fn refreshes_near_expiry_and_rejects_permanent_or_expired_role_results() {
        use aws_credential_types::credential_fn::provide_credentials_fn;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let provider = provide_credentials_fn(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(Credentials::new(
                    "example",
                    "fixture",
                    Some("fixture".into()),
                    Some(SystemTime::now() + Duration::from_secs(30)),
                    "test",
                ))
            }
        });
        let cache = TemporaryCredentials::new(SharedCredentialsProvider::new(provider));
        cache.provide_credentials().await.unwrap();
        cache.provide_credentials().await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let cache =
            TemporaryCredentials::new(SharedCredentialsProvider::new(Credentials::for_tests()));
        assert!(cache.provide_credentials().await.is_err());
        assert!(!format!("{cache:?}").contains("fixture"));
    }
}
