# ADR-005: AI Agent Architecture — Provider Abstraction + SSE Streaming

**Status:** Accepted  
**Context:** Editor perlu AI assistant untuk membantu menulis markdown. Ada banyak provider AI (OpenAI, Anthropic, OpenAPI-compatible) dengan API format berbeda.  
**Alternatives:** Bundling AI logic di frontend (JS), panggil API langsung dari frontend, pake SDK pihak ketiga  
**Decision:** 
1. **Go backend** sebagai proxy — frontend tidak pernah langsung ke API provider
2. **Provider interface** — `internal/agent/provider.go` mendefinisikan `Chat()` contract
3. **Implementasi**: OpenAI (`internal/agent/openai.go`) + Anthropic (`internal/agent/anthropic.go`)
4. **SSE streaming** — `GET /api/agent/ask` mengembalikan `text/event-stream`
5. **Frontend** — Alpine.js overlay membaca SSE events dan menampilkan token real-time
6. **Config** via `docu.json` (`ai.provider`, `ai.model`) + env var fallback (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`)

**Rationale:**
- API key tidak pernah terekspos ke frontend (WebView)
- Provider abstraction memudahkan nambah provider baru tanpa ubah frontend
- OpenAI API format sudah menjadi de facto standard — banyak provider (Ollama, Groq, vLLM) kompatibel
- SSE lebih sederhana dari WebSocket untuk one-way streaming
- `@docubook/ai` belum ada — kita buat pattern yang bisa diekstrak nanti

**Consequences:**
- Perlu API key dari user (via env var atau settings UI)
- Rate limit dan error handling perlu di-improve di masa depan
- Streaming token membutuhkan SSE parser di frontend (EventSource API)

## Provider Interface

```go
type Provider interface {
    Chat(ctx context.Context, req ChatRequest) (<-chan StreamEvent, error)
    Name() string
    DefaultModel() string
}
```

## Provider Matrix

| Provider | Package | API Endpoint | Auth | Default Model |
|----------|---------|-------------|------|---------------|
| OpenAI | `internal/agent/openai.go` | `/v1/chat/completions` | Bearer token | `gpt-4o` |
| Anthropic | `internal/agent/anthropic.go` | `/v1/messages` | x-api-key | `claude-sonnet-4` |
| OpenAI-compatible | via openai.go | custom `baseUrl` | Bearer token | — |

## Config Example (docu.json)

```json
{
  "ai": {
    "provider": "openai",
    "model": "gpt-4o",
    "baseUrl": "https://api.openai.com/v1"
  }
}
```
