/// AI agent configuration for API calls.
pub struct Agent {
    /* used in UI to label which provider served the response */
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
}

impl Agent {
/** Create a new AI agent with explicit config. */
    pub fn new(provider: &str, model: &str, api_key: &str, base_url: &str) -> Self {
        Self { provider: provider.to_string(), model: model.to_string(), api_key: api_key.to_string(), base_url: base_url.to_string() }
    }

}

/** Hosts allowed as AI API base URLs — mirrors the models.dev provider catalog
 *  (src/data/providers.ts `api` field, auto-extracted). Loopback hosts
 *  (localhost/127.0.0.1/::1) are accepted for local LLM servers. */
pub const ALLOWED_API_HOSTS: &[&str] = &[
    "127.0.0.1",
    "api.anthropic.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
    "ai-gateway.helicone.ai",
    "ai.zenifra.com",
    "aki.io",
    "api-inference.modelscope.cn",
    "api-sherlock.cloudferro.com",
    "api.302.ai",
    "api.abliteration.ai",
    "api.ai-router.dev",
    "api.aiand.com",
    "api.ambient.xyz",
    "api.anyapi.ai",
    "api.auriko.ai",
    "api.berget.ai",
    "api.clarifai.com",
    "api.claudin.io",
    "api.cline.bot",
    "api.cloudflare.com",
    "api.code.umans.ai",
    "api.cortecs.ai",
    "api.crossmodel.ai",
    "api.deepseek.com",
    "api.dinference.com",
    "api.empiriolabs.ai",
    "api.fireworks.ai",
    "api.friendli.ai",
    "api.getlilac.com",
    "api.githubcopilot.com",
    "api.gmi-serving.com",
    "api.hpc-ai.com",
    "api.inceptionlabs.ai",
    "api.inceptron.io",
    "api.inference.wandb.ai",
    "api.intelligence.io.solutions",
    "api.jiekou.ai",
    "api.kilo.ai",
    "api.kimi.com",
    "api.lkeap.cloud.tencent.com",
    "api.llama.com",
    "api.llmgateway.io",
    "api.longcat.chat",
    "api.lucidquery.com",
    "api.meganova.ai",
    "api.meta.ai",
    "api.minimax.io",
    "api.minimaxi.com",
    "api.modeloracle.com",
    "api.moonshot.ai",
    "api.moonshot.cn",
    "api.morphllm.com",
    "api.neuralwatt.com",
    "api.nova.amazon.com",
    "api.novita.ai",
    "api.ofox.ai",
    "api.openai-compat.model-serving.eu01.onstackit.cloud",
    "api.orcarouter.ai",
    "api.perplexity.ai",
    "api.pioneer.ai",
    "api.poe.com",
    "api.qhaigc.net",
    "api.qnaigc.com",
    "api.regolo.ai",
    "api.routing.run",
    "api.sakana.ai",
    "api.sarvam.ai",
    "api.scaleway.ai",
    "api.siliconflow.cn",
    "api.siliconflow.com",
    "api.stepfun.ai",
    "api.stepfun.com",
    "api.subconscious.dev",
    "api.synthetic.new",
    "api.tbox.cn",
    "api.thegrid.ai",
    "api.tokenfactory.nebius.com",
    "api.trustedrouter.com",
    "api.unorouter.com",
    "api.upstage.ai",
    "api.vivgrid.com",
    "api.vultrinference.com",
    "api.xiaomimimo.com",
    "api.z.ai",
    "api.zeldoc.ai",
    "apis.iflow.cn",
    "app.frogbot.ai",
    "cc.freemodel.dev",
    "chat.d.run",
    "cloud-api.near.ai",
    "coding-intl.dashscope.aliyuncs.com",
    "coding-plan-endpoint.kuaecloud.net",
    "coding.dashscope.aliyuncs.com",
    "crof.ai",
    "daoxe.com",
    "dashscope-intl.aliyuncs.com",
    "dashscope.aliyuncs.com",
    "go.fastrouter.ai",
    "hyper.charm.land",
    "inference.baseten.co",
    "inference.do-ai.run",
    "inference.hetzner.com",
    "inference.net",
    "inference.poolside.ai",
    "inference.tinfoil.sh",
    "inference.us-west.modal.direct",
    "integrate.api.nvidia.com",
    "kenari.id",
    "llm.chutes.ai",
    "llm.submodel.ai",
    "llmtr.com",
    "localhost",
    "maas-api.ebcloud.com",
    "moark.com",
    "model.inferx.net",
    "models.github.ai",
    "models.mixlayer.ai",
    "models.think.evroc.com",
    "nano-gpt.com",
    "oai.endpoints.kepler.ai.cloud.ovh.net",
    "ollama.com",
    "open.bigmodel.cn",
    "openai.blueclaw.network",
    "opencode.ai",
    "openrouter.ai",
    "pass.wafer.ai",
    "routellm.abacus.ai",
    "router.huggingface.co",
    "router.requesty.ai",
    "tinker.thinkingmachines.dev",
    "token-plan-ams.xiaomimimo.com",
    "token-plan-cn.xiaomimimo.com",
    "token-plan-sgp.xiaomimimo.com",
    "token-plan.ap-southeast-1.maas.aliyuncs.com",
    "token-plan.cn-beijing.maas.aliyuncs.com",
    "tokenhub.tencentmaas.com",
    "www.xpersona.co",
    "zenmux.ai",
];

