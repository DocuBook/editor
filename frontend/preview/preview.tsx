import React, { useMemo } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MDXProvider } from '@mdx-js/react';
import { createMdxComponents } from '@docubook/mdx-content';
import { compileSync, runSync } from '@mdx-js/mdx';
import * as runtime from 'react/jsx-runtime';

let root: Root | null = null;
const cache = new Map<string, any>();

function compileMdx(markdown: string) {
  if (cache.has(markdown)) return cache.get(markdown);
  try {
    const code = String(compileSync(markdown, { outputFormat: 'function-body' }));
    const mod = runSync(code, { ...runtime, baseUrl: import.meta.url });
    cache.set(markdown, mod);
    return mod;
  } catch {
    return null;
  }
}

function PreviewRenderer({ markdown, components }: { markdown: string; components: any }) {
  const content = useMemo(() => {
    const mod = compileMdx(markdown);
    if (!mod?.default) {
      return React.createElement('div', {
        dangerouslySetInnerHTML: { __html: simpleMarkdown(markdown) }
      });
    }
    const Content = mod.default;
    return React.createElement(MDXProvider, { components },
      React.createElement(Content)
    );
  }, [markdown]);
  return content;
}

export function render(markdown: string, containerId = 'preview-pane') {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!root) root = createRoot(container);
  const components = createMdxComponents();
  root.render(React.createElement(PreviewRenderer, { markdown, components }));
}

export function destroy(containerId = 'preview-pane') {
  if (root) { root.unmount(); root = null; }
  const container = document.getElementById(containerId);
  if (container) container.innerHTML = '';
}

function simpleMarkdown(md: string): string {
  let html = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>');
  return '<div class="prose prose-invert max-w-none px-6 py-4">' + html + '</div>';
}
