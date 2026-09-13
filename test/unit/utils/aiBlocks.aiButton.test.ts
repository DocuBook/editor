import { describe, expect, it, vi } from "vitest";
import {
  openAIMenuAtAnchor,
  resolveActiveBlockId,
  resolveAIBlockId,
} from "../../../frontend/utils/aiBlocks";

/** Regression: xl-ai's AIToolbarButton threw `Error("No selection")` when
 *  `editor.getSelection()` was undefined (collapsed / node selection such as a
 *  selected image) even though the formatting toolbar was shown. The safe
 *  resolver must fall back to the cursor block instead of throwing. */
describe("resolveAIBlockId", () => {
  it("uses the last block of an active text selection", () => {
    const editor: any = {
      getSelection: () => ({ blocks: [{ id: "b1" }, { id: "b2" }] }),
      getTextCursorPosition: () => ({ block: { id: "cursor" } }),
    };
    expect(resolveAIBlockId(editor)).toBe("b2");
  });

  it("falls back to the cursor block when there is no selection (node selection)", () => {
    const editor: any = {
      getSelection: () => undefined,
      getTextCursorPosition: () => ({ block: { id: "img-block" } }),
    };
    expect(resolveAIBlockId(editor)).toBe("img-block");
  });

  it("falls back to the cursor block when getSelection throws", () => {
    const editor: any = {
      getSelection: () => {
        throw new Error("Error getting selection");
      },
      getTextCursorPosition: () => ({ block: { id: "cursor" } }),
    };
    expect(resolveAIBlockId(editor)).toBe("cursor");
  });

  it("returns undefined when nothing can be resolved (never throws)", () => {
    const empty: any = { getSelection: () => ({ blocks: [] }) };
    expect(resolveAIBlockId(empty)).toBeUndefined();
    expect(resolveAIBlockId(undefined)).toBeUndefined();
    const both: any = {
      getSelection: () => {
        throw new Error("boom");
      },
      getTextCursorPosition: () => {
        throw new Error("boom");
      },
    };
    expect(resolveAIBlockId(both)).toBeUndefined();
  });
});

/** Regression: submitting from the floating composer moves DOM focus into a
 *  <textarea> while xl-ai locks the editor. `getTextCursorPosition()` can then
 *  resolve to a stale/fallback block, so the document state sent to the model
 *  carried the wrong id and operations failed with "block ID not recognized".
 *  The anchored block (set at menu-open time) must win. */
describe("resolveActiveBlockId", () => {
  const withAnchor = (anchor: any, editorFields: any = {}) => ({
    getExtension: () => ({ store: { state: { aiMenuState: anchor } } }),
    ...editorFields,
  });

  it("prefers the AI menu anchor over a stale live cursor", () => {
    const editor: any = withAnchor(
      { blockId: "anchored", status: "user-input" },
      { getTextCursorPosition: () => ({ block: { id: "stale-first-block" } }) },
    );
    expect(resolveActiveBlockId(editor)).toBe("anchored");
  });

  it("falls back to the live selection/cursor when the menu is closed", () => {
    const closed: any = withAnchor("closed", {
      getSelection: () => ({ blocks: [{ id: "sel" }] }),
      getTextCursorPosition: () => ({ block: { id: "cursor" } }),
    });
    expect(resolveActiveBlockId(closed)).toBe("sel");

    const noMenu: any = { getTextCursorPosition: () => ({ block: { id: "cursor" } }) };
    expect(resolveActiveBlockId(noMenu)).toBe("cursor");
  });

  it("never throws when the extension store is unavailable", () => {
    const editor: any = {
      getExtension: () => {
        throw new Error("boom");
      },
      getTextCursorPosition: () => ({ block: { id: "cursor" } }),
    };
    expect(resolveActiveBlockId(editor)).toBe("cursor");
  });
});

describe("openAIMenuAtAnchor", () => {
  it("preserves text selection and opens the menu at its anchor", () => {
    const setTextCursorPosition = vi.fn();
    const openAIMenuAtBlock = vi.fn();
    const editor: any = {
      getSelection: () => ({ blocks: [{ id: "target" }] }),
      getTextCursorPosition: () => ({ block: { id: "stale" } }),
      setTextCursorPosition,
      getExtension: () => ({ openAIMenuAtBlock }),
    };

    expect(openAIMenuAtAnchor(editor)).toBe("target");
    expect(setTextCursorPosition).not.toHaveBeenCalled();
    expect(openAIMenuAtBlock).toHaveBeenCalledWith("target");
  });

  it("restores editor focus before resolving a cursor anchor", () => {
    const focus = vi.fn();
    const setTextCursorPosition = vi.fn();
    const openAIMenuAtBlock = vi.fn();
    let focused = false;
    const getTextCursorPosition = vi.fn(() => ({
      block: { id: focused ? "anchored" : "stale-first-block" },
    }));
    const editor: any = {
      getSelection: () => undefined,
      focus: () => { focused = true; focus(); },
      getTextCursorPosition,
      setTextCursorPosition,
      getExtension: () => ({ openAIMenuAtBlock }),
    };

    expect(openAIMenuAtAnchor(editor)).toBe("anchored");
    expect(focus).toHaveBeenCalledOnce();
    expect(setTextCursorPosition).not.toHaveBeenCalled();
    expect(openAIMenuAtBlock).toHaveBeenCalledWith("anchored");
  });

  it("does not move the cursor when a text selection is active", () => {
    const setTextCursorPosition = vi.fn();
    const openAIMenuAtBlock = vi.fn();
    const editor: any = {
      getSelection: () => ({ blocks: [{ id: "same" }] }),
      getTextCursorPosition: () => ({ block: { id: "same" } }),
      setTextCursorPosition,
      getExtension: () => ({ openAIMenuAtBlock }),
    };

    expect(openAIMenuAtAnchor(editor)).toBe("same");
    expect(setTextCursorPosition).not.toHaveBeenCalled();
    expect(openAIMenuAtBlock).toHaveBeenCalledWith("same");
  });

  it("does not throw when getSelection fails", () => {
    const openAIMenuAtBlock = vi.fn();
    const editor: any = {
      getSelection: () => { throw new Error("selection unavailable"); },
      focus: vi.fn(),
      getTextCursorPosition: () => ({ block: { id: "cursor" } }),
      getExtension: () => ({ openAIMenuAtBlock }),
    };

    expect(openAIMenuAtAnchor(editor)).toBe("cursor");
    expect(openAIMenuAtBlock).toHaveBeenCalledWith("cursor");
  });

  it("returns undefined without opening when no block is resolvable", () => {
    const openAIMenuAtBlock = vi.fn();
    const editor: any = {
      getSelection: () => ({ blocks: [] }),
      getTextCursorPosition: () => {
        throw new Error("boom");
      },
      getExtension: () => ({ openAIMenuAtBlock }),
    };

    expect(openAIMenuAtAnchor(editor)).toBeUndefined();
    expect(openAIMenuAtBlock).not.toHaveBeenCalled();
  });

  it("does not throw when setTextCursorPosition rejects a non-collapsed selection", () => {
    const openAIMenuAtBlock = vi.fn();
    const editor: any = {
      getSelection: () => ({ blocks: [{ id: "target" }] }),
      getTextCursorPosition: () => ({ block: { id: "stale" } }),
      setTextCursorPosition: () => {
        throw new Error("cannot set cursor on a ranged selection");
      },
      getExtension: () => ({ openAIMenuAtBlock }),
    };

    expect(openAIMenuAtAnchor(editor)).toBe("target");
    expect(openAIMenuAtBlock).toHaveBeenCalledWith("target");
  });
});
