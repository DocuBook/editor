import { describe, expect, it } from "vitest";
import {
  AI_MARKDOWN_INSTRUCTION,
  buildToolSystemPrompt,
  filterMeaningfulOperations,
} from "./aiBlocks";

describe("filterMeaningfulOperations", () => {
  const editor: any = {
    document: [
      {
        id: "b1",
        type: "paragraph",
        content: [{ type: "text", text: "Existing content" }],
      },
    ],
    blocksToHTMLLossy: (blocks: any[]) =>
      blocks.map((b: any) => `<p>${b.content?.[0]?.text ?? ""}</p>`).join(""),
    tryParseHTMLToBlocks: (html: string) => [
      {
        type: "paragraph",
        content: [{ type: "text", text: html.replace(/<[^>]+>/g, "") }],
      },
    ],
  };

  it("drops update with identical HTML", () => {
    expect(
      filterMeaningfulOperations(editor, {
        input: {
          operations: [
            { type: "update", id: "b1$", block: "<p>Existing content</p>" },
          ],
        },
      }),
    ).toBeNull();
  });

  it("keeps update with changed HTML", () => {
    const result = filterMeaningfulOperations(editor, {
      input: {
        operations: [
          { type: "update", id: "b1$", block: "<p>Changed content</p>" },
        ],
      },
    });
    expect(result?.input.operations).toHaveLength(1);
  });

  it("drops empty add blocks and missing deletes", () => {
    expect(
      filterMeaningfulOperations(editor, {
        input: {
          operations: [
            { type: "add", referenceId: "b1$", blocks: ["", "  "] },
            { type: "delete", id: "missing$" },
          ],
        },
      }),
    ).toBeNull();
  });

  it("keeps valid add and existing delete", () => {
    const result = filterMeaningfulOperations(editor, {
      input: {
        operations: [
          { type: "add", referenceId: "b1$", blocks: ["<p>New</p>"] },
          { type: "delete", id: "b1$" },
        ],
      },
    });
    expect(result?.input.operations).toHaveLength(2);
  });
});

describe("AI math prompt contracts", () => {
  it("documents inline and block MathML for tool calls", () => {
    const prompt = buildToolSystemPrompt('[{"id":"b1$","block":"<p>x</p>"}]');
    expect(prompt).toContain('<math display="inline">');
    expect(prompt).toContain('<math display="block">');
  });

  it("documents $ inline and $$ block delimiters for text-only output", () => {
    expect(AI_MARKDOWN_INSTRUCTION).toContain("inline math ($LaTeX$)");
    expect(AI_MARKDOWN_INSTRUCTION).toContain("block math ($$LaTeX$$");
  });
});
