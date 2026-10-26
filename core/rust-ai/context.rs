//! Context tools for rust-ai: the read-only lookups the model may call before it
//! emits `applyDocumentOperations` — the built-in web tools (`web_search`,
//! `web_fetch`) plus `read_context_result`, which pages large results.
//!
//! This module owns discovery, cancellation, untrusted framing and paging; the
//! tools themselves live in `web`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::watch;

/// Results whose serialized form exceeds this are paged via `read_context_result`.
pub const CONTEXT_PAGE_BYTES: usize = 8 * 1024;
/// Upper bound for one framed page. Stays below the frontend per-result slice
/// (12k UTF-16 units; UTF-8 bytes >= UTF-16 units) so page metadata survives.
const MAX_FRAMED_PAGE_BYTES: usize = 11_000;
const MAX_STORED_RESULTS: usize = 16;
const MAX_STORED_RESULT_BYTES: usize = 16 * 1024 * 1024;
const STORED_RESULT_TTL: Duration = Duration::from_secs(15 * 60);
/// Built-in read-only tool that returns later pages of a large context result.
pub const READ_CONTEXT_RESULT_TOOL: &str = "read_context_result";

pub const UNTRUSTED_REFERENCE_TYPE: &str = "untrusted_reference_data";

static CONTEXT_CALLS: OnceLock<Mutex<CallRegistry>> = OnceLock::new();
static STORED_RESULTS: OnceLock<Mutex<ResultStore>> = OnceLock::new();

#[derive(Default)]
struct ResultStore {
    entries: VecDeque<StoredResult>,
    bytes: usize,
}

struct StoredResult {
    handle: String,
    text: String,
    created: Instant,
}

impl ResultStore {
    fn evict_expired(&mut self) {
        while self
            .entries
            .front()
            .is_some_and(|entry| entry.created.elapsed() > STORED_RESULT_TTL)
        {
            self.pop_oldest();
        }
    }

    fn pop_oldest(&mut self) {
        if let Some(entry) = self.entries.pop_front() {
            self.bytes -= entry.text.len();
        }
    }

    fn insert(&mut self, handle: String, text: String) {
        self.evict_expired();
        while !self.entries.is_empty()
            && (self.entries.len() >= MAX_STORED_RESULTS
                || self.bytes + text.len() > MAX_STORED_RESULT_BYTES)
        {
            self.pop_oldest();
        }
        self.bytes += text.len();
        self.entries.push_back(StoredResult {
            handle,
            text,
            created: Instant::now(),
        });
    }
}

