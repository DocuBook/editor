import './style.css';
import { createEditor, destroyEditor } from './editor.js';

document.addEventListener('alpine:init', () => {
  Alpine.data('editorApp', () => ({
    theme: localStorage.getItem('editor-theme') || 'dark',
    previewMode: 'split', // 'editor-only' | 'split' | 'preview-only'
    tabs: [],
    activeTab: null,
    backlinks: [],
    unlinked: [],
    cmdPaletteOpen: false,
    cmdQuery: '',
    aiOpen: false,
    aiQuery: '',
    aiResponse: '',
    aiStreaming: false,
    cmdItems: [
      { id: 'open-vault', label: 'Open Vault...', shortcut: 'Ctrl+O' },
      { id: 'new-note', label: 'New Note', shortcut: 'Ctrl+N' },
      { id: 'toggle-sidebar', label: 'Toggle Sidebar', shortcut: 'Ctrl+B' },
      { id: 'toggle-preview', label: 'Toggle Preview', shortcut: 'Ctrl+J' },
      { id: 'search-vault', label: 'Search in Vault...', shortcut: 'Ctrl+Shift+F' },
      { id: 'toggle-theme', label: 'Theme: Toggle Dark/Light', shortcut: 'Ctrl+D' },
      { id: 'push-publish', label: 'Push to Publish', shortcut: 'Ctrl+Shift+P' },
      { id: 'ask-ai', label: 'Ask AI Assistant', shortcut: 'Ctrl+Shift+A' },
    ],

    togglePreviewMode() {
      const modes = ['editor-only', 'split', 'preview-only'];
      const idx = modes.indexOf(this.previewMode);
      this.previewMode = modes[(idx + 1) % modes.length];
    },

    get filteredCmds() {
      if (!this.cmdQuery) return this.cmdItems;
      const q = this.cmdQuery.toLowerCase();
      return this.cmdItems.filter(i => i.label.toLowerCase().includes(q));
    },

    init() {
      this.applyTheme();
      this.$watch('theme', (val) => {
        localStorage.setItem('editor-theme', val);
        this.applyTheme();
      });
    },

    applyTheme() {
      document.documentElement.classList.toggle('dark', this.theme === 'dark');
      document.documentElement.classList.toggle('light', this.theme === 'light');
    },

    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
    },

    openFile(file) {
      const existing = this.tabs.find(t => t.path === file.path);
      if (existing) { this.activeTab = file.path; this.$nextTick(() => this.loadEditor()); return; }
      // Show loading tab
      this.tabs.push({ path: file.path, name: file.name, content: file.content || '' });
      this.activeTab = file.path;
      // If no content provided, fetch from server
      if (!file.content && file.path) {
        const baseUrl = htmx.config.baseUrl || '';
        fetch(baseUrl + '/api/vault/file/' + encodeURIComponent(file.path))
          .then(r => r.json())
          .then(data => {
            const tab = this.tabs.find(t => t.path === file.path);
            if (tab) { tab.content = data.content || ''; }
            this.$nextTick(() => this.loadEditor());
          })
          .catch(() => {
            this.$nextTick(() => this.loadEditor());
          });
      } else {
        this.$nextTick(() => this.loadEditor());
      }
    },

    closeTab(path, e) {
      e.stopPropagation();
      this.tabs = this.tabs.filter(t => t.path !== path);
      if (this.activeTab === path) {
        this.activeTab = this.tabs.length > 0 ? this.tabs[this.tabs.length - 1].path : null;
        this.$nextTick(() => this.activeTab ? this.loadEditor() : this.clearEditor());
      }
    },

    switchTab(path) {
      if (path === this.activeTab) return;
      this.activeTab = path;
      this.$nextTick(() => this.loadEditor());
    },

    get currentFile() {
      return this.tabs.find(t => t.path === this.activeTab);
    },

    loadEditor() {
      const container = document.getElementById('cm-container');
      if (!container) return;
      destroyEditor();
      const content = this.currentFile?.content || '';
      createEditor(container, content, {
        onChange: (val) => {
          if (this.currentFile) this.currentFile.content = val;
          this.updatePreview(val);
        },
      });
      this.updatePreview(content);
      this.loadBacklinks();
    },

    loadBacklinks() {
      const file = this.currentFile;
      if (!file?.path) { this.backlinks = []; this.unlinked = []; return; }
      const baseUrl = htmx.config.baseUrl || '';
      fetch(baseUrl + '/api/wiki/backlinks?path=' + encodeURIComponent(file.path))
        .then(r => r.json()).then(d => { this.backlinks = d || []; }).catch(() => {});
      fetch(baseUrl + '/api/wiki/unlinked?path=' + encodeURIComponent(file.path))
        .then(r => r.json()).then(d => { this.unlinked = d || []; }).catch(() => {});
    },

    clearEditor() {
      destroyEditor();
      const c = document.getElementById('cm-container');
      if (c) c.innerHTML = '<div class="flex items-center justify-center h-full text-zinc-600">Open a file to start editing</div>';
      if (window.EditorPreview?.destroy) window.EditorPreview.destroy();
      document.getElementById('preview-pane').innerHTML = '<div class="flex items-center justify-center h-full text-zinc-500 text-sm italic">Open a file to preview</div>';
    },

    updatePreview(content) {
      if (window.EditorPreview?.render) {
        window.EditorPreview.render(content || '', 'preview-pane');
      }
    },

    askAI(text) {
      this.aiQuery = text || '';
      this.aiResponse = '';
      this.aiOpen = true;
      this.aiStreaming = true;

      this.$nextTick(() => {
        const baseUrl = htmx.config.baseUrl || '';
        const params = new URLSearchParams({ text: this.aiQuery });
        const evtSource = new EventSource(baseUrl + '/api/agent/ask?' + params.toString());

        evtSource.addEventListener('token', (e) => {
          try {
            const d = JSON.parse(e.data);
            if (d.token) this.aiResponse += d.token;
          } catch {}
        });

        evtSource.addEventListener('done', () => {
          this.aiStreaming = false;
          evtSource.close();
        });

        evtSource.addEventListener('error', (e) => {
          this.aiStreaming = false;
          this.aiResponse += '\n\n[Error: ' + (e.data || 'connection failed') + ']';
          evtSource.close();
        });

        evtSource.onerror = () => {
          this.aiStreaming = false;
          evtSource.close();
        };
      });
    },

    closeAI() {
      this.aiOpen = false;
      this.aiQuery = '';
      this.aiResponse = '';
      this.aiStreaming = false;
    },

    toggleCmdPalette() {
      this.cmdPaletteOpen = !this.cmdPaletteOpen;
      this.cmdQuery = '';
      if (this.cmdPaletteOpen) {
        this.$nextTick(() => document.getElementById('cmd-input')?.focus());
      }
    },

    openGraphView() {
      const container = document.getElementById('preview-pane');
      if (!container) return;
      container.innerHTML = `<div id="graph-container" style="width:100%;height:100%;"><svg width="100%" height="100%"></svg></div>`;

      const baseUrl = htmx.config.baseUrl || '';
      fetch(baseUrl + '/api/graph')
        .then(r => r.json())
        .then(data => {
          if (!data.nodes || data.nodes.length === 0) {
            container.innerHTML = '<div class="flex items-center justify-center h-full text-zinc-500 text-sm">No notes to graph</div>';
            return;
          }
          this.renderD3Graph(data, container);
        })
        .catch(() => {
          container.innerHTML = '<div class="flex items-center justify-center h-full text-zinc-500 text-sm">Failed to load graph</div>';
        });
    },

    renderD3Graph(data, container) {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;

      const svg = d3.select(container).select('svg');
      svg.selectAll('*').remove();

      const simulation = d3.forceSimulation(data.nodes)
        .force('link', d3.forceLink(data.links).id(d => d.id).distance(80))
        .force('charge', d3.forceManyBody().strength(-200))
        .force('center', d3.forceCenter(width / 2, height / 2));

      const link = svg.append('g')
        .selectAll('line')
        .data(data.links)
        .join('line')
        .attr('stroke', '#2a2a2e')
        .attr('stroke-width', 1.5);

      const node = svg.append('g')
        .selectAll('circle')
        .data(data.nodes)
        .join('circle')
        .attr('r', 6)
        .attr('fill', '#3b82f6')
        .attr('stroke', '#1d4ed8')
        .attr('stroke-width', 1.5)
        .style('cursor', 'pointer')
        .on('click', (event, d) => {
          window.openFileInEditor({path: d.id, name: d.title + '.md'});
        })
        .call(d3.drag()
          .on('start', (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on('end', (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          }));

      const label = svg.append('g')
        .selectAll('text')
        .data(data.nodes)
        .join('text')
        .text(d => d.title)
        .attr('font-size', '10px')
        .attr('fill', '#a1a1aa')
        .attr('dx', 8)
        .attr('dy', 3);

      simulation.on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);
        node
          .attr('cx', d => d.x)
          .attr('cy', d => d.y);
        label
          .attr('x', d => d.x)
          .attr('y', d => d.y);
      });
    },

    execCmd(id) {
      this.cmdPaletteOpen = false;
      if (id === 'toggle-theme') this.toggleTheme();
      if (id === 'toggle-preview') this.togglePreviewMode();
      if (id === 'ask-ai') {
        const text = this.currentFile?.content || '';
        this.askAI(text.slice(0, 1000));
      }
    },
  }));
});
