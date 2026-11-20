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
 * Order concepts so every prerequisite comes first, keeping related concepts
 * together where the prerequisites allow it (a "sticky" topological sort):
 * stay in the same sub-theme, then the same top-level theme; when switching,
 * go to the most foundational top-level theme with something ready. Ties go
 * to lower level, then the docs' own order.
 */
export function stickyTopoOrder(
  input: ChapterInput,
  subOf: (id: string) => string,
  topOf: (id: string) => string,
  topRank: (top: string) => number,
): string[] {
  const inScope = new Set(input.ids);
  const remaining = new Map<string, number>(input.ids.map((id) => [id, 0]));
  const dependents = new Map<string, string[]>();
  for (const e of input.edges) {
    if (!inScope.has(e.from) || !inScope.has(e.to)) continue;
    remaining.set(e.to, (remaining.get(e.to) ?? 0) + 1);
    dependents.set(e.from, [...(dependents.get(e.from) ?? []), e.to]);
  }
  const ready = new Set(input.ids.filter((id) => remaining.get(id) === 0));
  const rank = (id: string): [number, number, number] => [
    topRank(topOf(id)),
    input.level.get(id) ?? 0,
    input.firstSeen.get(id) ?? Number.MAX_SAFE_INTEGER,
  ];
  const better = (a: string, b: string) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return (ra[i] as number) < (rb[i] as number);
    return a < b;
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
      (last && pick((id) => subOf(id) === subOf(last as string))) ??
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

interface Segment {
  top: string;
  ids: string[];
}

/**
 * Cut the ordered concepts into chapters. A new chapter starts when the
 * chapter is full, or when the sub-theme changes and the chapter already has
 * enough concepts. Because chapters are contiguous slices of a topological
 * order, no chapter can depend on a later one. Chapters that are still too
 * small are merged into a neighbour (preferring the same top-level theme),
 * which keeps that guarantee. Each chapter's "part" is its most common
 * top-level theme.
 */
export function buildChapters(input: ChapterInput): Chapter[] {
  const path = (id: string) => themePath(input.themes, input.conceptTheme[id] ?? "other");
  const topOf = (id: string) => path(id)[0] ?? "other";
  const subOf = (id: string) => path(id).slice(0, 2).join("/") || "other";
  const themeIndex = new Map(input.themes.map((t, i) => [t.id, i]));
  const topRank = (top: string) => themeIndex.get(top) ?? Number.MAX_SAFE_INTEGER;
  const order = stickyTopoOrder(input, subOf, topOf, topRank);

  let segments: Segment[] = [];
  for (const id of order) {
    const cur = segments[segments.length - 1];
    const lastId = cur?.ids[cur.ids.length - 1];
    const subChanged = lastId !== undefined && subOf(lastId) !== subOf(id);
    if (cur && cur.ids.length < input.maxConcepts && !(subChanged && cur.ids.length >= input.minConcepts)) {
      cur.ids.push(id);
    } else segments.push({ top: topOf(id), ids: [id] });
  }
  const mainTop = (ids: string[]) => {
    const count = new Map<string, number>();
    for (const id of ids) count.set(topOf(id), (count.get(topOf(id)) ?? 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1] || topRank(a[0]) - topRank(b[0]))[0]?.[0] ?? "other";
  };
  for (const seg of segments) seg.top = mainTop(seg.ids);

  // merge chapters that are too small into a neighbour, preferring the same top-level theme
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i] as Segment;
      if (s.ids.length >= input.minConcepts) continue;
      const room = (n?: Segment): n is Segment => n !== undefined && n.ids.length + s.ids.length <= input.maxConcepts + input.minConcepts;
      const prev = segments[i - 1];
      const next = segments[i + 1];
      const score = (n: Segment) => (n.top === s.top ? 0 : 1) * 1000 + n.ids.length;
      const target = [prev, next].filter(room).sort((a, b) => score(a) - score(b))[0];
      if (!target) continue;
      if (target === prev) target.ids.push(...s.ids);
      else target.ids.unshift(...s.ids);
      target.top = mainTop(target.ids);
      segments = [...segments.slice(0, i), ...segments.slice(i + 1)];
      changed = true;
      break;
    }
  }

  const themeName = new Map(input.themes.map((t) => [t.id, t.name]));
  const name = (id: string) => themeName.get(id) ?? id;
  const titles = new Map<string, number>();
  return segments.map((s, i) => {
    const count = new Map<string, number>();
    for (const id of s.ids) {
      const p = path(id);
      const sub = p[1] ?? p[0] ?? "other";
      count.set(sub, (count.get(sub) ?? 0) + 1);
    }
    // sub-themes covering most of the chapter, largest first (ties: first seen)
    const subs = [...count].sort((a, b) => b[1] - a[1]).map(([sub]) => sub);
    // name the sub-themes that make up at least a third of the chapter (at most two)
    const names = subs
      .filter((sub, k) => k === 0 || (count.get(sub) ?? 0) * 3 >= s.ids.length)
      .slice(0, 2)
      .map(name);
    let title = names.join(" · ");
    const n = (titles.get(title) ?? 0) + 1;
    titles.set(title, n);
    if (n > 1) title = `${title} (part ${n})`;
    return { number: i + 1, title, part: name(s.top), theme: s.top, concepts: s.ids };
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
