/**
 * AI transport for the xl-ai extension — the ONLY window between xl-ai's Chat
 * and the Rust backend (ask_ai SSE stream). Responsibilities, in order:
 *
 *  1. Resolve provider/model/tool support (probe-driven, model-agnostic).
 *  2. Stream Rust SSE events → ai-sdk stream parts (batched text-delta).
 *  3. Route output: meaningful tool ops win (Path A), text-only falls back to
 *     a generated applyDocumentOperations input (Path B).
 *  4. Semantic gate: referenced block ids must exist in the document;
 *     model-echoed ids get the trailing `$` restored before xl-ai validation.
 *
 * Everything pure lives in aiBlocks.ts (doc context, base messages) so the
 * streaming sequence here stays a thin, readable orchestration.
 */
import { invoke, listen } from "../lib/ipc";
import { toast } from "sonner";
import { useAiSettings, CUSTOM_PROVIDER_ID } from "../stores/aiSettings";
import { useEditorStore } from "../stores/editor";
import {
  buildApplyDocumentInput,
  MAX_AI_ATTEMPTS,
  validateOperationsSemantics,
  buildTaskFormattingRules,
  normalizeMarkdown,
  isVaultGenerationIntent,
  vaultPromptHints,
  buildEditSystemPrompt,
  buildToolSystemPrompt,
  buildDocumentContext,
  buildToolDocContext,
  buildBaseMessages,
  isMeaningfulOps,
  suffixOperationIds,
} from "./aiBlocks";
import { resolveProbeModel, isTextOnly } from "./aiProbe";
import { uuid } from "./uuid";

/** Batch AI token deltas into one text-delta part per tick — fewer ProseMirror
 *  document writes while the AI types (smooth instead of janky streaming). */
const AI_DELTA_BATCH_MS = 50;

/** Provider catalog — small manual list (was a 2.17 MB generated file); model
 *  lists are discovered at runtime via backend `list_models`. Import statically. */
import { PROVIDERS } from "../data/providers";

/** Read saved AI config from persisted store for Rust backend. The API key is
 *  intentionally NOT sent — the backend resolves it from the keychain (SEC-5). */
async function getAiConfig(): Promise<{
  provider?: string;
  model?: string;
  baseUrl?: string;
}> {
  try {
    const st = useAiSettings.getState();
    const p = st.provider
      ? PROVIDERS.find((x) => x.id === st.provider)
      : undefined;
    /** Custom OpenAI-compatible endpoints aren't in the catalog — their base URL
     *  lives in the store and is bound server-side at save time. */
    const baseUrl =
      p?.api ||
      (st.provider === CUSTOM_PROVIDER_ID
        ? st.baseUrls[st.provider]
        : undefined);
    return {
      provider: st.provider || undefined,
      model: st.model || undefined,
      baseUrl,
    };
  } catch (e) {
    console.error("[ai] getAiConfig error:", e);
    return {};
  }
}

export interface AiTransportDeps {
  /** Live BlockNote editor — used for selection text, semantic validation and
   *  converting text output into operations. */
  getEditor: () => any | null;
}

