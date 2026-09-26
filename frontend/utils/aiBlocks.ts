
import { TextSelection } from "prosemirror-state";
import { mathDollarToMathML } from "./mathMarkdown";

type AISelectionSnapshot = {
  blocks: any[];
  anchor: number;
  head: number;
  doc: unknown;
};

/** Selection must survive focus moving from the editor into the AI composer. */
const aiSelectionSnapshots = new WeakMap<object, AISelectionSnapshot>();

export function getAISelectionSnapshot(editor: any): any[] | undefined {
  const snapshot = editor && typeof editor === "object"
    ? aiSelectionSnapshots.get(editor)
    : undefined;
  return snapshot?.blocks.length ? snapshot.blocks : undefined;
}

function liveAISelection(editor: any): { blocks: any[]; anchor: number; head: number; doc: unknown } | undefined {
  try {
    const blocks = editor?.getSelection?.()?.blocks;
    const view = editor?.prosemirrorView;
    const selection = view?.state?.selection;
    if (
      !blocks?.length ||
      !selection ||
      selection.empty ||
      !Number.isInteger(selection.anchor) ||
      !Number.isInteger(selection.head)
    ) return undefined;
    return {
      blocks: blocks.map((block: any) => ({ ...block })),
      anchor: selection.anchor,
      head: selection.head,
      doc: view.state.doc,
    };
  } catch {
    return undefined;
  }
}

/** Capture before focus moves into custom AI UI. Missing live selection leaves
 * an existing snapshot intact; cursor-mode menu opening clears it explicitly. */
export function captureAISelection(editor: any): boolean {
  const snapshot = liveAISelection(editor);
  if (!snapshot || !editor || typeof editor !== "object") return false;
  aiSelectionSnapshots.set(editor, snapshot);
  return true;
}

export function hasAISelection(editor: any): boolean {
  return !!liveAISelection(editor) || !!getAISelectionSnapshot(editor)?.length;
}

/** BlockNote-level check: is a text/block range selected right now? Unlike
 *  `hasAISelection` this does not need a live ProseMirror range, so it stays
 *  correct for the formatting-toolbar popover (which takes focus off the
 *  editor) and for node selections. Used to decide which prompt entry point
 *  owns the UI: toolbar popover for selection, FAB list for cursor mode. */
export function hasTextSelection(editor: any): boolean {
  try {
    return !!editor?.getSelection?.()?.blocks?.length;
  } catch {
    return false;
  }
}

/** Restore exact text offsets; BlockNote.setSelection selects whole blocks and
 * throws for the common single-block selection case. */
export function restoreAISelection(editor: any): boolean {
  const live = liveAISelection(editor);
  const snapshot = editor && typeof editor === "object"
    ? aiSelectionSnapshots.get(editor)
    : undefined;
  if (!snapshot) return !!live;
  if (snapshot.blocks.some((block) => !blockIdExists(editor, block.id))) return false;
  try {
    const view = editor.prosemirrorView;
    if (!view || view.state.doc !== snapshot.doc) return false;
    const selection = TextSelection.create(
      view.state.doc,
      snapshot.anchor,
      snapshot.head,
    );
    view.dispatch(view.state.tr.setSelection(selection));
    return !!editor.getSelectionCutBlocks?.(true)?.blocks?.length;
  } catch {
    return false;
  }
}

/**
 * Keep selection requests small without changing rust-ai's document-state schema.
 * The stock HTML builder includes every document block even when a selection is
 * active. Tool operations only need ids for selected blocks; nearby blocks are
 * included without ids as lightweight structural context.
 */
function isEmptyParagraph(block: any): boolean {
  if (!block || (block.type && block.type !== "paragraph")) return false;
  const content = Array.isArray(block.content) ? block.content : [];
  return content.length === 0 || content.every((item: any) =>
    item?.type === "text" && String(item.text ?? "").length === 0,
  );
}

function isEmptyDocument(editor: any, documentBlocks: any[]): boolean {
  const topLevel = Array.isArray(editor?.document) ? editor.document : [];
  return topLevel.length === 1 && documentBlocks.length === 1 && isEmptyParagraph(topLevel[0]);
}

