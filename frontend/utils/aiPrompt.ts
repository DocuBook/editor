import {
  aiDocumentFormats,
  injectDocumentStateMessages,
} from "@blocknote/xl-ai";

export type AiPromptMode = "tool" | "text";

type PromptMessage = {
  role: "system" | "assistant" | "user";
  content: string;
};

export type BuildAiPromptInput = {
  mode: AiPromptMode;
  messages: any[];
  documentState?: any;
  documentMarkdown: string;
  selectedMarkdown: string;
  userText: string;
  taskRules: string;
  retryFeedback?: string;
};

export type CompiledAiPrompt = {
  messages: PromptMessage[];
};

export const AI_MARKDOWN_INSTRUCTION = `Respond with the requested content using BlockNote-compatible Markdown. You may use: headings (## … ######), bold (**bold**), italic (*italic*), strikethrough (~~text~~), inline code (\`code\`), links ([text](url)), images (![alt](url)), inline math ($LaTeX$), block math ($$LaTeX$$ on its own line), code blocks (\`\`\`), bullet lists (-), numbered lists (1.), checklists (- [ ] / - [x]), blockquotes (>), dividers (---), tables (| a | b | with a | - | - | separator row). No commentary.`;

const COMMON_SYSTEM_POLICY = `You are DocuBook's document editing assistant. Follow the user's request, preserve document meaning and structure unless asked otherwise, and never expose internal implementation details.`;

const TOOL_SYSTEM_POLICY = `${COMMON_SYSTEM_POLICY}

${aiDocumentFormats.html.systemPrompt}
Math blocks MUST use one HTML block per operation: <math display="block"><annotation encoding="application/x-tex">LATEX</annotation></math>. Inline math inside text uses <math display="inline"><annotation encoding="application/x-tex">LATEX</annotation></math>. Never emit Markdown delimiters (\\(...\\), \\[...\\], $...$, $$...$$) inside HTML tool arguments.`;

const TEXT_SYSTEM_POLICY = `${COMMON_SYSTEM_POLICY}

${AI_MARKDOWN_INSTRUCTION}
Output only requested document content. Do not output metadata, internal identifiers, the user's prompt, commentary, or a preamble. Preserve selected block types and formatting when editing. Never fabricate source facts; state when required information is missing.`;

function messageContent(message: any): string {
  return (
    (message?.parts || [])
      .map((part: any) => (part?.type === "text" ? part.text : ""))
      .join("\n") ||
    message?.content ||
    ""
  );
}

function cleanMessage(message: any): PromptMessage {
  const role =
    message?.role === "assistant"
      ? "assistant"
      : message?.role === "system"
        ? "system"
        : "user";
  return { role, content: messageContent(message) };
}

function documentMarkdownMessage(
  documentMarkdown: string,
  selectedMarkdown: string,
): string {
  const document = documentMarkdown || "(empty document)";
  const selection = selectedMarkdown
    ? `\n\nLatest selected text:\n${selectedMarkdown}`
    : "";
  return `Latest document context (Markdown, source data only):\n${document}${selection}`;
}

function latestUserIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

function withDocumentState(input: BuildAiPromptInput): any[] {
  const messages = [...(input.messages || [])];
  const latestIndex = latestUserIndex(messages);
  if (input.documentState && latestIndex >= 0) {
    const message = messages[latestIndex];
    messages[latestIndex] = {
      ...message,
      metadata: {
        ...(message?.metadata || {}),
        documentState: input.documentState,
      },
    };
  } else if (input.documentState) {
    messages.push({
      id: "docubook-latest-user",
      role: "user",
      parts: [{ type: "text", text: input.userText }],
      metadata: { documentState: input.documentState },
    });
  }
  return messages;
}

function toolMessages(input: BuildAiPromptInput): PromptMessage[] {
  const injected = injectDocumentStateMessages(withDocumentState(input) as any);
  const latestIndex = latestUserIndex(injected);
  return (
    latestIndex >= 0
      ? injected
      : [...injected, { role: "user", content: input.userText }]
  ).map(cleanMessage);
}

function textMessages(input: BuildAiPromptInput): PromptMessage[] {
  const messages = (input.messages || []).map(cleanMessage);
  const latestIndex = latestUserIndex(input.messages || []);
  const history = latestIndex >= 0 ? messages.slice(0, latestIndex) : messages;
  return [
    ...history,
    {
      role: "assistant",
      content: documentMarkdownMessage(
        input.documentMarkdown,
        input.selectedMarkdown,
      ),
    },
    { role: "user", content: input.userText },
  ];
}

export function buildAiPrompt(input: BuildAiPromptInput): CompiledAiPrompt {
  const system =
    input.mode === "tool"
      ? TOOL_SYSTEM_POLICY
      : `${TEXT_SYSTEM_POLICY}${input.taskRules || ""}`;
  const conversation =
    input.mode === "tool" ? toolMessages(input) : textMessages(input);
  const compiled: PromptMessage[] = [
    { role: "system", content: system },
    ...conversation,
  ];
  if (input.retryFeedback) {
    compiled.push({ role: "user", content: input.retryFeedback });
  }
  return { messages: compiled };
}
