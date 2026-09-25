use super::error::sanitize_ai_error;
use super::events::{
    AiEvent, StreamSummary, ToolCall, AI_MAX_SECONDS, MAX_AI_BUFFER, MAX_TOOL_ARGS_SIZE,
    MAX_TOOL_CALLS_PER_REQUEST,
};
use eventsource_stream::{EventStreamError, Eventsource};
use futures_util::StreamExt as _;
use reqwest::Response;
use serde_json::Value;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub type EventSender = mpsc::Sender<Result<AiEvent, String>>;

/// Counts the bytes handed over by the underlying stream and trips once `limit` is
/// exceeded.
///
/// The SSE parser buffers a whole event before yielding it, so a limit applied
/// downstream of it only runs after the allocation has already happened. Capping the
/// raw chunks keeps that in-flight buffer bounded no matter what the provider sends.
struct BoundedBytes<S> {
    inner: S,
    seen: usize,
    limit: usize,
    tripped: bool,
}

impl<S> BoundedBytes<S> {
    fn new(inner: S, limit: usize) -> Self {
        Self {
            inner,
            seen: 0,
            limit,
            tripped: false,
        }
    }
}

/// Either the transport failed or the cap tripped. The caller matches on the variant
/// so only a real transport error goes through `sanitize_ai_error`.
#[derive(Debug)]
enum BodyError<E> {
    Transport(E),
    TooLarge,
}

impl<E: std::fmt::Display> std::fmt::Display for BodyError<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(error) => error.fmt(f),
            Self::TooLarge => f.write_str(TOO_LARGE_MESSAGE),
        }
    }
}

impl<E: std::error::Error + 'static> std::error::Error for BodyError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Transport(error) => Some(error),
            Self::TooLarge => None,
        }
    }
}

