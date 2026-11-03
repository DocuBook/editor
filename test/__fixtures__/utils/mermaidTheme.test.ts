// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { readDiagramStyle, readMermaidTheme } from "../../../frontend/utils/mermaidTheme";

const root = document.documentElement;

afterEach(() => {
  root.removeAttribute("style");
});

describe("Mermaid theme from the app's color tokens", () => {
  it("maps each theme variable to the token it names, leaving unset ones to Mermaid", () => {
    root.style.setProperty("--color-background", "#0c0c0d");
    root.style.setProperty("--color-diagram-node", "#131d2e");
    root.style.setProperty("--color-foreground", "#e4e4e7");

    const { themeVariables } = readMermaidTheme();

    expect(themeVariables).toMatchObject({
      background: "#0c0c0d",
      mainBkg: "#131d2e",
      nodeBkg: "#131d2e",
      primaryTextColor: "#e4e4e7",
      textColor: "#e4e4e7",
    });
    // No `--color-accent` on this page: Mermaid derives it, rather than being
    // handed an empty string it cannot parse.
    expect(themeVariables).not.toHaveProperty("primaryColor");
  });

  it("fills the nested style objects some diagrams read, omitting empty ones", () => {
    root.style.setProperty("--color-foreground", "#e4e4e7");
    root.style.setProperty("--color-surface-active", "#222225");

    const { themeVariables } = readMermaidTheme();

    expect(themeVariables.packet).toEqual({ labelColor: "#e4e4e7", blockFillColor: "#222225" });
    expect(themeVariables.treeView).toEqual({ labelColor: "#e4e4e7" });

    root.removeAttribute("style");
    expect(readMermaidTheme().themeVariables).not.toHaveProperty("packet");
  });

  it("follows the computed color-scheme for Mermaid's dark-mode derivations", () => {
    root.style.setProperty("color-scheme", "dark");
    expect(readMermaidTheme().themeVariables.darkMode).toBe(true);

    root.style.setProperty("color-scheme", "light");
    expect(readMermaidTheme().themeVariables.darkMode).toBe(false);
  });

  it("changes its key, and the diagram style key, whenever a token does", () => {
    const element = document.createElement("div");
    root.style.setProperty("--color-background", "#000000");
    const before = readMermaidTheme().key;
    const styleBefore = readDiagramStyle(element).key;

    root.style.setProperty("--color-background", "#ffffff");

    expect(readMermaidTheme().key).not.toBe(before);
    expect(readDiagramStyle(element).key).not.toBe(styleBefore);
  });
});
