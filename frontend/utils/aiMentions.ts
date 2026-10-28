export type AiMentionKind = "file" | "folder";

export interface AiMention {
  raw: string;
  start: number;
  end: number;
  token: string;
  kind: AiMentionKind;
}

/** Characters an unquoted mention token may contain. Anything else (a space,
 *  non-ASCII, `(`, `#`, `+`…) ends the token, so such a path must be quoted. */
const UNQUOTED_TOKEN_CHAR = /[A-Za-z0-9._/-]/;

/** The mention text for a vault path, as `parseMentions` will read it back:
 *  bare when every character is allowed unquoted, `@"…"` otherwise. Quoting
 *  only on whitespace let the picker insert `@café.md` or `@notes(1).md`, read
 *  back as `caf` / `notes` — not found, or silently a different file. */
export function mentionText(path: string): string {
  return [...path].every((char) => UNQUOTED_TOKEN_CHAR.test(char)) ? `@${path}` : `@"${path}"`;
}

export function parseMentions(text: string): { mentions: AiMention[]; hasMentions: boolean } {
  if (!text.includes("@")) return { mentions: [], hasMentions: false };

  const mentions: AiMention[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || (i > 0 && !/\s/.test(text[i - 1])) || (i > 0 && text[i - 1] === "\\")) continue;

    let token: string;
    let end: number;
    if (text[i + 1] === '"') {
      const close = text.indexOf('"', i + 2);
      if (close < 0) continue;
      token = text.slice(i + 2, close);
      end = close + 1;
      if (!token) continue;
    } else {
      let cursor = i + 1;
      while (cursor < text.length && UNQUOTED_TOKEN_CHAR.test(text[cursor])) cursor++;
      /** Sentence punctuation after a mention is not part of it: "Summarize
       *  @CHANGELOG.md." asks for `CHANGELOG.md`, not a file named `CHANGELOG.md.`.
       *  A trailing `/` (folder) is kept. */
      token = text.slice(i + 1, cursor).replace(/[,;)}\]?!.]+$/, "");
      if (!token) continue;
      end = i + 1 + token.length;
    }

    mentions.push({ raw: text.slice(i, end), start: i, end, token, kind: token.endsWith("/") ? "folder" : "file" });
    i = end - 1;
  }
  return { mentions, hasMentions: mentions.length > 0 };
}
