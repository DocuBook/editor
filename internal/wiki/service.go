package wiki

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
)

type Suggestion struct {
	Path  string `json:"path"`
	Title string `json:"title"`
}

type Backlink struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Snippet string `json:"snippet"`
}

type fileInfo struct {
	path    string
	content string
	title   string
}

type Service struct {
	mu        sync.RWMutex
	vaultPath string
	files     []fileInfo
}

func New(vaultPath string) *Service {
	s := &Service{vaultPath: vaultPath}
	s.refresh()
	return s
}

func (s *Service) SetVaultPath(path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.vaultPath = path
	s.refresh()
}

// refresh scans vault and caches all .md files
func (s *Service) refresh() {
	s.files = nil
	if s.vaultPath == "" {
		return
	}
	const maxFiles = 5000
	filepath.Walk(s.vaultPath, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".md") {
			return nil
		}
		if len(s.files) >= maxFiles {
			return filepath.SkipDir
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(s.vaultPath, path)
		s.files = append(s.files, fileInfo{
			path:    rel,
			content: string(data),
			title:   titleFromPath(rel),
		})
		return nil
	})
}

func (s *Service) Suggest(query string) []Suggestion {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(query) < 1 || len(s.files) == 0 {
		return nil
	}
	q := strings.ToLower(query)
	var results []Suggestion
	for _, f := range s.files {
		if strings.Contains(strings.ToLower(f.title), q) || strings.Contains(strings.ToLower(f.path), q) {
			results = append(results, Suggestion{Path: f.path, Title: f.title})
			if len(results) >= 20 {
				break
			}
		}
	}
	return results
}

func (s *Service) Backlinks(targetPath string) []Backlink {
	s.mu.RLock()
	defer s.mu.RUnlock()
	targetTitle := titleFromPath(targetPath)
	var results []Backlink
	for _, f := range s.files {
		if f.path == targetPath {
			continue
		}
		search1 := "[[" + targetTitle + "]]"
		search2 := "[[" + targetPath + "]]"
		if strings.Contains(f.content, search1) || strings.Contains(f.content, search2) {
			snippet := extractSnippet(f.content, targetTitle)
			results = append(results, Backlink{
				Path:    f.path,
				Name:    filepath.Base(f.path),
				Snippet: snippet,
			})
			if len(results) >= 50 {
				break
			}
		}
	}
	return results
}

func (s *Service) Unlinked(targetPath string) []Backlink {
	s.mu.RLock()
	defer s.mu.RUnlock()
	targetTitle := titleFromPath(targetPath)
	linked := "[[" + targetTitle + "]]"
	var results []Backlink
	for _, f := range s.files {
		if f.path == targetPath || strings.Contains(f.content, linked) {
			continue
		}
		if strings.Contains(strings.ToLower(f.content), strings.ToLower(targetTitle)) {
			snippet := extractSnippet(f.content, targetTitle)
			results = append(results, Backlink{
				Path:    f.path,
				Name:    filepath.Base(f.path),
				Snippet: snippet,
			})
			if len(results) >= 20 {
				break
			}
		}
	}
	return results
}

func titleFromPath(rel string) string {
	name := strings.TrimSuffix(filepath.Base(rel), ".md")
	name = strings.ReplaceAll(name, "-", " ")
	name = strings.ReplaceAll(name, "_", " ")
	words := strings.Fields(name)
	for i, w := range words {
		if i == 0 || !isShortWord(w) {
			words[i] = string(unicode.ToUpper(rune(w[0]))) + w[1:]
		}
	}
	return strings.Join(words, " ")
}

func isShortWord(w string) bool {
	short := map[string]bool{"a": true, "an": true, "the": true, "in": true, "on": true, "at": true, "to": true, "for": true, "of": true, "and": true, "or": true}
	return short[w]
}

func extractSnippet(content, term string) string {
	idx := strings.Index(content, term)
	if idx == -1 {
		return ""
	}
	start := idx - 40
	if start < 0 {
		start = 0
	}
	end := idx + len(term) + 40
	if end > len(content) {
		end = len(content)
	}
	snippet := content[start:end]
	snippet = strings.ReplaceAll(snippet, "\n", " ")
	return strings.TrimSpace(snippet)
}
