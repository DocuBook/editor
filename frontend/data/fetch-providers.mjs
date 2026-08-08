#!/usr/bin/env node
/**
 * Regenerate frontend/data/providers.ts from the models.dev API.
 *
 *   node frontend/data/fetch-providers.mjs            # fetch live + write
 *   node frontend/data/fetch-providers.mjs --cache    # reuse /tmp/models.dev.json (offline dev)
 *
 * Source of truth: https://models.dev/api.json (provider-scoped catalog).
 * Output format must stay stable — frontend imports ModelInfo, ProviderInfo,
 * PROVIDERS and getDefaultModel (SettingsModal, Editor transport).
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

const OUT = new URL('./providers.ts', import.meta.url)
const CACHE = '/tmp/models.dev.json'

const api = await fetchCatalog(process.argv.includes('--cache'))
const providers = Object.entries(api)
  .filter(([, p]) => p && typeof p === 'object' && p.models && typeof p.models === 'object')
  .map(([id, p]) => {
    const models = Object.values(p.models)
      .filter(m => m && typeof m === 'object')
      .map(m => ({
        id: String(m.id ?? ''),
        name: String(m.name ?? ''),
        costInput: typeof m.cost?.input === 'number' ? m.cost.input : 0,
        costOutput: typeof m.cost?.output === 'number' ? m.cost.output : 0,
        context: typeof m.limit?.context === 'number' ? m.limit.context : 0,
        toolCall: m.tool_call === true,
      }))
      // cheapest first (matches the previous generator's ordering)
      .sort((a, b) => a.costInput - b.costInput || a.id.localeCompare(b.id))
    return { id, name: String(p.name ?? id), api: String(p.api ?? ''), models }
  })
  .filter(p => p.models.length > 0)
  // alphabetical by provider id (stable output)
  .sort((a, b) => a.id.localeCompare(b.id))

const q = s => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const num = n => String(n)
const modelLine = m => {
  const parts = [
    `id: ${q(m.id)}`,
    `name: ${q(m.name)}`,
    `costInput: ${num(m.costInput)}`,
    `costOutput: ${num(m.costOutput)}`,
    `context: ${num(m.context)}`,
    ...(m.toolCall ? ['toolCall: true'] : []),
  ]
  return `      { ${parts.join(', ')} },`
}

const out = `// Auto-generated from models.dev/api.json — run \`node frontend/data/fetch-providers.mjs\`
export interface ModelInfo {
  id: string
  name: string
  costInput: number
  costOutput: number
  context: number
  toolCall?: boolean
}

export interface ProviderInfo {
  id: string
  name: string
  api: string
  models: ModelInfo[]
}

export const PROVIDERS: ProviderInfo[] = [
${providers.map(p => `  {
    id: ${q(p.id)}, name: ${q(p.name)},
    api: ${q(p.api)},
    models: [
${p.models.map(modelLine).join('\n')}
    ],
  },`).join('\n')}
]

/** Pick cheapest model for a provider. */
export function getDefaultModel(providerId: string): string | null {
  const p = PROVIDERS.find(x => x.id === providerId);
  if (!p || p.models.length === 0) return null;
  return [...p.models].sort((a, b) => (a.costInput + a.costOutput) - (b.costInput + b.costOutput))[0]?.id || null;
}
`

writeFileSync(OUT, out)
console.log(`✓ wrote ${OUT.pathname} — ${providers.length} providers, ${providers.reduce((n, p) => n + p.models.length, 0)} models`)

async function fetchCatalog(cache) {
  if (cache && existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, 'utf8'))
  const res = await fetch('https://models.dev/api.json')
  if (!res.ok) throw new Error(`models.dev api.json: HTTP ${res.status}`)
  const json = await res.json()
  writeFileSync(CACHE, JSON.stringify(json))
  return json
}
