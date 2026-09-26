/**
 * AI transport for the rust-ai extension — the ONLY window between the AI menu
 * and the Rust backend (ask_ai SSE stream). Responsibilities, in order:
 *
 *  1. Resolve provider/model/tool support (probe-driven, model-agnostic).
 *  2. Stream Rust SSE events → typed stream parts (batched text-delta).
 *  3. Route output: meaningful tool ops win (Path A), text-only falls back to
 *     a generated applyDocumentOperations input (Path B).
 *  4. Semantic gate: referenced block ids must exist in the document;
 *     model-echoed ids get the trailing `$` restored before rust-ai validation.
 *
 *  Prompt policy and context assembly live in aiPrompt.ts; document operation
 *  helpers stay in aiBlocks.ts so this streaming sequence remains orchestration.
 */
import { invoke, listen } from "../lib/ipc";
import { toast } from "sonner";
import { useAiChat } from "../stores/aiChat";
import { useAiSettings } from "../stores/aiSettings";

import {
  buildApplyDocumentInput,
  extractDelimitedContent,
  MAX_AI_ATTEMPTS,
  validateOperationsSemantics,
  buildTaskFormattingRules,
  normalizeMarkdown,
  buildDocumentContext,
  filterMeaningfulOperations,
  isDocumentOperationToolCall,
  latestUserText,
  suffixOperationIds,
} from "./aiBlocks";
import { buildAiPrompt } from "./aiPrompt";
import { parseMentions } from "./aiMentions";
import { isTextOnly } from "./aiProbe";
import { uuid } from "./uuid";

/** Batch AI token deltas into one text-delta part per tick — fewer ProseMirror
 *  document writes while the AI types (smooth instead of janky streaming). */
const AI_DELTA_BATCH_MS = 50;

/** Human summary of what retrieval actually delivered. A mention that was
 *  skipped (typo, non-markdown, budget) must be visible: otherwise "the AI
 *  ignored my file" and "the file never reached the request" look identical.
 *  Paths only — never file content. */
function mentionNotice(context: any): string | null {
  if (!context) return null;
  const files = context.files?.length ?? 0;
  const truncated = context.totals?.truncated ?? 0;
  const skipped: any[] = context.skipped ?? [];
  const parts = [`${files} file${files === 1 ? "" : "s"} in context`];
  if (truncated) parts.push(`${truncated} truncated`);
  if (skipped.length) {
    const shown = skipped.slice(0, 2).map((item) => `${item.path}: ${item.reason}`).join(", ");
    parts.push(`${skipped.length} skipped (${shown}${skipped.length > 2 ? ", …" : ""})`);
  }
  return parts.join(" · ");
}

function safeAiTransportError(error: unknown) {
  return String(error).includes("AI response too large")
    ? "AI response is too large. Try a smaller request."
    : "AI request failed. Please retry.";
}

/** Provider catalog — small manual list (was a 2.17 MB generated file); model
 *  lists are discovered at runtime via backend `list_models`. Import statically. */
import { PROVIDERS } from "../data/providers";
import { getAiConfig } from "./aiConfig";

export interface AiTransportDeps {
  /** Live BlockNote editor — used for selection text, semantic validation and
   *  converting text output into operations. */
  getEditor: () => any | null;
  /** Vault-relative file bound to this keep-alive editor instance. */
  filePath?: string
}

/** Create the rust-ai ChatTransport. `reconnectToStream` is unsupported (the Rust
 *  stream is one-shot; rust-ai never resumes after an abort). */
export function createAiTransport(deps: AiTransportDeps) {
  return {
    sendMessages: async (args: any) => runSendMessages(args, deps),
    reconnectToStream: async () => null,
  };
}