/** Create the xl-ai ChatTransport. `reconnectToStream` is unsupported (the Rust
 *  stream is one-shot; xl-ai never resumes after an abort). */
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
  const probeModel = resolveProbeModel(provider, model);
  const supportsTools = !isTextOnly(provider, probeModel, st.probeTools);
  const toolDefs = (body as any)?.toolDefinitions as
    Record<string, { description: string; inputSchema: any }> | undefined;
  /** Send xl-ai's OWN tool definitions (applyDocumentOperations) so operations → suggestions work */
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
  const sel = editor?.getSelection();
  const selText = sel?.blocks?.length
    ? editor.blocksToMarkdownLossy(sel.blocks)
    : "";

  return new ReadableStream({
    async start(controller) {
      const id = uuid();
      controller.enqueue({ type: "text-start", id });
      let closed = false;
      let fullText = "";
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
      const unsubToken = await listen<string>("ai:token", (e) => {
        if (abortSignal?.aborted || closed) {
          try {
            controller.close();
          } catch {}
          return;
        }
        fullText += e.payload;
        pendingDelta += e.payload;
        if (!bufferText && !flushTimer)
          flushTimer = setTimeout(flushDeltas, AI_DELTA_BATCH_MS);
      });
      const toolBuffer: any[] = [];
      const unsubTool = await listen<any>("ai:tool_call", (e) => {
        if (abortSignal?.aborted || closed) return;
        toolBuffer.push(e.payload);
      });
      const unsubToolsDone = await listen("ai:tools_done", () => {});
      /** Propagate xl-ai abort → Rust cancel (stops the in-flight reqwest stream). */
      abortSignal?.addEventListener?.("abort", () => {
        invoke("cancel_ai").catch(() => {});
      });
      try {
        /** Ground the model with actual document state so output is doc-specific, not generic. */
        let docContext = buildDocumentContext(editor);
        const userMsg = messages.find((m: any) => m.role === "user");
        const userText =
          (userMsg?.parts || [])
            .map((p: any) => (p.type === "text" ? p.text : ""))
            .join("") || "";
        const taskRules = buildTaskFormattingRules(userText);
        /** Resolve wikilinks + search vault for additional grounding context —
         *  ONLY when the prompt shows vault hints (wikilink / question /
         *  generate verb / empty doc), so plain edits skip the RTT + index
         *  lookup entirely. Token-budgeted server-side (2k chars per file,
         *  3 search results max). */
        let vaultContext = "";
        if (vaultPromptHints(userText, docContext)) {
          try {
            const activePath = useEditorStore.getState().activeTab || "";
            vaultContext = await invoke<string>("ai_grounding_context", {
              query: userText,
              activePath,
            });
          } catch {
            /* no vault or no wiki index — skip grounding */
          }
        }
        const hasVaultContext = vaultContext.trim().length > 0;
        /** Vault-first generation: the edit rules below de-authorize vault
         *  content ("NEVER invent … content that is not in the document"),
         *  so a request referencing [[wikilinks]] / asking / generating /
         *  targeting an empty doc gets forced into an applyDocumentOperations
         *  edit with nothing to anchor on. Detect that intent → skip the
         *  tool path and use the vault context as the model's only source;
         *  output lands as plain-Markdown insert (accept/revert). */
        const isVaultGeneration = isVaultGenerationIntent(
          userText,
          hasVaultContext,
          docContext,
        );
        const useTools = supportsTools && !!tools && !isVaultGeneration;
        /** Tool path: reuse xl-ai's OWN document state (ids suffixed `$`, HTML
         *  blocks) — markdown without ids makes models hallucinate referenceIds.
         *  Always overrides the markdown context above when tools are used. */
        if (useTools)
          docContext = buildToolDocContext(
            (messages[messages.length - 1] as any)?.metadata?.documentState,
          );
        bufferText = useTools;
        /** Grounding (read-per-file related vault files) feeds BOTH paths: the
         *  tool call (buildToolSystemPrompt) and text-only (buildEditSystemPrompt).
         *  isVaultGeneration still routes tool-vs-text, but the shared grounding is shared. */
        const systemGrounding = useTools
          ? buildToolSystemPrompt(docContext, vaultContext)
          : buildEditSystemPrompt(docContext, vaultContext, taskRules);
        /** Base messages once; retry loop appends error feedback. */
        const baseMsgs = buildBaseMessages({
          system: systemGrounding,
          messages,
          userText,
          selText,
          useTools,
        });

        /** Retry loop: semantic validation (anti-hallucination) with error feedback. */
        let errorFeedback = "";
        let attempts = 0;
        let accepted = false;
        let lastReason = "";
        let emitToolCalls: any[] = [];
        let emitText = "";
        while (attempts <= MAX_AI_ATTEMPTS) {
          fullText = "";
          pendingDelta = "";
          toolBuffer.length = 0;
          const msgs = errorFeedback
            ? [...baseMsgs, { role: "user", content: errorFeedback }]
            : baseMsgs;
          await invoke("ask_ai", {
            messages: JSON.stringify(msgs),
            ...(useTools ? { tools: JSON.stringify(tools) } : {}),
            provider,
            model,
            baseUrl: providerInfo?.api || config.baseUrl,
          });
          /** Real correctness gate: referenced ids must exist in the document (blocking).
           *  Normalize model-echoed ids (BlockNote expects a trailing `$`; models like
           *  GLM strip it), validate each call, keep the FIRST error. Immutable form —
           *  no loop reassignment, so the accept/retry branch is unambiguous. */
          const semanticError =
            toolBuffer
              .map((tc: any) => {
                tc.input = suffixOperationIds(tc.input);
                return validateOperationsSemantics(editor, tc.input);
              })
              .find((e: string | null) => e !== null) ?? null;
          /** Quality is intentionally NOT gated — the transport fix (byte-buffered SSE + UTF-8)
           *  is the real guard against corruption. Content is always written; user reviews via accept/reject. */
          const normText = normalizeMarkdown(fullText);
          if (!semanticError) {
            emitToolCalls = [...toolBuffer];
            emitText = normText;
            accepted = true;
            break;
          }
          lastReason = semanticError ?? "unknown";
          errorFeedback = `Your previous response was rejected: ${semanticError}. Use ONLY block ids that exist in the document state above. Retry.`;
          attempts++;
        }
        closed = true;
        /** When the model produced meaningful tool ops they are the ONLY output
         *  channel — drop the buffered commentary text so the suggestion never
         *  overwrites/duplicates streamed prose. Otherwise flush (Path B already
         *  streamed live; Path A flushes now). */
        const meaningfulOps = accepted
          ? emitToolCalls.filter(isMeaningfulOps)
          : [];
        if (meaningfulOps.length > 0) {
          pendingDelta = "";
        } else {
          flushDeltas();
        }
        if (!accepted) {
          /** Signal the error to xl-ai so its AIMenu shows error state with retry/cancel
           *  (built-in getDefaultAIMenuItemsForError renders retry + cancel buttons). */
          const reason = lastReason || "unknown";
          console.error("[ai] AI output failed validation:", {
            provider,
            model,
            supportsTools,
            attempts,
            reason,
            toolCalls: toolBuffer.length,
            textLen: fullText.length,
            textSnippet: fullText.substring(0, 300),
          });
          toast.error("AI output was rejected: " + reason);
          controller.error(new Error(reason));
        } else if (emitToolCalls.length > 0) {
          /** A model forced by tool_choice:"required" often calls with EMPTY
           *  operations when it decides nothing needs changing. xl-ai hard-fails
           *  on empty input ("No operations seen"), so filter those out and
           *  close gracefully instead of surfacing an error. */
          if (meaningfulOps.length === 0) {
            console.info(
              "[ai] tool calls had no operations — treating as no change",
              { provider, model, toolCalls: emitToolCalls.length },
            );
            /** Route through xl-ai's ERROR surface: it renders retry + cancel
             *  (ai.retry() / ai.rejectChanges()), so the user can rephrase or
             *  dismiss. The toast carries the clear message — xl-ai only shows a
             *  generic "Error" label. The old force-close + toast fought each
             *  other (menu vanished while the toast claimed something happened). */
            toast.info(
              "AI made no document changes — retry with a different prompt or cancel",
            );
            controller.error(new Error("AI made no document changes"));
          } else {
            for (const tc of meaningfulOps) {
              /** Emit tool-input-available so xl-ai Chat creates a tool part → suggestions */
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
        } else if (emitText && editor) {
          /** Text-only: build applyDocumentOperations so xl-ai renders a suggestion (Option A) */
          const input = await buildApplyDocumentInput(editor, emitText);
          /** Path A (tools sent) produced text but not parseable markdown —
           *  e.g. empty document where model explains why it can't edit.
           *  Retry once with Path B prompt (no tools, explicit markdown
           *  instruction) before surfacing an error. */
          if (input) {
            /** Let xl-ai create the tool part → suggestion → accept/reject flow */
            controller.enqueue({
              type: "tool-input-available",
              toolCallId: "gen-" + uuid(),
              toolName: "applyDocumentOperations",
              input,
            });
            controller.enqueue({ type: "text-end", id });
          } else {
            /** Text that can't be parsed into blocks: the streamed text is
             *  already written into the document (flushed above) — close
             *  cleanly so xl-ai enters user-reviewing (accept/revert) on it. */
            console.info(
              "[ai] text kept as streamed result (not converted to blocks)",
              {
                provider,
                model,
                textLen: emitText.length,
                textSnippet: emitText.substring(0, 200),
              },
            );
            controller.enqueue({ type: "text-end", id });
          }
        } else {
          /** Nothing to emit — empty output AND no tool calls = gateway
           *  anomaly (unlike a deliberate empty tool call, which is a
           *  no-change). Surface it as an error with the details logged. */
          console.error("[ai] empty AI result:", {
            provider,
            model,
            supportsTools,
            attempts,
            lastReason,
            toolCalls: toolBuffer.length,
            textLen: fullText.length,
          });
          controller.error(new Error("AI returned an empty response"));
        }
      } catch (e) {
        console.error("[ai] transport error:", e);
        try {
          controller.error(e);
        } catch {}
      } finally {
        closed = true;
        if (flushTimer) clearTimeout(flushTimer);
        unsubToken();
        unsubTool();
        unsubToolsDone();
        try {
          controller.close();
        } catch {}
      }
    },
  });
}
