//! Loopback-only protocol failures. Even a broken redirect policy can reach only this fixture server.
use super::*;
use aws_credential_types::{
    Credentials, credential_fn::provide_credentials_fn, provider::SharedCredentialsProvider,
};
use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
#[derive(Clone)]
struct Fixture {
    mode: u8,
    calls: Arc<AtomicUsize>,
    redirected: Arc<AtomicUsize>,
}
const OK: &str =
    "<DescribeVpcsResponse><requestId>fixture</requestId><vpcSet/></DescribeVpcsResponse>";
async fn handler(State(state): State<Fixture>, headers: HeaderMap) -> Response<Body> {
    let count = state.calls.fetch_add(1, Ordering::SeqCst) + 1;
    if state.mode == 0 && count == 2 {
        assert_eq!(headers["x-amz-security-token"], "fixture-session-2");
    }
    let code = match state.mode {
        0 if count == 1 => "ExpiredToken",
        0 => return (StatusCode::OK, OK).into_response(),
        1 => "RequestLimitExceeded",
        2 => "UnauthorizedOperation",
        _ => return (StatusCode::FOUND, [("location", "/redirect-target")], "").into_response(),
    };
    (StatusCode::FORBIDDEN,format!("<Response><Errors><Error><Code>{code}</Code><Message>never-return-this-fixture-message</Message></Error></Errors></Response>")).into_response()
}
async fn redirect_target(State(state): State<Fixture>) -> impl IntoResponse {
    state.redirected.fetch_add(1, Ordering::SeqCst);
    (StatusCode::OK, OK)
}
#[tokio::test]
async fn refreshes_expired_sessions_bounds_throttle_retries_does_not_retry_permissions_or_follow_redirects()
 {
    for mode in 0..4 {
        let state = Fixture {
            mode,
            calls: Arc::new(AtomicUsize::new(0)),
            redirected: Arc::new(AtomicUsize::new(0)),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/", post(handler))
            .route("/redirect-target", get(redirect_target))
            .with_state(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let credentials_calls = Arc::new(AtomicUsize::new(0));
        let counter = credentials_calls.clone();
        let provider = provide_credentials_fn(move || {
            let counter = counter.clone();
            async move {
                let value = counter.fetch_add(1, Ordering::SeqCst) + 1;
                Ok(Credentials::new(
                    "ASIAEXAMPLEONLY",
                    "fixture-only-key",
                    Some(format!("fixture-session-{value}")),
                    Some(std::time::SystemTime::now() + std::time::Duration::from_secs(3600)),
                    "test",
                ))
            }
        });
        let credentials = super::super::session::TemporaryCredentials::new(
            SharedCredentialsProvider::new(provider),
        );
        let adapter = Ec2ReadOnly {
            client: transport(false).unwrap(),
            endpoint: format!("http://{address}/"),
            region: "eu-west-1".into(),
            credentials,
        };
        let mut budget = BodyBudget::default();
        let result = adapter.query("DescribeVpcs", true, None, &mut budget).await;
        server.abort();
        if mode != 3 {
            assert!(budget.bytes > 0);
        }
        assert_eq!(state.redirected.load(Ordering::SeqCst), 0);
        match mode {
            0 => {
                assert!(result.is_ok());
                assert_eq!(state.calls.load(Ordering::SeqCst), 2);
                assert_eq!(credentials_calls.load(Ordering::SeqCst), 2);
            }
            1 => {
                let error = result.unwrap_err().to_string();
                assert!(error.contains("RetryBudgetExhausted"));
                assert!(!error.contains("never-return-this-fixture-message"));
                assert_eq!(state.calls.load(Ordering::SeqCst), 3);
                assert_eq!(credentials_calls.load(Ordering::SeqCst), 1);
            }
            _ => {
                let error = result.unwrap_err().to_string();
                assert!(error.contains("PermissionOrRequestRejected"));
                assert!(!error.contains("never-return-this-fixture-message"));
                assert_eq!(state.calls.load(Ordering::SeqCst), 1);
            }
        }
    }
}
