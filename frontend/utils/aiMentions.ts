export type AiMentionKind = "file" | "folder";

export interface AiMention {
  raw: string;
  start: number;
  end: number;
  token: string;
  kind: AiMentionKind;
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
      while (cursor < text.length && /[A-Za-z0-9._/-]/.test(text[cursor])) cursor++;
      token = text.slice(i + 1, cursor).replace(/[,;)}\]?!]+$/, "");
      if (!token) continue;
      end = i + 1 + token.length;
    }

    mentions.push({ raw: text.slice(i, end), start: i, end, token, kind: token.endsWith("/") ? "folder" : "file" });
    i = end - 1;
  }
  return { mentions, hasMentions: mentions.length > 0 };
}
