use serde_json::{json, Value};

/// Stable tool name shared by frontend transport and AI providers.
pub const DOCUMENT_OPERATION_TOOL: &str = "applyDocumentOperations";

/// JSON Schema for HTML document operations emitted by the AI tool call.
///
/// BlockNote's HTML format accepts one valid HTML element per block. IDs are
/// suffixed with `$` in document context so the model cannot confuse stale IDs
/// with the current document.
pub fn document_operation_tool_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "operations": {
                "type": "array",
                "items": {
                    "anyOf": [
                        {
                            "type": "object",
                            "description": "Update a block",
                            "properties": {
                                "type": { "type": "string", "enum": ["update"] },
                                "id": { "type": "string", "description": "id of block to update" },
                                "block": {
                                    "type": "string",
                                    "description": "html of block (MUST be a single HTML element)"
                                }
                            },
                            "required": ["type", "id", "block"],
                            "additionalProperties": false
                        },
                        {
                            "type": "object",
                            "description": "Insert new blocks",
                            "properties": {
                                "type": { "type": "string", "enum": ["add"] },
                                "referenceId": {
                                    "type": "string",
                                    "description": "MUST be an id of a block in the document"
                                },
                                "position": {
                                    "type": "string",
                                    "enum": ["before", "after"],
                                    "description": "`after` to add blocks AFTER (below) the block with `referenceId`, `before` to add the block BEFORE (above)"
                                },
                                "blocks": {
                                    "type": "array",
                                    "items": {
                                        "type": "string",
                                        "description": "html of block (MUST be a single, VALID HTML element)"
                                    }
                                }
                            },
                            "required": ["type", "referenceId", "position", "blocks"],
                            "additionalProperties": false
                        },
                        {
                            "type": "object",
                            "description": "Delete a block",
                            "properties": {
                                "type": { "type": "string", "enum": ["delete"] },
                                "id": { "type": "string", "description": "id of block to delete" }
                            },
                            "required": ["type", "id"],
                            "additionalProperties": false
                        }
                    ]
                }
            }
        },
        "required": ["operations"],
        "additionalProperties": false
    })
}

/// OpenAI-compatible function tool definition used on both desktop and web.
pub fn openai_document_operation_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": DOCUMENT_OPERATION_TOOL,
            "description": "Apply grounded HTML block operations to the document.",
            "parameters": document_operation_tool_schema()
        }
    })
}

/// Wrap the operation schema in provider tool-definition shape.
#[allow(dead_code)]
pub fn document_operation_tool_definition() -> Value {
    json!({
        DOCUMENT_OPERATION_TOOL: {
            "description": "Apply grounded HTML block operations to the document.",
            "inputSchema": document_operation_tool_schema(),
            "outputSchema": { "type": "object" }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_serializes_stable_operation_union() {
        let schema = document_operation_tool_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["required"][0], "operations");
        let operations = &schema["properties"]["operations"]["items"]["anyOf"];
        assert_eq!(operations.as_array().unwrap().len(), 3);
        assert_eq!(operations[0]["properties"]["type"]["enum"][0], "update");
        assert_eq!(operations[1]["properties"]["type"]["enum"][0], "add");
        assert_eq!(operations[2]["properties"]["type"]["enum"][0], "delete");
    }

    #[test]
    fn tool_definition_uses_stable_name_and_schema() {
        let definition = document_operation_tool_definition();
        assert_eq!(
            definition[DOCUMENT_OPERATION_TOOL]["inputSchema"]["type"],
            "object"
        );
        assert_eq!(
            definition[DOCUMENT_OPERATION_TOOL]["outputSchema"]["type"],
            "object"
        );
        let openai = openai_document_operation_tool();
        assert_eq!(openai["function"]["name"], DOCUMENT_OPERATION_TOOL);
        assert_eq!(
            openai["function"]["parameters"]["required"][0],
            "operations"
        );
    }
}
