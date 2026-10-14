import { describe, expect, it } from "vitest";
import { remapSvgIds } from "../../../frontend/utils/svgIdRemap";

/** Mermaid ids are `mermaid-render-<n>`, so one is a string prefix of another.
 *  A plain `replaceAll` rewrites the longer id too and corrupts the SVG. */
describe("remapSvgIds", () => {
  it("rewrites the id and its namespaced references", () => {
    const svg = '<svg id="mermaid-render-7"><path marker-end="url(#mermaid-render-7-arrow)"/></svg>';
    expect(remapSvgIds(svg, "mermaid-render-7", "mermaid-preview-3")).toBe(
      '<svg id="mermaid-preview-3"><path marker-end="url(#mermaid-preview-3-arrow)"/></svg>',
    );
  });

  it("keeps remapping longer namespaced references", () => {
    // The guard must not block `-flowchart-…`: shadowing it would leave a
    // dangling `url(#…)`, the same corruption the prefix guard prevents.
    const svg = '<svg id="mermaid-render-7"><g id="mermaid-render-7-flowchart-abc"/></svg>';
    expect(remapSvgIds(svg, "mermaid-render-7", "mermaid-preview-3")).toBe(
      '<svg id="mermaid-preview-3"><g id="mermaid-preview-3-flowchart-abc"/></svg>',
    );
  });

  it("does not touch a longer id that has the source id as a prefix", () => {
    const svg = '<svg id="mermaid-render-1"><g id="mermaid-render-10"/></svg>';
    expect(remapSvgIds(svg, "mermaid-render-1", "mermaid-preview-0")).toBe(
      '<svg id="mermaid-preview-0"><g id="mermaid-render-10"/></svg>',
    );
  });

  it("escapes regex metacharacters in the id", () => {
    const svg = '<svg id="a.b"><use href="#a.b"/></svg>';
    expect(remapSvgIds(svg, "a.b", "c")).toBe('<svg id="c"><use href="#c"/></svg>');
  });

  it("leaves the SVG untouched for an empty or identical id", () => {
    const svg = '<svg id="mermaid-render-1"/>';
    expect(remapSvgIds(svg, "", "x")).toBe(svg);
    expect(remapSvgIds(svg, "mermaid-render-1", "mermaid-render-1")).toBe(svg);
  });
});
