package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type AnthropicConfig struct {
	APIKey  string
	Model   string
	BaseURL string
}

type anthropicProvider struct {
	config AnthropicConfig
}

func NewAnthropic(cfg AnthropicConfig) Provider {
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://api.anthropic.com/v1"
	}
	if cfg.Model == "" {
		cfg.Model = "claude-sonnet-4-20250514"
	}
	return &anthropicProvider{config: cfg}
}

func (p *anthropicProvider) Name() string { return "anthropic" }

func (p *anthropicProvider) DefaultModel() string { return "claude-sonnet-4-20250514" }

func (p *anthropicProvider) Chat(ctx context.Context, req ChatRequest) (<-chan StreamEvent, error) {
	if req.Model == "" {
		req.Model = p.config.Model
	}

	// Anthropic uses system as separate field
	system := ""
	var msgs []map[string]string
	for _, m := range req.Messages {
		if m.Role == "system" {
			system = m.Content
		} else {
			msgs = append(msgs, map[string]string{"role": m.Role, "content": m.Content})
		}
	}

	body := map[string]interface{}{
		"model":      req.Model,
		"messages":   msgs,
		"max_tokens": 4096,
		"stream":     true,
	}
	if system != "" {
		body["system"] = system
	}

	data, _ := json.Marshal(body)
	httpReq, err := http.NewRequestWithContext(ctx, "POST",
		p.config.BaseURL+"/messages",
		bytes.NewReader(data))
	if err != nil {
		return nil, err
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", p.config.APIKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("anthropic request failed: %w", err)
	}

	if resp.StatusCode != 200 {
		resp.Body.Close()
		return nil, fmt.Errorf("anthropic returned %d", resp.StatusCode)
	}

	ch := make(chan StreamEvent)
	go p.readStream(ctx, resp.Body, ch)
	return ch, nil
}

func (p *anthropicProvider) readStream(ctx context.Context, body io.ReadCloser, ch chan StreamEvent) {
	defer body.Close()
	defer close(ch)

	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024)

	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data: ") {
			data := strings.TrimPrefix(line, "data: ")
			if data == "[DONE]" {
				ch <- StreamEvent{Type: "done"}
				return
			}
			var event struct {
				Type string `json:"type"`
				Delta struct {
					Text string `json:"text"`
				} `json:"delta"`
			}
			if err := json.Unmarshal([]byte(data), &event); err != nil {
				continue
			}
			switch event.Type {
			case "content_block_delta":
				if event.Delta.Text != "" {
					ch <- StreamEvent{Type: "token", Data: event.Delta.Text}
				}
			case "message_stop":
				ch <- StreamEvent{Type: "done"}
				return
			}
		} else if strings.HasPrefix(line, "event: message_stop") {
			ch <- StreamEvent{Type: "done"}
			return
		}
	}

	if err := scanner.Err(); err != nil {
		ch <- StreamEvent{Type: "error", Data: err.Error()}
	}
	ch <- StreamEvent{Type: "done"}
}
