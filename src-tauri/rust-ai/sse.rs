use super::error::sanitize_ai_error;
use super::events::{
    AiEvent, StreamSummary, ToolCall, AI_MAX_SECONDS, MAX_AI_BUFFER, MAX_TOOL_ARGS_SIZE,
    MAX_TOOL_CALLS_PER_REQUEST,
};
use reqwest::Response;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub type EventSender = mpsc::Sender<Result<AiEvent, String>>;

pub async fn stream_chat(
    response: Response,
    provider: String,
    model: String,
    cancel: Arc<AtomicBool>,
    started: Instant,
    tx: EventSender,
) {
    let status = response.status();
    if !status.is_success() {
        let body_bytes = response.bytes().await.map(|body| body.len()).unwrap_or(0);
        tracing::warn!(
            event = "ai_request_failure",
            provider = %provider,
            model = %model,
            status = status.as_u16(),
            duration_ms = started.elapsed().as_millis() as u64,
            body_bytes,
            error_category = "provider_http"
        );
        send_error(&tx, format!("AI provider error (HTTP {status})")).await;
        return;
    }

    let mut stream = response;
    let first = match tokio::time::timeout(Duration::from_secs(30), stream.chunk()).await {
        Ok(Ok(Some(chunk))) => chunk,
        Ok(Ok(None)) => {
            send_error(&tx, "AI provider returned an empty response").await;
            return;
        }
        Ok(Err(error)) => {
            send_error(&tx, sanitize_ai_error(&error.to_string())).await;
            return;
        }
        Err(_) => {
            tracing::warn!(
                event = "ai_request_failure",
                provider = %provider,
                model = %model,
                status = status.as_u16(),
                duration_ms = started.elapsed().as_millis() as u64,
                body_bytes = 0_u64,
                error_category = "first_chunk_timeout"
            );
            send_error(&tx, "AI provider did not respond — try again").await;
            return;
        }
    };

    let mut summary = StreamSummary {
        provider: provider.clone(),
        text: String::new(),
        tool_calls: Vec::new(),
        truncated: false,
        generating_sent: false,
    };
    let mut byte_buf = Vec::new();
    let mut first_chunk = Some(first);
    let mut cancelled = false;

    loop {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        if started.elapsed().as_secs() >= AI_MAX_SECONDS {
            send_error(
                &tx,
                format!(
                    "AI generation exceeded {AI_MAX_SECONDS}s — try again or use a stronger model"
                ),
            )
            .await;
            return;
        }
        let chunk = match first_chunk.take() {
            Some(chunk) => Ok(Some(chunk)),
            None => stream.chunk().await,
        };
        match chunk {
            Ok(Some(chunk)) => {
                if cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                    break;
                }
                byte_buf.extend_from_slice(&chunk);
                if byte_buf.len() > MAX_AI_BUFFER {
                    send_error(&tx, "AI response too large").await;
                    return;
                }
                if let Err(error) = process_buffer(&mut byte_buf, &mut summary, &tx).await {
                    send_error(&tx, error).await;
                    return;
                }
                if summary.text.len() >= MAX_AI_BUFFER {
                    summary.truncated = true;
                }
                if summary.truncated {
                    break;
                }
            }
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(
                    event = "ai_request_failure",
                    provider = %provider,
                    model = %model,
                    status = status.as_u16(),
                    duration_ms = started.elapsed().as_millis() as u64,
                    body_bytes = summary.text.len(),
                    error_category = "stream_read"
                );
                send_error(&tx, sanitize_ai_error(&error.to_string())).await;
                return;
            }
        }
    }

    if cancelled {
        // A cancelled stream is not a result. Emitting the buffered tool calls or
        // a `Done` here would hand a superseded turn's output to whoever is
        // listening now — the newer request's listeners included.
        return;
    }

    if !byte_buf.is_empty() {
        let line = String::from_utf8_lossy(&byte_buf);
        let data = line
            .trim_end_matches('\r')
            .strip_prefix("data: ")
            .unwrap_or("");
        if !data.is_empty() {
            if let Err(error) = process_sse_data(data, &mut summary, &tx).await {
                send_error(&tx, error).await;
                return;
            }
        }
    }

    for (index, tool_call) in summary.tool_calls.iter().enumerate() {
        if !tool_call.provider_id.is_empty() && !tool_call.name.is_empty() {
            let input = serde_json::from_str(&tool_call.arguments).unwrap_or(Value::Null);
            if tx
                .send(Ok(AiEvent::ToolCall {
                    tool_call_id: super::events::local_tool_call_id(index),
                    tool_name: tool_call.name.clone(),
                    input,
                }))
                .await
                .is_err()
            {
                return;
            }
        }
    }
    if tx.send(Ok(AiEvent::ToolsDone)).await.is_err() {
        return;
    }
    if summary.text.is_empty() && summary.tool_calls.is_empty() {
        send_error(&tx, "AI returned empty response").await;
        return;
    }
    tracing::info!(
        event = "ai_request_complete",
        provider = %summary.provider,
        model = %model,
        status = status.as_u16(),
        duration_ms = started.elapsed().as_millis() as u64,
        body_bytes = summary.text.len(),
        error_category = "none"
    );
    let _ = tx
        .send(Ok(AiEvent::Done {
            provider: summary.provider,
            truncated: summary.truncated,
        }))
        .await;
}

