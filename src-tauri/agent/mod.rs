//! Shared AI provider policy compatibility exports.
//!
//! Provider configuration and endpoint validation live in `rust_ai::provider`.
//! This module keeps existing desktop/web call sites stable while consumers
//! migrate incrementally.

#[allow(unused_imports)]
pub use crate::rust_ai::provider::{
    catalog_base_url, fetch_models, session_id, validate_base_url, validate_custom_base_url,
    validate_provider_base_url, validated_custom_addrs, Agent, AI_USER_AGENT, CUSTOM_PROVIDER_ID,
    PROVIDER_IDS, SESSION_PROVIDER_ID,
};
