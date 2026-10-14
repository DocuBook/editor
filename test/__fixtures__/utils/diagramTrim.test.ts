// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

/** `safeTrimDiagramSVG` only decides whether to KEEP the upstream trim or fall
 *  back to the source; the trim itself is mocked so the decision is what runs. */
const trimDiagramSVG = vi.fn((svg: string) => svg);
vi.mock("@blocknote/diagram-block", () => ({
  trimDiagramSVG: (svg: string) => trimDiagramSVG(svg),
}));

const { safeTrimDiagramSVG } = await import("../../../frontend/utils/diagramTrim");

/** The engine-agnostic shape: a source SVG with a known viewBox height. */
const source = (height: number) =>
  `<svg viewBox="0 0 100 ${height}"><g/></svg>`;

describe("safeTrimDiagramSVG", () => {
  it("keeps a genuine shrink from the upstream trim", () => {
    trimDiagramSVG.mockReturnValueOnce(source(40));
    expect(safeTrimDiagramSVG(source(100))).toBe(source(40));
  });

  it("discards a collapsed measurement and keeps the untrimmed SVG", () => {
    // WebKit returning a zero/partial getBBox drives the height to the padding.
    trimDiagramSVG.mockReturnValueOnce(source(1));
    expect(safeTrimDiagramSVG(source(100))).toBe(source(100));
  });

  it("treats a non-shrink result as a failed measurement", () => {
    trimDiagramSVG.mockReturnValueOnce(source(100));
    expect(safeTrimDiagramSVG(source(100))).toBe(source(100));

    trimDiagramSVG.mockReturnValueOnce(source(120));
    expect(safeTrimDiagramSVG(source(100))).toBe(source(100));
  });

  it("defers to the trim when the result cannot be scored", () => {
    // A malformed result carries no height to compare against, so the guard has
    // nothing to reject it for; this documents that it does not pretend to.
    trimDiagramSVG.mockReturnValueOnce(source(NaN));
    expect(safeTrimDiagramSVG(source(100))).toBe(source(NaN));
  });

  it("passes the trim through when a viewBox is missing or malformed", () => {
    // The guard judges the height shrink only; the upstream trim must still run
    // for a source it cannot score (e.g. its `journey` height-attribute drop).
    trimDiagramSVG.mockReturnValueOnce('<svg height="200"><g/></svg>');
    expect(safeTrimDiagramSVG('').trim()).toBe('<svg height="200"><g/></svg>');

    trimDiagramSVG.mockReturnValueOnce(source(40));
    expect(safeTrimDiagramSVG('<svg viewBox="oops"><g/></svg>')).toBe(source(40));
  });
});