export async function buildHtmlDocumentState(editor: any, useSelection = false): Promise<any> {
  const flatten = (blocks: any[]): any[] => blocks.flatMap((block) => [block, ...(block?.children?.length ? flatten(block.children) : [])])
  const documentBlocks = flatten(Array.isArray(editor?.document) ? editor.document : [])
  const emptyDocument = isEmptyDocument(editor, documentBlocks)
  if (useSelection) {
    const selected = editor?.getSelectionCutBlocks?.(true)?.blocks || editor?.getSelection?.()?.blocks || []
    return {
      isEmptyDocument: emptyDocument,
      selection: true,
      selectedBlocks: await Promise.all(selected.map(async (block: any) => ({ id: `${block.id}$`, block: await editor.blocksToHTMLLossy([block]) }))),
      blocks: await Promise.all(documentBlocks.map(async (block: any) => ({ block: await editor.blocksToHTMLLossy([block]) }))),
    }
  }
  // Cursor mode must use the menu anchor, not the live cursor. The composer
  // takes focus and the AI extension makes the editor read-only while a request
  // is running, so getTextCursorPosition() can resolve to a stale block.
  const cursor = resolveActiveBlockId(editor) || editor?.getTextCursorPosition?.()?.block?.id
  const blocks = await Promise.all(documentBlocks.map(async (block: any) => ({ id: `${block.id}$`, block: await editor.blocksToHTMLLossy([block]) })))
  const withCursor = blocks.flatMap((block: any) => block.id === `${cursor}$` ? [block, { cursor: true }] : [block])
  return { selection: false, isEmptyDocument: emptyDocument, blocks: withCursor }
}

export function createSelectionAwareDocumentStateBuilder(defaultBuilder: any) {
  return async (request: any) => {
    if (!request?.selectedBlocks?.length) return defaultBuilder(request);
    const editor = request.editor;
    const flatten = (blocks: any[]): any[] => blocks.flatMap((block) => [
      block,
      ...(block?.children?.length ? flatten(block.children) : []),
    ]);
    const documentBlocks = flatten(Array.isArray(editor?.document) ? editor.document : []);
    const selectedIds = new Set(
      request.selectedBlocks.map((block: any) => String(block?.id ?? "")),
    );
    const selectedIndexes = documentBlocks
      .map((block, index) => selectedIds.has(String(block?.id)) ? index : -1)
      .filter((index) => index >= 0);
    const first = selectedIndexes.length ? Math.min(...selectedIndexes) : 0;
    const last = selectedIndexes.length ? Math.max(...selectedIndexes) : -1;
    const contextBlocks = last >= 0
      ? documentBlocks.slice(Math.max(0, first - 2), last + 3)
      : [];
    const convert = async (block: any) => ({
      id: block.id,
      block: await editor.blocksToHTMLLossy([block]),
    });
    const selectedBlocks = await Promise.all(
      request.selectedBlocks.map(convert),
    );
    const selectedSet = new Set(selectedBlocks.map((block: any) => block.id));
    const blocks = await Promise.all(
      contextBlocks
        .filter((block) => !selectedSet.has(block.id))
        .map(async (block) => ({
          block: await editor.blocksToHTMLLossy([block]),
        })),
    );
    return {
      isEmptyDocument: documentBlocks.length === 0,
      selection: true,
      selectedBlocks: selectedBlocks.map((block: any) => ({
        ...block,
        id: `${String(block.id)}$`,
      })),
      blocks,
    };
  };
}

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

/**
 * Resolve the block the formatting-toolbar AI button should open its menu at.
 *
 * The stock toolbar AI button does `const s = editor.getSelection(); if (!s)
 * throw new Error("No selection")` — but BlockNote's `getSelection()` returns
 * `undefined` for collapsed AND node selections (`"node" in tr.selection`, e.g.
 * a selected image), while the formatting toolbar is still shown. Clicking the
 * sparkle then throws an uncaught error.
 *
 * Prefer the last selected block (keeps text-selection semantics so the
 * selection-aware prompts like Translate appear), otherwise fall back to the
 * cursor block. `getSelection()` / `getTextCursorPosition()` can also throw on
 * odd documents, so both are guarded.
 */
export function resolveAIBlockId(editor: any): string | undefined {
  try {
    const blocks = editor?.getSelection?.()?.blocks;
    const id = blocks?.length ? blocks[blocks.length - 1]?.id : undefined;
    if (id) return id;
  } catch {
    /* fall through to the cursor block */
  }
  try {
    return editor?.getTextCursorPosition?.()?.block?.id;
  } catch {
    return undefined;
  }
}

