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
 *  structural roles that would otherwise inherit it are pinned below: nodes and
 *  tasks to an opaque accent tint, quadrants to neutral surfaces. */
const THEME_TOKENS = {
  background: '--color-background',
  primaryColor: '--color-accent',
  // Nodes, actors, states, entities, class boxes: a soft accent tint with an
  // accent border, so they read as highlighted shapes rather than grey boxes.
  mainBkg: '--color-diagram-node',
  nodeBkg: '--color-diagram-node',
  primaryBorderColor: '--color-diagram-node-border',
  nodeBorder: '--color-diagram-node-border',
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
  attributeBackgroundColorOdd: '--color-background',
  attributeBackgroundColorEven: '--color-diagram-node',
  requirementBackground: '--color-diagram-node',
  // Quadrants 2–4 otherwise derive from primaryColor (the accent), not quadrant1Fill.
  quadrant1Fill: '--color-surface',
  quadrant2Fill: '--color-surface-hover',
  quadrant3Fill: '--color-surface',
  quadrant4Fill: '--color-surface-hover',
  // Accent-rotated fills that keep the foreground as their label color (journey
  // sections and tasks): tinted surfaces instead, so the text stays readable.
  fillType0: '--color-accent-subtle',
  fillType1: '--color-success-surface',
  fillType2: '--color-warning-surface',
  fillType3: '--color-danger-surface',
  fillType4: '--color-accent-subtle',
  fillType5: '--color-success-surface',
  fillType6: '--color-warning-surface',
  fillType7: '--color-danger-surface',
  // The categorical scale (timeline, mindmap, kanban, treemap, radar). Mermaid
  // darkens its own by 75% on dark, which turns every section black, so it takes
  // the app's hue tokens instead: bright on dark, deep on light. Labels on them,
  // like git branch labels (Mermaid lightens branches on dark, darkens on light),
  // take `--color-background`: near-black on dark, white on light. Commit labels
  // would otherwise sit on a hue-rotated fill with an inverted, arbitrary color.
  cScale0: '--color-accent',
  cScale1: '--color-syntax-wikilink',
  cScale2: '--color-syntax-code',
  cScale3: '--color-warning',
  cScale4: '--color-success',
  cScale5: '--color-danger',
  cScale6: '--color-accent',
  cScale7: '--color-syntax-wikilink',
  cScale8: '--color-syntax-code',
  cScale9: '--color-warning',
  cScale10: '--color-success',
  cScale11: '--color-danger',
  scaleLabelColor: '--color-background',
  branchLabelColor: '--color-background',
  tagLabelColor: '--color-on-accent',
  commitLabelBackground: '--color-surface-active',
  commitLabelColor: '--color-foreground',
  // Sequence diagrams: the number sits on a circle filled with the text color.
  activationBkgColor: '--color-diagram-node',
  activationBorderColor: '--color-diagram-node-border',
  sequenceNumberColor: '--color-background',
  noteBkgColor: '--color-warning-surface',
  noteBorderColor: '--color-warning-border',
  noteTextColor: '--color-foreground',
  // Gantt.
  sectionBkgColor: '--color-surface',
  sectionBkgColor2: '--color-surface-hover',
  altSectionBkgColor: '--color-background',
  gridColor: '--color-border',
  taskBkgColor: '--color-diagram-node',
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
  // Architecture hardcodes a black group border and grey edges.
  archGroupBorderColor: '--color-foreground-subtle',
  archEdgeColor: '--color-foreground-subtle',
  archEdgeArrowColor: '--color-foreground-subtle',
  // Event modeling hardcodes white and pastel fills under the theme's text color.
  emUiFill: '--color-surface-active',
  emUiStroke: '--color-border',
  emCommandFill: '--color-accent-subtle',
  emCommandStroke: '--color-accent',
  emEventFill: '--color-warning-surface',
  emEventStroke: '--color-warning-border',
  emReadModelFill: '--color-success-surface',
  emReadModelStroke: '--color-success-border',
  emProcessorFill: '--color-danger-surface',
  emProcessorStroke: '--color-danger',
  emSwimlaneBackgroundOdd: '--color-surface',
  emSwimlaneBackgroundStroke: '--color-border',
} as const;

/** Diagrams that style from a nested object merged over their own black-on-white
 *  defaults, ignoring the flat variables above. */
const NESTED_THEME_TOKENS = {
  packet: {
    startByteColor: '--color-foreground-subtle',
    endByteColor: '--color-foreground-subtle',
    labelColor: '--color-foreground',
    titleColor: '--color-foreground-heading',
    blockStrokeColor: '--color-muted',
    blockFillColor: '--color-surface-active',
  },
  treeView: {
    labelColor: '--color-foreground',
    lineColor: '--color-foreground-subtle',
    iconColor: '--color-foreground-secondary',
  },
} as const;

export type MermaidThemeVariables = Partial<Record<keyof typeof THEME_TOKENS, string>> &
  Partial<Record<keyof typeof NESTED_THEME_TOKENS, Record<string, string>>> & {
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
  const read = (tokens: Record<string, string>) => {
    const values: Record<string, string> = {};
    for (const [variable, token] of Object.entries(tokens)) {
      const value = style.getPropertyValue(token).trim();
      if (value) values[variable] = value;
    }
    return values;
  };
  Object.assign(themeVariables, read(THEME_TOKENS));
  for (const [diagram, tokens] of Object.entries(NESTED_THEME_TOKENS)) {
    const values = read(tokens);
    if (Object.keys(values).length) themeVariables[diagram as keyof typeof NESTED_THEME_TOKENS] = values;
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
