// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  cacheMermaidParse,
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

  it("caps the cache by TOTAL SVG size and keeps the most recent diagram", async () => {
    const render = vi.fn(async (_id: string, source: string) => ({
      svg: "x".repeat(source.length),
    }));
    const cached = cacheMermaidRender(render, { maxSvgChars: 10 });

    await cached("one", "aaaaaa"); // 6 chars cached
    await cached("two", "bbbbbb"); // 12 > 10 -> evicts "aaaaaa"
    await cached("three", "bbbbbb"); // hit on the KEPT entry

    expect(render).toHaveBeenCalledTimes(2);
  });

  it("caches a single diagram larger than the whole budget", async () => {
    const render = vi.fn(async (_id: string, source: string) => ({
      svg: "x".repeat(source.length),
    }));
    const cached = cacheMermaidRender(render, { maxSvgChars: 4 });

    await cached("one", "aaaaaaaa");
    await cached("two", "aaaaaaaa"); // newest entry survives its own oversize

    expect(render).toHaveBeenCalledOnce();
  });

  it("still caps the cache by entry count", async () => {
    const render = vi.fn(async (id: string) => ({ svg: `<svg id="${id}" />` }));
    const cached = cacheMermaidRender(render, { maxEntries: 1, maxSvgChars: 1e9 });

    await cached("one", "A");
    await cached("two", "B");
    await cached("three", "A"); // "A" was evicted by count -> renders again

    expect(render).toHaveBeenCalledTimes(3);
  });

  /** Mermaid throws on a parse failure BEFORE removing the `<div id="d{id}">` it
   *  appended to `<body>`, so without cleanup every invalid source would leave an
   *  error diagram behind. The preview relies on `render`'s internal parse, so this
   *  is the only thing standing between a typo and a stray error graphic. */
  it("removes the temporary Mermaid element left behind by a failed render", async () => {
    vi.stubGlobal("requestIdleCallback", (run: () => void) => { run(); return 1; });
    vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = '<div id="dpreview-1"></div>';
    const render = vi.fn(async () => {
      throw new Error("invalid");
    });
    const queued = createQueuedMermaidRender(render);

    await expect(queued("preview-1", "bad")).rejects.toThrow("invalid");

    expect(document.getElementById("dpreview-1")).toBeNull();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("validates a source once, and re-validates only after a failure", async () => {
    const parse = vi.fn(async (source: string) => {
      if (source === "bad") throw new Error("invalid");
      return source.length;
    });
    const cached = cacheMermaidParse(parse);

    await cached("A --> B");
    await cached("A --> B");
    expect(parse).toHaveBeenCalledOnce();

    await expect(cached("bad")).rejects.toThrow("invalid");
    await expect(cached("bad")).rejects.toThrow("invalid");
    expect(parse).toHaveBeenCalledTimes(3);
  });
});
