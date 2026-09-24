import { describe, expect, it } from "vitest";
import { parseMentions } from "../../../frontend/utils/aiMentions";

describe("parseMentions", () => {
  it("ignores email addresses", () => {
    expect(parseMentions("me@mail.com").mentions).toEqual([]);
    expect(parseMentions("@notes.md").mentions).toHaveLength(1);
  });
  it("preserves quoted nested paths with spaces", () => {
    expect(parseMentions('@"a b/c.md"').mentions[0]).toMatchObject({ token: "a b/c.md", kind: "file" });
  });
  it("distinguishes recursive folders from file paths", () => {
    expect(parseMentions("@folder/").mentions[0].kind).toBe("folder");
    expect(parseMentions("@folder").mentions[0].kind).toBe("file");
    expect(parseMentions("@a/b/c/d.md").mentions[0].token).toBe("a/b/c/d.md");
  });
  it("allows extension-less paths", () => {
    expect(parseMentions("@roadmap").mentions[0]).toMatchObject({ token: "roadmap", kind: "file" });
  });
  it("strips trailing punctuation", () => {
    expect(parseMentions("@a,").mentions[0].token).toBe("a");
  });
  it("ignores escaped at-signs", () => {
    expect(parseMentions("\\@literal").mentions).toEqual([]);
  });
  it("ends unquoted mentions at whitespace and supports repeated tokens", () => {
    expect(parseMentions("@Project Plan").mentions[0].token).toBe("Project");
    expect(parseMentions("@a.md @a.md").mentions).toHaveLength(2);
  });
  it("returns immediately for text without at-signs", () => {
    expect(parseMentions("plain text")).toEqual({ mentions: [], hasMentions: false });
  });
});
