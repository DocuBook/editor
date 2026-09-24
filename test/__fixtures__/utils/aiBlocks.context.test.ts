import { describe, expect, it } from "vitest";
import {
  buildDocumentContext,
  buildHtmlDocumentState,
  CURSOR_MARKER,
} from "../../../frontend/utils/aiBlocks";
import { buildAiPrompt } from "../../../frontend/utils/aiPrompt";

describe("buildHtmlDocumentState", () => {
  it("marks a single placeholder paragraph as an empty document", async () => {
    const editor: any = {
      document: [{ id: "empty", type: "paragraph", content: [] }],
      blocksToHTMLLossy: () => "<p></p>",
      getSelection: () => undefined,
      getTextCursorPosition: () => ({ block: { id: "empty" } }),
      getExtension: () => ({
        store: { state: { aiMenuState: { blockId: "empty", status: "user-input" } } },
      }),
    };

    await expect(buildHtmlDocumentState(editor)).resolves.toMatchObject({
      isEmptyDocument: true,
      selection: false,
    });
  });

  it("uses the AI menu anchor instead of a stale live cursor", async () => {
    const blocks = [
      { id: "anchored", type: "paragraph" },
      { id: "stale", type: "paragraph" },
    ];
    const editor: any = {
      document: blocks,
      blocksToHTMLLossy: (value: any[]) => `<p>${value[0].id}</p>`,
      getSelection: () => undefined,
      getTextCursorPosition: () => ({ block: { id: "stale" } }),
      getExtension: () => ({
        store: {
          state: { aiMenuState: { blockId: "anchored", status: "error" } },
        },
      }),
    };

    const state = await buildHtmlDocumentState(editor);

    expect(state.blocks).toEqual([
      { id: "anchored$", block: "<p>anchored</p>" },
      { cursor: true },
      { id: "stale$", block: "<p>stale</p>" },
    ]);
    expect(state.blocks.findIndex((block: any) => block.cursor)).toBe(1);
  });
});

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

  it("describes the anchored block type when focus lost the live selection", () => {
    const ed: any = {
      document: [
        { id: "b1", type: "heading", level: 2, content: [{ type: "text", text: "Title" }] },
      ],
      blocksToMarkdownLossy: () => "## Title\n",
      getSelection: () => undefined,
      getTextCursorPosition: () => ({ block: { id: "stale-first" } }),
      getExtension: () =>
        ({ store: { state: { aiMenuState: { blockId: "b1", status: "user-input" } } } }),
    };
    const context = buildDocumentContext(ed);
    expect(context).toContain("Active block type");
    expect(context).toContain("heading level 2");
  });

  it("omits the active-block hint when nothing is resolvable", () => {
    const ed: any = {
      document: [],
      blocksToMarkdownLossy: () => "",
      getSelection: () => undefined,
      getTextCursorPosition: () => {
        throw new Error("boom");
      },
      getExtension: () => undefined,
    };
    expect(buildDocumentContext(ed)).not.toContain("Active block type");
  });

  /** Regression: truncating the document from char 0 dropped the region the
   *  user was writing in, so "continue writing" was answered from the document
   *  start on long notes. The window must be centred on the anchored block. */
  describe("long-document cursor anchoring", () => {
    /** 200 blocks is far past maxContextChars, so truncation always applies. */
    const blocks = Array.from({ length: 200 }, (_, index) => ({
      id: `b${index}`,
      type: "paragraph",
      content: [
        { type: "text", text: `Block ${index} ` + "filler ".repeat(20) },
      ],
    }));
    const CURSOR_ID = "b150";

    function makeLongEditor(anchorId: string) {
      return {
        document: blocks,
        blocksToMarkdownLossy: (value: any[]) =>
          value.map((block: any) => block.content[0].text).join("\n\n") + "\n",
        getSelection: () => undefined,
        getTextCursorPosition: () => ({ block: { id: "stale-first" } }),
        getExtension: () => ({
          store: {
            state: { aiMenuState: { blockId: anchorId, status: "user-input" } },
          },
        }),
      } as any;
    }

    it("marks the caret and drops the document head on a long document", () => {
      const context = buildDocumentContext(makeLongEditor(CURSOR_ID));
      expect(context).toContain(CURSOR_MARKER);
      // The anchored block survives; the far head is what gets cut.
      expect(context).toContain("Block 150");
      expect(context).not.toContain("Block 0 filler");
    });

    it("keeps the anchor block and immediate successors inside the budget", () => {
      const context = buildDocumentContext(makeLongEditor(CURSOR_ID));
      const markerIndex = context.indexOf(CURSOR_MARKER);
      const after = context.slice(markerIndex + CURSOR_MARKER.length);
      // Blocks right after the caret are what "continue writing" must follow.
      expect(after).toContain("Block 151");
      expect(after).toContain("Block 152");
      expect(context.length).toBeLessThanOrEqual(
        12000 + CURSOR_MARKER.length + 200,
      );
    });

    it("keeps preceding text when the caret sits near the document end", () => {
      const context = buildDocumentContext(makeLongEditor("b199"));
      expect(context).toContain(CURSOR_MARKER);
      expect(context).toContain("Block 199");
      // Nothing follows the last block, so the tail is empty but the head is not.
      expect(context).toContain("Block 19");
      expect(context).not.toContain("Block 0 filler");
    });

    it("falls back to a head-capped document when no anchor resolves", () => {
      const ed: any = { ...makeLongEditor("missing-block") };
      const context = buildDocumentContext(ed);
      expect(context).not.toContain(CURSOR_MARKER);
      expect(context).toContain("Block 0");
      expect(context).toContain("...[truncated]");
    });

    it("explains the cursor marker in the compiled prompt", () => {
      const prompt = buildAiPrompt({
        mode: "text",
        messages: [],
        documentMarkdown: buildDocumentContext(makeLongEditor(CURSOR_ID)),
        selectedMarkdown: "",
        userText: "Continue writing",
        taskRules: "",
      });
      const contextMessage = prompt.messages.find(
        (message) => message.role === "assistant",
      )?.content;
      expect(contextMessage).toContain(CURSOR_MARKER);
      expect(contextMessage).toContain("caret position");
    });

    it("tells the text policy how to use the cursor marker", () => {
      const prompt = buildAiPrompt({
        mode: "text",
        messages: [],
        documentMarkdown: "# T\n",
        selectedMarkdown: "",
        userText: "Continue writing",
        taskRules: "",
      });
      expect(prompt.messages[0].content).toContain(CURSOR_MARKER);
      expect(prompt.messages[0].content).toContain("Never output that marker");
    });

    it("does not emit the marker in tool mode", () => {
      const prompt = buildAiPrompt({
        mode: "tool",
        messages: [],
        documentState: { selection: false, blocks: [], isEmptyDocument: false },
        documentMarkdown: "",
        selectedMarkdown: "",
        userText: "Edit",
        taskRules: "",
      });
      expect(prompt.messages[0].content).not.toContain(CURSOR_MARKER);
    });
  });
});

describe("buildAiPrompt document state", () => {
  it("serializes blocks with suffixed ids from rust-ai metadata", () => {
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
