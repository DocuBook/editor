import { describe, expect, it, vi } from "vitest";
import {
  cacheMermaidRender,
  createQueuedMermaidRender,
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

  it("serializes different Mermaid renders", async () => {
    vi.stubGlobal("requestIdleCallback", (run: () => void) => { run(); return 1; });
    let finishFirst!: (value: { svg: string }) => void;
    const render = vi.fn((id: string) =>
      id === "first"
        ? new Promise<{ svg: string }>((resolve) => { finishFirst = resolve; })
        : Promise.resolve({ svg: `<svg id="${id}" />` }),
    );
    const queued = createQueuedMermaidRender(render);
    const first = queued("first", "A --> B");
    const second = queued("second", "B --> C");
    await Promise.resolve();
    await Promise.resolve();

    expect(render).toHaveBeenCalledTimes(1);
    finishFirst({ svg: '<svg id="first" />' });
    await first;
    await second;
    expect(render).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
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
