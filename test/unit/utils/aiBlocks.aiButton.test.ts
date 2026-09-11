import { describe, expect, it } from "vitest";
import { resolveAIBlockId } from "../../../frontend/utils/aiBlocks";

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
