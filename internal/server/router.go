package server

import (
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"editor/internal/agent"
	"editor/internal/config"
	"editor/internal/git"
	"editor/internal/markdown"
	"editor/internal/search"
	"editor/internal/vault"
	"editor/internal/wiki"
)

type Server struct {
	http    *http.Server
	Port    int
	vault   *vault.Service
	config  *config.Service
	git     *git.Service
	wiki    *wiki.Service
	search  *search.Service
	watcher *vault.Watcher
	agent   *agent.Service
}

func New(port int) *Server {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))

	v := vault.New()

	s := &Server{
		Port:  port,
		vault: v,
	}

	r.Get("/api/hello", helloHandler)
	r.Get("/api/layout/sidebar", s.sidebarHandler)
	r.Get("/api/layout/status", s.statusHandler)
	r.Post("/api/vault/open", s.openVaultHandler)
	r.Get("/api/vault/tree", s.treeHandler)
	r.Get("/api/vault/tree/{*path}", s.treeHandler)
	r.Get("/api/vault/file/{*path}", s.fileHandler)
	r.Post("/api/vault/file", s.createFileHandler)
	r.Post("/api/vault/rename", s.renameHandler)
	r.Post("/api/vault/delete", s.deleteHandler)
	r.Post("/api/vault/mkdir", s.mkdirHandler)
	r.Post("/api/vault/save", s.saveHandler)

	// Config
	r.Get("/api/config/docu", s.configUIHandler)
	r.Get("/api/config/docu/json", s.configGetHandler)
	r.Post("/api/config/docu", s.configSaveHandler)

	// Git
	r.Get("/api/git/status", s.gitStatusHandler)
	r.Post("/api/git/push", s.gitPushHandler)

	// Wiki
	r.Get("/api/wiki/suggest", s.wikiSuggestHandler)
	r.Get("/api/wiki/backlinks", s.wikiBacklinksHandler)
	r.Get("/api/wiki/unlinked", s.wikiUnlinkedHandler)

	// Search
	r.Get("/api/search", s.searchHandler)
	r.Get("/api/tags", s.tagsHandler)
	r.Get("/api/tag/{tag}", s.tagFilterHandler)

	// Watcher + Graph
	r.Get("/api/vault/version", s.versionHandler)
	r.Get("/api/graph", s.graphHandler)

	// AI Agent
	r.Get("/api/agent/ask", s.agentAskHandler)

	s.http = &http.Server{
		Addr:    fmt.Sprintf(":%d", port),
		Handler: r,
	}

	return s
}

func (s *Server) Start() error {
	return s.http.ListenAndServe()
}

func renderHTML(w http.ResponseWriter, html string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Write([]byte(html))
}

// jsEscape escapes a string for use inside single-quoted JS string
func jsEscape(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "'", "\\'")
	s = strings.ReplaceAll(s, "\n", "\\n")
	s = strings.ReplaceAll(s, "\r", "\\r")
	return s
}

func urlEscape(s string) string {
	return url.PathEscape(s)
}

func helloHandler(w http.ResponseWriter, r *http.Request) {
	renderHTML(w, `<div class="text-zinc-400">Hello from Go backend!</div>`)
}

// ── Sidebar ──

func (s *Server) sidebarHandler(w http.ResponseWriter, r *http.Request) {
	if !s.vault.IsOpen() {
		renderHTML(w, `<div class="flex flex-col h-full">
	<div class="p-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider border-b border-zinc-800">Files</div>
	<div class="flex-1 flex items-center justify-center p-4 text-sm text-zinc-500 italic" id="file-list">No vault opened</div>
	<div class="p-2 border-t border-zinc-800">
		<button hx-post="/api/vault/open" hx-target="#file-list" hx-swap="innerHTML"
			class="w-full text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors">+ Open Vault</button>
	</div>
</div>`)
		return
	}

	s.renderTree(w, "")
}

