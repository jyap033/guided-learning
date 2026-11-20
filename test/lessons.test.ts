import { describe, expect, it } from "vitest";
import { buildChapterLessons, chapterContext } from "../src/pipeline/lessons.ts";
import { chapterLessonSchema } from "../src/pipeline/lessonPrompts.ts";
import { renderChapter } from "../src/render/lessons.ts";
import type { LlmProvider, LlmTask } from "../src/llm/provider.ts";
import type { Curriculum } from "../src/graph/types.ts";
import type { Page } from "../src/ingest/fern.ts";

const concept = (id: string, name: string, pages: string[] = []) => ({
  id, name, aliases: [], definition: `${name} def`, kind: "conceptual" as const, origin: "docs" as const,
  firstSeen: 0, pages, depth: 0, known: false,
});
const cur: Curriculum = {
  topic: { id: "t", name: "T", goal: "g" },
  generated: { provider: "fake", source: { repo: "r", ref: "x", pages: 2 } },
  concepts: [concept("ip", "IP"), concept("dhcp", "DHCP", ["net.md"]), concept("pxe", "PXE", ["net.md", "boot.md"])],
  edges: [{ from: "ip", to: "dhcp", confidence: 0.9, why: "", origin: "docs" }, { from: "dhcp", to: "pxe", confidence: 0.9, why: "", origin: "docs" }],
  removedEdges: [], themes: [], conceptTheme: {}, warnings: [],
  chapters: [
    { number: 1, title: "Basics", part: "F", theme: "f", concepts: ["ip"] },
    { number: 2, title: "Booting", part: "F", theme: "f", concepts: ["dhcp", "pxe"] },
  ],
};
const pages: Page[] = [
  { order: 0, title: "Net", section: [], path: "net.md", text: "n".repeat(50), hash: "" },
  { order: 1, title: "Boot", section: [], path: "boot.md", text: "b".repeat(80), hash: "" },
  { order: 2, title: "Other", section: [], path: "other.md", text: "o", hash: "" },
];

const lesson = (concept: string) => ({
  concept, prequestions: [{ question: "q?", answer: "a" }], explanation: "e", analogy: "an",
  workedExample: { title: "w", steps: [{ subgoal: "s", detail: "d" }] },
  completionProblem: { prompt: "p", partialSolution: "x ___", answer: "y" },
  independentProblem: { prompt: "p", hints: ["h"], answer: "a" }, selfExplanation: "why?",
  checks: [{ question: "c?", options: ["A1", "B1"], answer: "B1", explanation: "because" }], sources: ["net.md"],
});
const chapter = (ids: string[]) => ({
  intro: "i", objectives: ["o"], lessons: ids.map(lesson),
  buildTask: { title: "b", goal: "g", whyItMatters: "w", setup: ["s"], steps: [{ subgoal: "s", detail: "d" }], verify: "v", hints: ["h"], stretch: "st" },
});

describe("chapterContext", () => {
  it("lists prerequisites with chapter numbers, earlier coverage and relevant pages only", () => {
    const ctx = chapterContext(cur, pages, 2, 1000);
    expect(ctx.concepts.map((c) => c.id)).toEqual(["dhcp", "pxe"]);
    expect(ctx.concepts[0]?.needs).toEqual(["IP (ch. 1)"]);
    expect(ctx.alreadyCovered).toContain("IP");
    expect(ctx.pages.map((p) => p.path)).toEqual(["net.md", "boot.md"]);
    expect(chapterContext(cur, pages, 2, 60).pages.map((p) => p.path)).toEqual(["net.md"]); // size cap
  });
});

describe("chapterLessonSchema", () => {
  const schema = chapterLessonSchema(["dhcp", "pxe"], ["net.md"]);
  it("accepts one lesson per concept", () => {
    expect(schema.safeParse(chapter(["pxe", "dhcp"])).success).toBe(true);
  });
  it("rejects a missing lesson, an unknown source and a wrong multiple-choice answer", () => {
    expect(schema.safeParse(chapter(["dhcp"])).success).toBe(false);
    const badSource = chapter(["dhcp", "pxe"]);
    badSource.lessons[0]!.sources = ["made-up.md"];
    expect(schema.safeParse(badSource).success).toBe(false);
    const badAnswer = chapter(["dhcp", "pxe"]);
    badAnswer.lessons[0]!.checks[0]!.answer = "C1";
    expect(schema.safeParse(badAnswer).success).toBe(false);
  });
});

describe("buildChapterLessons", () => {
  it("rewrites once when the review finds major issues, and renders answers collapsed", async () => {
    const kinds: string[] = [];
    let reviews = 0;
    const provider: LlmProvider = {
      name: "fake",
      async complete<T>(task: LlmTask<T>): Promise<T> {
        kinds.push(task.kind);
        if (task.kind === "review") {
          reviews++;
          const issues = reviews === 1 ? [{ where: "pxe", severity: "major", problem: "wrong", fix: "fix it" }] : [];
          return task.schema.parse({ verdict: issues.length ? "major-issues" : "ok", issues });
        }
        return task.schema.parse(chapter(["pxe", "dhcp"]));
      },
    };
    const r = await buildChapterLessons(cur, pages, 2, { provider, maxPageChars: 1000 });
    expect(kinds).toEqual(["lessons", "review", "revise", "review"]);
    expect(r.revised).toBe(true);
    expect(r.lessons.lessons.map((l) => l.concept)).toEqual(["dhcp", "pxe"]); // teaching order restored
    const md = renderChapter(r, "https://docs");
    expect(md).toContain("# Chapter 2: Booting");
    expect(md).toContain("<details>");
    expect(md).toContain("**B.** B1");
    expect(md).toContain("[net.md](https://docs/net.md)");
    expect(md).toContain("rewritten using the review");
  });
});
