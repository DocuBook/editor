import mermaid from 'mermaid';
import { defaultMermaidOptions } from '@blocknote/diagram-block';
import { cacheMermaidParse, createQueuedMermaidRender } from './mermaidRenderCache';
import { readMermaidTheme, type MermaidTheme } from './mermaidTheme';
import { installKatexRenderCache } from './mathRenderCache';

let installed = false;

/** Mermaid's `securityLevel` decides whether rendered SVG is sanitized with
 *  DOMPurify (`strict`), trusted (`loose`), or iframed (`sandbox`). The preview
 *  injects that SVG with `dangerouslySetInnerHTML`, and the diagram source comes
 *  from note content, so `strict` is a security boundary — not a preference.
 *
 *  `strict` is currently Mermaid's own default, but that is an implementation
 *  detail of a third-party package: a version bump or a caller passing its own
 *  options could silently downgrade it. Pinning on every `initialize` call (the
 *  app's own, and the ones `@blocknote/diagram-block` issues) makes the
 *  guarantee independent of both. */
function pinMermaidSecurity(mermaidApi: typeof mermaid): void {
  const initialize = mermaidApi.initialize.bind(mermaidApi);
  mermaidApi.initialize = ((options: Parameters<typeof initialize>[0] = {}) =>
    initialize({ ...options, securityLevel: 'strict' })) as typeof initialize;
}

/** The options `initializeMermaid` from `@blocknote/diagram-block` passes.
 *  `mermaid.initialize` rebuilds the site config from Mermaid's defaults on
 *  every call, so a themed call must repeat them or it would drop them. */
const MERMAID_OPTIONS = {
  ...defaultMermaidOptions,
  startOnLoad: false,
  suppressErrorRendering: true,
};

/** Make the app palette Mermaid's site config (see `readMermaidTheme`). It runs
 *  inside the render queue, right before each render, because the config is
 *  page-global: a theme switch must not leak into a render queued under the
 *  previous theme, and `initializeMermaid` (upstream, once) must not be the last
 *  word on it.
 *
 *  Mermaid parses the colors itself, and an unparsable token value throws here.
 *  Rather than failing every diagram, that falls back to Mermaid's built-in
 *  palette for the same color scheme. */
function applyMermaidTheme(mermaidApi: typeof mermaid, { themeVariables }: MermaidTheme): void {
  try {
    mermaidApi.initialize({ ...MERMAID_OPTIONS, theme: 'base', themeVariables });
  } catch (error) {
    console.error('[mermaid theme]', error);
    mermaidApi.initialize({ ...MERMAID_OPTIONS, theme: themeVariables.darkMode ? 'dark' : 'default' });
  }
}

/** Install the renderer memoization, once, on the singleton library objects.
 *
 *  Mermaid and KaTeX are both page-global: `@blocknote/diagram-block` imports the
 *  same `mermaid`, and `@blocknote/math-block` the same `katex`, so patching the
 *  modules here covers every preview that renders through them, in every editor
 *  instance. Idempotent — a second call is a no-op, so the wrap cannot stack and
 *  turn one cache lookup into a chain of them. */
export function installRenderCaches(): void {
  if (installed) return;
  installed = true;
  pinMermaidSecurity(mermaid);
  // `render` both memoizes by source and theme and serializes the global
  // renderer on an idle turn, applying the theme read when the render was
  // requested; `parse` memoizes the validator the export renderer runs first.
  (mermaid as any).render = createQueuedMermaidRender(mermaid.render, {
    siteConfig: () => {
      const theme = readMermaidTheme();
      return { key: theme.key, apply: () => applyMermaidTheme(mermaid, theme) };
    },
  });
  (mermaid as any).parse = cacheMermaidParse(mermaid.parse);
  installKatexRenderCache();
}
