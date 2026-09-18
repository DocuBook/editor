import mermaid from 'mermaid';
import { cacheMermaidParse, createQueuedMermaidRender } from './mermaidRenderCache';
import { installKatexRenderCache } from './mathRenderCache';

let installed = false;

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
  // `render` both memoizes by source and serializes the global renderer on an
  // idle turn; `parse` memoizes the validator the diagram preview runs first.
  (mermaid as any).render = createQueuedMermaidRender(mermaid.render);
  (mermaid as any).parse = cacheMermaidParse(mermaid.parse);
  installKatexRenderCache();
}
