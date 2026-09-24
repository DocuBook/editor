/**
 * Shared unit-test harness — the one place that knows how to let React's queued
 * work run inside jsdom.
 *
 * Imported by the component tests; never collected as a suite (vitest only picks
 * up `*.test.ts(x)`).
 */
import { act } from "react";

/* React only batches inside `act` when this flag is set; every component test
   used to repeat the line. */
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Let React's queued effects/microtasks run — the async-settle primitive. */
export const flush = () => act(async () => { await Promise.resolve(); });

/** Deeper drain: a state update that schedules another (3 hops, the deepest
 *  chain in the suite today). */
export const settle = async () => { await flush(); await flush(); await flush(); };
