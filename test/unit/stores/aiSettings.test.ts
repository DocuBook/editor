import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../../__fixtures__/memoryStorage";

// Zustand persist needs browser storage even in the Node test environment.
const { storage: localStorage, values: storage } = createMemoryStorage();
vi.stubGlobal("localStorage", localStorage);
vi.stubGlobal("window", { localStorage });

const { useAiSettings } = await import("../../../frontend/stores/aiSettings");

const DEFAULTS = {
  provider: "",
  model: "",
  apiKey: "",
  savedProviders: [],
  apiKeys: {},
  models: {},
};

describe("aiSettings store", () => {
  beforeEach(() => {
    useAiSettings.setState(DEFAULTS);
  });

  it("starts with empty defaults", () => {
    const s = useAiSettings.getState();
    expect(s.provider).toBe("");
    expect(s.model).toBe("");
    expect(s.apiKey).toBe("");
    expect(s.savedProviders).toEqual([]);
    expect(s.apiKeys).toEqual({});
    expect(s.models).toEqual({});
  });

  it("setModel saves per-provider and restores on provider switch", () => {
    useAiSettings.getState().setProvider("openai");
    useAiSettings.getState().setModel("gpt-5.6");
    expect(useAiSettings.getState().model).toBe("gpt-5.6");
    expect(useAiSettings.getState().models["openai"]).toBe("gpt-5.6");

    // switch to another provider, pick a different model
    useAiSettings.getState().setProvider("anthropic");
    expect(useAiSettings.getState().model).toBe("claude-sonnet-5");
    useAiSettings.getState().setModel("opus-5");
    expect(useAiSettings.getState().models["anthropic"]).toBe("opus-5");

    // switch back — last model for openai is restored, not defaulted to cheapest
    useAiSettings.getState().setProvider("openai");
    expect(useAiSettings.getState().model).toBe("gpt-5.6");

    useAiSettings.getState().setProvider("anthropic");
    expect(useAiSettings.getState().model).toBe("opus-5");
  });

  it("setProvider uses valid bootstrap models before keyed discovery is available", () => {
    for (const [provider, model] of [
      ["opencode-go", "deepseek-v4-flash"],
      ["anthropic", "claude-sonnet-5"],
      ["google", "gemini-3.7-flash"],
      ["deepseek", "deepseek-v4-flash"],
    ]) {
      useAiSettings.getState().setProvider(provider);
      expect(useAiSettings.getState().model).toBe(model);
    }
  });

  it("setProvider keeps unknown providers empty", () => {
    useAiSettings.getState().setProvider("groq");
    expect(useAiSettings.getState().model).toBe("");
  });

  it("setProvider loads apiKey from apiKeys", () => {
    useAiSettings.getState().setProvider("openai");
    useAiSettings.getState().setApiKey("sk-openai");
    useAiSettings.getState().setProvider("mistral");
    expect(useAiSettings.getState().apiKey).toBe("");

    useAiSettings.getState().setApiKey("sk-mistral");
    useAiSettings.getState().setProvider("openai");
    expect(useAiSettings.getState().apiKey).toBe("sk-openai");

    useAiSettings.getState().setProvider("mistral");
    expect(useAiSettings.getState().apiKey).toBe("sk-mistral");
  });

  it("setApiKey does not leak keys across providers", () => {
    useAiSettings.getState().setProvider("openai");
    useAiSettings.getState().setApiKey("sk-openai");

    useAiSettings.getState().setProvider("mistral");
    useAiSettings.getState().setApiKey("sk-mistral");

    expect(useAiSettings.getState().provider).toBe("mistral");
    expect(useAiSettings.getState().apiKeys["openai"]).toBe("sk-openai");
    expect(useAiSettings.getState().apiKeys["mistral"]).toBe("sk-mistral");
    expect(useAiSettings.getState().apiKey).toBe("sk-mistral");
  });

  it("clearApiKey removes key from apiKeys", () => {
    useAiSettings.getState().setProvider("openai");
    useAiSettings.getState().setApiKey("sk-1");
    expect(useAiSettings.getState().apiKeys["openai"]).toBe("sk-1");

    useAiSettings.getState().clearApiKey("openai");
    expect(useAiSettings.getState().apiKeys["openai"]).toBeUndefined();
    expect(useAiSettings.getState().apiKey).toBe("");
  });

  it("clearApiKey only clears current apiKey when matching provider", () => {
    useAiSettings.getState().setProvider("openai");
    useAiSettings.getState().setApiKey("sk-openai");

    useAiSettings.getState().setProvider("mistral");
    useAiSettings.getState().setApiKey("sk-mistral");

    // Clear mistral (current provider)
    useAiSettings.getState().clearApiKey("mistral");
    expect(useAiSettings.getState().apiKey).toBe("");
    expect(useAiSettings.getState().apiKeys["openai"]).toBe("sk-openai");
    expect(useAiSettings.getState().apiKeys["mistral"]).toBeUndefined();
  });

  it("clearApiKey does not clear current apiKey for different provider", () => {
    useAiSettings.getState().setProvider("openai");
    useAiSettings.getState().setApiKey("sk-openai");

    useAiSettings.getState().setProvider("mistral");
    useAiSettings.getState().setApiKey("sk-mistral");

    // Clear openai (non-current provider)
    useAiSettings.getState().clearApiKey("openai");
    expect(useAiSettings.getState().apiKey).toBe("sk-mistral");
    expect(useAiSettings.getState().apiKeys["openai"]).toBeUndefined();
    expect(useAiSettings.getState().apiKeys["mistral"]).toBe("sk-mistral");
  });

  it("addSavedProvider and removeSavedProvider", () => {
    useAiSettings.getState().addSavedProvider("openai");
    expect(useAiSettings.getState().savedProviders).toEqual(["openai"]);

    useAiSettings.getState().addSavedProvider("mistral");
    expect(useAiSettings.getState().savedProviders).toEqual([
      "openai",
      "mistral",
    ]);

    useAiSettings.getState().removeSavedProvider("openai");
    expect(useAiSettings.getState().savedProviders).toEqual(["mistral"]);
  });

  it("addSavedProvider deduplicates", () => {
    useAiSettings.getState().addSavedProvider("openai");
    useAiSettings.getState().addSavedProvider("openai");
    expect(useAiSettings.getState().savedProviders).toEqual(["openai"]);
  });

  it("never persists apiKey or apiKeys to storage", () => {
    useAiSettings.getState().setProvider("openai");
    useAiSettings.getState().setApiKey("sk-secret-42");
    const persisted = storage.get("docubook:ai-settings");
    expect(persisted).toBeDefined();
    expect(persisted).not.toContain("sk-secret-42");
    expect(persisted).not.toContain("apiKey");
  });

  it("custom base URL persists per-provider (openai-compatible)", () => {
    useAiSettings.getState().setProvider("openai-compatible");
    useAiSettings.getState().setBaseUrl("https://proxy.example.com/v1");
    expect(useAiSettings.getState().baseUrls["openai-compatible"]).toBe(
      "https://proxy.example.com/v1",
    );

    useAiSettings.getState().setProvider("openai");
    expect(useAiSettings.getState().baseUrls["openai-compatible"]).toBe(
      "https://proxy.example.com/v1",
    );

    // switching back restores the custom URL input source
    useAiSettings.getState().setProvider("openai-compatible");
    expect(useAiSettings.getState().baseUrls["openai-compatible"]).toBe(
      "https://proxy.example.com/v1",
    );
  });

  it("probeTools persist per-provider+model (measured tool-call support)", () => {
    useAiSettings.getState().setProbeTools("test-provider", "model-a", false);
    expect(
      useAiSettings.getState().probeTools["test-provider"]?.["model-a"],
    ).toBe(false);
    useAiSettings.getState().setProbeTools("openai-compatible", "gpt-4o", true);
    expect(
      useAiSettings.getState().probeTools["openai-compatible"]?.["gpt-4o"],
    ).toBe(true);
    /** a different model on the same provider keeps its own measurement */
    useAiSettings
      .getState()
      .setProbeTools("openai-compatible", "gpt-4o-mini", false);
    expect(
      useAiSettings.getState().probeTools["openai-compatible"]?.["gpt-4o"],
    ).toBe(true);
    expect(
      useAiSettings.getState().probeTools["openai-compatible"]?.["gpt-4o-mini"],
    ).toBe(false);
  });
});
