import { describe, expect, it } from "vitest";
import { buildDocumentContext } from "../../../frontend/utils/aiBlocks";
import { buildAiPrompt } from "../../../frontend/utils/aiPrompt";

describe("buildDocumentContext", () => {
  const editor: any = {
    document: [
      { id: "b1", type: "heading", content: [{ type: "text", text: "Title" }] },
    ],
    blocksToMarkdownLossy: () => "# Title\n",
    getSelection: () => null,
  };

  it("returns markdown without ids (non-tool path)", () => {
    expect(buildDocumentContext(editor)).toContain("# Title");
  });

  it("keeps selection block types without internal ids", () => {
    const leakedId = "f420cd68-9d89-46dc-9782-d1d973af1471$";
    const ed: any = {
      ...editor,
      getSelection: () => ({
        blocks: [{ id: leakedId, type: "heading", level: 1 }],
      }),
    };
    const context = buildDocumentContext(ed);
    expect(context).toContain("heading level 1");
    expect(context).not.toContain(leakedId);
    const prompt = buildAiPrompt({
      mode: "text",
      messages: [],
      documentMarkdown: context,
      selectedMarkdown: "",
      userText: "Edit",
      taskRules: "",
    });
    expect(
      prompt.messages.find((message) => message.role === "assistant")?.content,
    ).not.toContain(leakedId);
  });

  it("returns empty for missing editor", () => {
    expect(buildDocumentContext(null)).toBe("");
  });
});

describe("buildAiPrompt document state", () => {
  it("serializes blocks with suffixed ids from xl-ai metadata", () => {
    const documentState = {
      selection: false,
      blocks: [{ id: "abc$", block: "<h2>T</h2>" }],
      isEmptyDocument: false,
    };
    const prompt = buildAiPrompt({
      mode: "tool",
      messages: [],
      documentState,
      documentMarkdown: "",
      selectedMarkdown: "",
      userText: "Edit",
      taskRules: "",
    });
    const context = prompt.messages.find(
      (message) => message.role === "assistant",
    );
    expect(context?.content).toContain('"id":"abc$"');
    expect(context?.content).toContain("<h2>T</h2>");
  });

  it("puts selected blocks before full document context", () => {
    const prompt = buildAiPrompt({
      mode: "tool",
      messages: [],
      documentState: {
        selection: true,
        selectedBlocks: [{ id: "sel$", block: "<p>x</p>" }],
        blocks: [{ id: "a$", block: "<p>a</p>" }],
        isEmptyDocument: false,
      },
      documentMarkdown: "",
      selectedMarkdown: "",
      userText: "Edit",
      taskRules: "",
    });
    const content =
      prompt.messages.find((message) => message.role === "assistant")
        ?.content || "";
    expect(content.indexOf("sel$")).toBeLessThan(content.indexOf("a$"));
  });

  it("does not emit malformed JSON when state is large", () => {
    const blocks = Array.from({ length: 1000 }, (_, index) => ({
      id: `block-${index}$`,
      block: "<p>content</p>",
    }));
    const prompt = buildAiPrompt({
      mode: "tool",
      messages: [],
      documentState: { selection: false, blocks, isEmptyDocument: false },
      documentMarkdown: "",
      selectedMarkdown: "",
      userText: "Edit",
      taskRules: "",
    });
    const content =
      prompt.messages.find((message) => message.role === "assistant")
        ?.content || "";
    expect(() =>
      JSON.parse(content.slice(content.lastIndexOf("\n") + 1)),
    ).not.toThrow();
  });
});

describe("buildAiPrompt message layering", () => {
  it("keeps user prompt separate from system and context messages", () => {
    const prompt = buildAiPrompt({
      mode: "text",
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      documentState: undefined,
      documentMarkdown: "# Title",
      selectedMarkdown: "selected",
      userText: "hello",
      taskRules: "",
    });
    expect(prompt.messages[0].role).toBe("system");
    expect(prompt.messages.at(-1)).toEqual({ role: "user", content: "hello" });
    expect(
      prompt.messages.find((message) => message.role === "assistant")?.content,
    ).toContain("# Title");
  });
});
