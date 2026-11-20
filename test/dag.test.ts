import { describe, expect, it } from "vitest";
import { ancestors, breakCycles, cleanEdges, findCycle, levels, transitiveReduction } from "../src/graph/dag.ts";
import type { Edge } from "../src/graph/types.ts";

const e = (from: string, to: string, confidence = 0.9): Edge => ({ from, to, confidence, why: "", origin: "docs" });

describe("cleanEdges", () => {
  it("drops self-loops and weak edges, keeps the strongest duplicate", () => {
    const { kept, removed } = cleanEdges([e("a", "a"), e("a", "b", 0.3), e("b", "c", 0.7), e("b", "c", 0.9)], 0.6);
    expect(kept).toEqual([e("b", "c", 0.9)]);
    expect(removed.map((r) => r.reason).sort()).toEqual(["low-confidence", "self-loop"]);
  });
  it("keeps the clearly stronger direction of a two-way pair", () => {
    const { kept, removed } = cleanEdges([e("a", "b", 0.95), e("b", "a", 0.65)], 0.6);
    expect(kept).toEqual([e("a", "b", 0.95)]);
    expect(removed).toHaveLength(1);
  });
  it("drops both directions when they are about equally confident", () => {
    const { kept, removed } = cleanEdges([e("a", "b", 0.8), e("b", "a", 0.75)], 0.6);
    expect(kept).toEqual([]);
    expect(removed).toHaveLength(2);
  });
});

describe("cycles", () => {
  it("finds and breaks a cycle at its weakest edge", () => {
    const edges = [e("a", "b", 0.9), e("b", "c", 0.7), e("c", "a", 0.8), e("c", "d")];
    expect(findCycle(["a", "b", "c", "d"], edges)).toHaveLength(3);
    const { kept, removed } = breakCycles(["a", "b", "c", "d"], edges);
    expect(removed.map((r) => `${r.from}>${r.to}`)).toEqual(["b>c"]);
    expect(findCycle(["a", "b", "c", "d"], kept)).toBeNull();
  });
  it("returns null for a DAG", () => {
    expect(findCycle(["a", "b", "c"], [e("a", "b"), e("a", "c"), e("b", "c")])).toBeNull();
  });
});

describe("transitiveReduction", () => {
  it("removes an edge implied by a longer path", () => {
    const { kept, removed } = transitiveReduction(["a", "b", "c"], [e("a", "b"), e("b", "c"), e("a", "c")]);
    expect(kept.map((x) => `${x.from}>${x.to}`)).toEqual(["a>b", "b>c"]);
    expect(removed[0]?.reason).toBe("redundant");
  });
});

describe("levels and ancestors", () => {
  const edges = [e("a", "b"), e("b", "c"), e("x", "c")];
  it("levels count the longest prerequisite chain", () => {
    expect(Object.fromEntries(levels(["a", "b", "c", "x"], edges))).toEqual({ a: 0, b: 1, c: 2, x: 0 });
  });
  it("ancestors are all prerequisites, recursively", () => {
    expect([...ancestors(["c"], edges)].sort()).toEqual(["a", "b", "x"]);
  });
});
