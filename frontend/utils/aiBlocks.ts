import { mathDollarToMathML } from "./mathMarkdown";

/** Close an unbalanced code fence so markdown parses cleanly (low-level models often forget the closing ```). */
export function normalizeMarkdown(text: string): string {
  const fences = (text || "").match(/```/g)?.length ?? 0;
  if (fences % 2 !== 0) return (text || "").replace(/\s*$/, "") + "\n```";
  return text || "";
}

/**
 * Explicit formatting rules for AI → document operations.
 * Mirrors pi/ACP system-prompt principles: schema-constrained, grounded, validated.
 */
export const AI_FORMATTING_RULES = {
  /** Block types whose format is preserved when replacing a selection. */
  preserveFormatOnReplace: [
    "heading",
    "bulletListItem",
    "numberedListItem",
    "checkListItem",
    "toggleListItem",
    "blockquote",
  ],
  /** Max document-context chars sent to the model. */
  maxContextChars: 12000,
} as const;

/** Max AI attempts before giving up (retry loop on semantic validation failure). */
export const MAX_AI_ATTEMPTS = 2;

/** Check if a block id (optionally $-suffixed) exists in the editor document (recursive). */
export function blockIdExists(editor: any, id: string): boolean {
  if (!editor?.document) return false;
  const clean = String(id).replace(/\$$/, "");
  const find = (blocks: any[]): boolean =>
    blocks.some(
      (b: any) => b.id === clean || (b.children?.length && find(b.children)),
    );
  return find(editor.document);
}

/** Semantic anti-hallucination: referenced ids in applyDocumentOperations must exist in the doc. */
/**
 * Ensure every operation id/referenceId carries the trailing `$` that
 * BlockNote's applyDocumentOperations expects (idsSuffixed). The document
 * state in the AI prompt has suffixed ids, but some models (e.g. GLM) strip
 * the `$` when echoing them back — xl-ai then rejects with
 * "referenceId must end with $". Fix at the transport boundary.
 *
 * The model's tool args are `{ "operations": [...] }` — there is NO `type`
 * field (the tool name lives on the tool call itself), so accept either shape.
 */
export function suffixOperationIds(input: any): any {
  if (!input || typeof input !== "object") return input;
  const ops = input.operations;
  if (!Array.isArray(ops)) return input;
  const fix = (v: unknown): unknown =>
    typeof v === "string" && v.length > 0 && !v.endsWith("$") ? v + "$" : v;
  return {
    ...input,
    operations: ops.map((op) => {
      if (!op || typeof op !== "object") return op;
      const out: Record<string, unknown> = { ...op };
      if (typeof out.id === "string") out.id = fix(out.id);
      if (typeof out.referenceId === "string")
        out.referenceId = fix(out.referenceId);
      return out;
    }),
  };
}

/** Strip a trailing `$` suffix if present (operation ids are suffixed for the
 *  model; editor block ids are not). */
const stripSuffix = (id: string) => (id.endsWith("$") ? id.slice(0, -1) : id);
const MISSING_BLOCK_ERROR = "Referenced document block is no longer available";

export function validateOperationsSemantics(
  editor: any,
  input: any,
): string | null {
  // Model tool args are `{ "operations": [...] }` — there is NO `type` field
  // (the tool name lives on the tool call itself), so don't require one here.
  if (!input || !Array.isArray(input.operations)) return null;
  for (const op of input.operations) {
    if (!op) continue;
    if (
      op.type === "add" &&
      op.referenceId &&
      !blockIdExists(editor, stripSuffix(op.referenceId))
    ) {
      return MISSING_BLOCK_ERROR;
    }
    if (
      (op.type === "update" || op.type === "delete") &&
      op.id &&
      !blockIdExists(editor, stripSuffix(op.id))
    ) {
      return MISSING_BLOCK_ERROR;
    }
  }
  return null;
}

/** Task-specific formatting rules based on the detected command (pi/ACP style). */
export function buildTaskFormattingRules(userText: string): string {
  const t = (userText || "").toLowerCase();
  const rules: string[] = [];
  if (/summar/.test(t))
    rules.push(
      "Output a concise summary — keep only key points, preserve the original structure (headings/lists).",
    );
  if (/transl/.test(t))
    rules.push(
      "Translate the selected content; preserve its tone, meaning, and block formatting exactly.",
    );
  if (/improv|enhanc|rewrit/.test(t))
    rules.push(
      "Improve clarity and flow; preserve the original meaning, block structure, and inline formatting (bold/italic/links).",
    );
  if (/spell|grammar|typo/.test(t))
    rules.push(
      "Fix spelling and grammar errors only; do not rewrite content or change meaning.",
    );
  if (/simplif/.test(t))
    rules.push(
      "Simplify the language while keeping all key information and structure.",
    );
  if (/continu|write/.test(t))
    rules.push(
      "Continue naturally from the cursor; match the existing tone and block style.",
    );
  if (rules.length) return "\nTask-specific rules:\n- " + rules.join("\n- ");
  return "";
}

/** Document context for text-only prompts: Markdown plus selection block types.
 *  Tool prompts use xl-ai's metadata.documentState instead. */
export function buildDocumentContext(editor: any): string {
  if (!editor) return "";
  try {
    const md = editor.blocksToMarkdownLossy(editor.document);
    const sel = editor.getSelection();
    const selCtx = sel?.blocks?.length
      ? `\n\nSelection block types (preserve on edit):\n${sel.blocks.map((b: any) => `- ${b.type}${b.level ? " level " + b.level : ""}`).join("\n")}`
      : "";
    const MAX = AI_FORMATTING_RULES.maxContextChars;
    const trimmed =
      md.length > MAX ? md.substring(0, MAX) + "\n...[truncated]" : md;
    return trimmed + selCtx;
  } catch {
    return "";
  }
}

/** True when a tool call carries at least one operation — structural check used
 *  before an editor is available. Semantic filtering lives below. */
export const isDocumentOperationToolCall = (tc: any): boolean =>
  tc?.toolName === "applyDocumentOperations";

export const isMeaningfulOps = (tc: any): boolean =>
  !!tc?.input &&
  Array.isArray(tc.input.operations) &&
  tc.input.operations.length > 0;

const normalizeHtml = (html: unknown): string =>
  typeof html === "string" ? html.trim() : "";

function containsInternalBlockId(editor: any, html: string): boolean {
  const ids: string[] = [];
  const collect = (blocks: any[]) => {
    for (const block of blocks) {
      if (typeof block?.id === "string" && block.id.length >= 8)
        ids.push(block.id);
      if (block?.children?.length) collect(block.children);
    }
  };
  collect(Array.isArray(editor?.document) ? editor.document : []);
  return ids.some((id) => html.includes(id));
}

function findBlock(editor: any, id: string): any | null {
  const clean = stripSuffix(id);
  const find = (blocks: any[]): any | null => {
    for (const block of blocks) {
      if (block?.id === clean) return block;
      const nested = block?.children?.length ? find(block.children) : null;
      if (nested) return nested;
    }
    return null;
  };
  return find(Array.isArray(editor?.document) ? editor.document : []);
}

function sanitizeBlockHtml(editor: any, html: unknown): string | null {
  if (
    typeof html !== "string" ||
    typeof editor?.tryParseHTMLToBlocks !== "function" ||
    typeof editor?.blocksToHTMLLossy !== "function"
  ) {
    return null;
  }
  try {
    /** Models sometimes put Markdown math delimiters inside an HTML tool block.
     * Normalize them before BlockNote's HTML parser; canonical <math> markup is
     * protected by mathDollarToMathML and passes through unchanged. */
    const normalizedMath = mathDollarToMathML(html).replace(
      /<p>\s*(?:\\\[|\$\$)([\s\S]*?)(?:\\\]|\$\$)\s*<\/p>/gi,
      (_match, latex: string) =>
        `<math display="block"><annotation encoding="application/x-tex">${latex.trim()}</annotation></math>`,
    );
    const parsed = editor.tryParseHTMLToBlocks(normalizedMath);
    if (!Array.isArray(parsed) || !parsed.length) return null;
    const sanitized = editor.blocksToHTMLLossy([parsed[0]]);
    return typeof sanitized === "string" &&
      !containsInternalBlockId(editor, sanitized)
      ? sanitized
      : null;
  } catch {
    return null;
  }
}

function updateIsMeaningful(
  editor: any,
  op: any,
): { meaningful: boolean; block: string } | null {
  if (!op?.id || typeof op.block !== "string") return null;
  const current = findBlock(editor, op.id);
  if (!current || typeof editor?.blocksToHTMLLossy !== "function") return null;
  const requestedHtml = sanitizeBlockHtml(editor, op.block);
  if (requestedHtml === null) return null;
  try {
    const currentHtml = editor.blocksToHTMLLossy([
      { ...current, children: [] },
    ]);
    return {
      meaningful: normalizeHtml(currentHtml) !== normalizeHtml(requestedHtml),
      block: requestedHtml,
    };
  } catch {
    return { meaningful: true, block: requestedHtml };
  }
}

/** Remove operations that cannot change current document state. Returns cloned
 *  tool call so mixed meaningful/no-op calls keep only effective operations. */
export function filterMeaningfulOperations(editor: any, tc: any): any | null {
  if (!isMeaningfulOps(tc)) return null;
  const operations = tc.input.operations.flatMap((op: any) => {
    if (op?.type === "update") {
      const result = updateIsMeaningful(editor, op);
      return result?.meaningful ? [{ ...op, block: result.block }] : [];
    }
    if (op?.type === "delete") {
      return op.id && findBlock(editor, op.id) ? [op] : [];
    }
    if (op?.type === "add") {
      const blocks = Array.isArray(op.blocks)
        ? op.blocks
            .filter(
              (block: unknown) => typeof block === "string" && block.trim(),
            )
            .map((block: string) => sanitizeBlockHtml(editor, block))
            .filter((block: string | null): block is string => block !== null)
        : [];
      return blocks.length ? [{ ...op, blocks }] : [];
    }
    return [];
  });
  return operations.length
    ? { ...tc, input: { ...tc.input, operations } }
    : null;
}

/** Base messages for ask_ai — differs by path:
 *  - tools: system prompt + clean chat history (doc state lives in the prompt)
 *  - text-only: system prompt + single user message (selection + markdown rules) */
export function latestUserText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    return (
      (message.parts || [])
        .map((part: any) => (part.type === "text" ? part.text : ""))
        .join("") ||
      message.content ||
      ""
    );
  }
  return "";
}

