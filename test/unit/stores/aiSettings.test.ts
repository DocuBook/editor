import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../../__fixtures__/memoryStorage";

// Zustand persist needs browser storage even in the Node test environment.
const { storage: localStorage, values: storage } = createMemoryStorage();
vi.stubGlobal("localStorage", localStorage);
vi.stubGlobal("window", { localStorage });

const { useAiSettings, hydrateAiSettings, setSavedProviders } = await import("../../../frontend/stores/aiSettings");

// The store talks to the backend through the ipc bridge; hydration is the only
// path under test here, so the bridge is mocked per test.
const invoke = vi.fn();
vi.mock("../../../frontend/lib/ipc", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

const DEFAULTS = {
  provider: "",
  model: "",
  apiKey: "",
  savedProviders: [],
  apiKeys: {},
  models: {},
  baseUrls: {},
  probeTools: {},
};

describe("aiSettings store", () => {
  beforeEach(() => {
    useAiSettings.setState(DEFAULTS);
    invoke.mockReset();
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

  it("hydrateAiSettings restores provider, model, and providers from the backend", async () => {
    // The real scenario: a new browser/device where localStorage holds nothing.
    invoke.mockResolvedValue(
      JSON.stringify({
        provider: "anthropic",
        model: "claude-sonnet-5",
        savedProviders: ["anthropic", "openai-compatible"],
      })
    );
    await hydrateAiSettings();

    expect(useAiSettings.getState().provider).toBe("anthropic");
    expect(useAiSettings.getState().model).toBe("claude-sonnet-5");
    expect(useAiSettings.getState().savedProviders).toEqual(["anthropic", "openai-compatible"]);
  });

  it("hydrateAiSettings does not override a provider chosen in this browser", async () => {
    useAiSettings.getState().setProvider("deepseek");
    invoke.mockResolvedValue(
      JSON.stringify({ provider: "anthropic", model: "claude-sonnet-5", savedProviders: ["anthropic"] })
    );
    await hydrateAiSettings();

    expect(useAiSettings.getState().provider).toBe("deepseek");
    // Union, not replace: the server's view is merged in without dropping what
    // this browser already had (see the empty-keys.json regression below).
    expect(useAiSettings.getState().savedProviders).toContain("anthropic");
  });

  it("hydrateAiSettings keeps a locally-saved provider the backend does not know", async () => {
    // Regression: a browser seeded with a saved provider but an empty keys.json
    // used to have `savedProviders` replaced by the server's empty list, which
    // flipped aiConfigured false and disabled the AI composer permanently.
    useAiSettings.setState({ provider: "openai-compatible", savedProviders: ["openai-compatible"] });
    invoke.mockResolvedValue(
      JSON.stringify({ provider: "", model: "", savedProviders: [] })
    );
    await hydrateAiSettings();

    expect(useAiSettings.getState().savedProviders).toEqual(["openai-compatible"]);
  });

  it("setSavedProviders merges instead of dropping local entries", () => {
    useAiSettings.setState({ savedProviders: ["openai-compatible"] });
    setSavedProviders(["anthropic"]);
    expect(useAiSettings.getState().savedProviders).toEqual(["openai-compatible", "anthropic"]);
    // Idempotent: re-hydrating with a known provider must not duplicate it.
    setSavedProviders(["anthropic"]);
    expect(useAiSettings.getState().savedProviders).toEqual(["openai-compatible", "anthropic"]);
  });

  it("hydrateAiSettings restores a custom endpoint base URL from the backend", async () => {
    // keys.json/keychain own the bound URL, so a fresh browser must be able to
    // read it back even though localStorage lost it.
    invoke.mockResolvedValue(
      JSON.stringify({
        provider: "openai-compatible",
        model: "local-model",
        savedProviders: ["openai-compatible"],
        baseUrl: "https://gateway.example.com/v1",
      })
    );
    await hydrateAiSettings();

    expect(useAiSettings.getState().provider).toBe("openai-compatible");
    expect(useAiSettings.getState().baseUrls["openai-compatible"]).toBe(
      "https://gateway.example.com/v1"
    );
  });

  it("hydrateAiSettings restores measured probe results from the backend", async () => {
    // A fresh browser must not re-probe: each measurement is a network round-trip
    // (two requests), and until it lands the provider runs text-only.
    invoke.mockResolvedValue(
      JSON.stringify({
        provider: "anthropic",
        model: "claude-sonnet-5",
        savedProviders: ["anthropic"],
        probes: { anthropic: { "claude-sonnet-5": true, "claude-haiku-5": false } },
      })
    );
    await hydrateAiSettings();

    expect(useAiSettings.getState().probeTools["anthropic"]?.["claude-sonnet-5"]).toBe(true);
    expect(useAiSettings.getState().probeTools["anthropic"]?.["claude-haiku-5"]).toBe(false);
  });

  it("hydrateAiSettings prefers backend probes on conflicts", async () => {
    // Keep local-only entries, but a shared backend measurement wins when the
    // same provider/model was re-tested from another browser.
    useAiSettings.getState().setProbeTools("anthropic", "local-only", true);
    useAiSettings.getState().setProbeTools("anthropic", "shared", false);
    invoke.mockResolvedValue(
      JSON.stringify({
        provider: "anthropic",
        model: "claude-sonnet-5",
        savedProviders: ["anthropic"],
        probes: { anthropic: { "server-only": false, shared: true } },
      })
    );
    await hydrateAiSettings();

    expect(useAiSettings.getState().probeTools["anthropic"]?.["local-only"]).toBe(true);
    expect(useAiSettings.getState().probeTools["anthropic"]?.["server-only"]).toBe(false);
    expect(useAiSettings.getState().probeTools["anthropic"]?.shared).toBe(true);
  });

  it("hydrateAiSettings ignores a malformed probe map", async () => {
    // Non-boolean probe values would make `!== true` silently mean text-only, so
    // a bad payload must be dropped rather than stored.
    invoke.mockResolvedValue(
      JSON.stringify({
        provider: "anthropic",
        model: "m",
        savedProviders: ["anthropic"],
        probes: { anthropic: { ok: true, bad: "yes" } },
      })
    );
    await hydrateAiSettings();

    expect(useAiSettings.getState().probeTools).toEqual({});
  });

  it("mirrors probe results to the backend so they survive a browser change", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue("null");
    useAiSettings.getState().setProbeTools("anthropic", "claude-sonnet-5", true);
    await vi.advanceTimersByTimeAsync(600);

    expect(invoke).toHaveBeenCalledWith(
      "set_probes",
      expect.objectContaining({ probes: { anthropic: { "claude-sonnet-5": true } } })
    );
    vi.useRealTimers();
  });

  it("does not re-mirror probes that are already stored", async () => {
    // Auto-probe can set the same result repeatedly; each write is a file rewrite.
    vi.useFakeTimers();
    invoke.mockResolvedValue("null");
    useAiSettings.getState().setProbeTools("anthropic", "claude-sonnet-5", true);
    await vi.advanceTimersByTimeAsync(600);
    invoke.mockClear();

    useAiSettings.getState().setProbeTools("anthropic", "claude-sonnet-5", true);
    await vi.advanceTimersByTimeAsync(600);

    expect(invoke).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("hydrateAiSettings keeps local state when the backend command is unavailable", async () => {
    invoke.mockRejectedValue(new Error("unknown command"));
    await expect(hydrateAiSettings()).resolves.toBeUndefined();
    expect(useAiSettings.getState().provider).toBe("");
  });

  it("mirrors the selection to the backend on provider and model change", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue('null');

    useAiSettings.getState().setProvider('anthropic');
    vi.advanceTimersByTime(600);

    expect(invoke).toHaveBeenCalledWith('set_ai_settings', {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    vi.useRealTimers();
  });

  it("coalesces a burst of model edits into one backend write", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue('null');
    useAiSettings.setState({ provider: 'anthropic', model: '' });
    invoke.mockClear();

    // A model id typed by hand: one write, not one per keystroke.
    for (const value of ['c', 'cl', 'cla', 'clau', 'claud', 'claude-3']) {
      useAiSettings.getState().setModel(value);
    }
    vi.advanceTimersByTime(600);

    const writes = invoke.mock.calls.filter(([cmd]) => cmd === 'set_ai_settings');
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toEqual({ provider: 'anthropic', model: 'claude-3' });
    vi.useRealTimers();
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
