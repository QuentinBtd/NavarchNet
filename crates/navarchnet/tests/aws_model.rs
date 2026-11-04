use navarchnet::aws::RoleRegistration;
fn role(arn: &str) -> RoleRegistration {
    RoleRegistration {
        name: "Network".into(),
        role_arn: arn.into(),
        region: "eu-west-1".into(),
        external_id: Some("navarchnet-test".into()),
    }
}
#[test]
fn validates_exact_role_reference_and_account_without_normalizing_input() {
    let request = role("arn:aws:iam::123456789012:role/team/NetworkReader");
    let parsed = request.validate().unwrap();
    assert_eq!(parsed.account_id, "123456789012");
    assert_eq!(parsed.role_name, "NetworkReader");
    assert!(
        request
            .verify_identity(
                "123456789012",
                "arn:aws:sts::123456789012:assumed-role/NetworkReader/navarchnet-operator"
            )
            .is_ok()
    );
    assert!(
        request
            .verify_identity(
                "999999999999",
                "arn:aws:sts::999999999999:assumed-role/NetworkReader/navarchnet-operator"
            )
            .is_err()
    );
    assert!(
        request
            .verify_identity(
                "123456789012",
                "arn:aws:sts::123456789012:assumed-role/Admin/navarchnet-operator"
            )
            .is_err()
    );
    for invalid in [
        " arn:aws:iam::123456789012:role/Reader",
        "arn:aws:iam::12345678901:role/Reader",
        "arn:aws:iam::123456789012:user/Reader",
        "arn:aws-cn:iam::123456789012:role/Reader",
        "arn:aws:iam::123456789012:role/",
        "arn:aws:iam::123456789012:role/Invalid Role",
    ] {
        assert!(
            role(invalid).validate().is_err(),
            "Accepted invalid role: {invalid}"
        );
    }
}
#[test]
fn rejects_invalid_region_and_external_id_before_sdk_construction() {
    let mut request = role("arn:aws:iam::123456789012:role/Reader");
    request.region = "https://attacker.example".into();
    assert!(request.validate().is_err());
    request.region = "eu-west-1".into();
    request.external_id = Some("bad id".into());
    assert!(request.validate().is_err());
    request.external_id = None;
    assert!(request.validate().is_ok());
}
