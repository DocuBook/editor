package markdown

import (
	"bytes"
	"strings"
	"unicode"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

type Heading struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
}

type ParseResult struct {
	Content     string            `json:"content"`
	Frontmatter map[string]string `json:"frontmatter,omitempty"`
	Headings    []Heading         `json:"headings"`
	WordCount   int               `json:"wordCount"`
	Links       []string          `json:"links,omitempty"`
	Tags        []string          `json:"tags,omitempty"`
}

func Parse(content string) *ParseResult {
	md := goldmark.New(
		goldmark.WithExtensions(
			extension.GFM,
			extension.Table,
			extension.Strikethrough,
		),
		goldmark.WithParserOptions(
			parser.WithAutoHeadingID(),
		),
	)

	reader := text.NewReader([]byte(content))
	doc := md.Parser().Parse(reader)

	result := &ParseResult{
		Content:     content,
		Headings:    extractHeadings(doc, reader),
		WordCount:   countWords(content),
		Links:       extractLinks(content),
	}

	// Frontmatter
	result.Frontmatter = extractFrontmatter(content)
	if tags, ok := result.Frontmatter["tags"]; ok {
		result.Tags = strings.FieldsFunc(tags, func(r rune) bool {
			return r == ',' || r == ' ' || r == '['
		})
	}

	return result
}

func extractHeadings(doc ast.Node, reader text.Reader) []Heading {
	var headings []Heading
	ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if n.Kind() == ast.KindHeading {
			h := n.(*ast.Heading)
			headings = append(headings, Heading{
				Level: h.Level,
				Text:  string(n.Text(reader.Source())),
			})
		}
		return ast.WalkContinue, nil
	})
	return headings
}

func countWords(content string) int {
	count := 0
	inCode := false
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			inCode = !inCode
			continue
		}
		if inCode {
			continue
		}
		// Skip frontmatter
		if count == 0 && trimmed == "---" {
			continue
		}
		fields := strings.FieldsFunc(trimmed, func(r rune) bool {
			return !unicode.IsLetter(r) && !unicode.IsDigit(r)
		})
		count += len(fields)
	}
	return count
}

func extractFrontmatter(content string) map[string]string {
	result := make(map[string]string)
	lines := strings.Split(content, "\n")
	if len(lines) < 2 || strings.TrimSpace(lines[0]) != "---" {
		return result
	}
	for i := 1; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if line == "---" {
			break
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 {
			result[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
		}
	}
	return result
}

func extractLinks(content string) []string {
	var links []string
	// Simple [[wikilink]] extraction
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
		// Handle alias [[title|alias]]
		if pipe := strings.Index(link, "|"); pipe != -1 {
			link = link[:pipe]
		}
		links = append(links, link)
		content = content[start+2+end+2:]
	}
	return links
}

// RenderHTML converts markdown to HTML
func RenderHTML(content string) (string, error) {
	md := goldmark.New(
		goldmark.WithExtensions(extension.GFM, extension.Table),
	)
	var buf bytes.Buffer
	if err := md.Convert([]byte(content), &buf); err != nil {
		return "", err
	}
	return buf.String(), nil
}