/// Lock the result store, recovering from poisoning (entries are always whole).
fn stored_results() -> MutexGuard<'static, ResultStore> {
    STORED_RESULTS
        .get_or_init(|| Mutex::new(ResultStore::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Random handle so callers sharing a process cannot feasibly guess each other's results.
fn new_result_handle() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("operating system random source is unavailable");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Active context-tool calls, by AI round (`request_id`). A round may run its
/// calls in parallel, so every call of a round shares one cancel sender and the
/// slot lives until the last of them finishes.
#[derive(Default)]
struct CallRegistry {
    active: HashMap<String, CallSlot>,
    /// Rounds Stop already cancelled: a call that arrives afterwards (it was
    /// sent in parallel and lost the race to the Stop) starts cancelled.
    cancelled: crate::rust_ai::requests::Tombstones,
}

struct CallSlot {
    sender: Arc<watch::Sender<bool>>,
    calls: usize,
}

/// Lock the active-call registry, recovering from poisoning. The map only ever
/// holds whole entries, so a recovered guard is still sound; returning an error
/// here would silently disable Stop for an already-running request.
fn calls() -> MutexGuard<'static, CallRegistry> {
    CONTEXT_CALLS
        .get_or_init(|| Mutex::new(CallRegistry::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One registered call. Dropping it — on completion, or when the caller's
/// future is dropped mid-call (the web client disconnected) — releases the
/// call's share of the round's slot, so the registry cannot leak.
struct CallGuard {
    request_id: String,
    sender: Arc<watch::Sender<bool>>,
}

fn register_call(request_id: &str) -> (CallGuard, watch::Receiver<bool>) {
    let mut registry = calls();
    if registry.cancelled.contains(request_id) {
        let (sender, receiver) = watch::channel(true);
        let guard = CallGuard { request_id: request_id.to_string(), sender: Arc::new(sender) };
        return (guard, receiver);
    }
    let slot = registry
        .active
        .entry(request_id.to_string())
        .or_insert_with(|| CallSlot { sender: Arc::new(watch::channel(false).0), calls: 0 });
    slot.calls += 1;
    let receiver = slot.sender.subscribe();
    let guard = CallGuard { request_id: request_id.to_string(), sender: Arc::clone(&slot.sender) };
    (guard, receiver)
}

impl Drop for CallGuard {
    /// Release only while the slot still belongs to this call's sender: a
    /// cancelled round's late finish must not touch a newer slot.
    fn drop(&mut self) {
        let mut registry = calls();
        let Some(slot) = registry.active.get_mut(&self.request_id) else {
            return;
        };
        if !Arc::ptr_eq(&slot.sender, &self.sender) {
            return;
        }
        slot.calls -= 1;
        if slot.calls == 0 {
            registry.active.remove(&self.request_id);
        }
    }
}

/// A read-only tool offered to the model, as sent to the transport.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub read_only: bool,
}

/// List the context tools for a prompt turn: the ready built-in web tools, then
/// the paging tool when any tool can produce a pageable result.
///
/// `url_sources` are the URLs of the user's prompt and document; they seed the
/// turn's provenance ledger so `web_fetch` may open them.
pub async fn discover(request_id: &str, url_sources: &[String]) -> Result<Vec<ContextTool>, String> {
    if request_id.is_empty() {
        return Err("Context-tool request id is required".into());
    }
    crate::rust_ai::web::ledger::record(request_id, url_sources.iter().map(String::as_str));
    let mut tools: Vec<ContextTool> = crate::rust_ai::web::ready_tools()
        .into_iter()
        .map(|tool| ContextTool {
            name: tool.name.into(),
            description: tool.description,
            input_schema: tool.input_schema,
            read_only: true,
        })
        .collect();
    append_builtin_tools(&mut tools);
    Ok(tools)
}

/// Offer paging only when at least one tool can produce a result.
fn append_builtin_tools(output: &mut Vec<ContextTool>) {
    if output.is_empty() {
        return;
    }
    output.push(ContextTool {
        name: READ_CONTEXT_RESULT_TOOL.into(),
        description: "Read the next page of a large context-tool result. Call it with the `handle` and `next_offset` from a result whose `truncated` is true; repeat until `next_offset` is null. Only read as many pages as the task needs.".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "handle": {"type": "string", "description": "page.handle from the earlier result"},
                "offset": {"type": "integer", "minimum": 0, "description": "page.next_offset from the earlier result"}
            },
            "required": ["handle", "offset"],
            "additionalProperties": false
        }),
        read_only: true,
    });
}

/// Frame a tool result as untrusted data. Small results are returned whole;
/// larger ones are stored and returned page by page instead of being rejected.
pub fn frame_result(value: &Value) -> Result<String, String> {
    let text =
        serde_json::to_string(value).map_err(|_| "Context result is not serializable".to_string())?;
    if text.len() <= CONTEXT_PAGE_BYTES {
        return serde_json::to_string(
            &json!({"type": UNTRUSTED_REFERENCE_TYPE, "truncated": false, "content": value}),
        )
        .map_err(|_| "Context result is not serializable".into());
    }
    let source = result_text(value)?;
    let handle = new_result_handle();
    let first = frame_page(&handle, &source, 0)?;
    stored_results().insert(handle, source);
    Ok(first)
}

/// Flatten a CallToolResult-shaped value (`content: [{type, text}]`, as
/// `web_fetch` returns) into readable text so pages split prose, not JSON
/// structure. Binary payloads are replaced by a placeholder.
fn result_text(value: &Value) -> Result<String, String> {
    let serialize = |value: &Value| {
        serde_json::to_string_pretty(value)
            .map_err(|_| "Context result is not serializable".to_string())
    };
    let Some(items) = value.get("content").and_then(Value::as_array) else {
        return match value.get("structuredContent") {
            Some(structured) => serialize(structured),
            None => serialize(value),
        };
    };
    let mut parts = Vec::with_capacity(items.len());
    for item in items {
        let text = item
            .get("text")
            .or_else(|| {
                item.get("resource")
                    .and_then(|resource| resource.get("text"))
            })
            .and_then(Value::as_str);
        match (text, item.get("type").and_then(Value::as_str)) {
            (Some(text), _) => parts.push(text.to_string()),
            (None, Some(kind @ ("image" | "audio"))) => parts.push(format!(
                "[{kind} omitted: {}]",
                item.get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown type")
            )),
            _ => parts.push(serialize(item)?),
        }
    }
    Ok(parts.join("\n\n"))
}

