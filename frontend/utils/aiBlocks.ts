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
      return `referenceId "${op.referenceId}" does not exist in the document`;
    }
    if (
      (op.type === "update" || op.type === "delete") &&
      op.id &&
      !blockIdExists(editor, stripSuffix(op.id))
    ) {
      return `block id "${op.id}" does not exist in the document`;
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

/**
 * Route intent: vault-first generation vs document edit.
 *
 * The edit rules ("NEVER invent content that is not in the document") de-authorize
 * vault context, and Path A's tool call has nothing to anchor on in an empty doc.
 * So the vault path is taken when vault context exists AND the request is a
 * wikilink reference, a question, a generation command, or targets an empty
 * document — the vault context then acts as the model's only source material.
 */

/** Prompt-side hints that a request may need vault grounding — no knowledge of
 *  whether vault context actually exists. Shared by the transport's grounding
 *  pre-filter (skip the ai_grounding_context RTT when false) and the intent
 *  router below, so the two can never disagree. */
export function vaultPromptHints(
  userText: string,
  docContext: string,
): boolean {
  const t = (userText || "").trim();
  if (/\[\[[^\]]+\]\]/.test(t)) return true;
  if (/^.*\?$/.test(t)) return true;
  if (
    /^(what|how|why|where|when|who|which|is|are|can|does|do|list|find|search|apa|bagaimana|kenapa|mengapa|kapan|siapa|di mana|dimana|cari|jelaskan|ringkas|sebutkan)\b/i.test(
      t,
    )
  )
    return true;
  if (
    /^(buat|tulis|generate|draft|rangkum|rekap|susun|rancang|outline|kerangka|summar)/i.test(
      t,
    )
  )
    return true;
  return !(docContext || "").trim();
}

export function isVaultGenerationIntent(
  userText: string,
  hasVaultContext: boolean,
  docContext: string,
): boolean {
  if (!hasVaultContext) return false;
  return vaultPromptHints(userText, docContext);
}

/** System prompt for the vault-first path: the vault context is the ONLY source. */
/** Single shared markdown instruction for Path B / fallback user messages. */
export const AI_MARKDOWN_INSTRUCTION = `Respond with the requested content using BlockNote-compatible Markdown. You may use: headings (## … ######), bold (**bold**), italic (*italic*), strikethrough (~~text~~), inline code (\`code\`), links ([text](url)), images (![alt](url)), code blocks (\`\`\`), bullet lists (-), numbered lists (1.), checklists (- [ ] / - [x]), blockquotes (>), dividers (---), tables (| a | b | with a | - | - | separator row). No commentary.`;

/** Grounding context for non-tool paths: full document as markdown (the
 *  model-native format) + selection block types. The AI transport uses this
 *  for text-only and vault-generation routing. */
export function buildDocumentContext(editor: any): string {
  if (!editor) return "";
  try {
    const md = editor.blocksToMarkdownLossy(editor.document);
    const sel = editor.getSelection();
    const selCtx = sel?.blocks?.length
      ? `\n\nSelection (preserve these block types on edit):\n${sel.blocks.map((b: any) => `- ${b.id}: ${b.type}${b.level ? " level " + b.level : ""}`).join("\n")}`
      : "";
    const MAX = AI_FORMATTING_RULES.maxContextChars;
    const trimmed =
      md.length > MAX ? md.substring(0, MAX) + "\n...[truncated]" : md;
    return trimmed + selCtx;
  } catch {
    return "";
  }
}

/** Tool-path doc state: reuse xl-ai's OWN document state (already attached to
 *  the last user message as metadata.documentState — ids suffixed with `$`,
 *  HTML blocks). Rebuilding it as markdown is what made models hallucinate
 *  referenceIds ("referenceId not found"). Selection blocks go first. */
export function buildToolDocContext(ds: any): string {
  if (!ds?.blocks) return "";
  const MAX = AI_FORMATTING_RULES.maxContextChars;
  const full = JSON.stringify(ds.blocks);
  const state = ds.selectedBlocks?.length
    ? `SELECTED blocks (edit these when the user refers to the selection):\n${JSON.stringify(ds.selectedBlocks)}\n\nFull document:\n${full}`
    : full;
  return state.length > MAX
    ? state.substring(0, MAX) + "...[truncated]"
    : state;
}

/** True when a tool call carries at least one operation — the only channel that
 *  writes through xl-ai. Empty operations = model decided no change. */
export const isMeaningfulOps = (tc: any): boolean =>
  !!tc?.input &&
  Array.isArray(tc.input.operations) &&
  tc.input.operations.length > 0;

/** Base messages for ask_ai — differs by path:
 *  - tools: system prompt + clean chat history (doc state lives in the prompt)
 *  - text-only: system prompt + single user message (selection + markdown rules) */
