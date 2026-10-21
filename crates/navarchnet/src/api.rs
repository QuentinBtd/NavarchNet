use crate::{
    auth::{Auth, Principal, Role},
    aws::{
        self, AdoptionConsent, AdoptionRecord, RoleRegistration, TopologyView, VerifiedAccount,
        service::ReadOnlyAws,
    },
    domain::*,
    store::Store,
};
use anyhow::Context;
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};
use ts_rs::TS;
mod nat_cidr;
mod source_cidr;
mod source_target_cidr;
mod target_cidr;

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub auth: Arc<Auth>,
    pub aws: Option<Arc<dyn ReadOnlyAws>>,
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
    pub aws_accounts: Vec<VerifiedAccount>,
    pub aws_read_only_enabled: bool,
    pub aws_regions: Vec<String>,
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
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TgwLookupRequest {
    pub route_table_id: String,
    pub destination: String,
}
#[derive(Serialize, TS)]
pub struct TgwLookupResponse {
    pub topology_id: String,
    pub route_table_id: String,
    pub destination: String,
    pub result: aws::route_lookup::TgwLookupResult,
    pub execution_enabled: bool,
    pub connectivity_tested: bool,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TgwCidrCoverageRequest {
    pub route_table_id: String,
    pub destination_cidr: String,
}
#[derive(Serialize, TS)]
pub struct TgwCidrCoverageResponse {
    pub account_id: String,
    pub topology_id: String,
    pub started_at: String,
    pub completed_at: String,
    pub aws_account_id: String,
    pub region: String,
    pub route_table_id: String,
    pub destination_cidr: String,
    pub complete_for_supported_queries: bool,
    pub limitations: Vec<String>,
    pub request_ids: Vec<String>,
    pub coverage: aws::tgw_cidr_coverage::TgwCidrCoverage,
    pub reference_only: bool,
    pub execution_enabled: bool,
    pub connectivity_tested: bool,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TgwIngressRequest {
    pub ingress_attachment_id: String,
    pub destination: String,
}
#[derive(Serialize, TS)]
pub struct TgwIngressResponse {
    pub topology_id: String,
    pub ingress_attachment_id: String,
    pub destination: String,
    pub result: aws::ingress_lookup::TgwIngressResult,
    pub execution_enabled: bool,
    pub connectivity_tested: bool,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct VpcLookupRequest {
    pub subnet_id: String,
    pub destination: String,
}
#[derive(Serialize, TS)]
pub struct VpcLookupResponse {
    pub topology_id: String,
    pub subnet_id: String,
    pub destination: String,
    pub result: aws::vpc_lookup::VpcSubnetLookupResult,
    pub execution_enabled: bool,
    pub connectivity_tested: bool,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct VpcCidrCoverageRequest {
    pub subnet_id: String,
    pub destination_cidr: String,
}
#[derive(Serialize, TS)]
pub struct VpcCidrCoverageResponse {
    pub account_id: String,
    pub topology_id: String,
    pub completed_at: String,
    pub aws_account_id: String,
    pub region: String,
    pub subnet_id: String,
    pub destination_cidr: String,
    pub complete_for_supported_queries: bool,
    pub limitations: Vec<String>,
    pub request_ids: Vec<String>,
    pub coverage: aws::vpc_cidr_coverage::VpcCidrCoverage,
    pub reference_only: bool,
    pub execution_enabled: bool,
    pub connectivity_tested: bool,
}
#[derive(Serialize, TS)]
pub struct NatReferenceResponse {
    pub account_id: String,
    pub topology_id: String,
    pub completed_at: String,
    pub subnet_id: String,
    pub destination: String,
    pub result: aws::nat_reference::NatReferenceLookup,
    pub reference_only: bool,
    pub execution_enabled: bool,
    pub connectivity_tested: bool,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TgwSourceRequest {
    pub network_account_id: String,
    pub subnet_id: String,
    pub destination: String,
}
#[derive(Serialize, TS)]
pub struct TgwSourceResponse {
    pub source_topology_id: String,
    pub network_topology_id: String,
    pub source_completed_at: String,
    pub network_completed_at: String,
    pub network_account_id: String,
    pub subnet_id: String,
    pub destination: String,
    pub result: aws::source_handoff::SourceHandoffLookup,
    pub execution_enabled: bool,
    pub connectivity_tested: bool,
}
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TgwTargetRequest {
    pub transit_gateway_id: String,
    pub target_attachment_id: String,
    pub destination: String,
}
#[derive(Serialize, TS)]
pub struct TgwTargetResponse {
    pub topology_id: String,
    pub completed_at: String,
    pub transit_gateway_id: String,
    pub target_attachment_id: String,
    pub destination: String,
    pub result: aws::target_lookup::TargetVpcLookup,
    pub az_selection: aws::target_lookup::TargetAzSelection,
    pub execution_enabled: bool,
    pub connectivity_tested: bool,
}
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
        .route("/aws/accounts", get(list_aws).post(register_aws))
        .route("/aws/accounts/{id}/discover", post(discover_aws))
        .route("/aws/accounts/{id}/topology", get(topology_aws))
        .route("/aws/accounts/{id}/tgw-route-lookup", get(lookup_aws_route))
        .route(
            "/aws/accounts/{id}/tgw-cidr-coverage",
            get(coverage_aws_tgw),
        )
        .route(
            "/aws/accounts/{id}/tgw-ingress-lookup",
            get(lookup_aws_ingress),
        )
        .route("/aws/accounts/{id}/adoptions", post(adopt_aws))
        .route("/aws/accounts/{id}/vpc-route-lookup", get(lookup_aws_vpc))
        .route(
            "/aws/accounts/{id}/vpc-cidr-coverage",
            get(coverage_aws_vpc),
        )
        .route(
            "/aws/accounts/{id}/nat-reference-lookup",
            get(lookup_aws_nat_reference),
        )
        .route(
            "/aws/accounts/{id}/tgw-source-lookup",
            get(lookup_aws_source),
        )
        .route(
            "/aws/accounts/{id}/tgw-source-cidr-coverage",
            get(source_cidr::coverage),
        )
        .route(
            "/aws/accounts/{id}/tgw-target-lookup",
            get(lookup_aws_target),
        )
        .route(
            "/aws/accounts/{id}/tgw-target-cidr-coverage",
            get(target_cidr::coverage),
        )
        .route(
            "/aws/accounts/{id}/tgw-source-target-cidr-reference",
            get(source_target_cidr::reference),
        )
        .route(
            "/aws/accounts/{id}/nat-cidr-reference",
            get(nat_cidr::reference),
        )
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
        aws_accounts: s.store.aws_accounts().await?,
        aws_read_only_enabled: s.aws.is_some(),
        aws_regions: s.aws.as_ref().map(|p| p.regions()).unwrap_or_default(),
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
async fn lookup_aws_route(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<TgwLookupRequest>,
) -> Result<Json<TgwLookupResponse>, Failure> {
    if query.route_table_id.len() > 2048 || query.destination.len() > 64 {
        return Err(anyhow::anyhow!("Route lookup input exceeds its bound").into());
    }
    let view = s.store.aws_topology(&id).await?;
    let result =
        aws::route_lookup::lookup(&view.topology, &query.route_table_id, &query.destination);
    Ok(Json(TgwLookupResponse {
        topology_id: view.topology.id,
        route_table_id: query.route_table_id,
        destination: query.destination,
        result,
        execution_enabled: false,
        connectivity_tested: false,
    }))
}
enum TgwCoverageFailure {
    Coverage(aws::tgw_cidr_coverage::TgwCidrCoverageError),
    Store(anyhow::Error),
}
impl IntoResponse for TgwCoverageFailure {
    fn into_response(self) -> Response {
        match self {
            Self::Store(error) => Failure(error).into_response(),
            Self::Coverage(error) => {
                use aws::tgw_cidr_coverage::TgwCidrCoverageError::*;
                let status = match &error {
                    InvalidDestinationCidr | InvalidTableInput => StatusCode::UNPROCESSABLE_ENTITY,
                    InputTooLarge { .. } | BudgetExceeded { .. } => StatusCode::PAYLOAD_TOO_LARGE,
                    PartitionProofUnavailable => StatusCode::CONFLICT,
                };
                (status, Json(error)).into_response()
            }
        }
    }
}
async fn coverage_aws_tgw(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<TgwCidrCoverageRequest>,
) -> Result<Json<TgwCidrCoverageResponse>, TgwCoverageFailure> {
    use aws::tgw_cidr_coverage::{self, TgwCidrCoverageError, TgwCoverageBudget};
    tgw_cidr_coverage::validate_query(&query.route_table_id, &query.destination_cidr)
        .map_err(TgwCoverageFailure::Coverage)?;
    let topology = s
        .store
        .aws_topology(&id)
        .await
        .map_err(TgwCoverageFailure::Store)?
        .topology;
    if topology.account_id != id || topology.execution_enabled || topology.connectivity_tested {
        return Err(TgwCoverageFailure::Coverage(
            TgwCidrCoverageError::PartitionProofUnavailable,
        ));
    }
    let budget = TgwCoverageBudget::default();
    let coverage = tgw_cidr_coverage::analyze(
        &topology,
        &query.route_table_id,
        &query.destination_cidr,
        budget,
    )
    .map_err(TgwCoverageFailure::Coverage)?;
    let response = TgwCidrCoverageResponse {
        account_id: id,
        topology_id: topology.id,
        started_at: topology.started_at,
        completed_at: topology.completed_at,
        aws_account_id: topology.aws_account_id,
        region: topology.region,
        route_table_id: query.route_table_id,
        destination_cidr: query.destination_cidr,
        complete_for_supported_queries: topology.complete_for_supported_queries,
        limitations: topology.limitations,
        request_ids: topology.request_ids,
        coverage,
        reference_only: true,
        execution_enabled: false,
        connectivity_tested: false,
    };
    tgw_cidr_coverage::check_serialized(&response, budget.response_bytes)
        .map_err(TgwCoverageFailure::Coverage)?;
    Ok(Json(response))
}
async fn lookup_aws_ingress(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<TgwIngressRequest>,
) -> Result<Json<TgwIngressResponse>, Failure> {
    if query.ingress_attachment_id.len() > 2048 || query.destination.len() > 64 {
        return Err(anyhow::anyhow!("Ingress lookup input exceeds its bound").into());
    }
    let view = s.store.aws_topology(&id).await?;
    let result = aws::ingress_lookup::lookup(
        &view.topology,
        &query.ingress_attachment_id,
        &query.destination,
    );
    Ok(Json(TgwIngressResponse {
        topology_id: view.topology.id,
        ingress_attachment_id: query.ingress_attachment_id,
        destination: query.destination,
        result,
        execution_enabled: false,
        connectivity_tested: false,
    }))
}
async fn lookup_aws_vpc(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<VpcLookupRequest>,
) -> Result<Json<VpcLookupResponse>, Failure> {
    if query.subnet_id.len() > 2048 || query.destination.len() > 64 {
        return Err(anyhow::anyhow!("VPC lookup input exceeds its bound").into());
    }
    let view = s.store.aws_topology(&id).await?;
    let result = aws::vpc_lookup::lookup(&view.topology, &query.subnet_id, &query.destination);
    Ok(Json(VpcLookupResponse {
        topology_id: view.topology.id,
        subnet_id: query.subnet_id,
        destination: query.destination,
        result,
        execution_enabled: false,
        connectivity_tested: false,
    }))
}
enum CoverageFailure {
    Coverage(aws::vpc_cidr_coverage::VpcCidrCoverageError),
    Store(anyhow::Error),
}
impl IntoResponse for CoverageFailure {
    fn into_response(self) -> Response {
        match self {
            Self::Store(error) => Failure(error).into_response(),
            Self::Coverage(error) => {
                use aws::vpc_cidr_coverage::VpcCidrCoverageError::*;
                let status = match &error {
                    InvalidDestinationCidr | InvalidSubnetInput => StatusCode::UNPROCESSABLE_ENTITY,
                    InputTooLarge { .. } | BudgetExceeded { .. } => StatusCode::PAYLOAD_TOO_LARGE,
                    PartitionProofUnavailable => StatusCode::CONFLICT,
                };
                (status, Json(error)).into_response()
            }
        }
    }
}
async fn coverage_aws_vpc(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<VpcCidrCoverageRequest>,
) -> Result<Json<VpcCidrCoverageResponse>, CoverageFailure> {
    use aws::vpc_cidr_coverage::{self, CoverageBudget, VpcCidrCoverageError};
    vpc_cidr_coverage::validate_query(&query.subnet_id, &query.destination_cidr)
        .map_err(CoverageFailure::Coverage)?;
    let topology = s
        .store
        .aws_topology(&id)
        .await
        .map_err(CoverageFailure::Store)?
        .topology;
    if topology.account_id != id || topology.execution_enabled || topology.connectivity_tested {
        return Err(CoverageFailure::Coverage(
            VpcCidrCoverageError::PartitionProofUnavailable,
        ));
    }
    let budget = CoverageBudget::default();
    let coverage =
        vpc_cidr_coverage::analyze(&topology, &query.subnet_id, &query.destination_cidr, budget)
            .map_err(CoverageFailure::Coverage)?;
    let response = VpcCidrCoverageResponse {
        account_id: id,
        topology_id: topology.id,
        completed_at: topology.completed_at,
        aws_account_id: topology.aws_account_id,
        region: topology.region,
        subnet_id: query.subnet_id,
        destination_cidr: query.destination_cidr,
        complete_for_supported_queries: topology.complete_for_supported_queries,
        limitations: topology.limitations,
        request_ids: topology.request_ids,
        coverage,
        reference_only: true,
        execution_enabled: false,
        connectivity_tested: false,
    };
    vpc_cidr_coverage::check_serialized(&response, budget.response_bytes)
        .map_err(CoverageFailure::Coverage)?;
    Ok(Json(response))
}
async fn lookup_aws_nat_reference(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<VpcLookupRequest>,
) -> Result<Json<NatReferenceResponse>, Failure> {
    if query.subnet_id.len() > 2048 || query.destination.len() > 64 {
        return Err(anyhow::anyhow!("NAT reference input exceeds its bound").into());
    }
    let topology = s.store.aws_topology(&id).await?.topology;
    let result = aws::nat_reference::lookup(&topology, &query.subnet_id, &query.destination);
    Ok(Json(NatReferenceResponse {
        account_id: topology.account_id,
        topology_id: topology.id,
        completed_at: topology.completed_at,
        subnet_id: query.subnet_id,
        destination: query.destination,
        result,
        reference_only: true,
        execution_enabled: false,
        connectivity_tested: false,
    }))
}
async fn lookup_aws_source(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<TgwSourceRequest>,
) -> Result<Json<TgwSourceResponse>, Failure> {
    if query.network_account_id.len() > 2048
        || query.subnet_id.len() > 2048
        || query.destination.len() > 64
    {
        return Err(anyhow::anyhow!("Source handoff input exceeds its bound").into());
    }
    // These are independent saved reads, not a simultaneous cloud snapshot or a probe.
    let source = s.store.aws_topology(&id).await?.topology;
    let network = s
        .store
        .aws_topology(&query.network_account_id)
        .await?
        .topology;
    let result =
        aws::source_handoff::lookup(&source, &network, &query.subnet_id, &query.destination);
    Ok(Json(TgwSourceResponse {
        source_topology_id: source.id,
        network_topology_id: network.id,
        source_completed_at: source.completed_at,
        network_completed_at: network.completed_at,
        network_account_id: query.network_account_id,
        subnet_id: query.subnet_id,
        destination: query.destination,
        result,
        execution_enabled: false,
        connectivity_tested: false,
    }))
}
async fn lookup_aws_target(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<TgwTargetRequest>,
) -> Result<Json<TgwTargetResponse>, Failure> {
    if query.transit_gateway_id.len() > 2048
        || query.target_attachment_id.len() > 2048
        || query.destination.len() > 64
    {
        return Err(anyhow::anyhow!("Target lookup input exceeds its bound").into());
    }
    let topology = s.store.aws_topology(&id).await?.topology;
    let result = aws::target_lookup::lookup(
        &topology,
        &query.transit_gateway_id,
        &query.target_attachment_id,
        &query.destination,
    );
    Ok(Json(TgwTargetResponse {
        topology_id: topology.id,
        completed_at: topology.completed_at,
        transit_gateway_id: query.transit_gateway_id,
        target_attachment_id: query.target_attachment_id,
        destination: query.destination,
        result,
        az_selection: aws::target_lookup::TargetAzSelection::NotInferred,
        execution_enabled: false,
        connectivity_tested: false,
    }))
}
async fn list_aws(State(s): State<AppState>) -> Result<Json<Vec<VerifiedAccount>>, Failure> {
    Ok(Json(s.store.aws_accounts().await?))
}
async fn aws_audit(s: &AppState, actor: &str, event: &str, target: &str) -> anyhow::Result<()> {
    let mut tx = s.store.pool.begin().await?;
    crate::store::audit(&mut tx, actor, event, target).await?;
    tx.commit().await?;
    Ok(())
}
async fn register_aws(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(body): Json<RoleRegistration>,
) -> Result<Json<VerifiedAccount>, Failure> {
    let provider=s.aws.as_ref().context("AWS read-only onboarding is disabled; configure explicit regions and production authentication")?;
    body.validate()?;
    if !provider.regions().contains(&body.region) {
        return Err(Failure(anyhow::anyhow!(
            "AWS region is not enabled by the operator"
        )));
    }
    aws_audit(&s, &p.subject, "aws_verification_started", &body.role_arn).await?;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        provider.verify(&body, &p.subject),
    )
    .await;
    let identity = match result {
        Ok(Ok(identity)) => identity,
        other => {
            aws_audit(&s, &p.subject, "aws_verification_failed", &body.role_arn).await?;
            return Err(Failure(match other {
                Ok(Err(error)) => error,
                _ => anyhow::anyhow!("AWS role verification timed out"),
            }));
        }
    };
    Ok(Json(
        s.store
            .register_aws_verified(
                &p.subject,
                &body,
                &identity.account_id,
                &identity.session_name,
            )
            .await?,
    ))
}
async fn discover_aws(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> Result<Json<aws::observation::AwsTopology>, Failure> {
    let provider = s
        .aws
        .as_ref()
        .context("AWS read-only discovery is disabled")?;
    let (request, account, generation) = s.store.begin_aws_discovery(&p.subject, &id).await?;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        provider.discover(&request, &account, &p.subject),
    )
    .await;
    let topology = match result {
        Ok(Ok(topology)) => topology,
        other => {
            aws_audit(&s, &p.subject, "aws_discovery_failed", &id).await?;
            return Err(Failure(match other {
                Ok(Err(error)) => error,
                _ => anyhow::anyhow!(
                    "AWS discovery timed out; the previous complete observation remains available"
                ),
            }));
        }
    };
    if topology.account_id != id
        || topology.aws_account_id != account.aws_account_id
        || topology.region != account.region
    {
        aws_audit(&s, &p.subject, "aws_discovery_failed", &id).await?;
        return Err(Failure(anyhow::anyhow!(
            "AWS discovery returned a different account or region; prior observation preserved"
        )));
    }
    if let Err(error) = s
        .store
        .finish_aws_discovery(&p.subject, generation, &topology)
        .await
    {
        aws_audit(&s, &p.subject, "aws_discovery_failed", &id).await?;
        return Err(error.into());
    }
    Ok(Json(topology))
}
async fn topology_aws(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<TopologyView>, Failure> {
    Ok(Json(s.store.aws_topology(&id).await?))
}
async fn adopt_aws(
    State(s): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(body): Json<AdoptionConsent>,
) -> Result<Json<AdoptionRecord>, Failure> {
    s.aws
        .as_ref()
        .context("AWS ownership consent is disabled")?;
    Ok(Json(
        s.store.adopt_aws_resource(&p.subject, &id, &body).await?,
    ))
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
