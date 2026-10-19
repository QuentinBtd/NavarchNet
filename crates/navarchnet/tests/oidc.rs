use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use navarchnet::auth::{Auth, Role};
use rsa::{
    RsaPrivateKey, RsaPublicKey,
    pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding},
};
use serde_json::{Value, json};

#[test]
fn oidc_validates_signatures_claims_time_and_application_roles() -> anyhow::Result<()> {
    // Ephemeral keys; no committed private fixtures and no identity-provider calls.
    let private = RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048)?;
    let public = RsaPublicKey::from(&private).to_public_key_pem(LineEnding::LF)?;
    let signing = EncodingKey::from_rsa_pem(private.to_pkcs8_pem(LineEnding::LF)?.as_bytes())?;
    let auth = Auth::oidc(
        public.as_bytes(),
        "https://issuer.example".into(),
        "navarchnet".into(),
    )?;
    let now = jsonwebtoken::get_current_timestamp();
    let claims = json!({"sub":"operator","iss":"https://issuer.example","aud":"navarchnet","exp":now+3600,"nbf":now-1,"roles":["navarchnet-admin"]});
    let signed = |claims: &Value| encode(&Header::new(Algorithm::RS256), claims, &signing).unwrap();
    assert_eq!(auth.authenticate(&signed(&claims))?.role, Role::Admin);
    let mut read_only = claims.clone();
    read_only["roles"] = json!(["navarchnet-read-only"]);
    assert_eq!(auth.authenticate(&signed(&read_only))?.role, Role::ReadOnly);
    for (field, value) in [
        ("iss", json!("https://attacker.example")),
        ("aud", json!("another-app")),
        ("exp", json!(now - 120)),
        ("nbf", json!(now + 120)),
        ("sub", json!("")),
        ("roles", json!(["administrator"])),
        ("roles", json!("navarchnet-admin")),
    ] {
        let mut invalid = claims.clone();
        invalid[field] = value;
        assert!(
            auth.authenticate(&signed(&invalid)).is_err(),
            "Accepted invalid {field}"
        );
    }
    for field in ["sub", "iss", "aud", "exp", "roles"] {
        let mut invalid = claims.clone();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(
            auth.authenticate(&signed(&invalid)).is_err(),
            "Accepted missing {field}"
        );
    }
    let hmac = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(b"not-an-rsa-key"),
    )?;
    assert!(auth.authenticate(&hmac).is_err());
    let mut tampered = signed(&claims).into_bytes();
    let start = tampered.iter().rposition(|b| *b == b'.').unwrap() + 1;
    tampered[start] = if tampered[start] == b'A' { b'B' } else { b'A' };
    assert!(auth.authenticate(std::str::from_utf8(&tampered)?).is_err());
    Ok(())
}