impl<S, E> futures_util::Stream for BoundedBytes<S>
where
    S: futures_util::Stream<Item = Result<bytes::Bytes, E>> + Unpin,
{
    type Item = Result<bytes::Bytes, BodyError<E>>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        // Stay tripped: once the provider is over budget there is nothing left to read
        // that we would hand over, so stop pulling from the socket entirely.
        if this.tripped {
            return Poll::Ready(Some(Err(BodyError::TooLarge)));
        }
        match Pin::new(&mut this.inner).poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                this.seen = this.seen.saturating_add(chunk.len());
                if this.seen > this.limit {
                    this.tripped = true;
                    return Poll::Ready(Some(Err(BodyError::TooLarge)));
                }
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(Some(Err(error))) => Poll::Ready(Some(Err(BodyError::Transport(error)))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// A `BodyError::TooLarge` is ours, not the transport's, so it must not go through
/// `sanitize_ai_error` and lose the size framing.
const TOO_LARGE_MESSAGE: &str = "AI response too large";

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

    // The cap counts wire bytes, so it also covers SSE and JSON framing. That is the
    // point: it is what stops the parser from buffering past the budget while it waits
    // for an event to terminate. Budgeting bytes rather than text means the text
    // ceiling sits below `MAX_AI_BUFFER` by the framing ratio, which stays far above
    // what any provider will emit for one response.
    let mut events =
        std::pin::pin!(BoundedBytes::new(response.bytes_stream(), MAX_AI_BUFFER).eventsource());
    let mut summary = StreamSummary {
        provider: provider.clone(),
        text: String::new(),
        tool_calls: Vec::new(),
        truncated: false,
        generating_sent: false,
    };
    let mut saw_event = false;
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
        // Only the event carrying the prefill latency is bounded here; a stall later
        // in the stream is the transport's read timeout to catch.
        let next = if saw_event {
            events.next().await
        } else {
            match tokio::time::timeout(Duration::from_secs(30), events.next()).await {
                Ok(next) => next,
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
            }
        };
        match next {
            Some(Ok(event)) => {
                if cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                    break;
                }
                saw_event = true;
                if let Err(error) = process_sse_data(&event.data, &mut summary, &tx).await {
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
            Some(Err(error)) => {
                let too_large = matches!(error, EventStreamError::Transport(BodyError::TooLarge));
                tracing::warn!(
                    event = "ai_request_failure",
                    provider = %provider,
                    model = %model,
                    status = status.as_u16(),
                    duration_ms = started.elapsed().as_millis() as u64,
                    body_bytes = summary.text.len(),
                    error_category = if too_large {
                        "response_too_large"
                    } else {
                        "stream_read"
                    }
                );
                let message = if too_large {
                    TOO_LARGE_MESSAGE.to_string()
                } else {
                    sanitize_ai_error(&error.to_string())
                };
                send_error(&tx, message).await;
                return;
            }
            None if !saw_event => {
                send_error(&tx, "AI provider returned an empty response").await;
                return;
            }
            None => break,
        }
    }

    if cancelled {
        // A cancelled stream is not a result. Emitting the buffered tool calls or
        // a `Done` here would hand a superseded turn's output to whoever is
        // listening now — the newer request's listeners included.
        return;
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

    /// Minimal one-shot HTTP server: answers the first request with an SSE body
    /// delivered in `parts`, one TCP write each (with a short gap between them), so
    /// `stream_chat` sees the body split exactly where the test wants it.
    async fn sse_body_in_parts(parts: Vec<Vec<u8>>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let (mut socket, _) = listener.accept().await.unwrap();
            // Read the request head so the client finishes sending before we reply.
            let mut head = [0_u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut head).await;
            let _ = socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                )
                .await;
            for (index, part) in parts.iter().enumerate() {
                if index > 0 {
                    // Separate writes get coalesced into one chunk otherwise, which
                    // would hide the chunk-boundary handling under test.
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                let _ = socket.write_all(part).await;
                let _ = socket.flush().await;
            }
        });
        addr.to_string()
    }

    async fn one_sse_frame(payload: &str) -> String {
        sse_body_in_parts(vec![format!("data: {payload}\n\n").into_bytes()]).await
    }

    async fn get_sse(url: String) -> Response {
        reqwest::Client::new().get(url).send().await.unwrap()
    }

    #[tokio::test]
    async fn cancelled_stream_emits_nothing() {
        // Regression: a cancelled request used to fall through and emit its
        // buffered tool calls plus a `Done`, which a newer request's listeners
        // could not tell apart from their own.
        let addr = one_sse_frame(r#"{"choices":[{"delta":{"content":"hi"}}]}"#).await;
        let response = get_sse(format!("http://{addr}/chat")).await;

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
    async fn split_utf8_across_chunks_is_reassembled() {
        // A frame (and the é inside it) split across TCP writes must survive:
        // the parser holds the partial sequence instead of decoding per chunk.
        let mut frame = Vec::new();
        frame.extend_from_slice(b"data: {\"choices\":[{\"delta\":{\"content\":\"caf");
        frame.extend_from_slice("é".as_bytes());
        frame.extend_from_slice(b"\"}}]}\n\n");
        let split = frame.iter().position(|byte| *byte == 0xc3).unwrap() + 1;
        let (first, second) = frame.split_at(split);

        let addr = sse_body_in_parts(vec![first.to_vec(), second.to_vec()]).await;
        let response = get_sse(format!("http://{addr}/chat")).await;

        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        stream_chat(
            response,
            "test".into(),
            "test".into(),
            Arc::new(AtomicBool::new(false)),
            Instant::now(),
            tx,
        )
        .await;

        // The signal announced by the first delta precedes the text it carries.
        assert!(matches!(rx.recv().await, Some(Ok(AiEvent::Generating))));
        assert!(matches!(rx.recv().await, Some(Ok(AiEvent::Token(value))) if value == "café"));
    }

    #[tokio::test]
    async fn unterminated_trailing_event_is_dropped() {
        // Spec behaviour: an event whose blank line never arrives is discarded at
        // EOF. The hand-rolled flush parsed it instead, which shipped half a frame
        // whenever a connection died mid-event.
        let addr = sse_body_in_parts(vec![
            b"data: {\"choices\":[{\"delta\":{\"content\":\"half\"}}]}\n".to_vec(),
        ])
        .await;
        let response = get_sse(format!("http://{addr}/chat")).await;

        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        stream_chat(
            response,
            "test".into(),
            "test".into(),
            Arc::new(AtomicBool::new(false)),
            Instant::now(),
            tx,
        )
        .await;

        assert_eq!(
            rx.recv().await,
            Some(Err("AI provider returned an empty response".into()))
        );
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn oversized_body_is_rejected_before_the_event_completes() {
        use tokio::io::AsyncWriteExt;

        // Comment lines are ignored by the SSE parser and never reach the text
        // accumulator, so a body made only of comments isolates the byte cap: the
        // event-level text limit in `process_sse_data` cannot be the thing that trips.
        //
        // A single 8 MiB line would exercise the same cap, but the parser rescans its
        // pending line on every poll, which is quadratic and far too slow to assert on.
        //
        // `sse_body_in_parts` is not reused here: it paces writes 20ms apart to force
        // chunk splits, and the ~1000 parts needed to pass 8 MiB would take 20 seconds.
        let comment = format!(": {}\n", "x".repeat(8 * 1024));
        let parts = MAX_AI_BUFFER.div_ceil(comment.len()) + 2;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let (mut reader, mut writer) = socket.into_split();
            // Drain the request in the background so the reply never stalls on a full
            // receive window while we stream padding at the client.
            tokio::spawn(async move {
                let mut discard = [0_u8; 4096];
                loop {
                    // Reading until EOF is the point: the request bytes must leave the
                    // socket or our writes below would stall behind them.
                    let read = tokio::io::AsyncReadExt::read(&mut reader, &mut discard).await;
                    if !matches!(read, Ok(n) if n > 0) {
                        break;
                    }
                }
            });
            let _ = writer
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                )
                .await;
            for _ in 0..parts {
                if writer.write_all(comment.as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        let response = get_sse(format!("http://{addr}/chat")).await;

        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        stream_chat(
            response,
            "test".into(),
            "test".into(),
            Arc::new(AtomicBool::new(false)),
            Instant::now(),
            tx,
        )
        .await;

        assert_eq!(rx.recv().await, Some(Err("AI response too large".into())));
        assert!(rx.recv().await.is_none());
    }
}
