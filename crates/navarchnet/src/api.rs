use crate::{
    auth::{Auth, Principal, Role},
    domain::*,
    store::Store,
};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};
use ts_rs::TS;

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub auth: Arc<Auth>,
}
#[derive(Serialize, TS)]
pub struct Snapshot {
    pub accounts: Vec<Account>,
    pub inventory: Vec<Inventory>,
    pub networks: Vec<RegionalNetwork>,
    pub plans: Vec<Plan>,
    pub operations: Vec<Operation>,
    pub mode: String,
    pub role: String,
}
#[derive(Deserialize, TS)]
pub struct RegisterAccount {
    pub name: String,
    pub provider: ProviderKind,
    pub role_arn: String,
}
#[derive(Deserialize, TS)]
pub struct CreateNetwork {
    pub name: String,
}
#[derive(Deserialize, TS)]
pub struct ApplyPlan {
    pub fault: Fault,
}
#[derive(Serialize, TS)]
pub struct ApiError {
    pub error: String,
}
struct Failure(anyhow::Error);
impl From<anyhow::Error> for Failure {
    fn from(e: anyhow::Error) -> Self {
        Self(e)
    }
}
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        if self.0.downcast_ref::<sqlx::Error>().is_some() {
            tracing::warn!("Database operation failed");
            (StatusCode::CONFLICT,Json(ApiError { error: "Database conflict or missing resource; refresh and retry. Consult server diagnostics.".into() })).into_response()
        } else {
            (
                StatusCode::CONFLICT,
                Json(ApiError {
                    error: self.0.to_string(),
                }),
            )
                .into_response()
        }
    }
}

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/snapshot", get(snapshot))
        .route("/accounts", post(register))
        .route("/accounts/{id}/discover", post(discover))
        .route("/networks", post(create_network))
        .route("/plans", post(create_plan))
        .route("/plans/{id}/apply", post(apply))
        .route("/operations/{id}", get(operation))
        .route("/operations/{id}/observation", get(observe))
        .route("/operations/{id}/demo-drift", post(drift))
        .route("/operations/{id}/events", get(events))
        .route("/audit", get(audit))
        .route_layer(middleware::from_fn_with_state(state.clone(), authorize));
    Router::new().route("/healthz",get(|| async { "ok" }))
        .route("/readyz",get(ready))
        .nest("/api/v1",protected)
        .fallback_service(ServeDir::new(std::env::var("NAVARCHNET_STATIC_DIR").unwrap_or_else(|_| "frontend/dist".into())))
        .layer(DefaultBodyLimit::max(64*1024))
        .layer(SetResponseHeaderLayer::if_not_present(axum::http::header::CONTENT_SECURITY_POLICY,HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")))
        .layer(SetResponseHeaderLayer::if_not_present(axum::http::header::X_CONTENT_TYPE_OPTIONS,HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::if_not_present(axum::http::header::CACHE_CONTROL,HeaderValue::from_static("no-store")))
        .with_state(state)
}
async fn authorize(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    let token = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    let Some(principal) = token.and_then(|t| state.auth.authenticate(t).ok()) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ApiError {
                error: "Authentication required".into(),
            }),
        )
            .into_response();
    };
    if req.method() != Method::GET && req.method() != Method::HEAD && principal.role != Role::Admin
    {
        return (
            StatusCode::FORBIDDEN,
            Json(ApiError {
                error: "Administrator role required".into(),
            }),
        )
            .into_response();
    }
    req.extensions_mut().insert(principal);
    next.run(req).await
}
async fn ready(State(s): State<AppState>) -> StatusCode {
    if s.store.ready().await.is_ok() {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}
async fn snapshot(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
) -> Result<Json<Snapshot>, Failure> {
    Ok(Json(Snapshot {
        accounts: s.store.accounts().await?,
        inventory: s.store.inventories().await?,
        networks: s.store.networks().await?,
        plans: s.store.plans().await?,
        operations: s.store.operations().await?,
        mode: if s.auth.is_demo() { "demo" } else { "oidc" }.into(),
        role: if p.role == Role::Admin {
            "admin"
        } else {
            "read_only"
        }
        .into(),
    }))
}
async fn register(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(body): Json<RegisterAccount>,
) -> Result<Json<Account>, Failure> {
    Ok(Json(
        s.store
            .register(&p.subject, &body.name, body.provider, &body.role_arn)
            .await?,
    ))
}
async fn discover(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> Result<Json<Inventory>, Failure> {
    Ok(Json(s.store.discover(&p.subject, &id).await?))
}
async fn create_network(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(body): Json<CreateNetwork>,
) -> Result<Json<RegionalNetwork>, Failure> {
    Ok(Json(
        s.store.create_demo_network(&p.subject, &body.name).await?,
    ))
}
async fn create_plan(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(body): Json<ConnectionRequest>,
) -> Result<Json<Plan>, Failure> {
    Ok(Json(s.store.create_plan(&p.subject, body).await?))
}
async fn apply(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(body): Json<ApplyPlan>,
) -> Result<Json<Operation>, Failure> {
    Ok(Json(s.store.apply(&p.subject, &id, body.fault).await?))
}
async fn operation(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Operation>, Failure> {
    Ok(Json(s.store.operation(&id).await?))
}
async fn observe(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Observation>, Failure> {
    Ok(Json(s.store.observe(&id).await?))
}
async fn drift(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> Result<StatusCode, Failure> {
    if !s.auth.is_demo() {
        return Ok(StatusCode::NOT_FOUND);
    }
    s.store.inject_drift(&p.subject, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn events(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<serde_json::Value>>, Failure> {
    let rows = sqlx::query_scalar("SELECT jsonb_build_object('step',step,'fence',fence,'outcome',outcome,'at',created_at) FROM step_events WHERE operation_id=$1 ORDER BY id LIMIT 1000").bind(id).fetch_all(&s.store.pool).await.map_err(anyhow::Error::from)?;
    Ok(Json(rows))
}
async fn audit(State(s): State<AppState>) -> Result<Json<Vec<serde_json::Value>>, Failure> {
    let rows = sqlx::query_scalar("SELECT jsonb_build_object('actor',actor,'event',event,'target',target,'at',created_at) FROM audit ORDER BY id DESC LIMIT 1000").fetch_all(&s.store.pool).await.map_err(anyhow::Error::from)?;
    Ok(Json(rows))
}
