import { describe, it, expect } from "vitest";
import { mathDollarToMathML } from "../../../frontend/utils/mathMarkdown";

describe("mathDollarToMathML", () => {
  it("block $$ on own line", () => {
    const r = mathDollarToMathML("Before\n\n$$E = mc^2$$\n\nAfter");
    expect(r).toContain(
      '<div><math display="block"><annotation encoding="application/x-tex">E = mc^2</annotation></math></div>',
    );
    expect(r).not.toContain("$$");
  });

  it("inline $ within text", () => {
    const r = mathDollarToMathML("Text $x$ inline");
    expect(r).toContain(
      '<math display="inline"><annotation encoding="application/x-tex">x</annotation></math>',
    );
  });

  it("escaped \\$ is a literal dollar, never math", () => {
    const r = mathDollarToMathML("Price is \\$5 and $x$ math");
    expect(r).toContain("Price is $5 and");
    expect(r).toContain('display="inline"');
    expect(mathDollarToMathML("\\$x\\$ and \\$y\\$")).toBe("$x$ and $y$");
  });

  it("a delimiter after an escaped backslash is literal", () => {
    expect(mathDollarToMathML(String.raw`esc \\( x \\) here`)).toBe(String.raw`esc \\( x \\) here`);
  });

  it("multi-line block math", () => {
    const r = mathDollarToMathML("$$\nf(x) = x^2\n$$\n");
    expect(r).toContain("f(x) = x^2");
  });

  it("money amounts are not math", () => {
    const r = mathDollarToMathML("Cost: $5 and $10 total");
    expect(r).not.toContain("display=");
  });

  it("inline math with underscore not confused", () => {
    const r = mathDollarToMathML("Use $x_i$ here");
    expect(r).toContain("x_i");
  });

  it("supports LaTeX inline delimiters", () => {
    const r = mathDollarToMathML(String.raw`Area is \(A = \pi r^2\).`);
    expect(r).toContain('display="inline"');
    expect(r).toContain("A = \\pi r^2");
  });

  it("supports LaTeX block delimiters", () => {
    const r = mathDollarToMathML(String.raw`\[a^2 + b^2 = c^2\]`);
    expect(r).toContain('display="block"');
    expect(r).toContain("a^2 + b^2 = c^2");
  });
  it("block followed by paragraph has blank line (no stray \\ spacing)", () => {
    const r = mathDollarToMathML("$$a = b$$\nAfter");
    expect(r).toContain("</div>\n");
    expect(r).toContain("</div>\n\nAfter");
  });

  it("multiline block preserves newlines", () => {
    const r = mathDollarToMathML(
      "$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$\n\nAfter",
    );
    expect(r).toContain("a &= b");
    expect(r).toContain("c &= d");
    expect(r).toMatch(/a &= b \\.*\nc &= d/s);
  });

  describe("code is literal", () => {
    it.each([
      ["fenced shell", "```sh\ndocker run -v $(pwd):/app $(IMAGE)\n```"],
      ["fenced make", "```make\nbuild:\n\t$(CC) $(CFLAGS) -o app\n```"],
      ["fenced latex listing", "```latex\n\\[ x^2 \\]\n$$a$$\n```"],
      ["tilde fence", "~~~\n$x$ and \\(y\\)\n~~~"],
      ["inline code", "Run `docker run -v $(pwd):/app $(IMAGE)` now"],
      ["inline regex", "Match `/\\(foo\\)/` literally"],
      ["double-backtick span", "Use ``a $b$ ` c`` here"],
      ["HTML code", "<p>Run <code>$(a) $(b)</code></p>"],
      ["HTML pre", "<pre><code>\\[ x \\]</code></pre>"],
      ["HTML code with escaped dollar", "<p>Run <code>echo \\$HOME</code></p>"],
    ])("%s", (_name, md) => {
      expect(mathDollarToMathML(md)).toBe(md);
    });

    it("still converts math next to code", () => {
      const r = mathDollarToMathML("Area $x^2$ via `$(calc)` and\n\n```\n$y$\n```\n\n$$z$$");
      expect(r).toContain('display="inline"><annotation encoding="application/x-tex">x^2</annotation>');
      expect(r).toContain("`$(calc)`");
      expect(r).toContain("```\n$y$\n```");
      expect(r).toContain('display="block"><annotation encoding="application/x-tex">z</annotation>');
    });
  });
});
