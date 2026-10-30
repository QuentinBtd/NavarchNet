use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use navarchnet::{
    api::{self, AppState},
    auth::Auth,
    store::Store,
};
use std::sync::Arc;
use tower::ServiceExt;

#[tokio::test]
async fn api_enforces_auth_on_every_mutation() -> anyhow::Result<()> {
    let url = std::env::var("DATABASE_URL").expect("PostgreSQL required");
    let store = Store::connect(&url).await?;
    store.migrate().await?;
    let state = AppState {
        store,
        auth: Arc::new(Auth::demo("a".repeat(32), "r".repeat(32))?),
        aws: None,
    };
    let router = api::router(state);
    for path in [
        "/accounts",
        "/accounts/unknown/discover",
        "/aws/accounts",
        "/aws/accounts/unknown/discover",
        "/aws/accounts/unknown/adoptions",
        "/networks",
        "/plans",
        "/plans/unknown/apply",
        "/operations/unknown/demo-drift",
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::post(format!("/api/v1{path}"))
                    .header("authorization", format!("Bearer {}", "r".repeat(32)))
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
    }
    assert_eq!(
        router
            .clone()
            .oneshot(Request::get("/api/v1/snapshot").body(Body::empty())?)
            .await?
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        router
            .clone()
            .oneshot(
                Request::get("/api/v1/snapshot")
                    .header("authorization", format!("Bearer {}", "r".repeat(32)))
                    .body(Body::empty())?
            )
            .await?
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        router
            .oneshot(Request::get("/readyz").body(Body::empty())?)
            .await?
            .status(),
        StatusCode::OK
    );
    Ok(())
}