export function buildBaseMessages(p: {
  system: string;
  messages: any[];
  userText: string;
  selText: string;
  useTools: boolean;
}): any[] {
  if (p.useTools) {
    const clean = p.messages.map((m: any) => ({
      role: m.role,
      content:
        (m.parts || [])
          .map((x: any) => (x.type === "text" ? x.text : ""))
          .join("") ||
        m.content ||
        "",
    }));
    return p.system ? [{ role: "system", content: p.system }, ...clean] : clean;
  }
  const userContent = `${p.userText}${p.selText ? `\n\nSelected text:\n"${p.selText}"` : ""}\n\n${AI_MARKDOWN_INSTRUCTION}`;
  return p.system
    ? [
        { role: "system", content: p.system },
        { role: "user", content: userContent },
      ]
    : [{ role: "user", content: userContent }];
}

/** System prompt for the tool path: doc state carries real block ids (see
 *  buildToolDocumentContext) and the model must route edits through
 *  applyDocumentOperations — ids EXACTLY as shown, including the trailing $. */
/** Tool-path system prompt: doc state (real block ids) + rules. Vault context is
 *  intentionally NOT included — vault-gen is routed to buildVaultGroundingPrompt
 *  (vault as the ONLY source), and edit rules de-authorize outside content. */
/** Build the tool-call (Path A) system prompt — tool-mill: doc state + how to
 *  call applyDocumentOperations + math/diagram HTML encodings. NO task
 *  rules (those steer Path B text output) and NO vault (vault-gen is Path B). */
/** Shared: related vault files (grounding) injected into both paths. */
const referenceMaterial = (grounding: string): string =>
  grounding.trim()
    ? `\n\n─── Reference material (related vault files) ───\n${grounding}`
    : "";

/** Build the tool-call (Path A) system prompt — doc state + grounding (related vault files)
 *  + how to call applyDocumentOperations + math/diagram HTML encodings.
 *  NO taskRules (those steer Path B). When the document is empty it gains
 *  explicit scaffolding so the model CREATES structured blocks (PI-style) instead of guessing. */
export function buildToolSystemPrompt(
  docContext: string,
  grounding = "",
): string {
  const isEmpty = !docContext?.trim() || docContext.trim() === "[]";
  const steer = isEmpty
    ? `
The document is EMPTY — create the requested content as new blocks ("add" operations).
Keep it well-structured: use headings (<h1>…<h6>) for organization, lists and
blockquotes where natural; each block is a single valid HTML element. Follow the
BlockNote HTML block rules above (math / diagram / code with data-language).
ONLY invent content the user asked for — structure it clearly.`
    : "";
  return `You are editing the document below. Use the "applyDocumentOperations" tool to make changes; do NOT output the new content as text. Reference block ids EXACTLY as shown — including the trailing $.

Document state (JSON):
${docContext}${referenceMaterial(grounding)}${steer}

Rules (MUST follow):
- Call applyDocumentOperations with an \`operations\` array (add / update / delete).
- Prefer updating existing blocks over removing and adding.
- NEVER invent block ids — use only the ids from the document state above.
- NEVER echo the document state JSON back.
- Blocks are HTML strings (single valid HTML element per block).
- Math block: <math display="block"><annotation encoding="application/x-tex">…LaTeX…</annotation></math>
- Diagram (mermaid): <pre><code class="language-mermaid" data-language="mermaid">…mermaid source…</code></pre>
- When editing or replacing selected blocks, PRESERVE each block's type and formatting.`;
}

/** Single text-only (Path B) system prompt — doc state + grounding +
 *  taskRules. Empty doc = generate new content from the reference material;
 *  non-empty = edit existing blocks. Replaces the old buildVaultGroundingPrompt
 *  (one grounding concept, one prompt). */
export function buildEditSystemPrompt(
  docContext: string,
  grounding = "",
  taskRules = "",
): string {
  const isEmpty = !docContext?.trim();
  const intro = isEmpty
    ? "You are writing new content. Use the reference material below when it supports the request; generate well-structured Markdown, no commentary or preamble."
    : "You are editing the document below. Prefer updating existing blocks over adding new ones; reference block ids EXACTLY as shown.";
  const docBlock = isEmpty
    ? ""
    : "Document state (JSON):\n" + docContext + "\n";
  const source = isEmpty ? "the reference material" : "the document";
  const sourceRule = isEmpty
    ? "- Base content on the reference material when relevant; if it lacks what you need, say so instead of fabricating.\n- Structure clearly with headings and lists where natural.\n- Output plain Markdown."
    : "- Output ONLY the new or modified content for the requested task.\n- Use only the exact block ids from the document above when referencing existing blocks.\n- When editing or replacing selected blocks, PRESERVE each block's type and formatting (e.g., keep a heading as a heading with the same level, keep lists as lists, keep code blocks as code blocks). Change only the content unless the user explicitly asks to change the format.";
  return `${intro}\n\n${docBlock}${referenceMaterial(grounding)}\n\nRules (MUST follow):\n${sourceRule}\n- NEVER echo the user\'s prompt or instructions.\n- NEVER invent block ids or content that is not in ${source}; if the needed information is missing, state that instead of fabricating.\n- Output must be free of spelling and grammar errors.${taskRules}`;
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
