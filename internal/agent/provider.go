package agent

import (
	"context"
	"fmt"
	"os"
)

// ProviderType enumerates supported AI providers
type ProviderType string

const (
	ProviderOpenAI    ProviderType = "openai"
	ProviderAnthropic ProviderType = "anthropic"
)

// Message represents a chat message
type Message struct {
	Role    string `json:"role"`    // "system", "user", "assistant"
	Content string `json:"content"`
}

// ChatRequest is the input to any provider
type ChatRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
}

// StreamEvent is a single SSE event
type StreamEvent struct {
	Type string `json:"type"` // "token", "done", "error"
	Data string `json:"data,omitempty"`
}

// Provider interface — implemented by each AI provider
type Provider interface {
	Chat(ctx context.Context, req ChatRequest) (<-chan StreamEvent, error)
	Name() string
	DefaultModel() string
}

// Config holds provider settings
type Config struct {
	Provider ProviderType `json:"provider"`
	Model    string       `json:"model"`
	APIKey   string       `json:"-"`
	BaseURL  string       `json:"baseUrl,omitempty"`
}

// NewProvider creates a provider from config
func NewProvider(cfg Config) (Provider, error) {
	key := cfg.APIKey
	if key == "" {
		key = resolveAPIKey(cfg.Provider)
	}
	if key == "" {
		return nil, fmt.Errorf("%s API key not set — set %s_API_KEY env var or configure in docu.json",
			cfg.Provider, resolveEnvName(cfg.Provider))
	}

	switch cfg.Provider {
	case ProviderOpenAI:
		return NewOpenAI(OpenAIConfig{
			APIKey:  key,
			Model:   cfg.Model,
			BaseURL: cfg.BaseURL,
		}), nil
	case ProviderAnthropic:
		return NewAnthropic(AnthropicConfig{
			APIKey:  key,
			Model:   cfg.Model,
			BaseURL: cfg.BaseURL,
		}), nil
	default:
		return NewOpenAI(OpenAIConfig{
			APIKey:  key,
			Model:   cfg.Model,
			BaseURL: cfg.BaseURL,
		}), nil
	}
}

func resolveEnvName(pt ProviderType) string {
	switch pt {
	case ProviderOpenAI:
		return "OPENAI"
	case ProviderAnthropic:
		return "ANTHROPIC"
	default:
		return "OPENAI"
	}
}

// DefaultModels returns the default model for each provider
func DefaultModel(pt ProviderType) string {
	switch pt {
	case ProviderOpenAI:
		return "gpt-4o"
	case ProviderAnthropic:
		return "claude-sonnet-4-20250514"
	default:
		return "gpt-4o"
	}
}

func resolveAPIKey(pt ProviderType) string {
	switch pt {
	case ProviderOpenAI:
		return os.Getenv("OPENAI_API_KEY")
	case ProviderAnthropic:
		return os.Getenv("ANTHROPIC_API_KEY")
	}
	return ""
}
