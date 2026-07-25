package agent

import (
	"context"
	"fmt"
	"sync"
)

// Service orchestrates AI provider interactions
type Service struct {
	mu       sync.RWMutex
	provider Provider
	config   Config
}

func NewService(cfg Config) (*Service, error) {
	if cfg.Model == "" {
		cfg.Model = DefaultModel(cfg.Provider)
	}
	p, err := NewProvider(cfg)
	if err != nil {
		return nil, err
	}
	return &Service{
		provider: p,
		config:   cfg,
	}, nil
}

func (s *Service) Provider() Provider {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.provider
}

func (s *Service) Config() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.config
}

func (s *Service) UpdateConfig(cfg Config) error {
	p, err := NewProvider(cfg)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.provider = p
	s.config = cfg
	return nil
}

// Ask sends a chat request and returns a channel of stream events
func (s *Service) Ask(ctx context.Context, systemPrompt, userPrompt string) (<-chan StreamEvent, error) {
	s.mu.RLock()
	p := s.provider
	s.mu.RUnlock()

	if p == nil {
		return nil, fmt.Errorf("no AI provider configured")
	}

	var msgs []Message
	if systemPrompt != "" {
		msgs = append(msgs, Message{Role: "system", Content: systemPrompt})
	}
	msgs = append(msgs, Message{Role: "user", Content: userPrompt})

	req := ChatRequest{
		Model:    s.config.Model,
		Messages: msgs,
	}

	return p.Chat(ctx, req)
}

// DefaultSystemPrompt returns the default system prompt for code/markdown editing
func DefaultSystemPrompt() string {
	return `You are a helpful coding assistant integrated into a markdown editor. 
The user is editing markdown files. Respond with concise, helpful text.
When providing code examples, use proper markdown code blocks with language tags.
Keep responses short and actionable.`
}