func (s *Server) renderTree(w http.ResponseWriter, subpath string) {
	entries, err := s.vault.Tree(subpath)
	if err != nil {
		renderHTML(w, `<div class="p-2 text-sm text-red-400">Error: `+html.EscapeString(err.Error())+`</div>`)
		return
	}

	var b strings.Builder
	projectBadge := ""
	if s.vault.IsProject() {
		projectBadge = `<span class="text-xs bg-blue-600 text-white px-1 rounded">project</span>`
	} else {
		projectBadge = `<span class="text-xs bg-zinc-700 text-zinc-300 px-1 rounded">private</span>`
	}

	b.WriteString(`<div class="flex flex-col h-full">
	<div class="p-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider border-b border-zinc-800 flex items-center justify-between">
		<span>` + html.EscapeString(filepath.Base(s.vault.Path())) + ` ` + projectBadge + `</span>
		<button @click="$el.closest('[x-data]').__x.$data.openVaultPath = ''" class="text-zinc-600 hover:text-zinc-300 text-xs">[x]</button>
	</div>
	<div class="p-1 border-b border-zinc-800">
		<form hx-get="/api/search" hx-trigger="keyup changed delay:300ms" hx-target="#preview-pane" hx-swap="innerHTML">
			<input type="text" name="q" placeholder="Search vault... (Ctrl+Shift+F)"
				class="w-full bg-zinc-800 text-zinc-200 text-xs px-2 py-1 rounded border border-zinc-700 placeholder-zinc-600"
				autocomplete="off">
		</form>
	</div>
	<div class="flex-1 p-1 text-sm overflow-y-auto space-y-0.5" id="file-list">`)

	for _, entry := range entries {
		rel := entry.Path
		name := entry.Name
		escName := html.EscapeString(name)
		escPath := html.EscapeString(rel)

		if entry.Type == vault.TypeDir {
			b.WriteString(`<div class="file-tree-item" x-data="{ open: false }">
				<div @click="open = !open" class="flex items-center gap-1 py-0.5 px-2 rounded hover:bg-zinc-800 cursor-pointer text-zinc-400">
					<svg class="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
					</svg>
					<span class="truncate">` + escName + `</span>
				</div>
				<div x-show="open" class="pl-4" hx-get="/api/vault/tree/` + escPath + `" hx-trigger="load" hx-swap="innerHTML">
					<span class="text-zinc-600 text-xs">loading...</span>
				</div>
			</div>`)
		} else {
			b.WriteString(`<div class="flex items-center gap-1 py-0.5 px-2 rounded hover:bg-zinc-800 cursor-pointer text-zinc-300"
				onclick='window.openFileInEditor({path:"` + escPath + `",name:"` + escName + `"})'>
				<svg class="w-3.5 h-3.5 shrink-0 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
					<polyline points="14 2 14 8 20 8"/>
				</svg>
				<span class="truncate">` + escName + `</span>
			</div>`)
		}
	}

	b.WriteString(`</div>
	<div class="p-2 border-t border-zinc-800 flex flex-col gap-1">
		<div class="flex gap-1">
			<button hx-get="/api/vault/tree" hx-target="#file-list" hx-swap="outerHTML"
				class="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors" title="Refresh">⟳</button>
			<button @click="'"
				class="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors" title="New File">+</button>
		</div>
		<div class="flex gap-1">`)

	if s.vault.IsProject() {
		b.WriteString(`<button hx-get="/api/config/docu" hx-target="#preview-pane" hx-swap="innerHTML"
			class="flex-1 text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors">⚙ Project Config</button>`)
	}

	b.WriteString(fmt.Sprintf(`<button hx-post="/api/git/push" hx-target="#file-list" hx-swap="none"
		class="flex-1 text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors">⬆ Push</button>
	</div>
	<div class="flex gap-1">
		<button hx-get="/api/search?q=" hx-target="#preview-pane" hx-swap="innerHTML"
			class="flex-1 text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
			onclick='event.preventDefault();document.getElementById("search-input")?.focus()'>🔍 Search</button>
		<button hx-get="/api/tags" hx-target="#tag-pane" hx-swap="innerHTML"
			class="flex-1 text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"># Tags</button>
	</div>
	<div id="tag-pane" class="border-t border-zinc-800 max-h-32 overflow-y-auto"></div>
	<div class="p-2 border-t border-zinc-800">
		<button @click="openGraphView()"
			class="w-full text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors">◉ Graph View</button>
	</div>
</div>`))

	renderHTML(w, b.String())
}

// ── Status Bar ──

func (s *Server) statusHandler(w http.ResponseWriter, r *http.Request) {
	vaultName := "-"
	if s.vault.IsOpen() {
		vaultName = filepath.Base(s.vault.Path())
	}
	renderHTML(w, fmt.Sprintf(`<div class="flex items-center justify-between px-4 py-1 text-xs text-zinc-500">
	<span>%s</span><span>Ready</span><span>Ln 1, Col 1</span><span>UTF-8</span>
</div>`, html.EscapeString(vaultName)))
}

