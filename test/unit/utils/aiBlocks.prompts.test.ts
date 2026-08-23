import { describe, it, expect } from 'vitest'
import { AI_MARKDOWN_INSTRUCTION, buildEditSystemPrompt, buildTaskFormattingRules, buildToolSystemPrompt, vaultPromptHints } from '../../../frontend/utils/aiBlocks'

describe('buildToolSystemPrompt', () => {
  const base = buildToolSystemPrompt('[{"id":"a$","block":"<p>x</p>"}]')
  it('instructs the tool call and preserves internal ids', () => {
    expect(base).toContain('applyDocumentOperations')
    expect(base).toContain('trailing $')
    expect(base).toContain('"id":"a$"')
    expect(base).toContain('internal ids may appear only inside applyDocumentOperations arguments')
  })
  it('documents the math block HTML encoding', () => {
    expect(base).toContain('math display="block"')
    expect(base).toContain('application/x-tex')
  })
  it('documents the mermaid diagram HTML encoding', () => {
    expect(base).toContain('language-mermaid')
    expect(base).toContain('data-language="mermaid"')
  })
  it('tool prompt has no reference material unless supplied', () => {
    expect(base).not.toContain('Reference material')
  })
  it('adds scaffold guidance only for an EMPTY document (no taskRules)', () => {
    expect(base).not.toContain('document is EMPTY')
    const empty = buildToolSystemPrompt('[]')
    expect(empty).toContain('document is EMPTY')
    expect(empty).toContain('single valid HTML element')
    // steering is separate from taskRules
    expect(empty).not.toContain('Task-specific rules')
    expect(buildToolSystemPrompt('')).toContain('document is EMPTY')
  })
})

describe('vaultPromptHints', () => {
  it('matches wikilink, question, generate verb and empty doc', () => {
    expect(vaultPromptHints('lihat [[roadmap]]', 'doc')).toBe(true)
    expect(vaultPromptHints('Apa isi vault?', 'doc')).toBe(true)
    expect(vaultPromptHints('Buat draft rencana', 'doc')).toBe(true)
    expect(vaultPromptHints('apa pun', '')).toBe(true) // empty doc
  })
  it('misses plain edit prompts on a non-empty doc', () => {
    expect(vaultPromptHints('perbaiki kalimat ini', 'doc content')).toBe(false)
    expect(vaultPromptHints('jadikan lebih pendek', 'doc content')).toBe(false)
  })
})

describe('buildTaskFormattingRules', () => {
  it('adds summarize rule', () => {
    expect(buildTaskFormattingRules('Summarize')).toContain('concise summary')
  })
  it('adds translate rule', () => {
    expect(buildTaskFormattingRules('Translate to Indonesian')).toContain('preserve its tone')
  })
  it('adds fix spelling rule', () => {
    expect(buildTaskFormattingRules('Fix spelling')).toContain('spelling and grammar errors only')
  })
  it('adds improve rule', () => {
    expect(buildTaskFormattingRules('Improve writing')).toContain('preserve the original meaning')
  })
  it('returns empty for unknown prompt', () => {
    expect(buildTaskFormattingRules('do whatever')).toBe('')
  })
})

describe('grounding (bekal) in prompts', () => {
  it('tool prompt embeds reference material when provided', () => {
    const p = buildToolSystemPrompt('[{"id":"a$","block":"<p>x</p>"}]', '## notes\n(File: x.md)\nisi')
    expect(p).toContain('Reference material')
    expect(p).toContain('## notes')
  })
  it('edit prompt (empty doc) generates from reference material', () => {
    const p = buildEditSystemPrompt('', '## notes\n(File: x.md)\nisi')
    expect(p).toContain('writing new content')
    expect(p).toContain('Reference material')
    expect(p).toContain('## notes')
  })
  it('tool prompt has no reference material when none', () => {
    expect(buildToolSystemPrompt('[{"id":"a$"}]')).not.toContain('Reference material')
  })
})

describe('buildEditSystemPrompt', () => {
  it('includes markdown content, grounding and task rules without block-id instructions', () => {
    const p = buildEditSystemPrompt('konten doc', '## notes\nisi', '- summarize rule')
    expect(p).toContain('Document content (Markdown):')
    expect(p).toContain('konten doc')
    expect(p).toContain('Reference material')
    expect(p).toContain('summarize rule')
    expect(p).not.toContain('reference block ids')
    expect(p).not.toContain('exact block ids')
  })
})

describe('AI_MARKDOWN_INSTRUCTION', () => {
  it('is a non-empty markdown instruction', () => {
    expect(AI_MARKDOWN_INSTRUCTION).toContain('BlockNote-compatible Markdown')
    expect(AI_MARKDOWN_INSTRUCTION).toContain('No commentary')
  })
})

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
