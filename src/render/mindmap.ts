import type { Concept, Theme } from "../graph/types.ts";

/** Mermaid mindmap text breaks on brackets and some punctuation; keep labels plain. */
export function mermaidLabel(s: string): string {
  return s
    .replace(/[()[\]{}<>"`]/g, " ")
    .replace(/::/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Render the topic mind map (D-022) as a Mermaid `mindmap` block body. */
export function renderMindmap(
  rootName: string,
  themes: Theme[],
  concepts: Concept[],
  conceptTheme: Record<string, string>,
  opts: { status?: (c: Concept) => string | undefined } = {},
): string {
  const kids = new Map<string | null, Theme[]>();
  for (const t of themes) kids.set(t.parent, [...(kids.get(t.parent) ?? []), t]);
  const inTheme = new Map<string, Concept[]>();
  for (const c of concepts) {
    const t = conceptTheme[c.id];
    if (t) inTheme.set(t, [...(inTheme.get(t) ?? []), c]);
  }
  const lines = ["mindmap", `  root((${mermaidLabel(rootName)}))`];
  const walk = (parent: string | null, depth: number) => {
    for (const t of (kids.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`${"  ".repeat(depth)}${mermaidLabel(t.name)}`);
      walk(t.id, depth + 1);
      const cs = (inTheme.get(t.id) ?? []).sort((a, b) => a.firstSeen - b.firstSeen || a.name.localeCompare(b.name));
      for (const c of cs) {
        const s = opts.status?.(c);
        lines.push(`${"  ".repeat(depth + 1)}${mermaidLabel(c.name)}${s ? ` ${s}` : ""}`);
      }
    }
  };
  walk(null, 2);
  return lines.join("\n");
}