// ── Vault Handlers ──

func (s *Server) openVaultHandler(w http.ResponseWriter, r *http.Request) {
	path := r.FormValue("path")
	if path == "" {
		path = r.URL.Query().Get("path")
	}
	if path != "" {
		if err := s.vault.Open(path); err != nil {
			renderHTML(w, `<div class="p-2 text-sm text-red-400" id="file-list">Error: `+html.EscapeString(err.Error())+`</div>`)
			return
		}
		s.initVaultServices(path)
		renderHTML(w, `<div hx-get="/api/vault/tree" hx-trigger="load" hx-swap="outerHTML"></div>`)
		return
	}
	renderHTML(w, `<div class="p-2 text-sm" id="file-list">
	<div class="mb-2 text-zinc-400">Enter vault path:</div>
	<form hx-post="/api/vault/open" hx-target="#file-list" hx-swap="outerHTML">
		<input type="text" name="path" placeholder="/path/to/vault"
			class="w-full bg-zinc-800 text-zinc-200 text-xs px-2 py-1 rounded border border-zinc-700 mb-2">
		<button type="submit"
			class="w-full text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors">Open</button>
	</form>
</div>`)
}

func (s *Server) treeHandler(w http.ResponseWriter, r *http.Request) {
	if !s.vault.IsOpen() {
		renderHTML(w, `<div class="text-zinc-500 italic p-2">No vault opened</div>`)
		return
	}
	subpath := strings.TrimPrefix(r.URL.Path, "/api/vault/tree/")
	if subpath == "" || r.URL.Path == "/api/vault/tree" {
		s.renderTree(w, "")
		return
	}
	s.renderTree(w, subpath)
}

func (s *Server) fileHandler(w http.ResponseWriter, r *http.Request) {
	if !s.vault.IsOpen() {
		http.Error(w, "No vault", http.StatusBadRequest)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/vault/file/")
	content, err := s.vault.Read(path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	pr := markdown.Parse(content)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"path":    path,
		"name":    filepath.Base(path),
		"content": content,
		"meta":    pr,
	})
}

func (s *Server) createFileHandler(w http.ResponseWriter, r *http.Request) {
	path := r.FormValue("path")
	content := r.FormValue("content")
	name, err := s.vault.Create(path, content)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"path": name})
}