/**
 * Open the rust-ai menu at the resolved block and keep the editor's text cursor
 * in sync with it.
 *
 * rust-ai re-reads the LIVE cursor when building the request
 * (`buildAIRequest` → `getTextCursorPosition()` and `defaultDocumentStateBuilder`),
 * so if the cursor is stale when the menu opens, the document state sent to the
 * model carries the wrong block. Operations then reference ids the model never
 * saw and the block ID is reported as unrecognized. Anchoring the cursor at open
 * time (focus is still on the editor) makes every later read consistent.
 *
 * Returns the anchored block id (or undefined when nothing is resolvable).
 */
export function openAIMenuAtAnchor(editor: any): string | undefined {
  let selection: any;
  try {
    selection = editor?.getSelection?.();
  } catch {
    selection = undefined;
  }

  // A normal-chat submit can happen while focus is in the floating textarea.
  // Restore the editor's last selection before resolving the cursor anchor, but
  // never do this for an active text selection because focus/cursor operations
  // can collapse it before invokeAI reads useSelection.
  if (!selection?.blocks?.length) {
    try {
      editor?.focus?.();
    } catch {
      /* fall back to the last available editor selection */
    }
  }

  const selectedBlocks = selection?.blocks?.length ? selection.blocks : undefined;
  if (selectedBlocks?.length) {
    captureAISelection(editor);
  } else if (editor && typeof editor === "object") {
    aiSelectionSnapshots.delete(editor);
  }
  const blockId = resolveAIBlockId(editor);
  let ai: any;
  try {
    ai = editor?.getExtension?.('ai');
  } catch {
    ai = undefined;
  }
  if (!blockId || !ai?.openAIMenuAtBlock) return undefined;
  try {
    // Reposition only for cursor mode. Moving the cursor during a text
    // selection collapses the selection before invokeAI can use it.
    if (
      !selection?.blocks?.length &&
      editor.getTextCursorPosition?.()?.block?.id !== blockId
    ) {
      editor.setTextCursorPosition?.(blockId, "end");
    }
  } catch {
    /* selection may be unavailable — the menu anchor still holds */
  }
  ai.openAIMenuAtBlock(blockId);
  return blockId;
}

/**
 * Resolve the block the AI should treat as its anchor when assembling document
 * context, tolerating a host that has lost editor focus.
 *
 * Sending from the floating composer moves DOM focus into a `<textarea>`, and
 * rust-ai locks the editor (`isEditable = false`) while its menu is open. In that
 * state `getTextCursorPosition()` can resolve to a stale/fallback block, so the
 * context would no longer match the block the user picked — operations then
 * reference an id the model never saw (`block ID not recognized`).
 *
 * Prefer the menu's anchored block (set by `openAIMenuAtBlock` from a
 * focus-time-resolved id) and fall back to the live cursor.
 */
export function resolveActiveBlockId(editor: any): string | undefined {
  try {
    const menu = editor?.getExtension?.('ai')?.store?.state?.aiMenuState;
    if (menu && menu !== "closed" && typeof menu.blockId === "string")
      return menu.blockId;
  } catch {
    /* fall through to the live cursor */
  }
  return resolveAIBlockId(editor);
}

/** Semantic anti-hallucination: referenced ids in applyDocumentOperations must exist in the doc. */
/**
 * Ensure every operation id/referenceId carries the trailing `$` that
 * BlockNote's applyDocumentOperations expects (idsSuffixed). The document
 * state in the AI prompt has suffixed ids, but some models (e.g. GLM) strip
 * the `$` when echoing them back — rust-ai then rejects with
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

/** Budget split for the cursor-anchored window: text before the cursor is
 *  supporting context, text after it carries what "continue" must follow. */
const CONTEXT_BEFORE_RATIO = 0.4;
/** Marker inserted at the anchored block so the model knows where the caret is;
 *  text-only models never see a cursor otherwise. */
export const CURSOR_MARKER = "<!-- cursor -->";

/** Locate the anchored block's index in the flattened document so the window
 *  can be centred on it. Returns -1 when the block cannot be resolved. */
function flattenBlocks(blocks: any[]): any[] {
  return blocks.flatMap((block) => [
    block,
    ...(block?.children?.length ? flattenBlocks(block.children) : []),
  ]);
}

