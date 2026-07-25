import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { autocompletion, CompletionContext } from '@codemirror/autocomplete';

let editorView = null;
let onContentChange = null;
let vaultPath = '';

// Wikilink autocomplete source
function wikilinkSource(context) {
  const word = context.matchBefore(/\[\[[^\]]*$/);
  if (!word || word.from === word.to) return null;
  
  const query = word.text.slice(2); // remove [[
  
  return {
    from: word.from + 2,
    options: [], // populated async
    validFor: /\[\[[^\]]*$/,
  };
}

// Async autocomplete
async function wikilinkComplete(context) {
  const word = context.matchBefore(/\[\[[^\]]*$/);
  if (!word) return null;
  
  const query = word.text.slice(2);
  if (query.length < 1) return null;
  
  const baseUrl = window.htmx?.config?.baseUrl || '';
  try {
    const res = await fetch(baseUrl + '/api/wiki/suggest?q=' + encodeURIComponent(query));
    const data = await res.json();
    return {
      from: word.from + 2,
      options: data.map(item => ({
        label: item.title,
        detail: item.path,
        apply: item.title + ']](' + item.path + ')',
        type: 'keyword',
      })),
    };
  } catch {
    return null;
  }
}

export function setVaultPath(path) {
  vaultPath = path;
}

export function createEditor(parent, content = '', callbacks = {}) {
  onContentChange = callbacks.onChange || null;

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && onContentChange) {
      onContentChange(update.state.doc.toString());
    }
  });

  const state = EditorState.create({
    doc: content,
    extensions: [
      basicSetup,
      markdown({ base: markdownLanguage }),
      oneDark,
      keymap.of([indentWithTab]),
      updateListener,
      autocompletion({ override: [wikilinkComplete] }),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
        '.cm-content': { fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: '14px' },
        '.cm-gutters': { borderRight: '1px solid #2a2a2e' },
      }),
    ],
  });

  editorView = new EditorView({
    state,
    parent,
  });

  return editorView;
}

export function setEditorContent(content) {
  if (!editorView) return;
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: content },
  });
}

export function getEditorContent() {
  if (!editorView) return '';
  return editorView.state.doc.toString();
}

export function destroyEditor() {
  if (editorView) {
    editorView.destroy();
    editorView = null;
  }
}