func (s *Server) renameHandler(w http.ResponseWriter, r *http.Request) {
	oldPath := r.FormValue("old")
	newPath := r.FormValue("new")
	if err := s.vault.Rename(oldPath, newPath); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) deleteHandler(w http.ResponseWriter, r *http.Request) {
	path := r.FormValue("path")
	if err := s.vault.Delete(path); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) mkdirHandler(w http.ResponseWriter, r *http.Request) {
	path := r.FormValue("path")
	if err := s.vault.Mkdir(path); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) saveHandler(w http.ResponseWriter, r *http.Request) {
	path := r.FormValue("path")
	content := r.FormValue("content")
	if err := s.vault.Write(path, content); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// ── Config Handlers ──

func (s *Server) configUIHandler(w http.ResponseWriter, r *http.Request) {
	if !s.vault.IsOpen() || s.config == nil {
		renderHTML(w, `<div class="p-4 text-zinc-500">Open a vault first</div>`)
		return
	}
	cfg := s.config.Default()
	if s.config.Exists() {
		c, err := s.config.Read()
		if err == nil {
			cfg = c
		}
	}
	renderHTML(w, fmt.Sprintf(`<div class="p-4 overflow-y-auto h-full">
	<h2 class="text-sm font-semibold text-zinc-300 mb-3">Project Config</h2>
	<form hx-post="/api/config/docu" hx-target="this" hx-swap="outerHTML" class="space-y-3">
		<div>
			<label class="text-xs text-zinc-500">Title</label>
			<input type="text" name="title" value="%s"
				class="w-full bg-zinc-800 text-zinc-200 text-xs px-2 py-1 rounded border border-zinc-700">
		</div>
		<div>
			<label class="text-xs text-zinc-500">Base URL</label>
			<input type="text" name="baseurl" value="%s"
				class="w-full bg-zinc-800 text-zinc-200 text-xs px-2 py-1 rounded border border-zinc-700">
		</div>
		<div>
			<label class="text-xs text-zinc-500">Theme Color</label>
			<select name="colors" class="w-full bg-zinc-800 text-zinc-200 text-xs px-2 py-1 rounded border border-zinc-700">
				<option value="default" %s>Default</option>
				<option value="dark" %s>Dark</option>
				<option value="light" %s>Light</option>
			</select>
		</div>
		<button type="submit"
			class="w-full text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors">Save Config</button>
	</form>
</div>`,
		html.EscapeString(cfg.Meta.Title),
		html.EscapeString(cfg.Meta.BaseURL),
		selected(cfg.Themes.Colors, "default"),
		selected(cfg.Themes.Colors, "dark"),
		selected(cfg.Themes.Colors, "light"),
	))
}

func selected(current, value string) string {
	if current == value {
		return "selected"
	}
	return ""
}

func (s *Server) initVaultServices(vaultPath string) {
	// Stop previous watcher
	if s.watcher != nil {
		s.watcher.Close()
	}

	s.config = config.New(vaultPath)
	s.git = git.New(vaultPath)
	s.wiki = wiki.New(vaultPath)
	s.wiki.SetVaultPath(vaultPath)
	s.search = search.New(vaultPath)
	s.search.SetVaultPath(vaultPath)

	// Start file watcher
	s.watcher = vault.NewWatcher()
	if err := s.watcher.Start(vaultPath); err != nil {
		fmt.Printf("Watcher start error: %v\n", err)
	}

	s.initAgent()
}

func (s *Server) initAgent() {
	cfg := agent.Config{
		Provider: agent.ProviderOpenAI,
		Model:    agent.DefaultModel(agent.ProviderOpenAI),
	}

	// Try to read from docu.json
	if s.config != nil && s.config.Exists() {
		docu, err := s.config.Read()
		if err == nil && docu.AI != nil {
			cfg.Provider = agent.ProviderType(docu.AI.Provider)
			if docu.AI.Model != "" {
				cfg.Model = docu.AI.Model
			}
			cfg.BaseURL = docu.AI.BaseURL
		}
	}

	srv, err := agent.NewService(cfg)
	if err != nil {
		fmt.Printf("Agent init error: %v\n", err)
		return
	}
	s.agent = srv
}

func (s *Server) configGetHandler(w http.ResponseWriter, r *http.Request) {
	if !s.vault.IsOpen() || s.config == nil {
		http.Error(w, "No vault", http.StatusBadRequest)
		return
	}
	if !s.config.Exists() {
		// Return default empty config
		json.NewEncoder(w).Encode(s.config.Default())
		return
	}
	cfg, err := s.config.Read()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(cfg)
}

func (s *Server) configSaveHandler(w http.ResponseWriter, r *http.Request) {
	if !s.vault.IsOpen() || s.config == nil {
		http.Error(w, "No vault", http.StatusBadRequest)
		return
	}

	var cfg *config.DocuJson

	// Support both JSON body and form-encoded (from HTMX form)
	if r.Header.Get("Content-Type") == "application/json" {
		cfg = &config.DocuJson{}
		if err := json.NewDecoder(r.Body).Decode(cfg); err != nil {
			http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
			return
		}
	} else {
		// Form-encoded from HTMX
		current := s.config.Default()
		if s.config.Exists() {
			c, err := s.config.Read()
			if err == nil {
				current = c
			}
		}
		current.Meta.Title = r.FormValue("title")
		current.Meta.BaseURL = r.FormValue("baseurl")
		if current.Themes == nil {
			current.Themes = &config.ThemeConfig{}
		}
		current.Themes.Colors = r.FormValue("colors")
		cfg = current
	}

	if err := s.config.Write(cfg); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Return HTML fragment for HTMX form
	renderHTML(w, `<div class="p-4 text-green-500 text-xs">✓ Config saved. <button hx-get="/api/config/docu" class="underline">Reload</button></div>`)
}

// ── Git Handlers ──

func (s *Server) gitStatusHandler(w http.ResponseWriter, r *http.Request) {
	if !s.vault.IsOpen() || s.git == nil {
		renderHTML(w, `<span class="text-zinc-500">No vault</span>`)
		return
	}
	if !s.git.IsRepo() {
		renderHTML(w, `<span class="text-zinc-500">Not a git repo</span>`)
		return
	}
	status, _ := s.git.Status()
	branch, _ := s.git.Run("rev-parse", "--abbrev-ref", "HEAD")
	if status == "" {
		renderHTML(w, fmt.Sprintf(`<span class="text-green-500">✓ %s · clean</span>`, html.EscapeString(branch)))
	} else {
		lines := strings.Count(status, "\n")
		renderHTML(w, fmt.Sprintf(`<span class="text-yellow-500">~ %s · %d changes</span>`, html.EscapeString(branch), lines+1))
	}
}

func (s *Server) gitPushHandler(w http.ResponseWriter, r *http.Request) {
	if !s.vault.IsOpen() || s.git == nil {
		http.Error(w, "No vault", http.StatusBadRequest)
		return
	}
	msg := r.FormValue("message")
	result := s.git.PushFull(msg)
	json.NewEncoder(w).Encode(result)
}

// ── Wiki Handlers ──

func (s *Server) wikiSuggestHandler(w http.ResponseWriter, r *http.Request) {
	if !s.vault.IsOpen() || s.wiki == nil {
		json.NewEncoder(w).Encode([]wiki.Suggestion{})
		return
	}
	q := r.URL.Query().Get("q")
	results := s.wiki.Suggest(q)
	if results == nil {
		results = []wiki.Suggestion{}
	}
	json.NewEncoder(w).Encode(results)
}

func (s *Server) wikiBacklinksHandler(w http.ResponseWriter, r *http.Request) {
	if !s.vault.IsOpen() || s.wiki == nil {
		json.NewEncoder(w).Encode([]wiki.Backlink{})
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		json.NewEncoder(w).Encode([]wiki.Backlink{})
		return
	}
	results := s.wiki.Backlinks(path)
	if results == nil {
		results = []wiki.Backlink{}
	}
	json.NewEncoder(w).Encode(results)
}

func (s *Server) wikiUnlinkedHandler(w http.ResponseWriter, r *http.Request) {
	if !s.vault.IsOpen() || s.wiki == nil {
		json.NewEncoder(w).Encode([]wiki.Backlink{})
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		json.NewEncoder(w).Encode([]wiki.Backlink{})
		return
	}
	results := s.wiki.Unlinked(path)
	if results == nil {
		results = []wiki.Backlink{}
	}
	json.NewEncoder(w).Encode(results)
}

// ── Search Handlers ──

func (s *Server) searchHandler(w http.ResponseWriter, r *http.Request) {
	if !s.vault.IsOpen() || s.search == nil {
		json.NewEncoder(w).Encode([]search.Result{})
		return
	}
	q := r.URL.Query().Get("q")
	tag := r.URL.Query().Get("tag")
	results := s.search.Search(q, tag)
	if results == nil {
		results = []search.Result{}
	}

	// Render as HTML fragment for HTMX
	if r.Header.Get("HX-Request") == "true" {
		s.renderSearchResults(w, results, q)
		return
	}
	json.NewEncoder(w).Encode(results)
}

func (s *Server) renderSearchResults(w http.ResponseWriter, results []search.Result, query string) {
	var b strings.Builder
	if len(results) == 0 {
		b.WriteString(`<div class="p-4 text-sm text-zinc-500 text-center">No results found</div>`)
	} else {
		b.WriteString(fmt.Sprintf(`<div class="p-2 text-xs text-zinc-500">%d results for "%s"</div>`, len(results), html.EscapeString(query)))
		b.WriteString(`<div class="space-y-1 p-2">`)
		for _, r := range results {
			b.WriteString(fmt.Sprintf(`<div onclick="window.openFileInEditor({path:'%s',name:'%s'})" class="p-2 rounded hover:bg-zinc-800 cursor-pointer">
				<div class="text-sm text-zinc-200">%s</div>
				<div class="text-xs text-zinc-500 truncate">%s</div>
			</div>`,
				jsEscape(r.Path),
				jsEscape(r.Name),
				html.EscapeString(r.Title),
				html.EscapeString(r.Snippet),
			))
		}
		b.WriteString(`</div>`)
	}
	renderHTML(w, b.String())
}

func (s *Server) tagsHandler(w http.ResponseWriter, r *http.Request) {
	if !s.vault.IsOpen() || s.search == nil {
		renderHTML(w, `<div class="p-2 text-xs text-zinc-500">No vault</div>`)
		return
	}
	tags := s.search.AllTags()
	if len(tags) == 0 {
		renderHTML(w, `<div class="p-2 text-xs text-zinc-500">No tags</div>`)
		return
	}

	var b strings.Builder
	b.WriteString(`<div class="p-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Tags</div>
	<div class="flex flex-wrap gap-1 px-2 pb-2">`)
	for _, tag := range tags {
		b.WriteString(fmt.Sprintf(`<a href="#" hx-get="/api/tag/%s" hx-target="#preview-pane" hx-swap="innerHTML"
			class="text-xs px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors">#%s</a>`,
			html.EscapeString(tag), html.EscapeString(tag)))
	}
	b.WriteString(`</div>`)
	renderHTML(w, b.String())
}

func (s *Server) tagFilterHandler(w http.ResponseWriter, r *http.Request) {
	if !s.vault.IsOpen() || s.search == nil {
		json.NewEncoder(w).Encode([]search.Result{})
		return
	}
	tag := chi.URLParam(r, "tag")
	results := s.search.Search("", tag)
	if results == nil {
		results = []search.Result{}
	}
	s.renderSearchResults(w, results, "#"+tag)
}

// ── Watcher + Graph Handlers ──

func (s *Server) versionHandler(w http.ResponseWriter, r *http.Request) {
	v := int64(0)
	if s.watcher != nil {
		v = s.watcher.Version()
	}
	json.NewEncoder(w).Encode(map[string]int64{"version": v})
}

func (s *Server) graphHandler(w http.ResponseWriter, r *http.Request) {
	if !s.vault.IsOpen() {
		json.NewEncoder(w).Encode(map[string]interface{}{"nodes": []interface{}{}, "links": []interface{}{}})
		return
	}

	type Node struct {
		ID    string `json:"id"`
		Title string `json:"title"`
		Group int    `json:"group"`
	}
	type Link struct {
		Source string `json:"source"`
		Target string `json:"target"`
	}

	nodes := []Node{}
	links := []Link{}
	nodeSet := make(map[string]bool)

	// Walk vault, collect nodes + links
	filepath.Walk(s.vault.Path(), func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".md") {
			return nil
		}
		rel, _ := filepath.Rel(s.vault.Path(), path)
		if !nodeSet[rel] {
			title := strings.TrimSuffix(filepath.Base(rel), ".md")
			nodes = append(nodes, Node{ID: rel, Title: title, Group: 1})
			nodeSet[rel] = true
		}

		data, _ := os.ReadFile(path)
		content := string(data)
		// Extract [[links]]
		for _, match := range extractWikilinks(content) {
			if match != rel && nodeSet[match] {
				links = append(links, Link{Source: rel, Target: match})
			}
		}
		return nil
	})

	json.NewEncoder(w).Encode(map[string]interface{}{
		"nodes": nodes,
		"links": links,
	})
}