/**
 * Cursor-anchored Markdown context for the text-only (non-tool) path.
 *
 * Truncating the whole document from char 0 drops exactly the region the user
 * is writing in, so "continue writing" was answered from the document *start*
 * on long notes. Instead, window the Markdown around the anchored block and
 * mark the caret, so the model always sees local context and where to resume.
 */
export function buildDocumentContext(editor: any): string {
  if (!editor) return "";
  try {
    const MAX = AI_FORMATTING_RULES.maxContextChars;
    const selCtx = describeSelection(editor);
    const anchorId = resolveActiveBlockId(editor);
    const block = anchorId ? findBlock(editor, anchorId) : null;
    if (!block) {
      const md = editor.blocksToMarkdownLossy(editor.document);
      return trimContext(md, MAX) + selCtx;
    }

    // Render the document up to and including the anchored block's siblings.
    // Splitting on the anchor's own Markdown is lossy for repeated text, so
    // walk real block boundaries instead: parent index for top-level blocks,
    // sibling index for nested ones.
    const flat = flattenBlocks(Array.isArray(editor.document) ? editor.document : []);
    const anchorIndex = flat.indexOf(block);
    const before = flat.slice(0, anchorIndex);
    const after = flat.slice(anchorIndex + 1);

    const beforeMd = before.length ? editor.blocksToMarkdownLossy(before) : "";
    const anchorMd = editor.blocksToMarkdownLossy([block]);
    const afterMd = after.length ? editor.blocksToMarkdownLossy(after) : "";

    // Anchor block must survive verbatim: it carries the caret and the style
    // the continuation has to match. Budget the rest around it.
    const anchorBudget = anchorMd.length + CURSOR_MARKER.length;
    const remaining = Math.max(0, MAX - anchorBudget);
    const beforeBudget = Math.floor(remaining * CONTEXT_BEFORE_RATIO);
    const afterBudget = remaining - beforeBudget;

    const head = tailTruncate(beforeMd, beforeBudget);
    const tail = headTruncate(afterMd, afterBudget);

    const marked = /\n$/.test(anchorMd)
      ? anchorMd + CURSOR_MARKER + "\n"
      : anchorMd + "\n" + CURSOR_MARKER + "\n";
    return head + marked + tail + selCtx;
  } catch {
    return "";
  }
}

/** Keep the LAST `budget` chars — the text closest to the anchor. */
function tailTruncate(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= 0) return "";
  const sliced = text.slice(-budget);
  const firstBreak = sliced.indexOf("\n");
  return "...[truncated]\n" + (firstBreak >= 0 ? sliced.slice(firstBreak + 1) : sliced);
}

/** Keep the FIRST `budget` chars — the text that immediate continuation follows. */
function headTruncate(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= 0) return "";
  const sliced = text.slice(0, budget);
  const lastBreak = sliced.lastIndexOf("\n");
  return (lastBreak > 0 ? sliced.slice(0, lastBreak) : sliced) + "\n...[truncated]";
}

/** Fallback path (no resolvable anchor): cap the document at `max` chars. */
function trimContext(text: string, max: number): string {
  return text.length > max ? text.substring(0, max) + "\n...[truncated]" : text;
}

/** Selection block-type summary for the text prompt. Falls back to the AI menu's
 *  anchored block when the editor has lost focus (composer submit), so the model
 *  still learns the block type it must preserve on edit. */
