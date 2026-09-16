/// Map transport errors to user-safe messages. Never expose provider URLs,
/// filesystem paths, credentials, or raw response details to the UI.
pub fn sanitize_ai_error(err: &str) -> String {
    let e = err.to_lowercase();
    if e.contains("dns")
        || e.contains("resolve")
        || e.contains("connection")
        || e.contains("refused")
        || e.contains("connect")
    {
        "Could not reach the AI provider — check your connection".into()
    } else if e.contains("timeout") || e.contains("timed out") {
        "The AI provider timed out".into()
    } else if e.contains("tls") || e.contains("ssl") || e.contains("certificate") {
        "Secure connection to the AI provider failed".into()
    } else if e.contains("body") || e.contains("json") || e.contains("parse") {
        "The AI provider returned an unreadable response".into()
    } else {
        "AI request failed".into()
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_ai_error;

    #[test]
    fn ai_error_contract_is_user_safe() {
        assert!(!sanitize_ai_error("error sending request for url (https://internal.corp:8080/chat/completions): connection refused").contains("internal.corp"));
        assert!(sanitize_ai_error("connection refused").contains("Could not reach"));
        assert!(sanitize_ai_error("operation timed out after 120s").contains("timed out"));
        assert!(sanitize_ai_error("TLS handshake failed").contains("Secure connection"));
        assert!(!sanitize_ai_error("random error xyz").contains("random error"));
        assert!(sanitize_ai_error("random error xyz").contains("AI request failed"));
    }
}
