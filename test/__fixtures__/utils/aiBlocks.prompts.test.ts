import { describe, expect, it } from "vitest";
import {
  AI_MARKDOWN_INSTRUCTION,
  buildAiPrompt,
} from "../../../frontend/utils/aiPrompt";
import { buildTaskFormattingRules, extractDelimitedContent, AI_CONTENT_OPEN, AI_CONTENT_CLOSE } from "../../../frontend/utils/aiBlocks";

describe("buildAiPrompt", () => {
  const documentState = {
    selection: false,
    isEmptyDocument: false,
    blocks: [{ id: "a$", block: "<p>x</p>" }],
  };

  it("uses canonical rust-ai tool policy and keeps document state in context", () => {
    const result = buildAiPrompt({
      mode: "tool",
      messages: [{ role: "user", parts: [{ type: "text", text: "Fix x" }] }],
      documentState,
      documentMarkdown: "ignored in tool mode",
      selectedMarkdown: "",
      userText: "Fix x",
      taskRules: "",
    });
    const system = result.messages.find((message) => message.role === "system");
    const context = result.messages.find(
      (message) =>
        message.role === "assistant" && message.content.includes('"id":"a$"'),
    );
    expect(system?.content).toContain("applyDocumentOperations");
    expect(system?.content).toContain("trailing $");
    expect(context?.content).toContain('"id":"a$"');
    expect(system?.content).not.toContain('"id":"a$"');
  });

  it("uses canonical empty-document instruction", () => {
    const result = buildAiPrompt({
      mode: "tool",
      messages: [],
      documentState: {
        selection: false,
        isEmptyDocument: true,
        blocks: [{ id: "empty$", block: "<p></p>", cursor: true }],
      },
      documentMarkdown: "",
      selectedMarkdown: "",
      userText: "Create notes",
      taskRules: "",
    });
    const context = result.messages.find(
      (message) => message.role === "assistant",
    );
    expect(context?.content).toContain(
      "first update the empty block before adding new blocks",
    );
  });

  it("puts Markdown contract in text system policy", () => {
    const result = buildAiPrompt({
      mode: "text",
      messages: [{ role: "user", content: "Summarize this" }],
      documentState: undefined,
      documentMarkdown: "# Existing",
      selectedMarkdown: "selected",
      userText: "Summarize this",
      taskRules: "\nTask-specific rules:\n- concise summary",
    });
    const system = result.messages.find((message) => message.role === "system");
    const context = result.messages.find(
      (message) => message.role === "assistant",
    );
    expect(system?.content).toContain("BlockNote-compatible Markdown");
    expect(system?.content).toContain("concise summary");
    expect(context?.content).toContain("# Existing");
    expect(context?.content).toContain("selected");
  });

  it("keeps user prompt as user content", () => {
    const result = buildAiPrompt({
      mode: "text",
      messages: [],
      documentState: undefined,
      documentMarkdown: "",
      selectedMarkdown: "",
      userText: "Write a project outline",
      taskRules: "",
    });
    expect(result.messages.at(-1)).toEqual({
      role: "user",
      content: "Write a project outline",
    });
  });

  it("adds retry feedback as a separate user message", () => {
    const result = buildAiPrompt({
      mode: "tool",
      messages: [],
      documentState,
      documentMarkdown: "",
      selectedMarkdown: "",
      userText: "Fix x",
      taskRules: "",
      retryFeedback: "Use only existing ids.",
    });
    expect(result.messages.at(-1)).toEqual({
      role: "user",
      content: "Use only existing ids.",
    });
  });
});

describe("buildTaskFormattingRules", () => {
  it("adds summarize rule", () => {
    expect(buildTaskFormattingRules("Summarize")).toContain("concise summary");
  });

  it("adds translate rule", () => {
    expect(buildTaskFormattingRules("Translate to Indonesian")).toContain(
      "preserve its tone",
    );
  });

  it("adds fix spelling rule", () => {
    expect(buildTaskFormattingRules("Fix spelling")).toContain(
      "spelling and grammar errors only",
    );
  });

  it("adds improve rule", () => {
    expect(buildTaskFormattingRules("Improve writing")).toContain(
      "preserve the original meaning",
    );
  });

  it("returns empty for unknown prompt", () => {
    expect(buildTaskFormattingRules("do whatever")).toBe("");
  });
});

describe("AI_MARKDOWN_INSTRUCTION", () => {
  it("is a non-empty markdown instruction", () => {
    expect(AI_MARKDOWN_INSTRUCTION).toContain("BlockNote-compatible Markdown");
    expect(AI_MARKDOWN_INSTRUCTION).toContain("No commentary");
    expect(AI_MARKDOWN_INSTRUCTION).toContain("inline math ($LaTeX$)");
    expect(AI_MARKDOWN_INSTRUCTION).toContain("block math ($$LaTeX$$");
  });
});

describe("text-mode content contract", () => {
  /** The transport writes a text-mode reply ONLY when it carries the delimiters,
   *  and the model only emits them because this prompt asks for them. Both halves
   *  have to hold: dropping either silently stops text mode from ever writing. */
  it("asks the model to delimit content, and pins the tags the transport reads", () => {
    const { messages } = buildAiPrompt({
      mode: "text",
      messages: [{ role: "user", content: "summarize" }],
      documentMarkdown: "body",
      selectedMarkdown: "",
      userText: "summarize",
      taskRules: "",
    });
    const system = messages[0].content;
    expect(system).toContain(AI_CONTENT_OPEN);
    expect(system).toContain(AI_CONTENT_CLOSE);
    // The no-change escape hatch has to be stated, or a model with nothing to
    // edit will invent content to fill the tags.
    expect(system).toContain("no document change");
    // And the stated tags must be the ones extractDelimitedContent resolves.
    expect(extractDelimitedContent(`${AI_CONTENT_OPEN}payload${AI_CONTENT_CLOSE}`)).toBe(
      "payload",
    );
  });

  it("leaves tool mode without the delimiters", () => {
    const { messages } = buildAiPrompt({
      mode: "tool",
      messages: [{ role: "user", content: "edit" }],
      documentMarkdown: "body",
      selectedMarkdown: "",
      userText: "edit",
      taskRules: "",
    });
    expect(messages[0].content).not.toContain(AI_CONTENT_OPEN);
  });
});
