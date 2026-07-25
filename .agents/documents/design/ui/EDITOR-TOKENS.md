# Design System Tokens — Editor (Zed-inspired)

## Color Palette

### Dark Theme (default)

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-primary` | `#0a0a0b` | Main background |
| `--bg-secondary` | `#18181b` | Sidebar, panels |
| `--bg-tertiary` | `#1f1f23` | Hover, active states |
| `--bg-hover` | `#27272a` | Button hover |
| `--border` | `#2a2a2e` | Borders, separators |
| `--text-primary` | `#e4e4e7` | Main text |
| `--text-secondary` | `#a1a1aa` | Secondary text |
| `--text-muted` | `#52525b` | Placeholder, disabled |
| `--accent` | `#3b82f6` | Links, active tab, selection |
| `--accent-hover` | `#60a5fa` | Hover accent |
| `--success` | `#22c55e` | Save success, git ok |
| `--warning` | `#eab308` | Warning state |
| `--error` | `#ef4444` | Error state |
| `--surface` | `#09090b` | CodeMirror surface |

### Light Theme

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-primary` | `#ffffff` | Main background |
| `--bg-secondary` | `#f4f4f5` | Sidebar, panels |
| `--bg-tertiary` | `#e4e4e7` | Hover, active states |
| `--bg-hover` | `#d4d4d8` | Button hover |
| `--border` | `#e4e4e7` | Borders, separators |
| `--text-primary` | `#18181b` | Main text |
| `--text-secondary` | `#52525b` | Secondary text |
| `--text-muted` | `#a1a1aa` | Placeholder, disabled |
| `--accent` | `#2563eb` | Links, active tab, selection |
| `--accent-hover` | `#1d4ed8` | Hover accent |
| `--success` | `#16a34a` | Save success |
| `--warning` | `#ca8a04` | Warning state |
| `--error` | `#dc2626` | Error state |
| `--surface` | `#fafafa` | CodeMirror surface |

## Typography

| Token | Value | Usage |
|-------|-------|-------|
| `--font-ui` | `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif` | UI text |
| `--font-editor` | `'JetBrains Mono', 'Fira Code', monospace` | Editor content |
| `--font-preview` | `'Inter', system-ui, sans-serif` | Preview rendering |
| `--text-xs` | `11px` | Status bar, meta |
| `--text-sm` | `13px` | Sidebar, tabs |
| `--text-base` | `14px` | Body UI |
| `--text-lg` | `16px` | Section headers |
| `--text-xl` | `20px` | Panel titles |

## Spacing

| Token | Value |
|-------|-------|
| `--space-1` | `4px` |
| `--space-2` | `8px` |
| `--space-3` | `12px` |
| `--space-4` | `16px` |
| `--space-6` | `24px` |

## Sizing

| Component | Dimension |
|-----------|-----------|
| Title bar height | `32px` |
| Tab bar height | `36px` |
| Status bar height | `24px` |
| Sidebar width | `224px` (w-56) |
| Min sidebar | `180px` |
| Max sidebar | `400px` |
| Icon size (UI) | `14px` |
| Icon size (title) | `16px` |

## Borders & Radius

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | `4px` | Buttons, inputs |
| `--radius-md` | `6px` | Modals, dropdowns |
| `--radius-lg` | `8px` | Cards, panels |
| `--border-width` | `1px` | Standard border |

## Shadows

| Token | Value |
|-------|-------|
| `--shadow-sm` | `0 1px 2px 0 rgb(0 0 0 / 0.05)` |
| `--shadow-md` | `0 4px 6px -1px rgb(0 0 0 / 0.1)` |
| `--shadow-lg` | `0 10px 15px -3px rgb(0 0 0 / 0.15)` |

## Animation

| Token | Value |
|-------|-------|
| `--transition-fast` | `100ms ease` |
| `--transition-base` | `200ms ease` |
| `--transition-slow` | `300ms ease` |
