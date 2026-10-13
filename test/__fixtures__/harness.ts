/**
 * Shared unit-test harness — the one place that knows how to let React's queued
 * work run inside jsdom.
 *
 * Imported by the component tests; never collected as a suite (vitest only picks
 * up `*.test.ts(x)`).
 */
import { act, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

/* React only batches inside `act` when this flag is set; every component test
   used to repeat the line. */
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Let React's queued effects/microtasks run — the async-settle primitive. */
export const flush = () => act(async () => { await Promise.resolve(); });

/** Deeper drain: a state update that schedules another (3 hops, the deepest
 *  chain in the suite today). */
export const settle = async () => { await flush(); await flush(); await flush(); };

/** One macrotask hop — for effects that settle through `setTimeout(0)`, such as
 *  Mantine's focus trap claiming a control on the next task. */
export const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

/**
 * Mount `ui` WITHOUT flushing passive effects, so the assertions observe the
 * FIRST committed frame.
 *
 * React runs `useEffect` only after paint in a real browser; `act()` would flush
 * it early and hide the very frame under test (the cold-open skeleton), so the
 * initial render is deliberately outside `act` and the caller settles explicitly
 * with {@link settle}. `flushSync` still forces the synchronous commit.
 *
 * React warns about that deliberate render not being wrapped in `act`; the
 * warning is expected noise, so it is silenced here instead of in each suite.
 */
export const mountCold = (ui: ReactNode): { container: HTMLDivElement; root: Root } => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const original = console.error;
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("not wrapped in act")) return;
    original(...args);
  });
  try {
    flushSync(() => { root.render(ui); });
  } finally {
    spy.mockRestore();
  }
  return { container, root };
};
