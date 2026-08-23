import { describe, expect, it, vi } from "vitest";
import {
  cacheMermaidRender,
  whenIdle,
} from "../../../frontend/utils/mermaidRenderCache";

describe("Mermaid rendering", () => {
  it("defers uncached work to the next available browser turn", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => "done");
    const pending = whenIdle(run);
    expect(run).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("done");
    vi.useRealTimers();
  });

  it("reuses a render and namespaces its SVG IDs per caller", async () => {
    const render = vi.fn(async (id: string) => ({
      svg: `<svg id="${id}"><path marker-end="url(#${id}-arrow)"/></svg>`,
    }));
    const cached = cacheMermaidRender(render);

    expect((await cached("first", "A --> B")).svg).toContain("first-arrow");
    expect((await cached("second", "A --> B")).svg).toContain("second-arrow");
    expect(render).toHaveBeenCalledOnce();
  });

  it("shares concurrent work and retries failed renders", async () => {
    let resolve!: (value: { svg: string }) => void;
    const render = vi.fn(
      () =>
        new Promise<{ svg: string }>((done) => {
          resolve = done;
        }),
    );
    const cached = cacheMermaidRender(render);
    const first = cached("one", "same");
    const second = cached("two", "same");
    resolve({ svg: '<svg id="one" />' });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(render).toHaveBeenCalledOnce();

    const failing = vi.fn(async () => {
      throw new Error("invalid");
    });
    const retryable = cacheMermaidRender(failing);
    await expect(retryable("one", "bad")).rejects.toThrow("invalid");
    await expect(retryable("two", "bad")).rejects.toThrow("invalid");
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
