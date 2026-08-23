import { describe, expect, it } from "vitest";
import {
  indentationAt,
  indentSelection,
} from "../../../frontend/utils/mermaidIndent";

describe("Mermaid indentation", () => {
  it("preserves the current line indentation", () => {
    const source = "graph TD\n    subgraph API\n\t\tA --> B";
    expect(indentationAt(source, source.indexOf("subgraph") + 8)).toBe("    ");
    expect(indentationAt(source, source.length)).toBe("\t\t");
  });

  it("indents one or multiple selected lines", () => {
    expect(indentSelection("A --> B", 0, 7, false)).toEqual({
      start: 0,
      text: "  A --> B",
      from: 2,
      to: 9,
    });
    expect(indentSelection("A --> B\nB --> C", 0, 15, false)).toEqual({
      start: 0,
      text: "  A --> B\n  B --> C",
      from: 2,
      to: 19,
    });
  });

  it("outdents one or multiple selected lines", () => {
    expect(indentSelection("  A --> B", 2, 9, true)).toEqual({
      start: 0,
      text: "A --> B",
      from: 0,
      to: 7,
    });
    expect(indentSelection("  A --> B\n\tB --> C", 2, 18, true)).toEqual({
      start: 0,
      text: "A --> B\nB --> C",
      from: 0,
      to: 15,
    });
  });
});
