import { beforeEach, describe, expect, it } from "vitest";
import { createLruCache } from "../../../frontend/utils/lruCache";
import { readCacheStats, resetCacheStats } from "../../../frontend/utils/cacheStats";

const sizeOf = (value: string) => value.length;

beforeEach(resetCacheStats);

describe("createLruCache", () => {
  it("serves a stored value and records the hit and the miss", () => {
    const cache = createLruCache({ name: "diagram-svg", maxEntries: 2, maxChars: 100, sizeOf });

    expect(cache.peek("a")).toBeNull();
    cache.set("a", "hello");
    expect(cache.peek("a")).toBe("hello");
    expect(readCacheStats()["diagram-svg"]).toMatchObject({ hits: 1, misses: 1 });
  });

  it("drops the oldest entry once the count budget is exceeded", () => {
    const cache = createLruCache({ name: "diagram-svg", maxEntries: 1, maxChars: 1000, sizeOf });

    cache.set("a", "aaa");
    cache.set("b", "bbb");

    expect(cache.peek("a")).toBeNull();
    expect(cache.peek("b")).toBe("bbb");
    expect(readCacheStats()["diagram-svg"].evictions).toBe(1);
  });

  it("drops by total size but keeps the newest entry even when it exceeds the budget alone", () => {
    const cache = createLruCache({ name: "diagram-svg", maxEntries: 10, maxChars: 5, sizeOf });

    cache.set("a", "aaa"); // 3 chars
    cache.set("b", "bbbbb"); // 5 chars -> over budget, evicts "a" but never "b"

    expect(cache.peek("a")).toBeNull();
    expect(cache.peek("b")).toBe("bbbbb");
  });

  it("replaces a value without double-charging the size budget", () => {
    const cache = createLruCache({ name: "diagram-svg", maxEntries: 10, maxChars: 6, sizeOf });

    cache.set("a", "aaaa"); // 4 chars
    cache.set("a", "aa"); // replaced: 2 chars
    cache.set("b", "bbbb"); // 6 chars total -> still fits

    expect(cache.peek("a")).toBe("aa");
    expect(cache.peek("b")).toBe("bbbb");
    expect(readCacheStats()["diagram-svg"].chars).toBe(6);
  });

  it("reports current entries and characters", () => {
    const cache = createLruCache({ name: "diagram-svg", maxEntries: 10, maxChars: 100, sizeOf });

    cache.set("a", "aaa");
    cache.set("b", "bbbb");
    expect(readCacheStats()["diagram-svg"]).toMatchObject({ entries: 2, chars: 7 });

    cache.delete("a");
    expect(readCacheStats()["diagram-svg"]).toMatchObject({ entries: 1, chars: 4 });

    cache.clear();
    expect(readCacheStats()["diagram-svg"]).toMatchObject({ entries: 0, chars: 0 });
  });
});
