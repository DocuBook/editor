import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHtmlDocumentState,
  filterMeaningfulOperations,
  warmDocumentHtml,
} from "../../../frontend/utils/aiBlocks";

/** What a request costs before it reaches the provider and after it returns:
 *  the document is serialized once per block object, not once per request, and
 *  filtering operations does not walk the document per operation. */

type Block = { id: string; type: string; content: string; children: Block[] };
const block = (id: string, content: string, children: Block[] = []): Block => ({ id, type: "paragraph", content, children });

function editorOf(document: Block[], serialize?: (blocks: any[]) => string) {
  const serialized: string[] = [];
  const editor = {
    document,
    getSelection: () => undefined,
    getTextCursorPosition: () => undefined,
    getBlock: (id: string) => document.find((b) => b.id === id),
    tryParseHTMLToBlocks: (html: string) => [{ type: "paragraph", content: html.replace(/^<p>|<\/p>$/g, ""), children: [] }],
    blocksToHTMLLossy: vi.fn((blocks: any[]) => {
      serialized.push(blocks.map((b) => b.id ?? "new").join(","));
      return serialize ? serialize(blocks) : blocks.map((b) => `<p>${b.content}</p>`).join("");
    }),
  };
  return { editor, serialized };
}

afterEach(() => vi.useRealTimers());

describe("document state serialization", () => {
  it("serializes each block once and again only after it changed", async () => {
    const nested = block("nested-child", "child");
    const doc = [block("block-a", "a"), block("block-b", "b", [nested])];
    const { editor, serialized } = editorOf(doc);

    const first = await buildHtmlDocumentState(editor);
    expect(serialized).toEqual(["block-a", "block-b", "nested-child"]);

    serialized.length = 0;
    expect(await buildHtmlDocumentState(editor)).toEqual(first);
    expect(serialized).toEqual([]);

    // An edit replaces the block object (BlockNote's blockCache): only it is
    // serialized again, and the new content is what the state carries.
    editor.document = [doc[0], { ...doc[1], content: "b edited" }];
    const edited = await buildHtmlDocumentState(editor);
    expect(serialized).toEqual(["block-b"]);
    expect(edited.blocks.map((entry: any) => entry.block)).toEqual(["<p>a</p>", "<p>b edited</p>", "<p>child</p>"]);
  });

  it("keeps one cache per editor", async () => {
    const shared = block("shared-block", "same object");
    const one = editorOf([shared]);
    const two = editorOf([shared], () => "<p>other schema</p>");
    await buildHtmlDocumentState(one.editor);
    const state = await buildHtmlDocumentState(two.editor);
    expect(state.blocks[0].block).toBe("<p>other schema</p>");
  });
});

describe("document HTML warm-up", () => {

  it("fills the cache in slices, so the request serializes nothing", async () => {
    vi.useFakeTimers();
    const doc = Array.from({ length: 4 }, (_, i) => block(`warm-block-${i}`, String(i)));
    let clock = 0;
    const { editor, serialized } = editorOf(doc, (blocks) => {
      clock += 9; // a serializer slower than a slice: one block per slice
      return `<p>${blocks[0].content}</p>`;
    });

    warmDocumentHtml(editor, () => clock);
    expect(serialized).toEqual([]); // nothing runs synchronously
    vi.advanceTimersToNextTimer();
    expect(serialized).toHaveLength(1); // the slice yielded once over budget
    vi.runAllTimers();
    expect(serialized).toHaveLength(4);

    serialized.length = 0;
    vi.useRealTimers();
    await buildHtmlDocumentState(editor);
    expect(serialized).toEqual([]);
  });

  it("stops when cancelled", () => {
    vi.useFakeTimers();
    const { editor, serialized } = editorOf([block("cancel-block-a", "a"), block("cancel-block-b", "b")]);
    const cancel = warmDocumentHtml(editor);
    cancel();
    vi.runAllTimers();
    expect(serialized).toEqual([]);
  });
});

describe("filterMeaningfulOperations document index", () => {
  /** The rule the index replaced: any document id (8+ chars) anywhere in the HTML. */
  const naive = (doc: Block[], html: string) => {
    const ids: string[] = [];
    const walk = (blocks: Block[]) => blocks.forEach((b) => { if (b.id.length >= 8) ids.push(b.id); walk(b.children); });
    walk(doc);
    return ids.some((id) => html.includes(id));
  };

  it("drops exactly the HTML that carries a document id, of any length and position", () => {
    const uuid = "f420cd68-9d89-46dc-9782-d1d973af1471";
    const doc = [block(uuid, "uuid block"), block("ten-chars!", "short id", [block("nested-id-123", "nested")]), block("tiny", "under 8")];
    const { editor } = editorOf(doc);
    const candidates = [
      `<p>${uuid}</p>`,
      `<p>start</p>${uuid}`,
      `<p>ends with ten-chars!</p>`,
      `<p>has nested-id-123 inside</p>`,
      `<p>tiny is too short to count</p>`,
      `<p>${uuid.slice(0, -1)}</p>`,
      `<p>plain</p>`,
    ];
    const kept = filterMeaningfulOperations(editor, {
      input: { operations: [{ type: "add", referenceId: `${uuid}$`, position: "after", blocks: candidates }] },
    })?.input.operations[0].blocks ?? [];
    expect(kept).toEqual(candidates.filter((html) => !naive(doc, html)));
    expect(kept).toEqual([`<p>tiny is too short to count</p>`, `<p>${uuid.slice(0, -1)}</p>`, `<p>plain</p>`]);
  });

  it("finds nested blocks, prefers the selection's own copy, and drops deletes of missing blocks", () => {
    const child = block("child-block", "child text");
    const doc = [block("parent-block", "parent", [child])];
    const { editor } = editorOf(doc);
    const result = filterMeaningfulOperations(
      editor,
      { input: { operations: [
        { type: "update", id: "child-block$", block: "<p>child text</p>" },
        { type: "update", id: "parent-block$", block: "<p>parent</p>" },
        { type: "delete", id: "child-block$" },
        { type: "delete", id: "missing-block$" },
      ] } },
      // A selection cut covers part of the parent: an echo of that part is no change.
      [block("parent-block", "par")],
    );
    expect(result?.input.operations).toEqual([
      { type: "update", id: "parent-block$", block: "<p>parent</p>" },
      { type: "delete", id: "child-block$" },
    ]);
  });
});
