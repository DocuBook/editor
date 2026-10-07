use serde_json::{json, Value};

/// Stable policy. Dynamic document state stays in assistant context messages.
pub const HTML_DOCUMENT_SYSTEM_PROMPT: &str = r#"You're manipulating a text document using HTML blocks.
Make sure to follow the JSON schema provided. When referencing ids they MUST be EXACTLY the same (including the trailing $).
List items are 1 block with 1 list item each, so block content `<ul><li>item1</li></ul>` is valid, but `<ul><li>item1</li><li>item2</li></ul>` is invalid. We'll merge them automatically.
For code blocks, you can use the `data-language` attribute on a <code> block (wrapped with <pre>) to specify the language.

If the user requests updates to the document, use the "applyDocumentOperations" tool to update the document.
---
IF there is no selection active in the latest state, first, determine what part of the document the user is talking about. You SHOULD probably take cursor info into account if needed.
  EXAMPLE: if user says "below" (without pointing to a specific part of the document) he / she probably indicates the block(s) after the cursor.
  EXAMPLE: If you want to insert content AT the cursor position (UNLESS indicated otherwise by the user), then you need `referenceId` to point to the block before the cursor with position `after` (or block below and `before`
---
"#;

pub const DOCUMENT_STATE_FIELD: &str = "documentState";

/// Attach document state to latest user message metadata without putting state
/// into the stable system policy.
pub fn attach_document_state(messages: &mut Vec<Value>, document_state: Value) {
    if let Some(message) = messages
        .iter_mut()
        .rev()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
    {
        let metadata = message
            .get_mut("metadata")
            .and_then(Value::as_object_mut)
            .map(|object| object as &mut serde_json::Map<String, Value>);
        if let Some(metadata) = metadata {
            metadata.insert(DOCUMENT_STATE_FIELD.to_string(), document_state);
        } else if let Some(object) = message.as_object_mut() {
            object.insert(
                "metadata".to_string(),
                json!({ DOCUMENT_STATE_FIELD: document_state }),
            );
        }
    } else {
        messages.push(json!({
            "role": "user",
            "content": "",
            "metadata": { DOCUMENT_STATE_FIELD: document_state }
        }));
    }
}

/// Assemble stable policy and dynamic document context as separate messages.
pub fn assemble_messages(messages: &[Value]) -> Vec<Value> {
    let mut result = Vec::with_capacity(messages.len() + 1);
    if !messages
        .iter()
        .any(|message| message.get("role").and_then(Value::as_str) == Some("system"))
    {
        result.push(json!({
            "role": "system",
            "content": HTML_DOCUMENT_SYSTEM_PROMPT
        }));
    }
    result.extend(inject_document_state_messages(messages));
    result
}

/// Convert UI-message metadata into assistant context messages matching the
/// existing BlockNote AI prompt contract.
pub fn inject_document_state_messages(messages: &[Value]) -> Vec<Value> {
    let mut result = Vec::with_capacity(messages.len() + 1);
    for message in messages {
        if message.get("role").and_then(Value::as_str) == Some("user") {
            if let Some(state) = message
                .get("metadata")
                .and_then(|metadata| metadata.get(DOCUMENT_STATE_FIELD))
            {
                result.push(document_state_context(state, message));
            }
        }
        result.push(message.clone());
    }
    result
}

fn document_state_context(state: &Value, source_message: &Value) -> Value {
    let id = source_message
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("latest");
    if state.get("selection").and_then(Value::as_bool) == Some(true) {
        json!({
            "role": "assistant",
            "id": format!("assistant-document-state-{id}"),
            "content": [
                "This is the latest state of the selection (ignore previous selections, you MUST issue operations against this latest version of the selection):",
                state.get("selectedBlocks").cloned().unwrap_or_else(|| json!([])),
                "This is the latest state of the entire document (INCLUDING the selected text), you can use this to find the selected text to understand the context (but you MUST NOT issue operations against this document, you MUST issue operations against the selection):",
                state.get("blocks").cloned().unwrap_or_else(|| json!([]))
            ]
        })
    } else {
        let empty = state
            .get("isEmptyDocument")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let guidance = if empty {
            "Because the document is empty, YOU MUST first update the empty block before adding new blocks."
        } else {
            "Prefer updating existing blocks over removing and adding (but this also depends on the user's question)."
        };
        json!({
            "role": "assistant",
            "id": format!("assistant-document-state-{id}"),
            "content": [
                format!("There is no active selection. This is the latest state of the document (ignore previous documents, you MUST issue operations against this latest version of the document). The cursor is BETWEEN two blocks as indicated by cursor: true.\n{guidance}"),
                state.get("blocks").cloned().unwrap_or_else(|| json!([]))
            ]
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_no_selection_state_as_separate_assistant_context() {
        let messages = vec![json!({
            "id": "m1",
            "role": "user",
            "content": "continue",
            "metadata": {
                "documentState": {
                    "selection": false,
                    "isEmptyDocument": false,
                    "blocks": [{"id": "b1$", "block": "<p>Hello</p>"}, {"cursor": true}]
                }
            }
        })];
        let injected = assemble_messages(&messages);
        assert_eq!(injected.len(), 3);
        assert_eq!(injected[0]["role"], "system");
        let injected = &injected[1..];
        assert_eq!(injected[0]["role"], "assistant");
        assert!(injected[0]["content"][0]
            .as_str()
            .unwrap()
            .contains("latest state"));
        assert_eq!(injected[1]["role"], "user");
        assert!(injected[1]["metadata"][DOCUMENT_STATE_FIELD].is_object());
    }

    #[test]
    fn injects_selection_state_with_selected_and_full_document_context() {
        let messages = vec![json!({
            "id": "m2",
            "role": "user",
            "metadata": {
                "documentState": {
                    "selection": true,
                    "isEmptyDocument": false,
                    "selectedBlocks": [{"id": "b1$", "block": "<p>Selected</p>"}],
                    "blocks": [{"block": "<p>Context</p>"}]
                }
            }
        })];
        let injected = inject_document_state_messages(&messages);
        assert_eq!(injected[0]["content"][1][0]["id"], "b1$");
        assert_eq!(injected[0]["content"][3][0]["block"], "<p>Context</p>");
    }

    #[test]
    fn attaches_state_to_latest_user_message() {
        let mut messages = vec![
            json!({"role": "assistant", "content": "old"}),
            json!({"role": "user", "content": "new"}),
        ];
        attach_document_state(&mut messages, json!({"selection": false}));
        assert_eq!(
            messages[1]["metadata"][DOCUMENT_STATE_FIELD]["selection"],
            false
        );
    }
}
