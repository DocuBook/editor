
use std::path::Path;
use serde::{Serialize, Deserialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct DocuJson {
    pub meta: MetaConfig,
    pub routes: Vec<RouteConfig>,
    pub ai: Option<AIConfig>,
}

impl Default for DocuJson {
    fn default() -> Self {
        Self { meta: MetaConfig { title: "My Project".into(), base_url: "/".into() }, routes: vec![], ai: None }
    }
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct MetaConfig { pub title: String, pub base_url: String }

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct RouteConfig { pub path: String, pub title: String, pub file: String }

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct AIConfig { pub provider: String, pub model: String, pub base_url: Option<String> }



pub fn read_config(root: &Path) -> Result<DocuJson, String> {
    let path = root.join("docu.json");
    let data = std::fs::read_to_string(&path).map_err(|e| format!("Read docu.json: {}", e))?;
    serde_json::from_str(&data).map_err(|e| format!("Parse docu.json: {}", e))
}

pub fn write_config(root: &Path, cfg: &DocuJson) -> Result<(), String> {
    let path = root.join("docu.json");
    let data = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, &data).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_values() {
        let cfg = DocuJson::default();
        assert_eq!(cfg.meta.title, "My Project");
        assert_eq!(cfg.meta.base_url, "/");
        assert!(cfg.routes.is_empty());
        assert!(cfg.ai.is_none());
    }

    #[test]
    fn config_roundtrip_json() {
        let cfg = DocuJson {
            meta: MetaConfig { title: "Test".into(), base_url: "/docs/".into() },
            routes: vec![RouteConfig { path: "intro".into(), title: "Intro".into(), file: "intro.md".into() }],
            ai: Some(AIConfig { provider: "openai".into(), model: "gpt-4".into(), base_url: None }),
        };
        let json = serde_json::to_string_pretty(&cfg).unwrap();
        let parsed: DocuJson = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.meta.title, "Test");
        assert_eq!(parsed.routes.len(), 1);
        assert_eq!(parsed.routes[0].path, "intro");
        assert!(parsed.ai.is_some());
        assert_eq!(parsed.ai.unwrap().provider, "openai");
    }
}