/** True if the host is a loopback address (localhost, 127.0.0.1, ::1). */
fn is_loopback(host: &str) -> bool {
    host == "localhost" || host.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

/** Validate a base URL for the AI transport — SSRF / API-key exfiltration guard.\n *  Rules: scheme must be https (or http to loopback only); host must be in\n *  ALLOWED_API_HOSTS (provider catalog) or loopback; IP literals in\n *  private/link-local/reserved ranges are rejected. */
pub fn validate_base_url(base_url: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(base_url).map_err(|_| format!("Invalid base URL: {}", base_url))?;
    let host = url.host_str().unwrap_or("").to_lowercase();
    match url.scheme() {
        "https" => {}
        "http" => {
            if !is_loopback(&host) {
                return Err("HTTP base URLs are only allowed for local (localhost) servers".into());
            }
        }
        _ => return Err("Base URL must use http(s)".into()),
    }
    if !ALLOWED_API_HOSTS.contains(&host.as_str()) && !is_loopback(&host) {
        return Err(format!("Base URL host \"{}\" is not an allowed provider endpoint", host));
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        let internal_non_loopback = match ip {
            std::net::IpAddr::V4(v) => !v.is_loopback() && (v.is_private() || v.is_link_local() || v.is_unspecified() || v.is_multicast()),
            std::net::IpAddr::V6(v) => !v.is_loopback() && (v.is_unspecified() || v.is_multicast()),
        };
        if internal_non_loopback {
            return Err("Internal network addresses are not allowed".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_new_constructs_struct() {
        let a = Agent::new("test-provider", "test-model", "sk-test-key", "https://test.com/v1");
        assert_eq!(a.provider, "test-provider");
        assert_eq!(a.model, "test-model");
        assert_eq!(a.api_key, "sk-test-key");
        assert_eq!(a.base_url, "https://test.com/v1");
    }

    #[test]
    fn agent_supports_all_providers() {
        for (provider, model) in [
            ("openai", "gpt-4o"),
            ("anthropic", "claude-sonnet-4-20250514"),
            ("google", "gemini-2.0-flash"),
            ("openrouter", "openai/gpt-4o"),
        ] {
            let cfg = Agent::new(provider, model, "key", "");
            assert_eq!(cfg.provider, provider);
            assert_eq!(cfg.model, model);
            assert_eq!(cfg.api_key, "key");
        }
    }

    #[test]
    fn validate_base_url_allows_providers_and_loopback() {
        assert!(validate_base_url("https://api.openai.com/v1").is_ok());
        assert!(validate_base_url("https://openrouter.ai/api/v1").is_ok());
        assert!(validate_base_url("https://api.deepseek.com/v1").is_ok());
        assert!(validate_base_url("http://localhost:11434/v1").is_ok());
        assert!(validate_base_url("http://127.0.0.1:8080/v1").is_ok());
    }

    #[test]
    fn validate_base_url_rejects_ssrf_and_exfil() {
        // metadata / internal IPs
        assert!(validate_base_url("http://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_base_url("https://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_base_url("http://10.0.0.1/v1").is_err());
        assert!(validate_base_url("http://192.168.1.1/v1").is_err());
        // arbitrary hosts (exfiltration target)
        assert!(validate_base_url("https://evil.example.com/v1").is_err());
        assert!(validate_base_url("http://evil.example.com/v1").is_err());
        // bad schemes / malformed
        assert!(validate_base_url("ftp://x/v1").is_err());
        assert!(validate_base_url("not-a-url").is_err());
    }
}
