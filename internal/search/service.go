package search

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type Result struct {
	Path    string  `json:"path"`
	Name    string  `json:"name"`
	Title   string  `json:"title"`
	Snippet string  `json:"snippet"`
	Score   float64 `json:"score"`
}

type Service struct {
	mu        sync.RWMutex
	vaultPath string
	cache     []cachedFile
}

type cachedFile struct {
	Path    string
	Content string
}

func New(vaultPath string) *Service {
	return &Service{vaultPath: vaultPath}
}

func (s *Service) SetVaultPath(path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.vaultPath = path
	s.cache = nil
}

func (s *Service) Search(query string, filterTag string) []Result {
	if len(query) < 2 && filterTag == "" {
		return nil
	}

	s.mu.RLock()
	cache := s.cache
	vpath := s.vaultPath
	s.mu.RUnlock()

	// Build cache if needed
	if cache == nil {
		cache = s.buildCache(vpath)
		s.mu.Lock()
		s.cache = cache
		s.mu.Unlock()
	}

	q := strings.ToLower(query)
	var results []Result

	for _, f := range cache {
		lower := strings.ToLower(f.Content)
		score := 0.0

		if filterTag != "" {
			// Check for #tag or tags in frontmatter
			tagSearch := "#" + filterTag
			tagFm := "tags: " + filterTag
			if !strings.Contains(lower, tagSearch) && !strings.Contains(lower, tagFm) {
				continue
			}
			score += 1.0
		}

		if query != "" {
			if !strings.Contains(lower, q) {
				if filterTag != "" {
					// If we're filtering by tag and query doesn't match, still include
					score += 0.5
				} else {
					continue
				}
			} else {
				// Score based on match frequency and position
				count := strings.Count(lower, q)
				score += float64(count) * 0.1
				if strings.Contains(strings.ToLower(f.Content[:min(200, len(f.Content))]), q) {
					score += 2.0 // title/early boost
				}
			}
		}

		snippet := extractSnippet(f.Content, query)
		title := titleFromPath(f.Path)

		results = append(results, Result{
			Path:    f.Path,
			Name:    filepath.Base(f.Path),
			Title:   title,
			Snippet: snippet,
			Score:   score,
		})
	}

	// Sort by score descending
	for i := 0; i < len(results); i++ {
		for j := i + 1; j < len(results); j++ {
			if results[j].Score > results[i].Score {
				results[i], results[j] = results[j], results[i]
			}
		}
	}

	if len(results) > 50 {
		results = results[:50]
	}
	return results
}

func (s *Service) AllTags() []string {
	s.mu.RLock()
	cache := s.cache
	vpath := s.vaultPath
	s.mu.RUnlock()

	if cache == nil {
		cache = s.buildCache(vpath)
		s.mu.Lock()
		s.cache = cache
		s.mu.Unlock()
	}

	tagSet := make(map[string]bool)
	for _, f := range cache {
		for _, t := range extractTags(f.Content) {
			tagSet[t] = true
		}
	}

	var tags []string
	for t := range tagSet {
		tags = append(tags, t)
	}
	return tags
}

func (s *Service) buildCache(vpath string) []cachedFile {
	if vpath == "" {
		return nil
	}
	const maxFiles = 5000
	var cache []cachedFile
	filepath.Walk(vpath, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".md") {
			return nil
		}
		if len(cache) >= maxFiles {
			return filepath.SkipDir
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(vpath, path)
		cache = append(cache, cachedFile{Path: rel, Content: string(data)})
		return nil
	})
	return cache
}

// extractTags gets unique #tag values from content
func extractTags(content string) []string {
	var tags []string
	seen := make(map[string]bool)

	// Frontmatter tags
	if strings.HasPrefix(content, "---") {
		end := strings.Index(content[3:], "---")
		if end > 0 {
			fm := content[3 : 3+end]
			for _, line := range strings.Split(fm, "\n") {
				if strings.HasPrefix(line, "tags:") {
					val := strings.TrimSpace(line[5:])
					val = strings.Trim(val, "[]")
					for _, t := range strings.Split(val, ",") {
						t = strings.TrimSpace(t)
						if t != "" && !seen[t] {
							tags = append(tags, t)
							seen[t] = true
						}
					}
				}
			}
		}
	}

	// Inline #tags (skip frontmatter)
	body := content
	if strings.HasPrefix(content, "---") {
		end := strings.Index(content[3:], "---")
		if end > 0 {
			body = content[3+end+3:]
		}
	}

	for _, word := range strings.Fields(body) {
		if strings.HasPrefix(word, "#") && len(word) > 1 {
			tag := strings.TrimRight(word, ",.;:!?()[]{}")
			tag = strings.TrimPrefix(tag, "#")
			if tag != "" && !seen[tag] {
				tags = append(tags, tag)
				seen[tag] = true
			}
		}
	}

	return tags
}

func extractSnippet(content, query string) string {
	if query == "" {
		if len(content) > 100 {
			return content[:100] + "..."
		}
		return content
	}
	q := strings.ToLower(query)
	lower := strings.ToLower(content)
	idx := strings.Index(lower, q)
	if idx == -1 {
		return ""
	}
	start := idx - 30
	if start < 0 {
		start = 0
	}
	end := idx + len(q) + 30
	if end > len(content) {
		end = len(content)
	}
	snippet := content[start:end]
	snippet = strings.ReplaceAll(snippet, "\n", " ")
	snippet = strings.TrimSpace(snippet)
	return snippet
}

func titleFromPath(path string) string {
	name := strings.TrimSuffix(filepath.Base(path), ".md")
	name = strings.ReplaceAll(name, "-", " ")
	name = strings.ReplaceAll(name, "_", " ")
	return name
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
