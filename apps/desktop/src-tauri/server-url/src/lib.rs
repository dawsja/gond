//! Gond serves the web app and /api from one origin, so the path is dropped.
//! Without a scheme, https is tried first, except for this machine and
//! private networks, where a plain-http install is the norm.

use regex::Regex;
use std::sync::OnceLock;
use url::Url;

fn local_host() -> &'static Regex {
    static LOCAL_HOST: OnceLock<Regex> = OnceLock::new();
    LOCAL_HOST.get_or_init(|| {
        Regex::new(
            r"(?i)^(localhost|127(\.\d{1,3}){3}|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|[^.]+\.local|[^.]+)$",
        )
        .expect("LOCAL_HOST is a valid pattern")
    })
}

fn has_scheme() -> &'static Regex {
    static HAS_SCHEME: OnceLock<Regex> = OnceLock::new();
    HAS_SCHEME.get_or_init(|| {
        Regex::new(r"(?i)^[a-z][a-z\d+.-]*://").expect("HAS_SCHEME is a valid pattern")
    })
}

pub fn server_candidates(input: &str) -> Result<Vec<String>, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("Enter the address of your Gond.".to_string());
    }
    let urls: Vec<String> = if has_scheme().is_match(raw) {
        vec![raw.to_string()]
    } else {
        let host = raw.split(['/', ':', '?', '#']).next().unwrap_or("");
        if local_host().is_match(host) {
            vec![format!("http://{raw}"), format!("https://{raw}")]
        } else {
            vec![format!("https://{raw}"), format!("http://{raw}")]
        }
    };
    urls.iter()
        .map(|value| {
            let url = Url::parse(value).map_err(|_| {
                "That doesn't look like an address. Try something like https://gond.example.com.".to_string()
            })?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err("The address has to start with http:// or https://.".to_string());
            }
            if !url.username().is_empty() || url.password().is_some() {
                return Err("Leave the username and password out of the address.".to_string());
            }
            Ok(url.origin().ascii_serialization())
        })
        .collect()
}

pub fn same_origin(url: &str, origin: &str) -> bool {
    Url::parse(url)
        .map(|url| url.origin().ascii_serialization() == origin)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_full_address_and_drops_its_path() {
        assert_eq!(
            server_candidates(" https://gond.example.com/login?next=/app ").unwrap(),
            vec!["https://gond.example.com"]
        );
        assert_eq!(
            server_candidates("http://192.168.1.20:3000/").unwrap(),
            vec!["http://192.168.1.20:3000"]
        );
    }

    #[test]
    fn tries_https_first_for_public_names() {
        assert_eq!(
            server_candidates("gond.example.com").unwrap(),
            vec!["https://gond.example.com", "http://gond.example.com"]
        );
    }

    #[test]
    fn tries_http_first_for_this_machine_and_private_networks() {
        assert_eq!(
            server_candidates("localhost:3000").unwrap(),
            vec!["http://localhost:3000", "https://localhost:3000"]
        );
        assert_eq!(
            server_candidates("10.0.0.5:3000").unwrap(),
            vec!["http://10.0.0.5:3000", "https://10.0.0.5:3000"]
        );
        assert_eq!(
            server_candidates("nas.local").unwrap(),
            vec!["http://nas.local", "https://nas.local"]
        );
    }

    #[test]
    fn refuses_what_is_not_a_web_address() {
        assert!(server_candidates("")
            .unwrap_err()
            .contains("Enter the address"));
        assert!(server_candidates("file:///etc/passwd")
            .unwrap_err()
            .contains("http:// or https://"));
        assert!(server_candidates("https://me:pw@gond.example.com")
            .unwrap_err()
            .contains("username and password"));
        assert!(server_candidates("https://")
            .unwrap_err()
            .contains("doesn't look like an address"));
    }

    #[test]
    fn matches_origins_exactly() {
        assert!(same_origin(
            "https://gond.example.com/app/t/1",
            "https://gond.example.com"
        ));
        assert!(!same_origin(
            "https://gond.example.com.evil.test/",
            "https://gond.example.com"
        ));
        assert!(!same_origin(
            "http://gond.example.com/",
            "https://gond.example.com"
        ));
        assert!(!same_origin("not a url", "https://gond.example.com"));
    }
}
