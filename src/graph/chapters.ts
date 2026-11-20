import type { Chapter, Edge, Theme } from "./types.ts";
import { themePath } from "./themes.ts";

export interface ChapterInput {
  ids: string[]; // concepts to teach (floor and known already removed)
  edges: Edge[]; // acyclic
  level: Map<string, number>;
  firstSeen: Map<string, number>;
  conceptTheme: Record<string, string>;
  themes: Theme[];
  maxConcepts: number;
  minConcepts: number;
}

/**
 * Order concepts so every prerequisite comes first, keeping concepts of the
 * same theme together where the prerequisites allow it (a "sticky"
 * topological sort). Ties go to lower level, then the docs' own order.
 */
export function stickyTopoOrder(input: ChapterInput, groupOf: (id: string) => string, topOf: (id: string) => string): string[] {
  const inScope = new Set(input.ids);
  const remaining = new Map<string, number>(input.ids.map((id) => [id, 0]));
  const dependents = new Map<string, string[]>();
  for (const e of input.edges) {
    if (!inScope.has(e.from) || !inScope.has(e.to)) continue;
    remaining.set(e.to, (remaining.get(e.to) ?? 0) + 1);
    dependents.set(e.from, [...(dependents.get(e.from) ?? []), e.to]);
  }
  const ready = new Set(input.ids.filter((id) => remaining.get(id) === 0));
  const rank = (id: string): [number, number] => [input.level.get(id) ?? 0, input.firstSeen.get(id) ?? Number.MAX_SAFE_INTEGER];
  const better = (a: string, b: string) => {
    const [la, fa] = rank(a);
    const [lb, fb] = rank(b);
    return la !== lb ? la < lb : fa !== fb ? fa < fb : a < b;
  };
  const pick = (pred: (id: string) => boolean): string | undefined => {
    let best: string | undefined;
    for (const id of ready) if (pred(id) && (best === undefined || better(id, best))) best = id;
    return best;
  };

  const order: string[] = [];
  let last: string | undefined;
  while (ready.size) {
    const next =
      (last && pick((id) => groupOf(id) === groupOf(last as string))) ??
      (last && pick((id) => topOf(id) === topOf(last as string))) ??
      (pick(() => true) as string);
    ready.delete(next);
    order.push(next);
    last = next;
    for (const d of dependents.get(next) ?? []) {
      const r = (remaining.get(d) ?? 0) - 1;
      remaining.set(d, r);
      if (r === 0) ready.add(d);
    }
  }
  if (order.length !== input.ids.length) throw new Error("stickyTopoOrder: graph has a cycle");
  return order;
}

/**
 * Cut the ordered concepts into chapters: a new chapter starts when the theme
 * changes or the chapter is full. Because chapters are contiguous slices of a
 * topological order, no chapter can depend on a later one. Small chapters are
 * then merged into an adjacent chapter of the same top-level theme, which
 * keeps that guarantee.
 */
export function buildChapters(input: ChapterInput): Chapter[] {
  const groupOf = (id: string) => {
    const p = themePath(input.themes, input.conceptTheme[id] ?? "other");
    return p.slice(0, 2).join("/") || "other";
  };
  const topOf = (id: string) => themePath(input.themes, input.conceptTheme[id] ?? "other")[0] ?? "other";
  const order = stickyTopoOrder(input, groupOf, topOf);

  let segments: { group: string; ids: string[] }[] = [];
  for (const id of order) {
    const g = groupOf(id);
    const cur = segments[segments.length - 1];
    if (cur && cur.group === g && cur.ids.length < input.maxConcepts) cur.ids.push(id);
    else segments.push({ group: g, ids: [id] });
  }

  // merge small segments into a neighbour with the same top-level theme
  const top = (g: string) => g.split("/")[0];
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i] as { group: string; ids: string[] };
      if (s.ids.length >= input.minConcepts) continue;
      const prev = segments[i - 1];
      const next = segments[i + 1];
      const fits = (n?: { group: string; ids: string[] }) =>
        n !== undefined && top(n.group) === top(s.group) && n.ids.length + s.ids.length <= input.maxConcepts + input.minConcepts;
      if (fits(prev) && (!fits(next) || (prev as { ids: string[] }).ids.length <= (next as { ids: string[] }).ids.length)) {
        (prev as { ids: string[] }).ids.push(...s.ids);
      } else if (fits(next)) {
        (next as { ids: string[] }).ids.unshift(...s.ids);
      } else continue;
      segments = [...segments.slice(0, i), ...segments.slice(i + 1)];
      changed = true;
      break;
    }
  }

  const themeName = new Map(input.themes.map((t) => [t.id, t.name]));
  const seen = new Map<string, number>();
  return segments.map((s, i) => {
    const themeId = s.group.split("/").pop() as string;
    const n = (seen.get(s.group) ?? 0) + 1;
    seen.set(s.group, n);
    const base = themeName.get(themeId) ?? themeId;
    return { number: i + 1, title: n > 1 ? `${base} (part ${n})` : base, theme: themeId, concepts: s.ids };
  });
}

/** Every problem with a chapter list; empty means valid. */
export function validateChapters(chapters: Chapter[], ids: string[], edges: Edge[]): string[] {
  const problems: string[] = [];
  const pos = new Map<string, [number, number]>();
  chapters.forEach((c, ci) =>
    c.concepts.forEach((id, i) => {
      if (pos.has(id)) problems.push(`${id} appears in more than one chapter`);
      pos.set(id, [ci, i]);
    }),
  );
  for (const id of ids) if (!pos.has(id)) problems.push(`${id} is in no chapter`);
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) {
      problems.push(`${e.to} (chapter ${b[0] + 1}) is taught before its prerequisite ${e.from} (chapter ${a[0] + 1})`);
    }
  }
  return problems;
}
