use super::*;
use axum::body::to_bytes;

#[tokio::test]
async fn nested_core_errors_keep_status_shape_and_reader_errors_stay_redacted() {
    let cases = [
        (
            NatCidrReferenceError::Admission {
                cause: SourceHandoffCidrError::InvalidQuery {
                    field: "account_id",
                },
            },
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            NatCidrReferenceError::Admission {
                cause: SourceHandoffCidrError::BudgetExceeded {
                    dimension: "work_units",
                    limit: 1,
                },
            },
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            NatCidrReferenceError::Admission {
                cause: SourceHandoffCidrError::IdentityUnavailable,
            },
            StatusCode::CONFLICT,
        ),
        (
            NatCidrReferenceError::Admission {
                cause: SourceHandoffCidrError::PartitionProofUnavailable,
            },
            StatusCode::CONFLICT,
        ),
        (
            NatCidrReferenceError::VpcCoverage {
                cause: VpcCidrCoverageError::InvalidDestinationCidr,
            },
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            NatCidrReferenceError::VpcCoverage {
                cause: VpcCidrCoverageError::InvalidSubnetInput,
            },
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            NatCidrReferenceError::VpcCoverage {
                cause: VpcCidrCoverageError::InputTooLarge {
                    field: "subnet_id".into(),
                    limit: 2048,
                },
            },
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            NatCidrReferenceError::VpcCoverage {
                cause: VpcCidrCoverageError::BudgetExceeded {
                    dimension: "response_bytes".into(),
                    limit: 1,
                },
            },
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            NatCidrReferenceError::VpcCoverage {
                cause: VpcCidrCoverageError::PartitionProofUnavailable,
            },
            StatusCode::CONFLICT,
        ),
    ];
    for (error, expected_status) in cases {
        let expected = serde_json::to_value(&error).unwrap();
        let response = ReferenceFailure::Core(error).into_response();
        assert_eq!(response.status(), expected_status);
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            expected
        );
    }
    let response =
        ReferenceFailure::Store(anyhow::anyhow!("private context must not escape")).into_response();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        serde_json::json!({"error":"saved_observation_read_failed"})
    );
}