async function runSendMessages(
  args: any,
  deps: AiTransportDeps,
): Promise<ReadableStream<any>> {
  const { messages, abortSignal, body } = args;
  if (!messages.length || abortSignal?.aborted) return new ReadableStream();
  const config = await getAiConfig();
  /** Fallback: always resolve provider/model from store even if config incomplete (HMR-safe) */
  const st = useAiSettings.getState();
  const provider = config.provider || st.provider;
  const model = config.model || st.model;
  const providerInfo = PROVIDERS.find((p) => p.id === provider);
  /** Tool-call support = measured gateway compatibility (test_connection probe,
   *  stored per provider+model). The generated catalog's toolCall flag is gone —
   *  the probe is the single source of truth; unmeasured → text-only until
   *  auto-probe measures true. For env-controlled custom endpoints the probe is
   *  keyed by the env model (the one the backend actually sends). */
  const supportsTools = !isTextOnly(provider, model, st.probeTools);
  const toolDefs = (body as any)?.toolDefinitions as
    Record<string, { description: string; inputSchema: any }> | undefined;
  /** Send rust-ai's OWN tool definitions (applyDocumentOperations) so operations → suggestions work */
  const tools =
    supportsTools && toolDefs
      ? Object.entries(toolDefs).map(([name, def]) => ({
          type: "function" as const,
          function: {
            name,
            description: def.description,
            parameters: def.inputSchema,
          },
        }))
      : undefined;
  const editor = deps.getEditor();
  /** Path A → Path B fallback budget: a tool-capable provider that answers with
   *  prose gets exactly ONE re-ask against the text-only prompt. Not part of the
   *  semantic retry loop (MAX_AI_ATTEMPTS) — that one re-asks the SAME prompt,
   *  which cannot help when the provider structurally refuses to call tools. */
  let textFallbackUsed = false;

  return new ReadableStream({
    async start(controller) {
      const id = uuid();
      controller.enqueue({ type: "text-start", id });
      let closed = false;
      let fullText = "";
      let requestStartedAt = 0;
      let firstTokenAt = 0;
      /** Batched text streaming: flush pending deltas on a short timer. Path A
       *  (tools) buffers text and decides at the end — meaningful ops win, so
       *  live typing is skipped; Path B (no tools) streams live. */
      let pendingDelta = "";
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      const flushDeltas = () => {
        flushTimer = undefined;
        if (closed || !pendingDelta) return;
        controller.enqueue({ type: "text-delta", delta: pendingDelta, id });
        pendingDelta = "";
      };
      let bufferText = true;
      /** Identity of the provider request currently in flight. Each internal
       *  retry mints a new one, so events still arriving from the previous
       *  attempt (or from a turn the user already stopped) cannot be folded into
       *  this one — Rust tags every event with the id it was invoked with. */
      let currentRequestId = "";
      const isCurrent = (payload: { requestId?: string } | undefined) =>
        payload?.requestId === currentRequestId;
      const unsubToken = await listen<{ requestId?: string; token?: string }>("ai:token", (e) => {
        if (abortSignal?.aborted || closed) {
          try {
            controller.close();
          } catch {}
          return;
        }
        if (!isCurrent(e.payload) || typeof e.payload.token !== "string") return;
        const delta = e.payload.token;
        if (!firstTokenAt) {
          firstTokenAt = performance.now();
          if (import.meta.env.DEV && requestStartedAt) {
            console.debug("[ai] first token", {
              ttftMs: Math.round(firstTokenAt - requestStartedAt),
            });
          }
        }
        fullText += delta;
        pendingDelta += delta;
        if (!bufferText && !flushTimer)
          flushTimer = setTimeout(flushDeltas, AI_DELTA_BATCH_MS);
      });
      const toolBuffer: any[] = [];
      const unsubTool = await listen<any>("ai:tool_call", (e) => {
        if (abortSignal?.aborted || closed || !isCurrent(e.payload)) return;
        toolBuffer.push(e.payload);
      });
      const unsubToolsDone = await listen<{ requestId?: string }>("ai:tools_done", () => {});
      /** rust-ai: the first tool-call delta means the provider has started writing
       *  the document operations. Surface it now so the AI menu leaves "thinking"
       *  while the write happens, not only when the completed call lands. */
      const unsubGenerating = await listen<{ requestId?: string }>("ai:generating", (e) => {
        if (abortSignal?.aborted || closed || !isCurrent(e.payload)) return;
        try {
          controller.enqueue({ type: "writing-started" });
        } catch {}
      });
      /** Server-side truncation signal: the response hit MAX_AI_BUFFER and the
       *  stream ended early with `ai:done { truncated: true }`. Without this the
       *  partial text would be promoted as a valid response (retry prompts). */
      let streamTruncated = false;
      const unsubDone = await listen<{ requestId?: string; truncated?: boolean }>("ai:done", (e) => {
        if (!isCurrent(e.payload)) return;
        streamTruncated = e.payload?.truncated === true;
        if (import.meta.env.DEV && requestStartedAt) {
          console.debug("[ai] stream complete", {
            durationMs: Math.round(performance.now() - requestStartedAt),
            ttftMs: firstTokenAt ? Math.round(firstTokenAt - requestStartedAt) : null,
          });
        }
      });
      /** Propagate a rust-ai abort → Rust cancel (stops the in-flight reqwest stream).
       *  The id keeps Stop bound to this turn: if a retry already took over, the
       *  newer request must not be cancelled by the older signal. */
      abortSignal?.addEventListener?.("abort", () => {
        invoke("cancel_ai", { requestId: currentRequestId }).catch(() => {});
      });
      try {
        /** Mutable: flipped to false once a text fallback turn is warranted. The
         *  prompt, capabilities and streaming behaviour all derive from it. */
        let useTools = supportsTools && !!tools;
        /** Text-mode context (full markdown + selection) is only needed on Path B,
         *  but a Path A turn may fall back into it. Building it up front (instead of
         *  at the fallback site) keeps the selection read at its earliest, focused
         *  point — resolving it after the first attempt can see a stale cursor. */
        const docContext = buildDocumentContext(editor);
        const sel = editor?.getSelection?.();
        const selText = sel?.blocks?.length
          ? editor.blocksToMarkdownLossy(sel.blocks)
          : "";
        const userText = latestUserText(messages);
        const parsedMentions = parseMentions(userText);
        const mentionResult = parsedMentions.hasMentions
          ? await invoke<any>("resolve_mentions", { request: { mentions: parsedMentions.mentions.map(({ token, kind }) => ({ token, kind })), excludePath: deps.filePath } })
          : undefined;
        /** The Tauri command may hand back the bundle as a serialized string; a
         *  malformed payload must not abort the turn. Mentions are optional
         *  context, so a decode failure degrades to "no context" and the notice
         *  line stays empty rather than the request failing for an unrelated
         *  parse error. */
        const mentionContext = (() => {
          if (typeof mentionResult !== 'string') return mentionResult;
          try {
            return JSON.parse(mentionResult);
          } catch {
            console.debug("[ai] mention payload was not valid JSON; sending without vault context");
            return undefined;
          }
        })();
        /** Publish the retrieval outcome for the composer's context line. */
        useAiChat.getState().setMentionNotice(mentionNotice(mentionContext));
        const taskRules = buildTaskFormattingRules(userText);
        const documentState = [...messages]
          .reverse()
          .find((message: any) => message?.role === "user")
          ?.metadata?.documentState;
        /** Compile stable policy separately from dynamic document/reference context.
         *  Tool mode uses rust-ai's canonical documentState; text mode uses Markdown. */
        const basePrompt = {
          messages,
          documentState,
          mentionContext,
          documentMarkdown: docContext,
          selectedMarkdown: selText,
          userText,
          taskRules,
        };
        /** Retry loop: semantic validation (anti-hallucination) with error feedback. */
        let errorFeedback = "";
        let attempts = 0;
        let accepted = false;
        let lastReason = "";
        let emitToolCalls: any[] = [];
        let emitText = "";
        /** Outer turn loop. Each iteration = one provider attempt (which may itself
         *  contain semantic-validation retries). A turn normally ends the stream, but
         *  the Path A → Path B fallback re-enters for exactly one more iteration. */
        turn: for (;;) {
          /** Per-turn outputs MUST reset here, not just inside the retry loop: the
           *  fallback re-enters with the previous turn's accepted/text state, which
           *  would otherwise be judged again as this turn's result. */
          accepted = false;
          emitToolCalls = [];
          emitText = "";
          while (attempts <= MAX_AI_ATTEMPTS) {
            fullText = "";
            pendingDelta = "";
            toolBuffer.length = 0;
            streamTruncated = false;
            const msgs = buildAiPrompt({
              ...basePrompt,
              mode: useTools ? ("tool" as const) : ("text" as const),
              retryFeedback: errorFeedback,
            }).messages;
            if (import.meta.env.DEV) {
              console.debug("[ai] prompt metrics", {
                mode: useTools ? "tool" : "text",
                documentStateBytes: JSON.stringify(documentState ?? {}).length,
                mentionContextChars: JSON.stringify(mentionContext ?? {}).length,
                documentMarkdownChars: docContext.length,
                selectedMarkdownChars: selText.length,
                promptChars: msgs.reduce((total, message) => total + String(message.content ?? "").length, 0),
                messageCount: msgs.length,
                attempt: attempts + 1,
              });
            }
            requestStartedAt = performance.now();
            firstTokenAt = 0;
            currentRequestId = uuid();
            await invoke("ask_ai", {
              messages: JSON.stringify(msgs),
              ...(useTools ? { tools: JSON.stringify(tools) } : {}),
              provider,
              model,
              baseUrl: providerInfo?.api || config.baseUrl,
              requestId: currentRequestId,
            });
            /** Truncated = the same cap applies on retry — no point re-asking. */
            if (streamTruncated) break;
            /** Real correctness gate: referenced ids must exist in the document (blocking).
             *  Normalize model-echoed ids (BlockNote expects a trailing `$`; models like
             *  GLM strip it), validate each call, keep the FIRST error. Immutable form —
             *  no loop reassignment, so the accept/retry branch is unambiguous. */
            const semanticError =
              toolBuffer
                .filter(isDocumentOperationToolCall)
                .map((tc: any) => {
                  tc.input = suffixOperationIds(tc.input);
                  return validateOperationsSemantics(editor, tc.input);
                })
                .find((e: string | null) => e !== null) ?? null;
            /** Quality is intentionally NOT gated — the transport fix (byte-buffered SSE + UTF-8)
             *  is the real guard against corruption. Content is always written; user reviews via accept/reject. */
            const normText = normalizeMarkdown(fullText);
            if (!semanticError) {
              emitToolCalls = toolBuffer.filter(isDocumentOperationToolCall);
              emitText = normText;
              accepted = true;
              break;
            }
            lastReason = semanticError ?? "unknown";
            errorFeedback = `Your previous response was rejected: ${semanticError}. Use ONLY block ids that exist in the document state above. Retry.`;
            attempts++;
          }
          /** The retry loop settled (accepted, exhausted, or truncated). Output for
           *  this turn is complete — but `closed` must NOT be set yet: the buffered
           *  flush below still has to run, and the Path A → Path B fallback re-opens
           *  the turn entirely. Each terminal branch closes the stream explicitly. */
          /** Server cap (MAX_AI_BUFFER) hit: content is incomplete — never present
           *  partial output as a valid response. Fail once so rust-ai shows retry/cancel;
           *  retrying internally cannot help (the same cap applies). */
          if (streamTruncated) {
            console.error("[ai] response truncated at server cap", {
              provider,
              model,
              attempts,
              textLen: fullText.length,
              toolCalls: toolBuffer.length,
            });
            toast.error("AI response was truncated — try a smaller request");
            closed = true;
            controller.error(new Error("AI response was truncated"));
            return;
          }
          /** When the model produced meaningful tool ops they are the ONLY output
           *  channel — drop the buffered commentary text so the suggestion never
           *  overwrites/duplicates streamed prose. Otherwise flush (Path B already
           *  streamed live; Path A flushes now). */
          const meaningfulOps = accepted
            ? emitToolCalls
                .map((tc: any) => filterMeaningfulOperations(editor, tc))
                .filter(Boolean)
            : [];
          if (useTools || meaningfulOps.length > 0 || emitToolCalls.length > 0) {
            pendingDelta = "";
          } else {
            flushDeltas();
          }
          if (!accepted) {
            /** Signal the error to rust-ai so the AI menu shows error state with retry/cancel
             *  buttons. */
            const reason = lastReason || "unknown";
            console.error("[ai] AI output failed validation:", {
              provider,
              model,
              supportsTools,
              attempts,
              toolCalls: toolBuffer.length,
              textLen: fullText.length,
            });
            toast.error("AI output was rejected: " + reason);
            closed = true;
            controller.error(new Error(reason));
            break turn;
          }
          if (emitToolCalls.length > 0) {
            /** A model forced by tool_choice:"required" often calls with EMPTY
             *  operations when it decides nothing needs changing. Empty input must not
             *  become a document edit and must not surface as an error, so filter
             *  those out and close gracefully. */
            if (meaningfulOps.length === 0) {
              console.info(
                "[ai] tool calls had no operations — treating as no change",
                { provider, model, toolCalls: emitToolCalls.length },
              );
              /** Route through rust-ai's ERROR surface: it renders retry + cancel
               *  buttons, so the user can rephrase or dismiss. The toast carries
               *  the clear message — the menu only shows a
               *  generic "Error" label. The old force-close + toast fought each
               *  other (menu vanished while the toast claimed something happened). */
              toast.info(
                "AI made no document changes — retry with a different prompt or cancel",
              );
              closed = true;
              controller.error(new Error("AI made no document changes"));
            } else {
              for (const tc of meaningfulOps) {
                /** Emit tool-input-available so rust-ai creates a tool part → suggestions */
                controller.enqueue({
                  type: "tool-input-available",
                  toolCallId: tc.toolCallId,
                  toolName: tc.toolName,
                  input: tc.input,
                });
              }
              /** text-end only when a tool part was emitted (stream still open). */
              controller.enqueue({ type: "text-end", id });
            }
            closed = true;
            break turn;
          }
          if (useTools && emitText && editor && !textFallbackUsed) {
            /** Path A/Path B asymmetry: a probed tool-capable provider can still answer
             *  with prose (tool calling is not deterministic — the model explains why it
             *  cannot edit, or the gateway drops `tools`). Re-ask ONCE with the text-only
             *  prompt. The prose itself is NOT converted: the tool prompt hands the model
             *  internal block ids, so feeding that transcript back as Markdown would leak
             *  ids and misrepresent the document. */
            console.info("[ai] tools mode returned text — retrying once as text-only", {
              provider,
              model,
              attempts,
              textLen: fullText.length,
            });
            textFallbackUsed = true;
            useTools = false;
            /** Path B streams live, so the buffered Path A prose must go. */
            bufferText = false;
            pendingDelta = "";
            attempts = 0;
            errorFeedback = "";
            toast.info("AI could not call tools — retrying in text mode");
            continue turn;
          }
          if (useTools && emitText) {
            /** Fallback already spent: the provider refuses to call tools AND refuses to
             *  produce usable text. Surface retry/cancel instead of looping. */
            toast.error(
              "AI returned text instead of a tool call — retry or cancel",
            );
            closed = true;
            controller.error(new Error("AI tool call required"));
            break turn;
          }
          if (emitText && editor) {
            /** Path B (no tools, or the tools fallback above): map the model's
             *  Markdown into operations so rust-ai renders a suggestion. Only a
             *  delimited payload counts as content — anything else is the model
             *  talking about the document, and writing it would replace the
             *  selection (or append after the cursor) with prose. */
            const payload = extractDelimitedContent(emitText);
            const input = payload
              ? await buildApplyDocumentInput(editor, payload)
              : null;
            const meaningfulInput = input
              ? filterMeaningfulOperations(editor, { input })?.input
              : null;
            if (meaningfulInput) {
              /** Let rust-ai create the tool part → suggestion → accept/reject flow */
              controller.enqueue({
                type: "tool-input-available",
                toolCallId: "gen-" + uuid(),
                toolName: "applyDocumentOperations",
                input: meaningfulInput,
              });
              controller.enqueue({ type: "text-end", id });
            } else if (!payload || input) {
              /** No payload at all — the model answered instead of editing, which
               *  is the correct reply to "fix spelling" on clean text — or a
               *  payload that parsed to nothing but no-ops. Both mean no change:
               *  fail so rust-ai does not turn successful completion into
               *  user-reviewing. */
              toast.info(
                "AI made no document changes — retry with a different prompt or cancel",
              );
              closed = true;
              controller.error(new Error("AI made no document changes"));
            } else {
              /** Delimited, but it cannot be mapped to blocks: remains a normal text result. */
              controller.enqueue({ type: "text-end", id });
            }
            closed = true;
            break turn;
          }
          /** Nothing to emit — empty output AND no tool calls = gateway
           *  anomaly (unlike a deliberate empty tool call, which is a
           *  no-change). Surface it as an error with the details logged. */
          console.error("[ai] empty AI result:", {
            provider,
            model,
            supportsTools,
            attempts,
            toolCalls: toolBuffer.length,
            textLen: fullText.length,
          });
          controller.error(new Error("AI returned an empty response"));
          closed = true;
          break turn;
          }
      } catch (error) {
        if (abortSignal?.aborted) return;
        const message = safeAiTransportError(error);
        /** Log the cause: the generic toast is intentional (no vault/provider
         *  detail leaks to the user), but swallowing the error made field
         *  reports like "[ai] transport failed" impossible to diagnose. */
        console.error("[ai] transport failed", error);
        toast.error(message);
        try {
          controller.error(new Error(message));
        } catch {}
      } finally {
        closed = true;
        if (flushTimer) clearTimeout(flushTimer);
        unsubToken();
        unsubTool();
        unsubToolsDone();
        unsubGenerating();
        unsubDone();
        try {
          controller.close();
        } catch {}
      }
    },
  });
}