function describeSelection(editor: any): string {
  try {
    const sel = editor.getSelection();
    if (sel?.blocks?.length)
      return `\n\nSelection block types (preserve on edit):\n${sel.blocks.map((b: any) => `- ${b.type}${b.level ? " level " + b.level : ""}`).join("\n")}`;
  } catch {
    /* fall through to the anchored block */
  }
  const id = resolveActiveBlockId(editor);
  if (!id) return "";
  const block = findBlock(editor, id);
  return block?.type
    ? `\n\nActive block type (preserve on edit):\n- ${block.type}${block.level ? " level " + block.level : ""}`
    : "";
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

/** Literal delimiters stated to the model in the text-only (Path B) prompt. */
export const AI_CONTENT_OPEN = "<content>";
export const AI_CONTENT_CLOSE = "</content>";

/** Matchers are kept separate from the constants above so a casing or spacing
 *  variant the model invents still resolves, instead of silently failing the
 *  reply into the no-write path. A test pins the two together. */
const CONTENT_OPEN = /<content\s*>/i;
const CONTENT_CLOSE = /<\/content\s*>/gi;

/**
 * Pull the document payload out of a text-only (Path B) reply.
 *
 * Text mode has no schema to lean on, so a reply on its own cannot say whether
 * it is content or commentary *about* content. The delimiter is what makes that
 * verifiable: without it the reply is an answer, an apology, or an echo of the
 * prompt — and writing it would overwrite the selection, or append after the
 * cursor, with the model's prose.
 *
 * Preamble and trailing notes are tolerated because the tags bound the payload,
 * so "Here is the content:" still maps. Returns null when there is no complete,
 * non-empty payload — callers must treat that as "nothing to write".
 */
export function extractDelimitedContent(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const open = CONTENT_OPEN.exec(text);
  if (!open) return null;
  const rest = text.slice(open.index + open[0].length);
  // The LAST closing tag wins: that keeps the whole payload when the content
  // itself contains the literal tag, rather than truncating mid-document.
  const closes = [...rest.matchAll(CONTENT_CLOSE)];
  const close = closes[closes.length - 1];
  if (!close || close.index === undefined) return null;
  const content = rest.slice(0, close.index).trim();
  return content.length ? content : null;
}

/**
 * Build an applyDocumentOperations input from the AI text output.
 * Follows rust-ai's operation schema (html format, idsSuffixed):
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
    let sel: any;
    try {
      sel = editor.getSelection();
    } catch {
      sel = undefined;
    }
    const selectedBlocks = sel?.blocks?.length
      ? sel.blocks
      : getAISelectionSnapshot(editor);
    if (selectedBlocks?.length) {
      const formatted = inheritFormatOnReplace(selectedBlocks, parsed);
      /** Update ops map 1:1 onto the selection; extra blocks (model returned more than selected)
       *  become an add-op after the last selected block — never an "undefined$" id that fails validation. */
      const operations: any[] = formatted
        .slice(0, selectedBlocks.length)
        .map((block: any, i: number) => ({
          type: "update",
          id: selectedBlocks[i]?.id + "$",
          block: editor.blocksToHTMLLossy([block]),
        }));
      const extras = formatted.slice(selectedBlocks.length);
      if (extras.length) {
        operations.push({
          type: "add",
          referenceId: selectedBlocks[selectedBlocks.length - 1]?.id + "$",
          position: "after",
          blocks: extras.map((b: any) => editor.blocksToHTMLLossy([b])),
        });
      }
      return { type: "applyDocumentOperations", operations };
    }
    const cursor = editor.getTextCursorPosition();
    const emptyBlock = Array.isArray(editor.document) && editor.document.length === 1 && isEmptyParagraph(editor.document[0])
      ? editor.document[0]
      : null;
    if (emptyBlock) {
      const operations: any[] = [{
        type: "update",
        id: `${emptyBlock.id}$`,
        block: editor.blocksToHTMLLossy([parsed[0]]),
      }];
      if (parsed.length > 1) {
        operations.push({
          type: "add",
          referenceId: `${emptyBlock.id}$`,
          position: "after",
          blocks: parsed.slice(1).map((block: any) => editor.blocksToHTMLLossy([block])),
        });
      }
      return { type: "applyDocumentOperations", operations };
    }
    /** Focus-loss tolerant anchor: when the user submits from the floating
     *  composer, the editor is locked and unfocused, so `getTextCursorPosition()`
     *  can be stale. Prefer the AI menu's anchored block (resolved at invoke time)
     *  when it disagrees with the live cursor. */
    const anchored = findBlock(editor, resolveActiveBlockId(editor) || "");
    /** Anchor add-ops on the previous block when the cursor block is empty: the
     *  empty cursor block would otherwise keep the new content below it, and a
     *  referenced empty block can be gone before the operations execute
     *  ("referenceId not found"). Single-empty-block documents keep the cursor
     *  block as the anchor. */
    const useAnchored = !!anchored && anchored.id !== cursor?.block?.id;
    const refBlock = useAnchored
      ? anchored
      : cursor?.block &&
          (!cursor.block.content || cursor.block.content.length === 0) &&
          cursor.prevBlock
        ? cursor.prevBlock
        : cursor?.block;
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