// ── AI Agent Handler (SSE) ──

func (s *Server) agentAskHandler(w http.ResponseWriter, r *http.Request) {
	if s.agent == nil {
		http.Error(w, "AI agent not initialized", http.StatusServiceUnavailable)
		return
	}

	text := r.URL.Query().Get("text")
	if text == "" {
		http.Error(w, "Missing 'text' parameter", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming not supported", http.StatusInternalServerError)
		return
	}

	ctx := r.Context()
	ch, err := s.agent.Ask(ctx, agent.DefaultSystemPrompt(), text)
	if err != nil {
		fmt.Fprintf(w, "event: error\ndata: {\"error\":\"%s\"}\n\n", html.EscapeString(err.Error()))
		flusher.Flush()
		return
	}

	for evt := range ch {
		switch evt.Type {
		case "token":
			e := strings.ReplaceAll(evt.Data, "\n", "\\n")
			e = strings.ReplaceAll(e, "\r", "\\r")
			fmt.Fprintf(w, "event: token\ndata: {\"token\":\"%s\"}\n\n", e)
			flusher.Flush()
		case "done":
			fmt.Fprintf(w, "event: done\ndata: {}\n\n")
			flusher.Flush()
			return
		case "error":
			fmt.Fprintf(w, "event: error\ndata: {\"error\":\"%s\"}\n\n", html.EscapeString(evt.Data))
			flusher.Flush()
			return
		}
	}
}

func extractWikilinks(content string) []string {
	var links []string
	for {
		start := strings.Index(content, "[[")
		if start == -1 {
			break
		}
		end := strings.Index(content[start+2:], "]]")
		if end == -1 {
			break
		}
		link := content[start+2 : start+2+end]
		if pipe := strings.Index(link, "|"); pipe != -1 {
			link = link[:pipe]
		}
		// Try to match as title (normalize spaces)
		link = strings.ReplaceAll(link, " ", "-")
		link = strings.ToLower(link)
		links = append(links, link)
		content = content[start+2+end+2:]
	}
	return links
}
