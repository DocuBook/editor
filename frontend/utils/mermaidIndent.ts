export function indentationAt(source: string, caret: number): string {
  return (
    source
      .slice(source.lastIndexOf("\n", caret - 1) + 1, caret)
      .match(/^\s*/)?.[0] ?? ""
  );
}

export function indentSelection(
  source: string,
  from: number,
  to: number,
  outdent: boolean,
) {
  const start = source.lastIndexOf("\n", from - 1) + 1;
  const selected = source.slice(start, to);
  const text = outdent
    ? selected.replace(/^(?: {1,2}|\t)/gm, "")
    : selected.replace(/^/gm, "  ");
  const firstDelta =
    text.split("\n", 1)[0].length - selected.split("\n", 1)[0].length;
  return {
    start,
    text,
    from: Math.max(start, from + firstDelta),
    to: to + text.length - selected.length,
  };
}
