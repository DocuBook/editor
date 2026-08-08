/** Close an unbalanced code fence so markdown parses cleanly (low-level models often forget the closing ```). */
export function normalizeMarkdown(text: string): string {
  const fences = (text || '').match(/```/g)?.length ?? 0
  if (fences % 2 !== 0) return (text || '').replace(/\s*$/, '') + '\n```'
  return text || ''
}

/**
 * Explicit formatting rules for AI → document operations.
 * Mirrors pi/ACP system-prompt principles: schema-constrained, grounded, validated.
 */
export const AI_FORMATTING_RULES = {
  /** Block types whose format is preserved when replacing a selection. */
  preserveFormatOnReplace: ['heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'toggleListItem', 'blockquote'],
  /** Max document-context chars sent to the model. */
  maxContextChars: 12000,
} as const

/** Max AI attempts before giving up (retry loop on semantic validation failure). */
export const MAX_AI_ATTEMPTS = 2

/** Check if a block id (optionally $-suffixed) exists in the editor document (recursive). */

/** Check if a block id (optionally $-suffixed) exists in the editor document (recursive). */
export function blockIdExists(editor: any, id: string): boolean {
  if (!editor?.document) return false
  const clean = String(id).replace(/\$$/, '')
  const find = (blocks: any[]): boolean =>
    blocks.some((b: any) => b.id === clean || (b.children?.length && find(b.children)))
  return find(editor.document)
}

/** Semantic anti-hallucination: referenced ids in applyDocumentOperations must exist in the doc. */
export function validateOperationsSemantics(editor: any, input: any): string | null {
  if (!input || input.type !== 'applyDocumentOperations' || !Array.isArray(input.operations)) return null
  for (const op of input.operations) {
    if (!op) continue
    if (op.type === 'add' && op.referenceId && !blockIdExists(editor, op.referenceId)) {
      return `referenceId "${op.referenceId}" does not exist in the document`
    }
    if ((op.type === 'update' || op.type === 'delete') && op.id && !blockIdExists(editor, op.id)) {
      return `block id "${op.id}" does not exist in the document`
    }
  }
  return null
}

/** Task-specific formatting rules based on the detected command (pi/ACP style). */
export function buildTaskFormattingRules(userText: string): string {
  const t = (userText || '').toLowerCase()
  const rules: string[] = []
  if (/summar/.test(t)) rules.push('Output a concise summary — keep only key points, preserve the original structure (headings/lists).')
  if (/transl/.test(t)) rules.push('Translate the selected content; preserve its tone, meaning, and block formatting exactly.')
  if (/improv|enhanc|rewrit/.test(t)) rules.push('Improve clarity and flow; preserve the original meaning, block structure, and inline formatting (bold/italic/links).')
  if (/spell|grammar|typo/.test(t)) rules.push('Fix spelling and grammar errors only; do not rewrite content or change meaning.')
  if (/simplif/.test(t)) rules.push('Simplify the language while keeping all key information and structure.')
  if (/continu|write/.test(t)) rules.push('Continue naturally from the cursor; match the existing tone and block style.')
  if (rules.length) return '\nTask-specific rules:\n- ' + rules.join('\n- ')
  return ''
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
export function isVaultGenerationIntent(userText: string, hasVaultContext: boolean, docContext: string): boolean {
  if (!hasVaultContext) return false
  const t = (userText || '').trim()
  if (/\[\[[^\]]+\]\]/.test(t)) return true
  if (/^.*\?$/.test(t)) return true
  if (/^(what|how|why|where|when|who|which|is|are|can|does|do|list|find|search|apa|bagaimana|kenapa|mengapa|kapan|siapa|di mana|dimana|cari|jelaskan|ringkas|sebutkan)\b/i.test(t)) return true
  if (/^(buat|tulis|generate|draft|rangkum|rekap|susun|rancang|outline|kerangka|summar)/i.test(t)) return true
  return !(docContext || '').trim()
}

/** System prompt for the vault-first path: the vault context is the ONLY source. */
export function buildVaultGroundingPrompt(vaultContext: string): string {
  return `You are working from the vault context below — it is your authoritative source material. Use it to fulfill the request (answer, summarize, draft, or generate content); cite the source file name(s) when you do.

─── Vault context (from [[wikilinks]] and search) ───${vaultContext}

Rules (MUST follow):
- Base your output on the vault context above; it is your only source material.
- If it does not contain what you need, say so clearly — never fabricate.
- Output plain Markdown only. No commentary, no preamble, no block ids.`
}

/** Single shared markdown instruction for Path B / fallback user messages. */
export const AI_MARKDOWN_INSTRUCTION = `Respond with the requested content using BlockNote-compatible Markdown. You may use: headings (## … ######), bold (**bold**), italic (*italic*), strikethrough (~~text~~), inline code (\`code\`), links ([text](url)), images (![alt](url)), code blocks (\`\`\`), bullet lists (-), numbered lists (1.), checklists (- [ ] / - [x]), blockquotes (>), dividers (---), tables (| a | b | with a | - | - | separator row). No commentary.`

/** Single edit-rule system prompt: document state (bekal) + vault context + rules. */
export function buildEditSystemPrompt(docContext: string, vaultContext: string, taskRules: string): string {
  const vault = vaultContext.trim() ? `\n\n─── Vault context (from [[wikilinks]] and search) ───${vaultContext}` : ''
  return `You are editing the document below. Prefer updating existing blocks over adding new ones; reference block ids EXACTLY as shown.

Document state (JSON):
${docContext}${vault}

Rules (MUST follow):
- Output ONLY the new or modified content for the requested task.
- NEVER echo the document state JSON or block ids back into the output.
- NEVER repeat the user's prompt or these instructions.
- NEVER invent block ids or content that is not in the document; if the document lacks the needed information, state that instead of fabricating.
- Use only the exact block ids from the document above when referencing existing blocks.
- Output must be free of spelling and grammar errors.
- When editing or replacing selected blocks, PRESERVE each block's type and formatting (e.g., keep a heading as a heading with the same level, keep lists as lists, keep code blocks as code blocks). Change only the content unless the user explicitly asks to change the format.${taskRules}`
}

/**
 * Build an applyDocumentOperations input from the AI text output.
 * Follows xl-ai's operation schema (html format, idsSuffixed):
 * - referenceId / id MUST end with `$`
 * - blocks MUST be HTML strings (not block objects)
 * - selection → update ops (preserving format); no selection → add op after cursor
 */
export async function buildApplyDocumentInput(editor: any, fullText: string): Promise<any | null> {
  if (!editor || !fullText?.trim()) return null
  try {
    /** Close unbalanced code fences before parsing (low-level models often forget the closing ```). */
    const parsed = await editor.tryParseMarkdownToBlocks(normalizeMarkdown(fullText))
    if (!parsed?.length) return null
    const sel = editor.getSelection()
    if (sel?.blocks?.length) {
      const formatted = inheritFormatOnReplace(sel.blocks, parsed)
      /** Update ops map 1:1 onto the selection; extra blocks (model returned more than selected)
       *  become an add-op after the last selected block — never an "undefined$" id that fails validation. */
      const operations: any[] = formatted.slice(0, sel.blocks.length).map((block: any, i: number) => ({
        type: 'update',
        id: sel.blocks[i]?.id + '$',
        block: editor.blocksToHTMLLossy([block]),
      }))
      const extras = formatted.slice(sel.blocks.length)
      if (extras.length) {
        operations.push({
          type: 'add',
          referenceId: sel.blocks[sel.blocks.length - 1]?.id + '$',
          position: 'after',
          blocks: extras.map((b: any) => editor.blocksToHTMLLossy([b])),
        })
      }
      return { type: 'applyDocumentOperations', operations }
    }
    const cursor = editor.getTextCursorPosition()
    return {
      type: 'applyDocumentOperations',
      operations: [{
        type: 'add',
        referenceId: cursor?.block?.id + '$',
        position: 'after',
        blocks: parsed.map((b: any) => editor.blocksToHTMLLossy([b])),
      }],
    }
  } catch { return null }
}

/** Block types that share inline text content (safe to inherit format onto a paragraph). */
const INLINE_CONTENT_TYPES = AI_FORMATTING_RULES.preserveFormatOnReplace

/**
 * When replacing a selection, re-apply the original block's format onto AI output.
 * If the model returned a plain paragraph but the original block was a heading/list/
 * blockquote (with inline content), inherit type + level so formatting is preserved.
 */
export function inheritFormatOnReplace(original: any[], parsed: any[]): any[] {
  return parsed.map((block, i) => {
    const orig = original[i]
    if (!orig || !orig.type) return block
    if (block.type === 'paragraph' && INLINE_CONTENT_TYPES.includes(orig.type)) {
      return { ...block, type: orig.type, level: orig.level }
    }
    return block
  })
}
