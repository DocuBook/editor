import { describe, expect, it } from "vitest";
import { mentionText, parseMentions } from "../../../frontend/utils/aiMentions";

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
  it("drops sentence punctuation after a mention, keeping a folder's slash", () => {
    expect(parseMentions("Summarize @CHANGELOG.md.").mentions[0].token).toBe("CHANGELOG.md");
    expect(parseMentions("Read @docs/guide.md, then @notes.").mentions.map((m) => m.token)).toEqual(["docs/guide.md", "notes"]);
    expect(parseMentions("Everything in @docs/.").mentions[0]).toMatchObject({ token: "docs/", kind: "folder" });
  });
});

describe("mentionText", () => {
  it("quotes any path the unquoted form cannot carry, and reads back intact", () => {
    for (const path of ["café.md", "notes(1).md", "C#.md", "a+b.md", "日本語.md", "my notes.md", "docs/guide.md", "roadmap"]) {
      const text = `summarise ${mentionText(path)} please`;
      expect(parseMentions(text).mentions.map((m) => m.token), path).toEqual([path]);
    }
  });
  it("keeps plain paths bare", () => {
    expect(mentionText("docs/guide.md")).toBe("@docs/guide.md");
    expect(mentionText("notes(1).md")).toBe('@"notes(1).md"');
  });
});
