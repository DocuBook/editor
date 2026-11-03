// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { centerMindmapLabels } from "../../../frontend/utils/renderCacheInstall";

const node = (shape: string, label: string) =>
  `<g class="node mindmap-node">${shape}<g class="label"><text y="-10.1"><tspan x="0">${label}</tspan></text></g></g>`;

const mindmap = (...nodes: string[]) =>
  `<svg xmlns="http://www.w3.org/2000/svg" aria-roledescription="mindmap">${nodes.join("")}</svg>`;

const anchorOf = (svg: string, label: string) =>
  [...new DOMParser().parseFromString(svg, "image/svg+xml").querySelectorAll("text")]
    .find((text) => text.textContent === label)
    ?.getAttribute("text-anchor");

describe("centerMindmapLabels", () => {
  it("centers labels of shapes drawn around them, leaving self-translated ones alone", () => {
    const svg = centerMindmapLabels(
      mindmap(
        node('<circle r="40"/>', "Root"),
        node('<rect width="80" height="20"/>', "Square"),
        node('<polygon points="0,0 1,1"/>', "Hexagon"),
        node('<path d="M0 0"/><line/>', "Default"),
      ),
    );

    expect(anchorOf(svg, "Root")).toBe("middle");
    expect(anchorOf(svg, "Square")).toBe("middle");
    expect(anchorOf(svg, "Hexagon")).toBe("middle");
    // The default node already translates its label by half its width.
    expect(anchorOf(svg, "Default")).toBeNull();
  });

  it("returns other diagrams byte-identical", () => {
    const flowchart = `<svg aria-roledescription="flowchart-v2"><g class="node"><circle/><g class="label"><text>A</text></g></g></svg>`;
    expect(centerMindmapLabels(flowchart)).toBe(flowchart);
  });
});