/// Frame one page starting at byte `offset`. Metadata precedes content so a
/// downstream character slice can never drop the handle or next offset.
fn frame_page(handle: &str, text: &str, offset: usize) -> Result<String, String> {
    if offset > text.len() || !text.is_char_boundary(offset) {
        return Err("Invalid context result offset".into());
    }
    let to_json = |value: &Value| {
        serde_json::to_string(value).map_err(|_| "Context result is not serializable".to_string())
    };
    let mut budget = CONTEXT_PAGE_BYTES;
    loop {
        let mut end = (offset + budget).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == offset && offset < text.len() {
            // Always make progress by at least one character.
            end = offset + text[offset..].chars().next().map_or(0, char::len_utf8);
        }
        let next_offset = (end < text.len()).then_some(end);
        let page = json!({
            "handle": handle,
            "offset": offset,
            "next_offset": next_offset,
            "total_bytes": text.len(),
            "continue_with": next_offset.map(|_| READ_CONTEXT_RESULT_TOOL),
        });
        let framed = format!(
            "{{\"type\":{},\"truncated\":{},\"page\":{},\"content\":{}}}",
            to_json(&json!(UNTRUSTED_REFERENCE_TYPE))?,
            next_offset.is_some(),
            to_json(&page)?,
            to_json(&json!(&text[offset..end]))?,
        );
        // JSON escaping can inflate content; shrink until the frame fits.
        if framed.len() <= MAX_FRAMED_PAGE_BYTES || end - offset <= 4 {
            return Ok(framed);
        }
        budget = (end - offset) * 3 / 4;
    }
}

/// Serve `read_context_result`: a later page of a stored large result.
fn read_stored_page(input: &Value) -> Result<String, String> {
    let handle = input
        .get("handle")
        .and_then(Value::as_str)
        .filter(|handle| handle.len() == 64 && handle.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| "Invalid context result handle".to_string())?;
    let offset = input
        .get("offset")
        .and_then(Value::as_u64)
        .and_then(|offset| usize::try_from(offset).ok())
        .ok_or_else(|| "Invalid context result offset".to_string())?;
    let mut store = stored_results();
    store.evict_expired();
    let entry = store
        .entries
        .iter()
        .find(|entry| entry.handle == handle)
        .ok_or_else(|| {
            "Context result expired or not found; call the original tool again".to_string()
        })?;
    frame_page(&entry.handle, &entry.text, offset)
}

/// Run one context tool for the AI round `request_id`.
///
/// `context_id` identifies the whole prompt turn (stable across rounds) and keys
/// the web tools' URL-provenance ledger; it falls back to `request_id`.
pub async fn invoke(
    request_id: &str,
    context_id: &str,
    name: &str,
    input: Value,
) -> Result<String, String> {
    if request_id.is_empty() {
        return Err("Context-tool request id is required".into());
    }
    if name == READ_CONTEXT_RESULT_TOOL {
        return read_stored_page(&input);
    }
    if !crate::rust_ai::web::is_web_tool(name) {
        return Err("Context tool is not available".into());
    }
    let (_call, mut cancelled) = register_call(request_id);
    if *cancelled.borrow() {
        return frame_result(&crate::rust_ai::web::cancelled_error().to_value());
    }
    let context_id = if context_id.is_empty() { request_id } else { context_id };
    let outcome = crate::rust_ai::web::invoke(context_id, name, &input, &mut cancelled).await;
    // Tool errors are answers for the model, not request failures.
    frame_result(&outcome.unwrap_or_else(|error| error.to_value()))
}

