//! `web_search` adapters: Tavily (BYOK) and a self-hosted SearXNG instance.

use futures_util::StreamExt;
use reqwest::header::HeaderMap;
use reqwest::{Response, StatusCode};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::watch;

use super::{cancelled_error, SearchProvider, ToolError, MAX_RESULTS_LIMIT};

/// Fixed Tavily endpoint: the API key is never sent anywhere else.
const TAVILY_SEARCH_URL: &str = "https://api.tavily.com/search";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// SearXNG fans out to engines with up to 10 s each, so allow a little more.
const SEARCH_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_QUERY_CHARS: usize = 400;
/// Snippets are trimmed so a handful of results stays well inside one page.
const MAX_SNIPPET_CHARS: usize = 1_200;
const MAX_TITLE_CHARS: usize = 300;
/// Responses larger than this are rejected instead of parsed.
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// Tavily's plan and pay-as-you-go limit statuses.
const TAVILY_PLAN_LIMIT: u16 = 432;
const TAVILY_PAYG_LIMIT: u16 = 433;

/// Validated `web_search` arguments.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchRequest {
    pub query: String,
    pub max_results: usize,
    pub time_range: Option<&'static str>,
}

impl SearchRequest {
    /// Validate the model's arguments against the configured result cap.
    pub fn from_input(input: &Value, configured_max: usize) -> Result<Self, ToolError> {
        let query = input
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|query| !query.is_empty())
            .ok_or_else(|| ToolError::invalid_input("query is required"))?;
        if query.chars().count() > MAX_QUERY_CHARS {
            return Err(ToolError::invalid_input("query is longer than 400 characters"));
        }
        let cap = configured_max.clamp(1, MAX_RESULTS_LIMIT);
        let max_results = match input.get("max_results") {
            None | Some(Value::Null) => cap,
            Some(value) => value
                .as_u64()
                .and_then(|count| usize::try_from(count).ok())
                .filter(|count| *count >= 1)
                .ok_or_else(|| ToolError::invalid_input("max_results must be a positive integer"))?
                .min(cap),
        };
        let time_range = match input.get("time_range").and_then(Value::as_str) {
            None => None,
            Some("day") => Some("day"),
            Some("week") => Some("week"),
            Some("month") => Some("month"),
            Some("year") => Some("year"),
            Some(_) => return Err(ToolError::invalid_input("time_range must be day, week, month or year")),
        };
        Ok(Self { query: query.to_string(), max_results, time_range })
    }
}

/// One normalised search result.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
}

/// Run a search on the configured provider.
pub async fn search(
    provider: &SearchProvider,
    request: &SearchRequest,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<Vec<SearchHit>, ToolError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(SEARCH_TIMEOUT)
        .build()
        .map_err(|_| ToolError::unavailable("could not create the HTTP client"))?;
    let call = match provider {
        SearchProvider::Off => return Err(ToolError::unavailable("web search is off")),
        SearchProvider::Tavily { api_key } => client
            .post(TAVILY_SEARCH_URL)
            .bearer_auth(api_key)
            .json(&tavily_body(request)),
        SearchProvider::Searxng { base_url } => {
            let mut url = searxng_url(base_url)?;
            url.query_pairs_mut().extend_pairs(searxng_query(request));
            client.get(url)
        }
    };
    let response = tokio::select! {
        response = call.send() => response.map_err(|error| {
            if error.is_timeout() {
                ToolError::unavailable("the search provider timed out")
            } else {
                ToolError::unavailable("the search provider could not be reached")
            }
        })?,
        _ = cancelled.changed() => return Err(cancelled_error()),
    };
    let body = tokio::select! {
        body = read_json(response, provider) => body?,
        _ = cancelled.changed() => return Err(cancelled_error()),
    };
    let hits = match provider {
        SearchProvider::Tavily { .. } => parse_results(&body, "content", "published_date"),
        _ => parse_results(&body, "content", "publishedDate"),
    };
    Ok(hits.into_iter().take(request.max_results).collect())
}

/// Tavily request body: basic depth (1 credit), snippets only.
fn tavily_body(request: &SearchRequest) -> Value {
    let mut body = json!({
        "query": request.query,
        "max_results": request.max_results,
        "search_depth": "basic",
        "topic": "general",
        "include_answer": false,
        "include_raw_content": false,
        "include_images": false,
    });
    if let Some(range) = request.time_range {
        body["time_range"] = json!(range);
    }
    body
}

