import type { Edge, RemovedEdge } from "./types.ts";

const key = (from: string, to: string) => `${from}\u0000${to}`;

/**
 * Drop self-loops and weak edges, merge duplicates, and resolve pairs that
 * point both ways (D-020): keep the clearly stronger direction, or drop both
 * when the model was unsure which way it goes.
 */
export function cleanEdges(edges: Edge[], minConfidence: number): { kept: Edge[]; removed: RemovedEdge[] } {
  const removed: RemovedEdge[] = [];
  const best = new Map<string, Edge>();
  for (const e of edges) {
    if (e.from === e.to) {
      removed.push({ ...e, reason: "self-loop" });
      continue;
    }
    if (e.confidence < minConfidence) {
      removed.push({ ...e, reason: "low-confidence" });
      continue;
    }
    const k = key(e.from, e.to);
    const prev = best.get(k);
    if (!prev || e.confidence > prev.confidence) best.set(k, e);
  }
  const kept: Edge[] = [];
  const decided = new Set<string>();
  for (const e of best.values()) {
    const k = key(e.from, e.to);
    if (decided.has(k)) continue;
    const back = best.get(key(e.to, e.from));
    if (!back) {
      kept.push(e);
      continue;
    }
    decided.add(k);
    decided.add(key(e.to, e.from));
    if (Math.abs(e.confidence - back.confidence) >= 0.2) {
      const [win, lose] = e.confidence > back.confidence ? [e, back] : [back, e];
      kept.push(win);
      removed.push({ ...lose, reason: "bidirectional" });
    } else {
      removed.push({ ...e, reason: "bidirectional" }, { ...back, reason: "bidirectional" });
    }
  }
  return { kept, removed };
}

function adjacency(nodes: Iterable<string>, edges: Edge[]): Map<string, Edge[]> {
  const out = new Map<string, Edge[]>();
  for (const n of nodes) out.set(n, []);
  for (const e of edges) out.get(e.from)?.push(e);
  return out;
}

/** Find one cycle (as a list of edges), or null if the graph is acyclic. */
export function findCycle(nodes: string[], edges: Edge[]): Edge[] | null {
  const adj = adjacency(nodes, edges);
  const state = new Map<string, 0 | 1 | 2>(); // 0 new, 1 on stack, 2 done
  const stack: Edge[] = [];
  let found: Edge[] | null = null;

  const visit = (n: string): boolean => {
    state.set(n, 1);
    for (const e of adj.get(n) ?? []) {
      const s = state.get(e.to) ?? 0;
      if (s === 1) {
        const start = stack.findIndex((x) => x.from === e.to);
        found = [...stack.slice(start === -1 ? stack.length : start), e];
        return true;
      }
      if (s === 0) {
        stack.push(e);
        if (visit(e.to)) return true;
        stack.pop();
      }
    }
    state.set(n, 2);
    return false;
  };

  for (const n of nodes) if ((state.get(n) ?? 0) === 0 && visit(n)) return found;
  return null;
}

/** Remove the weakest edge of each cycle until none remain. */
export function breakCycles(nodes: string[], edges: Edge[]): { kept: Edge[]; removed: RemovedEdge[] } {
  let kept = [...edges];
  const removed: RemovedEdge[] = [];
  for (let cycle = findCycle(nodes, kept); cycle; cycle = findCycle(nodes, kept)) {
    const weakest = cycle.reduce((a, b) => (b.confidence < a.confidence ? b : a));
    kept = kept.filter((e) => e !== weakest);
    removed.push({ ...weakest, reason: "cycle" });
  }
  return { kept, removed };
}

/**
 * Remove edges implied by a longer path (A→B→C makes A→C redundant), so each
 * concept lists only its direct prerequisites. Graph must be acyclic.
 */
export function transitiveReduction(nodes: string[], edges: Edge[]): { kept: Edge[]; removed: RemovedEdge[] } {
  const adj = adjacency(nodes, edges);
  const reachableAvoiding = (from: string, to: string, skip: Edge): boolean => {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length) {
      const n = queue.pop() as string;
      for (const e of adj.get(n) ?? []) {
        if (e === skip || seen.has(e.to)) continue;
        if (e.to === to) return true;
        seen.add(e.to);
        queue.push(e.to);
      }
    }
    return false;
  };
  const kept: Edge[] = [];
  const removed: RemovedEdge[] = [];
  for (const e of edges) {
    if (reachableAvoiding(e.from, e.to, e)) {
      removed.push({ ...e, reason: "redundant" });
      adj.set(e.from, (adj.get(e.from) ?? []).filter((x) => x !== e));
    } else kept.push(e);
  }
  return { kept, removed };
}

/** Level 0 = no prerequisites; otherwise one more than the deepest prerequisite. */
export function levels(nodes: string[], edges: Edge[]): Map<string, number> {
  const prereqs = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const e of edges) prereqs.get(e.to)?.push(e.from);
  const memo = new Map<string, number>();
  const level = (n: string): number => {
    const m = memo.get(n);
    if (m !== undefined) return m;
    memo.set(n, 0); // guards against cycles; callers pass a DAG
    const l = Math.max(-1, ...(prereqs.get(n) ?? []).map(level)) + 1;
    memo.set(n, l);
    return l;
  };
  for (const n of nodes) level(n);
  return memo;
}

/** Every concept that must be learned before `ids` (their prerequisites, recursively). */
export function ancestors(ids: Iterable<string>, edges: Edge[]): Set<string> {
  const prereqs = new Map<string, string[]>();
  for (const e of edges) prereqs.set(e.to, [...(prereqs.get(e.to) ?? []), e.from]);
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const n = stack.pop() as string;
    for (const p of prereqs.get(n) ?? []) {
      if (!out.has(p)) {
        out.add(p);
        stack.push(p);
      }
    }
  }
  return out;
}
