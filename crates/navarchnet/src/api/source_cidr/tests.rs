use super::*;
use axum::body::to_bytes;
use serde_json::{Value, json};
#[test]
fn aggregate_allowance_preserves_individual_caps_and_refuses_underflow() {
    let b = SavedObservationReadBudget {
        topology_bytes: 7,
        registration_bytes: 3,
        total_bytes: 10,
    };
    for (charge, left) in [(0, 10), (9, 1), (10, 0)] {
        let next = remaining(b, charge).unwrap_or_else(|_| panic!("Valid remaining allowance"));
        assert_eq!(next.total_bytes, left);
        assert_eq!(next.topology_bytes, 7);
        assert_eq!(next.registration_bytes, 3);
    }
    for charged in [11, usize::MAX] {
        assert!(matches!(
            remaining(b, charged),
            Err(CoverageFailure::Core(
                SourceHandoffCidrError::BudgetExceeded {
                    dimension: "aggregate_read_bytes",
                    limit: 10
                }
            ))
        ));
    }
}
async fn check(error: CoverageFailure, status: StatusCode, expected: Value) {
    let response = error.into_response();
    assert_eq!(response.status(), status);
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), expected);
}
#[tokio::test]
async fn all_known_reader_and_core_errors_keep_fixed_statuses_and_redacted_shapes() {
    use SavedObservationReadError::*;
    for (error, status, label) in [
        (
            InvalidRegistrationInput,
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_saved_registration_input",
        ),
        (
            InvalidBudget,
            StatusCode::INTERNAL_SERVER_ERROR,
            "saved_observation_budget_configuration_invalid",
        ),
        (
            MissingObservation,
            StatusCode::NOT_FOUND,
            "saved_observation_unavailable",
        ),
        (
            BudgetExceeded {
                dimension: "metadata_bytes",
                limit: 8192,
            },
            StatusCode::PAYLOAD_TOO_LARGE,
            "saved_observation_budget_exceeded",
        ),
        (
            MalformedObservation,
            StatusCode::CONFLICT,
            "saved_observation_malformed",
        ),
        (
            IdentityUnavailable,
            StatusCode::CONFLICT,
            "saved_observation_identity_unavailable",
        ),
    ] {
        check(
            CoverageFailure::Store(
                anyhow::Error::new(error).context("fixture-only hidden context"),
            ),
            status,
            json!({"error":label}),
        )
        .await;
    }
    for error in [
        anyhow::anyhow!("fixture-only hidden payload"),
        anyhow::Error::new(sqlx::Error::Protocol("fixture-only SQL detail".into())),
    ] {
        check(
            CoverageFailure::Store(error),
            StatusCode::CONFLICT,
            json!({"error":"saved_observation_read_failed"}),
        )
        .await;
    }
    for (error, status) in [
        (
            SourceHandoffCidrError::InvalidQuery {
                field: "destination_cidr",
            },
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            SourceHandoffCidrError::BudgetExceeded {
                dimension: "response_bytes",
                limit: 1,
            },
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            SourceHandoffCidrError::IdentityUnavailable,
            StatusCode::CONFLICT,
        ),
        (
            SourceHandoffCidrError::PartitionProofUnavailable,
            StatusCode::CONFLICT,
        ),
    ] {
        let expected = serde_json::to_value(&error).unwrap();
        check(CoverageFailure::Core(error), status, expected).await;
    }
}