/// SearXNG `/search` endpoint under the configured base URL.
fn searxng_url(base_url: &str) -> Result<reqwest::Url, ToolError> {
    let mut url = reqwest::Url::parse(base_url)
        .map_err(|_| ToolError::unavailable("the SearXNG URL in Settings is invalid"))?;
    let path = format!("{}/search", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

/// SearXNG query parameters (JSON output, moderate safe search).
fn searxng_query(request: &SearchRequest) -> Vec<(&'static str, String)> {
    let mut query = vec![
        ("q", request.query.clone()),
        ("format", "json".to_string()),
        ("safesearch", "1".to_string()),
    ];
    // SearXNG documents day/month/year; a week window is widened to a month.
    if let Some(range) = request.time_range {
        query.push(("time_range", if range == "week" { "month" } else { range }.to_string()));
    }
    query
}

/// Map provider statuses to tool errors and parse a bounded JSON body.
async fn read_json(response: Response, provider: &SearchProvider) -> Result<Value, ToolError> {
    let status = response.status();
    if !status.is_success() {
        return Err(status_error(status, response.headers(), provider));
    }
    if response.content_length().is_some_and(|length| length > MAX_RESPONSE_BYTES as u64) {
        return Err(ToolError::unavailable("the search response is too large"));
    }
    // Stream with a cap: a chunked body has no Content-Length to check up front.
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ToolError::unavailable("the search response could not be read"))?;
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(ToolError::unavailable("the search response is too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ToolError::unavailable("the search provider returned malformed JSON"))
}

/// Translate an HTTP error status into a stable tool error.
fn status_error(status: StatusCode, headers: &HeaderMap, provider: &SearchProvider) -> ToolError {
    let searxng = matches!(provider, SearchProvider::Searxng { .. });
    match status.as_u16() {
        401 => ToolError::unauthorized("the search API key was rejected; update it in Settings"),
        403 if searxng => ToolError::unavailable("SearXNG refused JSON output; add `json` to search.formats in settings.yml"),
        403 => ToolError::unauthorized("the search API key is not allowed to search"),
        429 => {
            let retry = headers
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .map(|value| format!("; retry after {value} s"))
                .unwrap_or_default();
            ToolError::rate_limited(format!("the search provider is rate limiting{retry}"))
        }
        TAVILY_PLAN_LIMIT | TAVILY_PAYG_LIMIT if !searxng => {
            ToolError::quota_exceeded("the Tavily plan's credit limit is reached")
        }
        400 | 422 => ToolError::invalid_input("the search provider rejected the query"),
        _ => ToolError::unavailable(format!("the search provider answered HTTP {}", status.as_u16())),
    }
}

/// Read `results[]` into hits, dropping entries without an http(s) URL.
fn parse_results(body: &Value, snippet_field: &str, date_field: &str) -> Vec<SearchHit> {
    body.get("results")
        .and_then(Value::as_array)
        .map(|results| {
            results
                .iter()
                .filter_map(|result| {
                    let url = result.get("url").and_then(Value::as_str)?;
                    super::ledger::normalize(url)?;
                    Some(SearchHit {
                        title: truncate(result.get("title").and_then(Value::as_str).unwrap_or(url), MAX_TITLE_CHARS),
                        url: url.to_string(),
                        snippet: truncate(result.get(snippet_field).and_then(Value::as_str).unwrap_or_default(), MAX_SNIPPET_CHARS),
                        published: result.get(date_field).and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Cut text to at most `limit` characters, marking the cut.
fn truncate(text: &str, limit: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(limit) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_validation_caps_and_rejects() {
        let request = SearchRequest::from_input(&json!({"query": "  rust ssrf  ", "max_results": 50, "time_range": "week"}), 5).unwrap();
        assert_eq!(request, SearchRequest { query: "rust ssrf".into(), max_results: 5, time_range: Some("week") });
        assert_eq!(SearchRequest::from_input(&json!({"query": "x"}), 3).unwrap().max_results, 3);
        for bad in [json!({}), json!({"query": "   "}), json!({"query": "x", "max_results": 0}), json!({"query": "x", "time_range": "decade"}), json!({"query": "q".repeat(401)})] {
            assert_eq!(SearchRequest::from_input(&bad, 5).unwrap_err().code, "invalid_input", "{bad}");
        }
    }

    #[test]
    fn tavily_body_uses_basic_depth_and_optional_range() {
        let request = SearchRequest { query: "q".into(), max_results: 3, time_range: None };
        let body = tavily_body(&request);
        assert_eq!(body["search_depth"], "basic");
        assert_eq!(body["max_results"], 3);
        assert!(body.get("time_range").is_none());
    }

    #[test]
    fn searxng_url_and_query_are_built_under_the_base_path() {
        assert_eq!(searxng_url("http://searxng:8080").unwrap().as_str(), "http://searxng:8080/search");
        assert_eq!(searxng_url("https://example.org/sx/").unwrap().as_str(), "https://example.org/sx/search");
        let query = searxng_query(&SearchRequest { query: "q".into(), max_results: 5, time_range: Some("week") });
        assert!(query.contains(&("format", "json".into())));
        assert!(query.contains(&("time_range", "month".into())));
    }

    #[test]
    fn provider_statuses_map_to_stable_codes() {
        let tavily = SearchProvider::Tavily { api_key: "k".into() };
        let searxng = SearchProvider::Searxng { base_url: "http://searxng:8080".into() };
        let mut retry = HeaderMap::new();
        retry.insert(reqwest::header::RETRY_AFTER, "30".parse().unwrap());
        let code = |status: u16, headers: &HeaderMap, provider: &SearchProvider| {
            status_error(StatusCode::from_u16(status).unwrap(), headers, provider)
        };
        let none = HeaderMap::new();
        assert_eq!(code(401, &none, &tavily).code, "unauthorized");
        assert_eq!(code(432, &none, &tavily).code, "quota_exceeded");
        assert_eq!(code(433, &none, &tavily).code, "quota_exceeded");
        assert_eq!(code(422, &none, &tavily).code, "invalid_input");
        assert_eq!(code(500, &none, &tavily).code, "unavailable");
        let limited = code(429, &retry, &tavily);
        assert_eq!(limited.code, "rate_limited");
        assert!(limited.message.contains("retry after 30 s"));
        let refused = code(403, &none, &searxng);
        assert_eq!(refused.code, "unavailable");
        assert!(refused.message.contains("search.formats"));
        assert_eq!(code(432, &none, &searxng).code, "unavailable");
    }

    /// One-shot HTTP server answering with `status` and a JSON `body`; returns
    /// its base URL and a channel carrying the raw request head.
    async fn mock_searxng(status: &'static str, body: String) -> (String, tokio::sync::oneshot::Receiver<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (sent, head) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 2048];
            let read = socket.read(&mut buffer).await.unwrap_or(0);
            let _ = sent.send(String::from_utf8_lossy(&buffer[..read]).into_owned());
            let reply = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(reply.as_bytes()).await;
        });
        (format!("http://{addr}"), head)
    }

    #[tokio::test]
    async fn searxng_search_queries_json_and_trims_to_the_requested_count() {
        let body = json!({"results": [
            {"title": "One", "url": "https://one.example/", "content": "first", "publishedDate": "2026-10-01"},
            {"title": "Two", "url": "https://two.example/", "content": "second"},
            {"title": "Three", "url": "https://three.example/", "content": "third"}
        ]})
        .to_string();
        let (base_url, head) = mock_searxng("200 OK", body).await;
        let (_cancel, mut cancelled) = watch::channel(false);
        let request = SearchRequest { query: "docubook editor".into(), max_results: 2, time_range: Some("day") };
        let hits = search(&SearchProvider::Searxng { base_url }, &request, &mut cancelled).await.unwrap();
        assert_eq!(hits.iter().map(|hit| hit.title.as_str()).collect::<Vec<_>>(), ["One", "Two"]);
        assert_eq!(hits[0].published.as_deref(), Some("2026-10-01"));
        let head = head.await.unwrap();
        assert!(head.starts_with("GET /search?q=docubook+editor&format=json&safesearch=1&time_range=day "), "{head}");
    }

    #[tokio::test]
    async fn searxng_without_json_output_explains_the_fix() {
        let (base_url, _head) = mock_searxng("403 Forbidden", "{}".into()).await;
        let (_cancel, mut cancelled) = watch::channel(false);
        let request = SearchRequest { query: "q".into(), max_results: 1, time_range: None };
        let error = search(&SearchProvider::Searxng { base_url }, &request, &mut cancelled).await.unwrap_err();
        assert!(error.message.contains("search.formats"), "{error:?}");
    }

    #[tokio::test]
    async fn an_unbounded_body_without_content_length_is_refused() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 2048];
            let _ = socket.read(&mut buffer).await;
            // No Content-Length: the body runs until the connection closes.
            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n").await;
            // Endless body: only a client that stops at the cap ever finishes.
            let chunk = vec![b' '; 64 * 1024];
            while socket.write_all(&chunk).await.is_ok() {}
        });
        let (_cancel, mut cancelled) = watch::channel(false);
        let request = SearchRequest { query: "q".into(), max_results: 1, time_range: None };
        let error = search(&SearchProvider::Searxng { base_url: format!("http://{addr}") }, &request, &mut cancelled).await.unwrap_err();
        assert_eq!(error.message, "the search response is too large");
    }

    #[test]
    fn results_are_normalised_and_non_http_urls_dropped() {
        let body = json!({"results": [
            {"title": "A", "url": "https://a.example/x", "content": "alpha", "published_date": "2026-01-02"},
            {"title": "B", "url": "javascript:alert(1)", "content": "bad"},
            {"url": "https://c.example/", "content": "x".repeat(MAX_SNIPPET_CHARS + 10)}
        ]});
        let hits = parse_results(&body, "content", "published_date");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].published.as_deref(), Some("2026-01-02"));
        assert_eq!(hits[1].title, "https://c.example/");
        assert!(hits[1].snippet.ends_with('…'));
    }
}