async fn send_error(tx: &EventSender, message: impl Into<String>) {
    let _ = tx.send(Err(message.into())).await;
}

async fn process_buffer(
    byte_buf: &mut Vec<u8>,
    summary: &mut StreamSummary,
    tx: &EventSender,
) -> Result<(), String> {
    let mut start = 0;
    while let Some(pos) = byte_buf[start..].iter().position(|&byte| byte == b'\n') {
        let line_end = start + pos;
        let line = String::from_utf8_lossy(&byte_buf[start..line_end]);
        let data = line
            .trim_end_matches('\r')
            .strip_prefix("data: ")
            .unwrap_or("");
        start = line_end + 1;
        if !data.is_empty() {
            process_sse_data(data, summary, tx).await?;
        }
        if summary.truncated {
            break;
        }
    }
    byte_buf.drain(..start);
    Ok(())
}

pub async fn process_sse_data(
    data: &str,
    summary: &mut StreamSummary,
    tx: &EventSender,
) -> Result<(), String> {
    if data == "[DONE]" {
        return Ok(());
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return Ok(());
    };
    if value["choices"][0]["finish_reason"]
        .as_str()
        .is_some_and(|reason| reason.eq_ignore_ascii_case("length"))
    {
        summary.truncated = true;
    }
    let content = value["choices"][0]["delta"]["content"].as_str();
    if summary
        .text
        .len()
        .checked_add(content.map_or(0, str::len))
        .filter(|size| *size <= MAX_AI_BUFFER)
        .is_none()
    {
        return Err("AI response too large".into());
    }

    let mut next_tool_calls = summary.tool_calls.clone();
    let mut tool_call_delta = false;
    if let Some(tool_calls) = value["choices"][0]["delta"]["tool_calls"].as_array() {
        tool_call_delta = !tool_calls.is_empty();
        for tool_call in tool_calls {
            let index = tool_call["index"].as_i64().unwrap_or(0);
            let id = tool_call["id"].as_str().unwrap_or("").to_string();
            let name = tool_call["function"]["name"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let arguments = tool_call["function"]["arguments"]
                .as_str()
                .unwrap_or("")
                .to_string();
            if let Some(position) = next_tool_calls.iter().position(|call| call.index == index) {
                if !id.is_empty() {
                    next_tool_calls[position].provider_id = id;
                }
                if !name.is_empty() {
                    next_tool_calls[position].name = name;
                }
                next_tool_calls[position].arguments.push_str(&arguments);
            } else {
                next_tool_calls.push(ToolCall {
                    index,
                    provider_id: id,
                    name,
                    arguments,
                });
            }
        }
    }
    let tool_args_size = next_tool_calls
        .iter()
        .try_fold(0usize, |total, call| {
            total.checked_add(call.arguments.len())
        })
        .ok_or_else(|| "AI response too large".to_string())?;
    if next_tool_calls.len() > MAX_TOOL_CALLS_PER_REQUEST || tool_args_size > MAX_TOOL_ARGS_SIZE {
        return Err("AI response too large".into());
    }
    let text_delta = content.is_some_and(|delta| !delta.is_empty());
    summary.tool_calls = next_tool_calls;
    // First non-empty delta — prose or tool-call arguments — means the provider has
    // begun writing. One signal per stream, sent before the completed call — without
    // it the UI sits in "thinking" for the whole write and only flips at the end.
    if (tool_call_delta || text_delta) && !summary.generating_sent {
        summary.generating_sent = true;
        tx.send(Ok(AiEvent::Generating))
            .await
            .map_err(|_| "AI stream consumer closed".to_string())?;
    }
    if let Some(content) = content {
        summary.text.push_str(content);
        tx.send(Ok(AiEvent::Token(content.to_string())))
            .await
            .map_err(|_| "AI stream consumer closed".to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn summary() -> StreamSummary {
        StreamSummary {
            provider: "test".into(),
            text: String::new(),
            tool_calls: Vec::new(),
            truncated: false,
            generating_sent: false,
        }
    }

    fn tool_delta(index: i64, arguments: &str) -> String {
        json!({ "choices": [{ "delta": { "tool_calls": [{ "index": index, "id": format!("call-{index}"), "function": { "name": "test", "arguments": arguments } }] } }] }).to_string()
    }

    #[tokio::test]
    async fn first_tool_call_delta_signals_generating_once() {
        use tokio::sync::mpsc::error::TryRecvError;

        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let mut state = summary();
        process_sse_data(&tool_delta(0, "{\"operations\""), &mut state, &tx)
            .await
            .unwrap();
        assert!(matches!(rx.recv().await, Some(Ok(AiEvent::Generating))));

        // Argument deltas of the same call must not repeat the signal.
        process_sse_data(&tool_delta(0, ":[],\"x\":1}"), &mut state, &tx)
            .await
            .unwrap();
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
    }

    #[tokio::test]
    async fn first_content_delta_signals_generating_once() {
        use tokio::sync::mpsc::error::TryRecvError;

        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let mut state = summary();
        let data = json!({ "choices": [{ "delta": { "content": "hi" } }] }).to_string();
        process_sse_data(&data, &mut state, &tx).await.unwrap();
        // Signal first, then the text it announces.
        assert!(matches!(rx.recv().await, Some(Ok(AiEvent::Generating))));
        assert!(matches!(rx.recv().await, Some(Ok(AiEvent::Token(token))) if token == "hi"));

        process_sse_data(&data, &mut state, &tx).await.unwrap();
        assert!(matches!(rx.try_recv(), Ok(Ok(AiEvent::Token(_)))));
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
    }

    #[tokio::test]
    async fn empty_leading_delta_does_not_signal_generating() {
        // Providers open with a role-only frame (`content: ""`); announcing
        // "writing" for it would flip the label before any content exists.
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let mut state = summary();
        let data =
            json!({ "choices": [{ "delta": { "role": "assistant", "content": "" } }] }).to_string();
        process_sse_data(&data, &mut state, &tx).await.unwrap();
        assert!(!state.generating_sent);
        assert!(matches!(rx.recv().await, Some(Ok(AiEvent::Token(_)))));
    }

    #[tokio::test]
    async fn process_sse_data_enforces_text_limit_before_append() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let mut state = summary();
        state.text = "x".repeat(MAX_AI_BUFFER);
        let data = json!({ "choices": [{ "delta": { "content": "y" } }] }).to_string();
        assert_eq!(
            process_sse_data(&data, &mut state, &tx).await.unwrap_err(),
            "AI response too large"
        );
        assert_eq!(state.text.len(), MAX_AI_BUFFER);
    }

    #[tokio::test]
    async fn process_sse_data_enforces_tool_limits_transactionally() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let mut state = summary();
        for index in 0..MAX_TOOL_CALLS_PER_REQUEST {
            process_sse_data(&tool_delta(index as i64, "{}"), &mut state, &tx)
                .await
                .unwrap();
        }
        let before = state.tool_calls.clone();
        assert_eq!(
            process_sse_data(
                &tool_delta(MAX_TOOL_CALLS_PER_REQUEST as i64, "{}"),
                &mut state,
                &tx
            )
            .await
            .unwrap_err(),
            "AI response too large"
        );
        assert_eq!(state.tool_calls, before);

        state.tool_calls = vec![ToolCall {
            index: 0,
            provider_id: "call-0".into(),
            name: "test".into(),
            arguments: "x".repeat(MAX_TOOL_ARGS_SIZE),
        }];
        let before = state.tool_calls.clone();
        assert_eq!(
            process_sse_data(&tool_delta(0, "y"), &mut state, &tx)
                .await
                .unwrap_err(),
            "AI response too large"
        );
        assert_eq!(state.tool_calls, before);
    }

    #[tokio::test]
    async fn finish_reason_length_marks_provider_truncation() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let mut state = summary();
        let data = json!({ "choices": [{ "delta": {}, "finish_reason": "length" }] }).to_string();
        process_sse_data(&data, &mut state, &tx).await.unwrap();
        assert!(state.truncated);
        state.truncated = false;
        let stop = json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] }).to_string();
        process_sse_data(&stop, &mut state, &tx).await.unwrap();
        assert!(!state.truncated);
    }

    /// Minimal one-shot HTTP server: answers the first request with a single
    /// SSE frame and closes, so `stream_chat` sees exactly one chunk.
    async fn one_sse_frame(payload: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let (mut socket, _) = listener.accept().await.unwrap();
            // Read the request head so the client finishes sending before we reply.
            let mut head = [0_u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut head).await;
            let body = format!("data: {payload}\n\n");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.flush().await;
        });
        addr.to_string()
    }

    #[tokio::test]
    async fn cancelled_stream_emits_nothing() {
        // Regression: a cancelled request used to fall through and emit its
        // buffered tool calls plus a `Done`, which a newer request's listeners
        // could not tell apart from their own.
        let addr = one_sse_frame(r#"{"choices":[{"delta":{"content":"hi"}}]}"#).await;
        let response = reqwest::Client::new()
            .get(format!("http://{addr}/chat"))
            .send()
            .await
            .unwrap();

        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let cancel = Arc::new(AtomicBool::new(true));
        stream_chat(
            response,
            "test".into(),
            "test".into(),
            cancel,
            Instant::now(),
            tx,
        )
        .await;

        assert!(
            rx.recv().await.is_none(),
            "a cancelled stream must not deliver tokens, tool calls, or Done"
        );
    }

    #[tokio::test]
    async fn byte_buffer_preserves_split_events_and_utf8() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        let mut state = summary();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"data: {\"choices\":[{\"delta\":{\"content\":\"caf");
        bytes.extend_from_slice("é".as_bytes());
        bytes.extend_from_slice(b"\"}}]}\n");
        let split = bytes.iter().position(|byte| *byte == b'\xc3').unwrap() + 1;
        let (first, second) = bytes.split_at(split);
        let mut buffer = first.to_vec();
        process_buffer(&mut buffer, &mut state, &tx).await.unwrap();
        buffer.extend_from_slice(second);
        process_buffer(&mut buffer, &mut state, &tx).await.unwrap();
        assert_eq!(state.text, "café");
        // The signal announced by the first delta precedes the text it carries.
        assert!(matches!(rx.recv().await, Some(Ok(AiEvent::Generating))));
        assert!(matches!(rx.recv().await, Some(Ok(AiEvent::Token(value))) if value == "café"));
    }
}
