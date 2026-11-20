import { describe, expect, it } from "vitest";
import { buildCurriculum } from "../src/pipeline/build.ts";
import { TopicSchema } from "../src/topic.ts";
import type { LlmProvider, LlmTask } from "../src/llm/provider.ts";
import type { Page } from "../src/ingest/fern.ts";

/** Fake AI: canned answers per pipeline step, validated by the real schemas. */
class FakeProvider implements LlmProvider {
  name = "fake";
  async complete<T>(task: LlmTask<T>): Promise<T> {
    const answers: Record<string, unknown> = {
      extract: {
        concepts: [
          { name: "ManagedHost", aliases: [], definition: "A host plus its DPUs.", kind: "conceptual", role: "explained", pages: ["b.md"] },
          { name: "Data Processing Unit (DPU)", aliases: ["BlueField"], definition: "A NIC with its own CPU.", kind: "conceptual", role: "assumed", pages: ["a.md"] },
          { name: "Baseboard Management Controller (BMC)", aliases: [], definition: "Out-of-band controller.", kind: "conceptual", role: "assumed", pages: ["a.md"] },
          { name: "DPUs", aliases: [], definition: "", kind: "conceptual", role: "assumed", pages: ["b.md"] },
        ],
        prerequisites: [
          { concept: "ManagedHost", requires: "DPU", confidence: 0.9, why: "a ManagedHost contains DPUs" },
          { concept: "ManagedHost", requires: "BMC", confidence: 0.8, why: "hosts are managed via BMC" },
          { concept: "DPU", requires: "ManagedHost", confidence: 0.85, why: "bad reverse edge" },
          { concept: "ManagedHost", requires: "Nonexistent", confidence: 0.9, why: "unresolved" },
        ],
      },
      dedupe: { groups: [] },
      expand: {
        results: [
          { concept: "Data Processing Unit (DPU)", prerequisites: [{ name: "Network Interface Card (NIC)", definition: "Network card.", kind: "conceptual", confidence: 0.9, why: "a DPU is a smart NIC" }] },
          { concept: "Baseboard Management Controller (BMC)", prerequisites: [{ name: "Basic use of a terminal", definition: "", kind: "procedural", confidence: 0.9, why: "floor" }] },
          { concept: "Network Interface Card (NIC)", prerequisites: [] },
        ],
      },
      themes: {
        themes: [
          { id: "hardware", name: "Hardware", parent: null },
          { id: "nico", name: "NICo", parent: null },
        ],
        assignments: [
          { concept: "managedhost", theme: "nico" },
          { concept: "data-processing-unit", theme: "hardware" },
          { concept: "baseboard-management-controller", theme: "hardware" },
        ],
      },
    };
    return task.schema.parse(answers[task.kind]);
  }
}

const topic = TopicSchema.parse({
  id: "t", name: "Test topic", goal: "g",
  source: { type: "fern-docs", repo: "r", ref: "x", docsDir: "docs", nav: "docs/index.yml" },
  floor: ["Basic use of a terminal"],
  expansion: { maxDepth: 3, batchSize: 10 },
  chapters: { maxConcepts: 10, minConcepts: 1 },
});
const pages: Page[] = [
  { order: 0, title: "A", section: [], path: "a.md", text: "a", hash: "" },
  { order: 1, title: "B", section: [], path: "b.md", text: "b", hash: "" },
];

describe("buildCurriculum (fake AI)", () => {
  it("merges duplicates, expands prerequisites, stops at the floor and orders chapters", async () => {
    const cur = await buildCurriculum(topic, pages, { provider: new FakeProvider(), concurrency: 2, batchChars: 1000, log: () => {} });
    const names = cur.concepts.map((c) => c.name).sort();
    expect(names).toEqual([
      "Baseboard Management Controller (BMC)", "Basic use of a terminal", "Data Processing Unit (DPU)", "ManagedHost", "Network Interface Card (NIC)",
    ]);
    const nic = cur.concepts.find((c) => c.name.startsWith("Network Interface"));
    expect(nic?.origin).toBe("prerequisite");
    expect(nic?.depth).toBe(1);
    // the reverse DPU -> ManagedHost edge is close in confidence, so both directions are dropped
    expect(cur.edges.some((e) => e.from === "data-processing-unit" && e.to === "managedhost")).toBe(false);
    expect(cur.edges.some((e) => e.from === "managedhost")).toBe(false);
    // NIC was not themed by the fake, so it lands in Other
    expect(cur.conceptTheme["network-interface-card"]).toBe("other");
    const order = cur.chapters.flatMap((c) => c.concepts);
    expect(order.indexOf("network-interface-card")).toBeLessThan(order.indexOf("data-processing-unit"));
    expect(order).not.toContain("basic-use-of-a-terminal");
    expect(cur.warnings.join(" ")).toMatch(/weren't in the list/);
  });
});
