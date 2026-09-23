import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../../__fixtures__/memoryStorage";

/** A storage that WOULD receive anything the store persisted. The store must leave
 *  it untouched: config.json on the backend is the only source of truth. */
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
  dirtySelection: false,
};

/** The backend payload in its current shape: one entry per configured provider. */
const payload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    active: "opencode-go",
    endpoints: {
      'opencode-go': { baseUrl: "https://opencode.ai/zen/go/v1", model: "deepseek-v4-flash", probes: {}, hasKey: true },
    },
    savedProviders: ["opencode-go"],
    ...over,
  });

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

  it("never writes AI config to localStorage — the backend is the only store", async () => {
    // The reported bug: a browser that persisted its own copy rendered stale (or
    // empty) fields instead of what config.json says. Any AI write here would
    // reintroduce a second source of truth.
    invoke.mockResolvedValue(payload());
    useAiSettings.getState().setProvider("opencode-go");
    useAiSettings.getState().setModel("deepseek-v4-flash");
    useAiSettings.getState().setApiKey("sk-secret-42");
    await hydrateAiSettings();

    expect(storage.get("docubook:ai-settings")).toBeUndefined();
  });

  it("hydrateAiSettings SETS state from the backend (server is authoritative)", async () => {
    // A new browser/device holds nothing, but the full payload must land in state.
    invoke.mockResolvedValue(payload());
    await hydrateAiSettings();

    expect(useAiSettings.getState().provider).toBe("opencode-go");
    expect(useAiSettings.getState().model).toBe("deepseek-v4-flash");
    expect(useAiSettings.getState().savedProviders).toEqual(["opencode-go"]);
    expect(useAiSettings.getState().baseUrls["opencode-go"]).toBe("https://opencode.ai/zen/go/v1");
    expect(useAiSettings.getState().models["opencode-go"]).toBe("deepseek-v4-flash");
  });

  it("hydrateAiSettings does not leave stale local state behind", async () => {
    // The old "adopt only if empty" rule kept a browser's own pick forever. The
    // server now owns the selection, so a reload lands on the backend's value.
    useAiSettings.getState().setProvider("deepseek");
    invoke.mockResolvedValue(payload());
    await hydrateAiSettings();

    expect(useAiSettings.getState().provider).toBe("opencode-go");
    expect(useAiSettings.getState().savedProviders).toEqual(["opencode-go"]);
  });

  it("hydrateAiSettings replaces savedProviders with the server list", async () => {
    // Revoke on another device must be visible here: a union would resurrect the
    // provider and re-enable the composer for a key that no longer exists.
    useAiSettings.setState({ provider: "openai-compatible", savedProviders: ["openai-compatible"] });
    invoke.mockResolvedValue(payload());
    await hydrateAiSettings();

    expect(useAiSettings.getState().savedProviders).toEqual(["opencode-go"]);
  });

  it("a repeat hydration preserves a live composer pick instead of re-applying the backend's stale active model", async () => {
    // The reported bug: picking a model in the composer went back to the
    // currently active model. Composer picks are session-local (Settings Save is
    // what tells the backend), so a delayed/boot-retry hydration that still
    // reports the old active model must not clobber them. A fresh session (no
    // pick, dirtySelection false) still adopts the server selection.
    invoke.mockResolvedValue(payload());
    await hydrateAiSettings(); // first hydration adopts the backend
    expect(useAiSettings.getState().model).toBe("deepseek-v4-flash");

    useAiSettings.getState().setModel("deepseek-reasoner");
    useAiSettings.getState().markSelectionDirty();

    await hydrateAiSettings(); // pending retry lands with the old active model
    expect(useAiSettings.getState().model).toBe("deepseek-reasoner");
    expect(useAiSettings.getState().provider).toBe("opencode-go");
    // The data still refreshes — only the live selection is preserved.
    expect(useAiSettings.getState().savedProviders).toEqual(["opencode-go"]);
    expect(useAiSettings.getState().models["opencode-go"]).toBe("deepseek-v4-flash");
  });

  it("hydrateAiSettings restores a custom endpoint base URL from the backend", async () => {
    // keys.json/keychain own the bound URL, so a fresh browser must be able to
    // read it back even though it stores nothing locally.
    invoke.mockResolvedValue(
      JSON.stringify({
        active: "openai-compatible",
        endpoints: {
          "openai-compatible": { baseUrl: "https://gateway.example.com/v1", model: "local-model", probes: {}, hasKey: true },
        },
        savedProviders: ["openai-compatible"],
      })
    );
    await hydrateAiSettings();

    expect(useAiSettings.getState().provider).toBe("openai-compatible");
    expect(useAiSettings.getState().model).toBe("local-model");
    expect(useAiSettings.getState().baseUrls["openai-compatible"]).toBe(
      "https://gateway.example.com/v1"
    );
  });

  it("hydrateAiSettings restores measured probe results from the backend", async () => {
    // A fresh browser must not re-probe: each measurement is a network round-trip
    // (two requests), and until it lands the provider runs text-only.
    invoke.mockResolvedValue(
      JSON.stringify({
        active: "opencode-go",
        endpoints: {
          'opencode-go': {
            baseUrl: "https://opencode.ai/zen/go/v1",
            model: "deepseek-v4-flash",
            probes: { "deepseek-v4-flash": true, "deepseek-v4-chat": false },
            hasKey: true,
          },
        },
        savedProviders: ["opencode-go"],
      })
    );
    await hydrateAiSettings();

    expect(useAiSettings.getState().probeTools["opencode-go"]?.["deepseek-v4-flash"]).toBe(true);
    expect(useAiSettings.getState().probeTools["opencode-go"]?.["deepseek-v4-chat"]).toBe(false);
  });

  it("hydrateAiSettings keeps multi-endpoint probes apart", async () => {
    // Several providers can be configured at once (like Zed); probes are nested
    // per endpoint, so one provider's measurements must not leak into another.
    invoke.mockResolvedValue(
      JSON.stringify({
        active: "opencode-go",
        endpoints: {
          "opencode-go": { baseUrl: "https://opencode.ai/zen/go/v1", model: "deepseek-v4-flash", probes: { "deepseek-v4-flash": true }, hasKey: true },
          "openai-compatible": { baseUrl: "https://kenari.id/v1", model: "deepseek-v4-1-flash", probes: {}, hasKey: true },
        },
        savedProviders: ["opencode-go", "openai-compatible"],
      })
    );
    await hydrateAiSettings();

    expect(useAiSettings.getState().probeTools["opencode-go"]).toEqual({ "deepseek-v4-flash": true });
    expect(useAiSettings.getState().probeTools["openai-compatible"]).toEqual({});
  });

  it("hydrateAiSettings applies the env override to the custom provider", async () => {
    // DB_OPENAI_COMPAT_* wins server-side, so the UI must render the env values
    // as the custom provider's endpoint rather than a stale file value.
    invoke.mockResolvedValue(
      JSON.stringify({
        active: "openai-compatible",
        endpoints: {
          "openai-compatible": { baseUrl: "https://old.example/v1", model: "old-model", probes: {}, hasKey: true },
        },
        savedProviders: ["openai-compatible"],
        env: { baseUrl: "https://x.example/v1", model: "m", hasKey: true },
      })
    );
    await hydrateAiSettings();

    expect(useAiSettings.getState().baseUrls["openai-compatible"]).toBe("https://x.example/v1");
    expect(useAiSettings.getState().model).toBe("m");
  });

  it("hydrateAiSettings ignores a malformed probe map", async () => {
    // Non-boolean probe values would make `!== true` silently mean text-only, so
    // a bad payload must be dropped rather than stored.
    invoke.mockResolvedValue(
      JSON.stringify({
        active: "opencode-go",
        endpoints: {
          'opencode-go': { baseUrl: "", model: "m", probes: { ok: true, bad: "yes" }, hasKey: true },
        },
        savedProviders: ["opencode-go"],
      })
    );
    await hydrateAiSettings();

    expect(useAiSettings.getState().probeTools["opencode-go"]).toEqual({ ok: true });
  });

  it("hydrateAiSettings ignores a malformed payload", async () => {
    // A half-parsed response must not overwrite state with empty fields.
    useAiSettings.setState({ provider: "opencode-go", model: "deepseek-v4-flash" });
    for (const raw of ["null", "[]", "not json", JSON.stringify({ endpoints: "nope", active: "" })]) {
      invoke.mockResolvedValue(raw);
      await hydrateAiSettings();

      expect(useAiSettings.getState().provider).toBe("opencode-go");
      expect(useAiSettings.getState().model).toBe("deepseek-v4-flash");
    }
  });

  it("hydrateAiSettings keeps local state when the backend command is unavailable", async () => {
    invoke.mockRejectedValue(new Error("unknown command"));
    await expect(hydrateAiSettings()).resolves.toBe(false);
    expect(useAiSettings.getState().provider).toBe("");
  });

  it("hydrateAiSettings survives a boot-time 401 and picks up the config when retried", async () => {
    // Browser B boots before login: auth_mw answers 401 for /api/ai_settings and
    // the failure is silent (catch → null → no setState). Without a retry the
    // composer would stay disabled forever even though the server holds the
    // config — the exact "must configure twice" gap. App gates hydration on
    // auth `ready`, so the second run here is the post-login retry.
    invoke.mockRejectedValue(new Error("Unauthorized"));
    await expect(hydrateAiSettings()).resolves.toBe(false);
    expect(useAiSettings.getState().provider).toBe("");
    expect(useAiSettings.getState().savedProviders).toEqual([]);

    invoke.mockResolvedValue(payload());
    await expect(hydrateAiSettings()).resolves.toBe(true);
    expect(useAiSettings.getState().provider).toBe("opencode-go");
    expect(useAiSettings.getState().savedProviders).toEqual(["opencode-go"]);
  });

  it("setSavedProviders replaces with the server list", () => {
    useAiSettings.setState({ savedProviders: ["openai-compatible"] });
    setSavedProviders(["opencode-go"]);
    expect(useAiSettings.getState().savedProviders).toEqual(["opencode-go"]);
    // Idempotent: re-hydrating with a known provider must not duplicate it.
    setSavedProviders(["opencode-go"]);
    expect(useAiSettings.getState().savedProviders).toEqual(["opencode-go"]);
  });

  it("setModel saves per-provider and restores on provider switch", () => {
    useAiSettings.getState().setProvider("openai");
    useAiSettings.getState().setModel("gpt-5.6");
    expect(useAiSettings.getState().model).toBe("gpt-5.6");
    expect(useAiSettings.getState().models["openai"]).toBe("gpt-5.6");

    // switch to another provider, pick a different model
    useAiSettings.getState().setProvider("opencode-go");
    expect(useAiSettings.getState().model).toBe("deepseek-v4-flash");
    useAiSettings.getState().setModel("opus-5");
    expect(useAiSettings.getState().models["opencode-go"]).toBe("opus-5");

    // switch back — last model for openai is restored, not defaulted to cheapest
    useAiSettings.getState().setProvider("openai");
    expect(useAiSettings.getState().model).toBe("gpt-5.6");

    useAiSettings.getState().setProvider("opencode-go");
    expect(useAiSettings.getState().model).toBe("opus-5");
  });

  it("setProvider uses valid bootstrap models before keyed discovery is available", () => {
    for (const [provider, model] of [
      ["opencode-go", "deepseek-v4-flash"],
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

  it("writes nothing to the backend on its own", async () => {
    // Selection and probes are persisted by explicit invokes (Save / Revoke /
    // auto-probe), never as a side effect of a state change — a UI that writes
    // over the backend is how endpoint values got silently overwritten.
    vi.useFakeTimers();
    invoke.mockResolvedValue("null");
    useAiSettings.getState().setProvider("opencode-go");
    useAiSettings.getState().setModel("deepseek-v4-reasoner");
    useAiSettings.getState().setProbeTools("opencode-go", "deepseek-v4-reasoner", true);
    useAiSettings.getState().setBaseUrl("https://proxy.example.com/v1");
    await vi.advanceTimersByTimeAsync(1000);

    expect(invoke).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("custom base URL is kept per-provider (openai-compatible)", () => {
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
