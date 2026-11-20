import type { Theme } from "./types.ts";

export interface ThemeProposal {
  themes: { id: string; name: string; parent: string | null }[];
  assignments: { concept: string; theme: string }[];
}

export const OTHER_THEME: Theme = { id: "other", name: "Other", parent: null };

/**
 * Check and repair the AI's proposed mind-map tree (D-022): parents must
 * exist, no cycles, depth ≤ maxDepth; every concept is in exactly one theme.
 * Problems that can be repaired are fixed and reported as warnings.
 */
export function validateThemes(
  proposal: ThemeProposal,
  conceptIds: string[],
  opts: { maxDepth: number; maxChildren: number },
): { themes: Theme[]; conceptTheme: Record<string, string>; warnings: string[] } {
  const warnings: string[] = [];
  const themes = new Map<string, Theme>();
  for (const t of proposal.themes) {
    if (themes.has(t.id)) warnings.push(`theme id "${t.id}" used twice; kept the first`);
    else themes.set(t.id, { id: t.id, name: t.name, parent: t.parent });
  }
  for (const t of themes.values()) {
    if (t.parent !== null && !themes.has(t.parent)) {
      warnings.push(`theme "${t.name}" had unknown parent "${t.parent}"; made it top-level`);
      t.parent = null;
    }
  }
  // break parent cycles and enforce depth
  const depthOf = (t: Theme): number => {
    const seen = new Set<string>();
    let d = 1;
    for (let p = t.parent; p !== null; p = themes.get(p)?.parent ?? null) {
      if (seen.has(p)) return Infinity;
      seen.add(p);
      d++;
    }
    return d;
  };
  for (const t of themes.values()) {
    const d = depthOf(t);
    if (d === Infinity) {
      warnings.push(`theme "${t.name}" was in a parent cycle; made it top-level`);
      t.parent = null;
    } else if (d > opts.maxDepth) {
      let p = t.parent;
      while (p !== null && depthOf(themes.get(p) as Theme) >= opts.maxDepth) p = themes.get(p)?.parent ?? null;
      warnings.push(`theme "${t.name}" was nested ${d} deep; moved it up`);
      t.parent = p;
    }
  }

  const valid = new Set(conceptIds);
  const conceptTheme: Record<string, string> = {};
  for (const a of proposal.assignments) {
    if (!valid.has(a.concept)) continue;
    if (conceptTheme[a.concept]) continue;
    if (!themes.has(a.theme)) {
      warnings.push(`concept "${a.concept}" was put in unknown theme "${a.theme}"`);
      continue;
    }
    conceptTheme[a.concept] = a.theme;
  }
  const missing = conceptIds.filter((id) => !conceptTheme[id]);
  if (missing.length) {
    themes.set(OTHER_THEME.id, { ...OTHER_THEME });
    for (const id of missing) conceptTheme[id] = OTHER_THEME.id;
    warnings.push(`${missing.length} concept(s) had no theme and went into "Other": ${missing.slice(0, 10).join(", ")}`);
  }

  // drop empty themes (no concepts below them)
  const used = new Set<string>();
  for (const tid of Object.values(conceptTheme)) {
    for (let p: string | null = tid; p !== null; p = themes.get(p)?.parent ?? null) used.add(p);
  }
  for (const id of [...themes.keys()]) if (!used.has(id)) themes.delete(id);

  // lint: wide nodes are hard to read
  const children = new Map<string | null, number>();
  for (const t of themes.values()) children.set(t.parent, (children.get(t.parent) ?? 0) + 1);
  for (const tid of Object.values(conceptTheme)) children.set(tid, (children.get(tid) ?? 0) + 1);
  for (const [parent, n] of children) {
    if (n > opts.maxChildren) {
      const name = parent === null ? "the root" : (themes.get(parent)?.name ?? parent);
      warnings.push(`mind map: ${name} has ${n} children (aim for ≤ ${opts.maxChildren})`);
    }
  }
  return { themes: [...themes.values()], conceptTheme, warnings };
}

/** Path of theme ids from the top-level theme down to `id`. */
export function themePath(themes: Theme[], id: string): string[] {
  const byId = new Map(themes.map((t) => [t.id, t]));
  const out: string[] = [];
  for (let p: string | null = id; p !== null; p = byId.get(p)?.parent ?? null) out.unshift(p);
  return out;
}
