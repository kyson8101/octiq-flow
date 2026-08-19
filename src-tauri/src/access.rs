//! Signing in with Cloudflare Access, so a browser needs no token of ours.
//!
//! Access sits in front of the tunnel and will not pass a request until the
//! person behind it has proved who they are. Every request it does pass carries
//! a JWT it signed, naming them. Verify that and there is nothing left for our
//! own token to add: the gate has already been held.
//!
//! ## Why the signature is the whole point
//!
//! It is tempting to trust the header's presence — Access is in front, so
//! anything with the header came through it. That is false the moment anyone
//! can reach the origin another way, and they can: the server listens on
//! loopback and `cloudflared` connects to it from this same machine, so a
//! forged header from a local process, or from anything on the LAN if the bind
//! address is ever widened, would be indistinguishable from the real thing.
//!
//! So the signature is checked against Cloudflare's published keys, and the
//! `aud` claim against THIS application's tag — a valid token for somebody
//! else's Access application is still somebody else's.
//!
//! ## When it is off
//!
//! Unconfigured, this module says no to everything and the token path is
//! untouched. Turning it on is a deliberate act: two values from the Access
//! dashboard, in web.json.
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// How long Cloudflare's signing keys are held before being fetched again.
/// They rotate, but slowly; this is short enough to follow a rotation and long
/// enough that a burst of requests costs one fetch.
const KEYS_TTL: Duration = Duration::from_secs(60 * 60);

/// The header Access puts on every request it lets through.
pub const ASSERTION_HEADER: &str = "cf-access-jwt-assertion";

/// What the dashboard tells you, and nothing else.
#[derive(Debug, Clone, serde::Serialize, Deserialize, Default, PartialEq)]
pub struct AccessConfig {
    /// `something.cloudflareaccess.com` — the team domain, which is where the
    /// public keys live.
    #[serde(default)]
    pub team_domain: String,
    /// The application's Audience (AUD) tag. Without this a token minted for
    /// any other application on the same team would pass.
    #[serde(default)]
    pub aud: String,
}

impl AccessConfig {
    /// Both halves or nothing: a team domain with no audience would verify the
    /// signature and then accept a token meant for a different application.
    pub fn is_configured(&self) -> bool {
        !self.team_domain.trim().is_empty() && !self.aud.trim().is_empty()
    }

    fn certs_url(&self) -> String {
        format!(
            "https://{}/cdn-cgi/access/certs",
            self.team_domain.trim().trim_start_matches("https://").trim_end_matches('/')
        )
    }

    fn issuer(&self) -> String {
        format!(
            "https://{}",
            self.team_domain.trim().trim_start_matches("https://").trim_end_matches('/')
        )
    }
}

/// One RSA public key as Cloudflare publishes it.
#[derive(Debug, Clone, Deserialize)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

/// Who Access says you are.
#[derive(Debug, Clone, Deserialize)]
pub struct Identity {
    /// The address they signed in with.
    #[serde(default)]
    pub email: String,
}

static KEYS: Mutex<Option<(Instant, Vec<Jwk>)>> = Mutex::new(None);

/// Drop the cached keys. Only used by tests, and after a config change.
pub fn forget_keys() {
    if let Ok(mut guard) = KEYS.lock() {
        *guard = None;
    }
}

fn fetch_keys(cfg: &AccessConfig) -> Result<Vec<Jwk>, String> {
    if let Ok(guard) = KEYS.lock() {
        if let Some((at, keys)) = guard.as_ref() {
            if at.elapsed() < KEYS_TTL {
                return Ok(keys.clone());
            }
        }
    }
    let body: Jwks = ureq::get(&cfg.certs_url())
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|e| format!("could not fetch Access keys: {e}"))?
        .into_json()
        .map_err(|e| format!("Access keys were not the shape we expect: {e}"))?;
    if body.keys.is_empty() {
        return Err("Access published no keys".into());
    }
    if let Ok(mut guard) = KEYS.lock() {
        *guard = Some((Instant::now(), body.keys.clone()));
    }
    Ok(body.keys)
}

/// Check one assertion. `Ok` names the person; `Err` says why not, for a log
/// rather than for them.
pub fn verify(cfg: &AccessConfig, token: &str) -> Result<Identity, String> {
    if !cfg.is_configured() {
        return Err("Access is not configured".into());
    }
    let header = jsonwebtoken::decode_header(token).map_err(|e| format!("bad token: {e}"))?;
    let kid = header.kid.ok_or("token names no key")?;

    let keys = fetch_keys(cfg)?;
    let jwk = keys
        .iter()
        .find(|k| k.kid == kid)
        .ok_or("token was signed with a key Access does not publish")?;

    let key = jsonwebtoken::DecodingKey::from_rsa_components(&jwk.n, &jwk.e)
        .map_err(|e| format!("unusable key: {e}"))?;

    // RS256 is what Access signs with; naming it stops a token that asks to be
    // verified with a weaker algorithm — or with `none` — from being taken at
    // its word.
    let mut rules = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    rules.set_audience(&[cfg.aud.trim()]);
    rules.set_issuer(&[cfg.issuer()]);
    // Expiry is checked by default; say so rather than relying on it.
    rules.validate_exp = true;

    jsonwebtoken::decode::<Identity>(token, &key, &rules)
        .map(|data| data.claims)
        .map_err(|e| format!("token rejected: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_a_configuration_is_not_a_configuration() {
        // A team domain with no audience would verify the signature and then
        // accept a token minted for someone else's application on the same team.
        assert!(!AccessConfig::default().is_configured());
        assert!(!AccessConfig {
            team_domain: "acme.cloudflareaccess.com".into(),
            aud: "".into(),
        }
        .is_configured());
        assert!(!AccessConfig {
            team_domain: "".into(),
            aud: "abc123".into(),
        }
        .is_configured());
        assert!(AccessConfig {
            team_domain: "acme.cloudflareaccess.com".into(),
            aud: "abc123".into(),
        }
        .is_configured());
    }

    #[test]
    fn urls_are_built_from_the_team_domain_however_it_was_typed() {
        let bare = AccessConfig {
            team_domain: "acme.cloudflareaccess.com".into(),
            aud: "x".into(),
        };
        let pasted = AccessConfig {
            team_domain: "https://acme.cloudflareaccess.com/".into(),
            aud: "x".into(),
        };
        assert_eq!(bare.certs_url(), pasted.certs_url());
        assert_eq!(bare.issuer(), pasted.issuer());
        assert_eq!(
            bare.certs_url(),
            "https://acme.cloudflareaccess.com/cdn-cgi/access/certs"
        );
        assert_eq!(bare.issuer(), "https://acme.cloudflareaccess.com");
    }

    #[test]
    fn an_unconfigured_gate_refuses_rather_than_waves_through() {
        let err = verify(&AccessConfig::default(), "anything").unwrap_err();
        assert!(err.contains("not configured"), "{err}");
    }

    #[test]
    fn a_token_that_is_not_a_token_is_refused() {
        let cfg = AccessConfig {
            team_domain: "acme.cloudflareaccess.com".into(),
            aud: "x".into(),
        };
        // No network is reached: this fails at the shape, before any fetch.
        assert!(verify(&cfg, "not-a-jwt").is_err());
    }
}
