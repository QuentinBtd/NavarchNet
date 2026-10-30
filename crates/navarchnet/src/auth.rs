use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Role {
    Admin,
    ReadOnly,
}
#[derive(Debug, Clone)]
pub struct Principal {
    pub subject: String,
    pub role: Role,
}
#[derive(Clone)]
pub enum Auth {
    Demo {
        admin: String,
        reader: String,
    },
    Oidc {
        key: Arc<DecodingKey>,
        issuer: String,
        audience: String,
    },
}
#[derive(Debug, Deserialize, Clone)]
struct Claims {
    sub: String,
    roles: Vec<String>,
}

impl Auth {
    pub fn demo(admin: String, reader: String) -> anyhow::Result<Self> {
        anyhow::ensure!(
            admin.len() >= 32 && reader.len() >= 32 && admin != reader,
            "Demo tokens must be different and contain at least 32 bytes"
        );
        Ok(Self::Demo { admin, reader })
    }
    pub fn oidc(pem: &[u8], issuer: String, audience: String) -> anyhow::Result<Self> {
        anyhow::ensure!(
            issuer.starts_with("https://") && !audience.is_empty(),
            "OIDC requires an HTTPS issuer and nonempty audience"
        );
        Ok(Self::Oidc {
            key: Arc::new(DecodingKey::from_rsa_pem(pem)?),
            issuer,
            audience,
        })
    }
    pub fn authenticate(&self, token: &str) -> anyhow::Result<Principal> {
        anyhow::ensure!(token.len() <= 16384, "Invalid token");
        match self {
            Self::Demo { admin, reader } => {
                // Tokens are high-entropy local-only secrets; use digest equality to avoid prefix timing leaks.
                use sha2::{Digest, Sha256};
                use std::hint::black_box;
                let matches = |expected: &str| {
                    let a = Sha256::digest(token.as_bytes());
                    let b = Sha256::digest(expected.as_bytes());
                    black_box(
                        a.iter()
                            .zip(b.iter())
                            .fold(0u8, |acc, (a, b)| acc | (a ^ b)),
                    ) == 0
                };
                if matches(admin) {
                    Ok(Principal {
                        subject: "demo-admin".into(),
                        role: Role::Admin,
                    })
                } else if matches(reader) {
                    Ok(Principal {
                        subject: "demo-reader".into(),
                        role: Role::ReadOnly,
                    })
                } else {
                    anyhow::bail!("Invalid token")
                }
            }
            Self::Oidc {
                key,
                issuer,
                audience,
            } => {
                let header = decode_header(token)?;
                anyhow::ensure!(
                    header.alg == Algorithm::RS256,
                    "Unsupported signing algorithm"
                );
                let mut validation = Validation::new(Algorithm::RS256);
                validation.set_issuer(&[issuer]);
                validation.set_audience(&[audience]);
                validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
                validation.validate_nbf = true;
                validation.leeway = 30;
                let claims = decode::<Claims>(token, key, &validation)?.claims;
                anyhow::ensure!(
                    !claims.sub.is_empty() && claims.sub.len() <= 256,
                    "Invalid subject"
                );
                let role = if claims.roles.iter().any(|r| r == "navarchnet-admin") {
                    Role::Admin
                } else if claims.roles.iter().any(|r| r == "navarchnet-read-only") {
                    Role::ReadOnly
                } else {
                    anyhow::bail!("Required application role missing")
                };
                Ok(Principal {
                    subject: claims.sub,
                    role,
                })
            }
        }
    }
    pub fn is_demo(&self) -> bool {
        matches!(self, Self::Demo { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn demo_auth_is_explicit_and_does_not_escalate() {
        assert!(Auth::demo("short".into(), "short".into()).is_err());
        let auth = Auth::demo("a".repeat(32), "r".repeat(32)).unwrap();
        assert_eq!(
            auth.authenticate(&"r".repeat(32)).unwrap().role,
            Role::ReadOnly
        );
        assert!(auth.authenticate("").is_err());
        assert!(auth.authenticate(&"a".repeat(31)).is_err());
    }
}
