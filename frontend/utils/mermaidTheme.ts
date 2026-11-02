/** Mermaid bakes its theme into every SVG it renders: the colors land in an
 *  inline `<style>` as literal values, so a diagram cannot follow the page's
 *  CSS after the fact. Left uninitialized, Mermaid uses its light `default`
 *  palette — dark text and pale lavender nodes on the dark editor.
 *
 *  So Mermaid's `base` theme (the one Mermaid documents as customizable) is fed
 *  from the app's semantic color tokens in index.css, read at render time and
 *  applied per render in `installRenderCaches`. No color lives here: each theme
 *  variable names the token it takes, and a variable whose token is unset is
 *  left for Mermaid to derive.
 *
 *  `primaryColor` takes the accent on purpose: Mermaid derives its categorical
 *  palettes (pie slices, git branches, mindmap and timeline sections) by
 *  rotating that hue, so a neutral seed would turn every slice grey. The
 *  structural roles that would otherwise inherit it (nodes, tasks, quadrants)
 *  are pinned to neutral surfaces below. */
const THEME_TOKENS = {
  background: '--color-background',
  primaryColor: '--color-accent',
  // Nodes, actors, states, entities.
  mainBkg: '--color-surface-active',
  nodeBkg: '--color-surface-active',
  primaryBorderColor: '--color-muted',
  nodeBorder: '--color-muted',
  primaryTextColor: '--color-foreground',
  textColor: '--color-foreground',
  titleColor: '--color-foreground-heading',
  // Edges and their labels.
  lineColor: '--color-foreground-subtle',
  arrowheadColor: '--color-foreground-subtle',
  edgeLabelBackground: '--color-background',
  relationLabelBackground: '--color-background',
  // Subgraphs and ER attribute rows.
  clusterBkg: '--color-surface',
  clusterBorder: '--color-border',
  attributeBackgroundColorOdd: '--color-surface',
  attributeBackgroundColorEven: '--color-surface-hover',
  requirementBackground: '--color-surface-active',
  quadrant1Fill: '--color-surface',
  // Sequence diagrams: the number sits on a circle filled with the text color.
  activationBkgColor: '--color-surface-hover',
  activationBorderColor: '--color-muted',
  sequenceNumberColor: '--color-background',
  noteBkgColor: '--color-warning-surface',
  noteBorderColor: '--color-warning-border',
  noteTextColor: '--color-foreground',
  // Gantt.
  sectionBkgColor: '--color-surface',
  sectionBkgColor2: '--color-surface-hover',
  altSectionBkgColor: '--color-background',
  gridColor: '--color-border',
  taskBkgColor: '--color-surface-active',
  activeTaskBkgColor: '--color-accent-subtle',
  activeTaskBorderColor: '--color-accent',
  doneTaskBkgColor: '--color-surface-hover',
  doneTaskBorderColor: '--color-muted',
  critBkgColor: '--color-danger-surface',
  critBorderColor: '--color-danger',
  todayLineColor: '--color-danger',
  vertLineColor: '--color-accent',
  excludeBkgColor: '--color-surface',
  taskTextClickableColor: '--color-accent',
  // Pie slice separators.
  pieStrokeColor: '--color-background',
  pieOuterStrokeColor: '--color-border',
  errorBkgColor: '--color-danger-surface',
  errorTextColor: '--color-danger',
} as const;

export type MermaidThemeVariables = Partial<Record<keyof typeof THEME_TOKENS, string>> & {
  darkMode: boolean;
};

export interface MermaidTheme {
  themeVariables: MermaidThemeVariables;
  /** Identifies the palette, so a render cached under one theme is never served
   *  under another. */
  key: string;
}

/** Read the active palette from the document root, where the theme store sets
 *  `data-theme` and `color-scheme` (see stores/theme). `darkMode` follows the
 *  computed `color-scheme`, so Mermaid's own derivations (borders, row stripes,
 *  section shades) lighten instead of darken on a dark palette. */
export function readMermaidTheme(root: Element = document.documentElement): MermaidTheme {
  const style = getComputedStyle(root);
  const themeVariables: MermaidThemeVariables = {
    darkMode: style.getPropertyValue('color-scheme').split(/\s+/).includes('dark'),
  };
  for (const [variable, token] of Object.entries(THEME_TOKENS)) {
    const value = style.getPropertyValue(token).trim();
    if (value) themeVariables[variable as keyof typeof THEME_TOKENS] = value;
  }
  return { themeVariables, key: JSON.stringify(themeVariables) };
}

/** Everything outside the source that a finished preview SVG has baked in:
 *  the label font (computed on the editor, where it is themable) and the
 *  palette. `key` changes whenever either does. */
export interface DiagramStyle {
  fontFamily: string;
  key: string;
}

export function readDiagramStyle(fontFamilyElement?: Element): DiagramStyle {
  const fontFamily = fontFamilyElement ? getComputedStyle(fontFamilyElement).fontFamily : '';
  return { fontFamily, key: JSON.stringify([fontFamily, readMermaidTheme().key]) };
}
