//! Read-only RAM sharing metadata. Never accept invitations or infer management ownership.
use super::{
    ec2::Pagination,
    observation::*,
    session::{RoleSession, redacted_error},
};
use anyhow::{Context, ensure};
use aws_sdk_ram::{error::ProvideErrorMetadata, types::ResourceOwner};
use aws_types::request_id::RequestId;
fn push(out: &mut Vec<AwsResource>, value: AwsResource) -> anyhow::Result<()> {
    out.push(value);
    ensure!(out.len() <= 10_000, "RAM resource budget exceeded");
    Ok(())
}
pub async fn discover(session: &RoleSession) -> anyhow::Result<(Vec<AwsResource>, Vec<String>)> {
    let client = aws_sdk_ram::Client::new(&session.config);
    let mut resources = Vec::new();
    let mut requests = Vec::new();
    for owner in ["SELF", "OTHER-ACCOUNTS"] {
        let mut pages = Pagination::new();
        let mut token = None;
        loop {
            let result = client
                .get_resource_shares()
                .resource_owner(ResourceOwner::from(owner))
                .max_results(100)
                .set_next_token(token)
                .send()
                .await
                .map_err(|e| {
                    redacted_error(
                        "RAM GetResourceShares",
                        e.as_service_error().and_then(|e| e.code()),
                    )
                })?;
            if let Some(id) = result.request_id() {
                requests.push(id.into());
            }
            for share in result.resource_shares() {
                let mut row = AwsResource::new(
                    ResourceKind::RamShare,
                    share
                        .resource_share_arn()
                        .context("RAM share ARN missing")?
                        .into(),
                );
                row.owner_account_id = share.owning_account_id().map(str::to_owned);
                row.state = share.status().map(|v| v.as_str().into());
                for tag in share.tags() {
                    if let Some(key) = tag.key() {
                        row.tags
                            .insert(key.into(), tag.value().unwrap_or_default().into());
                    }
                }
                push(&mut resources, row)?;
            }
            token = pages.next(result.next_token().map(str::to_owned))?;
            if token.is_none() {
                break;
            }
        }
        let mut pages = Pagination::new();
        let mut token = None;
        loop {
            let result = client
                .list_resources()
                .resource_owner(ResourceOwner::from(owner))
                .resource_type("ec2:TransitGateway")
                .max_results(100)
                .set_next_token(token)
                .send()
                .await
                .map_err(|e| {
                    redacted_error(
                        "RAM ListResources",
                        e.as_service_error().and_then(|e| e.code()),
                    )
                })?;
            if let Some(id) = result.request_id() {
                requests.push(id.into());
            }
            for resource in result.resources() {
                let mut row = AwsResource::new(
                    ResourceKind::RamResource,
                    resource.arn().context("RAM resource ARN missing")?.into(),
                );
                row.state = resource.status().map(|v| v.as_str().into());
                if let Some(share) = resource.resource_share_arn() {
                    row.related_ids.push(share.into());
                }
                push(&mut resources, row)?;
            }
            token = pages.next(result.next_token().map(str::to_owned))?;
            if token.is_none() {
                break;
            }
        }
        let mut pages = Pagination::new();
        let mut token = None;
        loop {
            let result = client
                .list_principals()
                .resource_owner(ResourceOwner::from(owner))
                .resource_type("ec2:TransitGateway")
                .max_results(100)
                .set_next_token(token)
                .send()
                .await
                .map_err(|e| {
                    redacted_error(
                        "RAM ListPrincipals",
                        e.as_service_error().and_then(|e| e.code()),
                    )
                })?;
            if let Some(id) = result.request_id() {
                requests.push(id.into());
            }
            for principal in result.principals() {
                let mut row = AwsResource::new(
                    ResourceKind::RamPrincipal,
                    principal.id().context("RAM principal ID missing")?.into(),
                );
                if let Some(share) = principal.resource_share_arn() {
                    row.related_ids.push(share.into());
                }
                push(&mut resources, row)?;
            }
            token = pages.next(result.next_token().map(str::to_owned))?;
            if token.is_none() {
                break;
            }
        }
    }
    let mut pages = Pagination::new();
    let mut token = None;
    loop {
        let result = client
            .get_resource_share_invitations()
            .max_results(100)
            .set_next_token(token)
            .send()
            .await
            .map_err(|e| {
                redacted_error(
                    "RAM GetResourceShareInvitations",
                    e.as_service_error().and_then(|e| e.code()),
                )
            })?;
        if let Some(id) = result.request_id() {
            requests.push(id.into());
        }
        for invitation in result.resource_share_invitations() {
            let mut row = AwsResource::new(
                ResourceKind::RamInvitation,
                invitation
                    .resource_share_invitation_arn()
                    .context("RAM invitation ARN missing")?
                    .into(),
            );
            row.owner_account_id = invitation.sender_account_id().map(str::to_owned);
            row.state = invitation.status().map(|v| v.as_str().into());
            if let Some(share) = invitation.resource_share_arn() {
                row.related_ids.push(share.into());
            }
            push(&mut resources, row)?;
        }
        token = pages.next(result.next_token().map(str::to_owned))?;
        if token.is_none() {
            break;
        }
    }
    Ok((resources, requests))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_config::BehaviorVersion;
    use aws_credential_types::{Credentials, provider::SharedCredentialsProvider};
    use aws_smithy_http_client::test_util::{ReplayEvent, StaticReplayClient};
    use aws_smithy_types::body::SdkBody;
    use serde_json::json;
    #[tokio::test]
    async fn pages_both_share_owners_without_accepting_invitations_or_adopting_tags() {
        let share = "arn:aws:ram:eu-west-1:123456789012:resource-share/fixture";
        let rows = [
            json!({"resourceShares":[{"resourceShareArn":share,"owningAccountId":"123456789012","status":"ACTIVE"}],"nextToken":"next+/="}),
            json!({"resourceShares":[]}),
            json!({"resources":[{"arn":"arn:aws:ec2:eu-west-1:123456789012:transit-gateway/tgw-01111111111111111","resourceShareArn":share,"status":"AVAILABLE"}]}),
            json!({"principals":[{"id":"999999999999","resourceShareArn":share}]}),
            json!({"resourceShares":[]}),
            json!({"resources":[]}),
            json!({"principals":[]}),
            json!({"resourceShareInvitations":[{"resourceShareInvitationArn":"arn:aws:ram:eu-west-1:123456789012:resource-share-invitation/fixture","senderAccountId":"999999999999","resourceShareArn":share,"status":"PENDING"}]}),
        ];
        let replay = StaticReplayClient::new(
            rows.iter()
                .enumerate()
                .map(|(i, row)| {
                    ReplayEvent::new(
                        http::Request::builder()
                            .uri("https://ram.eu-west-1.amazonaws.com/")
                            .body(SdkBody::empty())
                            .unwrap(),
                        http::Response::builder()
                            .status(200)
                            .header("content-type", "application/json")
                            .header("x-amzn-requestid", format!("fixture-{i}"))
                            .body(SdkBody::from(row.to_string()))
                            .unwrap(),
                    )
                })
                .collect(),
        );
        let credentials = super::super::session::TemporaryCredentials::new(
            SharedCredentialsProvider::new(Credentials::new(
                "ASIAEXAMPLEONLY",
                "fixture-key",
                Some("fixture-session".into()),
                Some(std::time::SystemTime::now() + std::time::Duration::from_secs(3600)),
                "test",
            )),
        );
        let config = aws_types::SdkConfig::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(aws_types::region::Region::new("eu-west-1"))
            .time_source(aws_smithy_async::time::SystemTimeSource::new())
            .credentials_provider(SharedCredentialsProvider::new(credentials.clone()))
            .http_client(replay.clone())
            .build();
        let session = RoleSession {
            config,
            credentials,
            session_name: "fixture".into(),
            aws_account_id: "123456789012".into(),
            region: "eu-west-1".into(),
        };
        let (resources, request_ids) = discover(&session).await.unwrap();
        assert_eq!(request_ids.len(), rows.len());
        assert!(resources.iter().all(|r| !r.managed));
        assert!(resources.iter().any(
            |r| r.kind == ResourceKind::RamInvitation && r.state.as_deref() == Some("PENDING")
        ));
        let requests: Vec<_> = replay
            .actual_requests()
            .map(|r| {
                (
                    r.uri().to_string(),
                    serde_json::from_slice::<serde_json::Value>(r.body().bytes().unwrap()).unwrap(),
                    r.headers().get("authorization").unwrap().to_owned(),
                )
            })
            .collect();
        assert_eq!(requests.len(), rows.len());
        assert_eq!(requests[1].1["nextToken"], "next+/=");
        assert_eq!(requests[0].1["resourceOwner"], "SELF");
        assert_eq!(requests[4].1["resourceOwner"], "OTHER-ACCOUNTS");
        for (uri, _, auth) in requests {
            assert!(!uri.to_lowercase().contains("accept"));
            assert!(auth.contains("/eu-west-1/ram/aws4_request"));
        }
    }
}
