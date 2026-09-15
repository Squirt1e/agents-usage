//! Production HTTP transport.
//!
//! Wraps `reqwest` with the read-only rules the collectors rely on:
//!
//! - only `GET` is exposed, and no request body is ever sent;
//! - redirects are followed at most a few times and only **inside the same
//!   host**, so a credential cannot be replayed to another origin;
//! - authentication failures, rate limits and timeouts map onto the shared
//!   error vocabulary instead of a generic transport error.

use std::collections::BTreeMap;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::contracts::ErrorKind;
use crate::http::{CollectorError, HttpGet, HttpResponse, HttpTransport};

/// Maximum redirects followed for one request.
pub const MAX_REDIRECTS: usize = 5;

/// `reqwest`-backed transport.
#[derive(Debug, Clone)]
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    /// Build a transport with a redirect policy that never leaves the origin
    /// host and never downgrades HTTPS to plain HTTP.
    pub fn new(user_agent: &str) -> Result<Self, CollectorError> {
        let client = reqwest::Client::builder()
            .user_agent(user_agent.to_string())
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= MAX_REDIRECTS {
                    return attempt.error("too many redirects");
                }
                let previous = attempt.previous().last().cloned();
                let target = attempt.url().clone();
                let Some(previous) = previous else {
                    return attempt.error("invalid redirect target");
                };
                if previous.scheme() != target.scheme() || previous.host_str() != target.host_str()
                {
                    // Never forward a credential to another host, and never
                    // accept a downgrade from HTTPS.
                    return attempt.error("cross-origin redirect is not allowed");
                }
                attempt.follow()
            }))
            .build()
            .map_err(|error| {
                CollectorError::network(format!("cannot create the HTTP client: {error}"))
            })?;
        Ok(Self { client })
    }

    fn headers(request: &HttpGet) -> Result<HeaderMap, CollectorError> {
        let mut headers = HeaderMap::new();
        for (name, value) in &request.headers {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|error| {
                CollectorError::compatibility(format!("invalid request header name: {error}"))
            })?;
            let value = HeaderValue::from_str(value).map_err(|_| {
                CollectorError::compatibility(format!("invalid request header value for {name}"))
            })?;
            headers.insert(name, value);
        }
        Ok(headers)
    }

    /// Classify a status code into the shared error vocabulary.
    ///
    /// `Ok` means the response is usable (2xx). Non-success statuses become
    /// errors so a collector never parses an error page as data.
    fn classify(status: u16, retry_after_seconds: Option<u64>) -> Result<(), CollectorError> {
        match status {
            200..=299 => Ok(()),
            401 | 403 => Err(CollectorError::authentication(format!(
                "the provider rejected the credential (HTTP {status})"
            ))),
            429 => {
                let mut error =
                    CollectorError::rate_limit("the provider is rate limiting this connection");
                if let Some(seconds) = retry_after_seconds {
                    error = error.with_diagnostic("retryAfterSeconds", seconds.to_string());
                }
                Err(error)
            }
            500..=599 => Err(CollectorError::network(format!(
                "the provider failed with HTTP {status}"
            ))),
            _ => Err(CollectorError::new(
                ErrorKind::Network,
                format!("the request failed with HTTP {status}"),
            )),
        }
    }

    fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
        headers
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
    }
}

impl HttpTransport for ReqwestTransport {
    fn get(
        &self,
        request: HttpGet,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, CollectorError>> + Send + '_>,
    > {
        Box::pin(async move {
            let headers = Self::headers(&request)?;
            let timeout = Duration::from_millis(request.timeout_ms.max(1_000));

            let response = self
                .client
                .get(&request.url)
                .headers(headers)
                .timeout(timeout)
                .send()
                .await
                .map_err(|error| {
                    if error.is_timeout() {
                        CollectorError::network(format!(
                            "request timed out after {} ms",
                            request.timeout_ms
                        ))
                    } else if error.is_redirect() {
                        CollectorError::network("redirect refused to leave the provider origin")
                    } else {
                        CollectorError::network(format!("request failed: {error}"))
                    }
                })?;

            let status = response.status().as_u16();
            let retry_after_seconds = Self::retry_after(response.headers());
            let final_url = Some(response.url().to_string());
            let body = response.text().await.map_err(|error| {
                CollectorError::network(format!("cannot read the response body: {error}"))
            })?;

            Self::classify(status, retry_after_seconds)?;

            Ok(HttpResponse {
                status,
                final_url,
                body,
                retry_after_seconds,
            })
        })
    }
}

/// Convenience constructor for the service binary.
pub fn shared_transport(
    user_agent: &str,
) -> Result<std::sync::Arc<dyn HttpTransport>, CollectorError> {
    Ok(std::sync::Arc::new(ReqwestTransport::new(user_agent)?))
}

/// Headers a collector sends, built here so every provider sends the same shape.
pub fn authorization_header(value: &str) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::new();
    headers.insert("Authorization".to_string(), value.to_string());
    headers.insert("Accept".to_string(), "application/json".to_string());
    headers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_status_codes_into_the_shared_vocabulary() {
        assert!(ReqwestTransport::classify(200, None).is_ok());
        assert_eq!(
            ReqwestTransport::classify(401, None).unwrap_err().kind,
            ErrorKind::Authentication
        );
        assert_eq!(
            ReqwestTransport::classify(403, None).unwrap_err().kind,
            ErrorKind::Authentication
        );
        assert_eq!(
            ReqwestTransport::classify(429, Some(30)).unwrap_err().kind,
            ErrorKind::RateLimit
        );
        assert_eq!(
            ReqwestTransport::classify(503, None).unwrap_err().kind,
            ErrorKind::Network
        );
        assert_eq!(
            ReqwestTransport::classify(404, None).unwrap_err().kind,
            ErrorKind::Network
        );
    }

    #[test]
    fn rate_limit_diagnostics_carry_the_retry_delay() {
        let error = ReqwestTransport::classify(429, Some(42)).unwrap_err();
        assert_eq!(
            error
                .diagnostic
                .get("retryAfterSeconds")
                .map(String::as_str),
            Some("42")
        );
    }

    #[test]
    fn builds_a_client_with_the_origin_pinned_redirect_policy() {
        assert!(ReqwestTransport::new("agents-usage-test").is_ok());
    }
}
