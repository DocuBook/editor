import { beforeEach, describe, expect, it } from "vitest";
import {
  cacheDiagramSVG,
  clearDiagramSVG,
  peekDiagramSVG,
} from "../../../frontend/utils/mermaidRenderCache";
import { readCacheStats, resetCacheStats } from "../../../frontend/utils/cacheStats";

beforeEach(() => {
  clearDiagramSVG();
  resetCacheStats();
});

describe("finished diagram SVG cache", () => {
  it("serves a diagram back by its source, with the font it was rendered for", () => {
    cacheDiagramSVG("graph TD; A-->B", '<svg id="a"></svg>', "Inter");

    expect(peekDiagramSVG("graph TD; A-->B")).toEqual({
      svg: '<svg id="a"></svg>',
      fontFamily: "Inter",
      renderId: '',
    });
  });

  it("never stores an empty source or a diagram that failed to render", () => {
    cacheDiagramSVG("", '<svg id="a"></svg>', "Inter");
    cacheDiagramSVG("graph TD; A-->B", "", "Inter");

    expect(peekDiagramSVG("")).toBeNull();
    expect(peekDiagramSVG("graph TD; A-->B")).toBeNull();
  });

  it("drops every entry on clear, e.g. when the vault scope ends", () => {
    cacheDiagramSVG("a", '<svg id="a"></svg>', "Inter");
    cacheDiagramSVG("b", '<svg id="b"></svg>', "Inter");

    clearDiagramSVG();

    expect(peekDiagramSVG("a")).toBeNull();
    expect(peekDiagramSVG("b")).toBeNull();
    expect(readCacheStats()["diagram-svg"]).toMatchObject({ entries: 0, chars: 0 });
  });

  it("reports its size so the cache is observable", () => {
    const svg = '<svg id="a"></svg>';
    cacheDiagramSVG("a", svg, "Inter");

    expect(readCacheStats()["diagram-svg"]).toMatchObject({
      entries: 1,
      chars: svg.length,
    });
  });
});
