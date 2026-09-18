import { beforeEach, describe, expect, it, vi } from "vitest";
import { cachedRenderToString } from "../../../frontend/utils/mathRenderCache";
import { readCacheStats, resetCacheStats } from "../../../frontend/utils/cacheStats";

beforeEach(resetCacheStats);

describe("KaTeX render memo", () => {
  it("renders each source once and reuses the markup", () => {
    const render = vi.fn((tex: string) => `<span>${tex}</span>`);
    const cached = cachedRenderToString(render);

    expect(cached("x^2")).toBe("<span>x^2</span>");
    expect(cached("x^2")).toBe("<span>x^2</span>");
    expect(render).toHaveBeenCalledOnce();
  });

  it("keeps block and inline output apart, since displayMode changes the markup", () => {
    const render = vi.fn((tex: string, options?: { displayMode?: boolean }) =>
      `${options?.displayMode ? "block" : "inline"}:${tex}`,
    );
    const cached = cachedRenderToString(render as any);

    expect(cached("y_1", { displayMode: true })).toBe("block:y_1");
    expect(cached("y_1", { displayMode: false })).toBe("inline:y_1");
    expect(cached("y_1", { displayMode: true })).toBe("block:y_1");
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed render, so a half-typed formula re-renders as it changes", () => {
    const render = vi.fn(() => {
      throw new Error("bad latex");
    });
    const cached = cachedRenderToString(render);

    expect(() => cached("\\frac{")).toThrow("bad latex");
    expect(() => cached("\\frac{")).toThrow("bad latex");
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("records hits and misses for observability", () => {
    const cached = cachedRenderToString(() => "<span>k</span>");

    cached("z_9");
    cached("z_9");

    expect(readCacheStats()["katex-render"]).toMatchObject({ hits: 1, misses: 1 });
  });
});
