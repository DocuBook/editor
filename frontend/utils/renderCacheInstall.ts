import mermaid from 'mermaid';
import { cacheMermaidParse, createQueuedMermaidRender } from './mermaidRenderCache';
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
  // `render` both memoizes by source and serializes the global renderer on an
  // idle turn; `parse` memoizes the validator the diagram preview runs first.
  (mermaid as any).render = createQueuedMermaidRender(mermaid.render);
  (mermaid as any).parse = cacheMermaidParse(mermaid.parse);
  installKatexRenderCache();
}
