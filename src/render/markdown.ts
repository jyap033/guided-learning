import type { Concept, Curriculum } from "../graph/types.ts";
import { renderMindmap } from "./mindmap.ts";

function index(cur: Curriculum) {
  const byId = new Map(cur.concepts.map((c) => [c.id, c]));
  const prereqs = new Map<string, string[]>();
  const unlocks = new Map<string, string[]>();
  for (const e of cur.edges) {
    prereqs.set(e.to, [...(prereqs.get(e.to) ?? []), e.from]);
    unlocks.set(e.from, [...(unlocks.get(e.from) ?? []), e.to]);
  }
  const chapterOf = new Map<string, number>();
  for (const ch of cur.chapters) for (const id of ch.concepts) chapterOf.set(id, ch.number);
  return { byId, prereqs, unlocks, chapterOf };
}

const originLabel = (c: Concept) =>
  c.origin === "docs" ? "from the docs" : c.origin === "prerequisite" ? `background, ${c.depth} level${c.depth > 1 ? "s" : ""} below the docs` : "starting knowledge";

/** The curriculum as a readable Markdown file. */
/** `docsBase` is the URL that docs page paths are relative to. */
export function renderCurriculum(cur: Curriculum, docsBase: string): string {
  const { byId, prereqs, unlocks, chapterOf } = index(cur);
  const name = (id: string) => byId.get(id)?.name ?? id;
  const link = (id: string) => {
    const ch = chapterOf.get(id);
    return ch ? `${name(id)} (ch. ${ch})` : name(id);
  };
  const floor = cur.concepts.filter((c) => c.origin === "floor");
  const known = cur.concepts.filter((c) => c.known && c.origin !== "floor");
  const taught = cur.chapters.reduce((n, ch) => n + ch.concepts.length, 0);

  const out: string[] = [];
  out.push(`# ${cur.topic.name}: curriculum`, "");
  out.push(`**Goal:** ${cur.topic.goal}`, "");
  out.push(
    `${cur.chapters.length} chapters, ${taught} concepts, ordered so that every concept comes after its prerequisites. ` +
      `Generated from ${cur.generated.source.pages} docs pages of [${cur.generated.source.repo.replace("https://github.com/", "")}](${cur.generated.source.repo}) ` +
      `at \`${cur.generated.source.ref.slice(0, 12)}\` by \`${cur.generated.provider}\`. See [mindmap.md](./mindmap.md) for the overview and [report.md](./report.md) for checks.`,
    "",
  );
  out.push("> This is AI-generated and not yet reviewed. Definitions are summaries: check them against the linked docs pages.", "");
  out.push(`**Assumed starting knowledge:** ${floor.map((c) => c.name).join("; ")}.`, "");
  if (known.length) out.push(`**Skipped because you know them:** ${known.map((c) => c.name).join(", ")}.`, "");

  out.push("## Chapters", "");
  for (const ch of cur.chapters) out.push(`${ch.number}. [${ch.title}](#chapter-${ch.number}) (${ch.concepts.length})`);
  out.push("");

  for (const ch of cur.chapters) {
    out.push(`<a id="chapter-${ch.number}"></a>`, `## Chapter ${ch.number}: ${ch.title}`, "");
    const needs = new Set<number>();
    for (const id of ch.concepts) for (const p of prereqs.get(id) ?? []) {
      const n = chapterOf.get(p);
      if (n && n !== ch.number) needs.add(n);
    }
    if (needs.size) out.push(`Builds on chapters ${[...needs].sort((a, b) => a - b).join(", ")}.`, "");
    for (const id of ch.concepts) {
      const c = byId.get(id) as Concept;
      out.push(`### ${c.name}`, "");
      out.push(`${c.definition || "_No definition yet._"}`, "");
      const meta = [`*${c.kind}*`, originLabel(c)];
      if (c.aliases.length) meta.push(`also called ${c.aliases.slice(0, 4).join(", ")}`);
      out.push(meta.join(" · "), "");
      const pre = prereqs.get(id) ?? [];
      if (pre.length) out.push(`- **Needs:** ${pre.map(link).join(", ")}`);
      const un = unlocks.get(id) ?? [];
      if (un.length) out.push(`- **Unlocks:** ${un.map(link).join(", ")}`);
      if (c.pages.length) {
        out.push(`- **Docs:** ${c.pages.slice(0, 5).map((p) => `[${p}](${docsBase}/${p})`).join(", ")}`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}

export function renderMindmapFile(cur: Curriculum, rootName: string): string {
  const mapped = cur.concepts.filter((c) => c.origin !== "floor");
  const chapterOf = index(cur).chapterOf;
  const full = renderMindmap(rootName, cur.themes, mapped, cur.conceptTheme, {
    status: (c) => (c.known ? "✓" : chapterOf.has(c.id) ? `· ch ${chapterOf.get(c.id)}` : undefined),
  });
  const overview = renderMindmap(rootName, cur.themes, [], cur.conceptTheme);
  return [
    `# ${cur.topic.name}: mind map`,
    "",
    "The whole topic grouped by theme (D-022). GitHub draws these diagrams; elsewhere, paste a block into <https://mermaid.live>.",
    "",
    "## Themes",
    "",
    "```mermaid",
    overview,
    "```",
    "",
    "## Everything",
    "",
    "Each concept shows the chapter that teaches it; ✓ means you already know it.",
    "",
    "```mermaid",
    full,
    "```",
    "",
  ].join("\n");
}

export function renderReport(cur: Curriculum): string {
  const by = (o: string) => cur.concepts.filter((c) => c.origin === o).length;
  const reasons = new Map<string, number>();
  for (const e of cur.removedEdges) reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);
  const depthCounts = new Map<number, number>();
  for (const c of cur.concepts) if (c.origin === "prerequisite") depthCounts.set(c.depth, (depthCounts.get(c.depth) ?? 0) + 1);
  const name = new Map(cur.concepts.map((c) => [c.id, c.name]));
  const out = [
    `# ${cur.topic.name}: build report`,
    "",
    "## Counts",
    "",
    "| | |",
    "|---|---|",
    `| Docs pages read | ${cur.generated.source.pages} |`,
    `| Concepts from the docs | ${by("docs")} |`,
    `| Background concepts below the docs | ${by("prerequisite")} (${[...depthCounts].sort().map(([d, n]) => `depth ${d}: ${n}`).join(", ")}) |`,
    `| Starting knowledge | ${by("floor")} |`,
    `| Prerequisite links kept | ${cur.edges.length} |`,
    `| Links removed | ${cur.removedEdges.length} (${[...reasons].map(([r, n]) => `${r}: ${n}`).join(", ") || "none"}) |`,
    `| Mind map themes | ${cur.themes.length} |`,
    `| Chapters | ${cur.chapters.length} |`,
    "",
    "## Checks passed",
    "",
    "- The prerequisite graph has no cycles.",
    "- Every taught concept is in exactly one chapter.",
    "- No concept is taught before any of its prerequisites.",
    "",
    "## Warnings",
    "",
    ...(cur.warnings.length ? cur.warnings.map((w) => `- ${w}`) : ["None."]),
    "",
    "## Links removed to break cycles",
    "",
    ...cycleLines(cur, name),
    "",
  ];
  return out.join("\n");
}

function cycleLines(cur: Curriculum, name: Map<string, string>): string[] {
  const lines = cur.removedEdges
    .filter((e) => e.reason === "cycle")
    .map((e) => `- ${name.get(e.from)} → ${name.get(e.to)} (confidence ${e.confidence}): ${e.why}`);
  return lines.length ? lines : ["None."];
}