/// Cancel every call of the round `request_id`, including calls that arrive
/// after this Stop.
pub fn cancel(request_id: &str) {
    if request_id.is_empty() {
        return;
    }
    // Recover from a poisoned lock instead of silently doing nothing: a panic
    // elsewhere must not turn Stop into a no-op for an already-running request.
    let mut registry = calls();
    registry.cancelled.insert(request_id);
    if let Some(slot) = registry.active.remove(request_id) {
        let _ = slot.sender.send(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_results_as_untrusted_data() {
        let framed = frame_result(&json!({"content":[{"text":"reference"}]})).unwrap();
        assert!(framed.contains(UNTRUSTED_REFERENCE_TYPE));
    }

    /// Read every page of a framed result and return the reassembled text.
    fn read_all_pages(first: &str) -> (String, usize) {
        let mut page: Value = serde_json::from_str(first).unwrap();
        let mut text = String::new();
        let mut pages = 0;
        loop {
            assert!(serde_json::to_string(&page).unwrap().len() <= MAX_FRAMED_PAGE_BYTES);
            text.push_str(page["content"].as_str().unwrap());
            pages += 1;
            let Some(next) = page["page"]["next_offset"].as_u64() else {
                assert_eq!(page["truncated"], false);
                return (text, pages);
            };
            assert_eq!(page["truncated"], true);
            let raw = read_stored_page(&json!({"handle": page["page"]["handle"], "offset": next}))
                .unwrap();
            page = serde_json::from_str(&raw).unwrap();
        }
    }

    #[test]
    fn pages_large_results_instead_of_rejecting() {
        let body = "lorem ipsum dolor sit amet ".repeat(4_000);
        let first = frame_result(&json!({"content":[{"type":"text","text": body}]})).unwrap();
        assert!(first.starts_with(r#"{"type":"untrusted_reference_data","truncated":true,"page":"#));
        let (text, pages) = read_all_pages(&first);
        assert_eq!(text, body);
        assert!(pages > 1);
    }

    #[test]
    fn many_result_items_are_paged_not_rejected() {
        let items: Vec<Value> = (0..500)
            .map(|index| json!({"type":"text","text": format!("row {index}")}))
            .collect();
        let first = frame_result(&json!({ "content": items })).unwrap();
        let (text, _) = read_all_pages(&first);
        assert!(text.starts_with("row 0\n\nrow 1") && text.ends_with("row 499"));
    }

    #[test]
    fn pages_respect_utf8_boundaries_and_escaping() {
        let body = "é漢🙂\u{1}\"".repeat(5_000);
        let first = frame_result(&json!({"content":[{"type":"text","text": body}]})).unwrap();
        let (text, _) = read_all_pages(&first);
        assert_eq!(text, body);
    }

    #[test]
    fn binary_content_is_replaced_by_placeholder() {
        let first = frame_result(&json!({"content":[
            {"type":"image","mimeType":"image/png","data": "A".repeat(20_000)},
            {"type":"text","text":"caption"}
        ]}))
        .unwrap();
        let (text, _) = read_all_pages(&first);
        assert_eq!(text, "[image omitted: image/png]\n\ncaption");
    }

    #[test]
    fn rejects_invalid_page_requests() {
        assert!(read_stored_page(&json!({"handle":"nope","offset":0})).is_err());
        assert!(read_stored_page(&json!({"handle": "0".repeat(32), "offset": 0})).is_err());
        let first =
            frame_result(&json!({"content":[{"type":"text","text": "é".repeat(10_000)}]})).unwrap();
        let page: Value = serde_json::from_str(&first).unwrap();
        let handle = page["page"]["handle"].clone();
        assert!(read_stored_page(&json!({"handle": handle, "offset": 1})).is_err());
        assert!(read_stored_page(&json!({"handle": handle, "offset": 1_000_000})).is_err());
    }

    #[test]
    fn builtin_paging_tool_is_offered_only_with_other_tools() {
        let mut none = Vec::new();
        append_builtin_tools(&mut none);
        assert!(none.is_empty());
        let mut some = vec![ContextTool {
            name: crate::rust_ai::web::WEB_FETCH_TOOL.into(),
            description: String::new(),
            input_schema: json!({"type":"object"}),
            read_only: true,
        }];
        append_builtin_tools(&mut some);
        assert_eq!(some.len(), 2);
        assert_eq!(some[1].name, READ_CONTEXT_RESULT_TOOL);
        assert!(some[1].read_only);
    }

    #[tokio::test]
    async fn discovery_lists_ready_web_tools_with_paging_and_seeds_the_ledger() {
        use crate::rust_ai::web::{self, SearchProvider, WebToolsConfig};
        let _guard = web::test_config_lock().await;
        web::set_config(WebToolsConfig { search: SearchProvider::Tavily { api_key: "k".into() }, fetch_enabled: true, max_results: 5 }).unwrap();
        let tools = discover("turn-discovery", &["https://seed.example/page".to_string()]).await.unwrap();
        let names = tools.iter().map(|tool| tool.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, [web::WEB_SEARCH_TOOL, web::WEB_FETCH_TOOL, READ_CONTEXT_RESULT_TOOL]);
        assert!(tools.iter().all(|tool| tool.read_only));
        assert!(web::ledger::allows("turn-discovery", "https://seed.example/page"));
        web::set_config(WebToolsConfig::default()).unwrap();
        assert!(discover("turn-discovery-off", &[]).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn only_built_in_tools_can_be_invoked() {
        let error = invoke("round-unknown", "turn-unknown", "mcp_0", json!({})).await.unwrap_err();
        assert_eq!(error, "Context tool is not available");
    }

    #[tokio::test]
    async fn web_tool_errors_are_framed_answers_not_failures() {
        use crate::rust_ai::web::{self, WebToolsConfig};
        let _guard = web::test_config_lock().await;
        web::set_config(WebToolsConfig { fetch_enabled: true, ..WebToolsConfig::default() }).unwrap();
        let framed = invoke("round-1", "turn-framing", web::WEB_FETCH_TOOL, json!({"url": "https://never.example/"})).await.unwrap();
        let value: Value = serde_json::from_str(&framed).unwrap();
        assert_eq!(value["type"], UNTRUSTED_REFERENCE_TYPE);
        assert_eq!(value["content"]["error"]["code"], "url_not_in_context");
        web::set_config(WebToolsConfig::default()).unwrap();
    }

    #[test]
    fn parallel_calls_of_one_round_share_cancellation() {
        // A round may run its web calls in parallel; they used to be refused
        // ("already active") after the first.
        let (first, mut first_rx) = register_call("parallel-round");
        let (second, mut second_rx) = register_call("parallel-round");
        assert_eq!(calls().active["parallel-round"].calls, 2);
        cancel("parallel-round");
        assert!(*first_rx.borrow_and_update());
        assert!(*second_rx.borrow_and_update());
        drop((first, second));
        assert!(!calls().active.contains_key("parallel-round"));
    }

    #[test]
    fn the_slot_lives_until_the_last_call_of_the_round_finishes() {
        let (first, _) = register_call("slot-round");
        let (second, mut second_rx) = register_call("slot-round");
        drop(first);
        assert!(calls().active.contains_key("slot-round"));
        cancel("slot-round");
        assert!(*second_rx.borrow_and_update());
        drop(second);
        assert!(!calls().active.contains_key("slot-round"));
    }

    #[test]
    fn a_call_that_arrives_after_stop_starts_cancelled() {
        cancel("late-round");
        let (_guard, receiver) = register_call("late-round");
        assert!(*receiver.borrow());
        assert!(!calls().active.contains_key("late-round"));
    }

    #[tokio::test]
    async fn invoking_a_cancelled_round_answers_without_network_access() {
        cancel("cancelled-round");
        let framed = invoke("cancelled-round", "turn-x", crate::rust_ai::web::WEB_SEARCH_TOOL, json!({"query": "q"}))
            .await
            .unwrap();
        let value: Value = serde_json::from_str(&framed).unwrap();
        assert_eq!(value["content"]["error"]["code"], "unavailable");
    }

    #[test]
    fn cancellation_registry_survives_a_poisoned_lock() {
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = calls();
            panic!("poison the active-call registry");
        }));
        assert!(poisoned.is_err());

        let (_guard, mut receiver) = register_call("poison-recovery");
        cancel("poison-recovery");
        assert!(*receiver.borrow_and_update());
    }

    #[test]
    fn late_finish_of_a_released_call_does_not_touch_a_newer_slot() {
        // A call whose slot was already retired must not release a slot that
        // a different sender now owns.
        let (stale, _) = register_call("reused-round");
        calls().active.remove("reused-round");
        let (fresh, mut fresh_rx) = register_call("reused-round");
        drop(stale);
        assert_eq!(calls().active["reused-round"].calls, 1);
        cancel("reused-round");
        assert!(*fresh_rx.borrow_and_update());
        drop(fresh);
    }
}