/**
 * Build an applyDocumentOperations input from the AI text output.
 * Follows xl-ai's operation schema (html format, idsSuffixed):
 * - referenceId / id MUST end with `$`
 * - blocks MUST be HTML strings (not block objects)
 * - selection → update ops (preserving format); no selection → add op after cursor
 */
export async function buildApplyDocumentInput(
  editor: any,
  fullText: string,
): Promise<any | null> {
  if (!editor || !fullText?.trim()) return null;
  try {
    /** Math parity with the markdown LOAD path: BlockNote's parser has no `$`
     *  handling, so model-written $$…$$ would land as literal text (and the
     *  exporter re-escapes $ → \$ , corrupting the block). Restore model-escaped
     *  \$ then run the same $$ → <math> conversion as WysiwygEditor's load. */
    const text = normalizeMarkdown(fullText).replace(/\\\$/g, "$");
    const parsed = await editor.tryParseMarkdownToBlocks(
      mathDollarToMathML(text),
    );
    if (!parsed?.length) return null;
    const sel = editor.getSelection();
    if (sel?.blocks?.length) {
      const formatted = inheritFormatOnReplace(sel.blocks, parsed);
      /** Update ops map 1:1 onto the selection; extra blocks (model returned more than selected)
       *  become an add-op after the last selected block — never an "undefined$" id that fails validation. */
      const operations: any[] = formatted
        .slice(0, sel.blocks.length)
        .map((block: any, i: number) => ({
          type: "update",
          id: sel.blocks[i]?.id + "$",
          block: editor.blocksToHTMLLossy([block]),
        }));
      const extras = formatted.slice(sel.blocks.length);
      if (extras.length) {
        operations.push({
          type: "add",
          referenceId: sel.blocks[sel.blocks.length - 1]?.id + "$",
          position: "after",
          blocks: extras.map((b: any) => editor.blocksToHTMLLossy([b])),
        });
      }
      return { type: "applyDocumentOperations", operations };
    }
    const cursor = editor.getTextCursorPosition();
    /** xl-ai deletes the empty cursor block before executing (deleteEmptyCursorBlock
     *  in onStart, when the doc has other content) — anchoring on it fails
     *  validation with "referenceId not found". Anchor on the previous block
     *  instead when the cursor block is empty (exactly the block xl-ai removes).
     *  Single-empty-block docs are safe: there xl-ai does NOT delete it. */
    const cursorBlock = cursor?.block;
    const cursorEmpty =
      !!cursorBlock &&
      (!cursorBlock.content || cursorBlock.content.length === 0);
    const refBlock =
      cursorEmpty && cursor.prevBlock ? cursor.prevBlock : cursorBlock;
    return {
      type: "applyDocumentOperations",
      operations: [
        {
          type: "add",
          referenceId: refBlock?.id + "$",
          position: "after",
          blocks: parsed.map((b: any) => editor.blocksToHTMLLossy([b])),
        },
      ],
    };
  } catch {
    return null;
  }
}

/** Block types that share inline text content (safe to inherit format onto a paragraph). */
const INLINE_CONTENT_TYPES = AI_FORMATTING_RULES.preserveFormatOnReplace;

/**
 * When replacing a selection, re-apply the original block's format onto AI output.
 * If the model returned a plain paragraph but the original block was a heading/list/
 * blockquote (with inline content), inherit type + level so formatting is preserved.
 */
export function inheritFormatOnReplace(original: any[], parsed: any[]): any[] {
  return parsed.map((block, i) => {
    const orig = original[i];
    if (!orig || !orig.type) return block;
    if (
      block.type === "paragraph" &&
      INLINE_CONTENT_TYPES.includes(orig.type)
    ) {
      return { ...block, type: orig.type, level: orig.level };
    }
    return block;
  });
}
