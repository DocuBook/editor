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

/** KaTeX output is injected with `dangerouslySetInnerHTML` (see MathPreview), and
 *  the formula source comes from note content. `trust` is what gates `\href`,
 *  `\url`, `\includegraphics` and the `\html*` commands, so it must be off on
 *  every render — even if a caller asks for it, and even though KaTeX defaults
 *  it to false today. Same regression shape as the Mermaid security pin. */
describe("KaTeX trust pinning", () => {
  it("forces trust off even when the caller asks for trust", () => {
    const render = vi.fn(() => "<span>k</span>");
    const cached = cachedRenderToString(render);

    cached("\\href{javascript:alert(1)}{x}", { trust: true, displayMode: true });

    expect(render).toHaveBeenCalledWith("\\href{javascript:alert(1)}{x}", {
      trust: false,
      displayMode: true,
    });
  });

  it("passes trust off when no options were given", () => {
    const render = vi.fn(() => "<span>k</span>");
    const cached = cachedRenderToString(render);

    cached("x");

    expect(render).toHaveBeenCalledWith("x", { trust: false });
  });

  it("keys the cache on the sanitized options, so trust:true cannot seed it", () => {
    const render = vi.fn(() => "<span>k</span>");
    const cached = cachedRenderToString(render);

    cached("y", { trust: true });
    cached("y", { trust: false });

    expect(render).toHaveBeenCalledOnce();
  });
});
