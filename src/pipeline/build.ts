import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Topic, TopicPaths } from "../topic.ts";
import { batchPages, loadFernPages, type Page } from "../ingest/fern.ts";
import { mapLimit, type LlmProvider } from "../llm/provider.ts";
import { ConceptRegistry } from "../graph/registry.ts";
import { ancestors, breakCycles, cleanEdges, levels, transitiveReduction } from "../graph/dag.ts";
import { validateThemes } from "../graph/themes.ts";
import { buildChapters, validateChapters } from "../graph/chapters.ts";
import type { Curriculum, Edge, RemovedEdge } from "../graph/types.ts";
import { dedupeTask, expandTask, extractTask, themesTask } from "./prompts.ts";

export interface BuildOptions {
  provider: LlmProvider;
  concurrency: number;
  /** Characters of docs text per extraction call. */
  batchChars: number;
  log: (msg: string) => void;
}

/** Check out the pinned docs source into the work dir (shallow, one commit). */
export function fetchSource(topic: Topic, paths: TopicPaths, log: (m: string) => void): void {
  const dir = paths.sourceCheckout;
  const head = (): string | null => {
    try {
      return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  if (head() === topic.source.ref) return;
  log(`fetching ${topic.source.repo} @ ${topic.source.ref.slice(0, 12)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "inherit" });
  git("init", "-q");
  git("remote", "add", "origin", topic.source.repo);
  git("fetch", "-q", "--depth", "1", "origin", topic.source.ref);
  git("checkout", "-q", "FETCH_HEAD");
}

export function ingest(topic: Topic, paths: TopicPaths): Page[] {
  const root = paths.sourceCheckout;
  const docsRoot = path.join(root, topic.source.docsDir);
  const pages = loadFernPages({
    docsRoot,
    navFile: path.join(root, topic.source.nav),
    tab: topic.source.tab,
    includeSections: topic.source.includeSections,
    extraPages: topic.source.extraPages,
  });
  if (pages.length === 0) throw new Error("no docs pages found; check source.nav and includeSections");
  return pages;
}

export async function buildCurriculum(topic: Topic, pages: Page[], opts: BuildOptions): Promise<Curriculum> {
  const { provider, log } = opts;
  const warnings: string[] = [];
  const reg = new ConceptRegistry();
  const pageOrder = new Map(pages.map((p) => [p.path, p.order]));
  /** Concept ids merged away, so edges recorded earlier can be re-pointed. */
  const mergedInto = new Map<string, string>();
  const resolve = (id: string): string => {
    let cur = id;
    for (let next = mergedInto.get(cur); next; next = mergedInto.get(cur)) cur = next;
    return cur;
  };
  const rawEdges: Edge[] = [];

  // 1. Extract concepts and prerequisite links from the docs, batch by batch.
  const batches = batchPages(pages, opts.batchChars);
  log(`extract: ${pages.length} pages in ${batches.length} batches`);
  const extracted = await mapLimit(batches, opts.concurrency, (b) => provider.complete(extractTask(topic.name, b)));
  let unresolved = 0;
  for (const result of extracted) {
    for (const c of result.concepts) {
      const seen = c.pages.map((p) => pageOrder.get(p)).filter((n): n is number => n !== undefined);
      reg.add({
        name: c.name,
        aliases: c.aliases,
        definition: c.definition,
        kind: c.kind,
        origin: "docs",
        firstSeen: seen.length ? Math.min(...seen) : undefined,
        pages: c.pages.filter((p) => pageOrder.has(p)),
        depth: 0,
      });
    }
    for (const p of result.prerequisites) {
      const to = reg.find(p.concept);
      const from = reg.find(p.requires);
      if (!to || !from) {
        unresolved++;
        continue;
      }
      rawEdges.push({ from: from.id, to: to.id, confidence: p.confidence, why: p.why, origin: "docs" });
    }
  }
  if (unresolved) warnings.push(`${unresolved} extracted prerequisite link(s) named concepts that weren't in the list; skipped`);
  log(`extract: ${reg.size} concepts, ${rawEdges.length} links`);

  // 2. AI pass for duplicates the name matcher missed.
  const dedupe = async (label: string) => {
    const list = reg.all().filter((c) => c.origin !== "floor");
    const result = await provider.complete(
      dedupeTask(topic.name, list.map((c) => ({ id: c.id, name: c.name, definition: c.definition }))),
    );
    let n = 0;
    for (const g of result.groups) {
      const keep = resolve(g.keep);
      if (!reg.get(keep)) continue;
      for (const m of g.merge) {
        const drop = resolve(m);
        if (drop === keep || !reg.get(drop)) continue;
        reg.absorb(keep, drop);
        mergedInto.set(drop, keep);
        n++;
      }
    }
    log(`dedupe (${label}): merged ${n}, ${reg.size} concepts`);
  };
  await dedupe("docs");

  // 3. Starting knowledge, then expand prerequisites below the docs.
  const floorIds = new Set(topic.floor.map((name) => reg.add({ name, origin: "floor", depth: 0 })));
  let frontier = reg.all().filter((c) => c.origin === "docs");
  for (let depth = 0; depth < topic.expansion.maxDepth && frontier.length; depth++) {
    const chunks: (typeof frontier)[] = [];
    for (let i = 0; i < frontier.length; i += topic.expansion.batchSize) chunks.push(frontier.slice(i, i + topic.expansion.batchSize));
    log(`expand depth ${depth + 1}: ${frontier.length} concepts in ${chunks.length} calls`);
    const existingNames = reg.all().map((c) => c.name);
    const results = await mapLimit(chunks, opts.concurrency, (chunk) =>
      provider.complete(
        expandTask({
          topicName: topic.name,
          floor: topic.floor,
          concepts: chunk.map((c) => ({ name: c.name, definition: c.definition })),
          existingNames,
        }),
      ),
    );
    const before = new Set(reg.all().map((c) => c.id));
    for (const r of results) {
      for (const res of r.results) {
        const target = reg.find(res.concept);
        if (!target) continue;
        for (const p of res.prerequisites) {
          const id = reg.add({ name: p.name, definition: p.definition, kind: p.kind, origin: "prerequisite", depth: depth + 1 });
          if (floorIds.has(id)) continue;
          rawEdges.push({ from: id, to: target.id, confidence: p.confidence, why: p.why, origin: "expansion" });
        }
      }
    }
    frontier = reg.all().filter((c) => !before.has(c.id) && c.origin === "prerequisite");
  }
  if (frontier.length) {
    warnings.push(`expansion stopped at depth ${topic.expansion.maxDepth}; ${frontier.length} concept(s) were not expanded further`);
  }
  await dedupe("all");

  // 4. Clean the graph: drop weak/ambiguous edges, break cycles, remove redundant edges.
  const floorSet = new Set([...floorIds].map(resolve));
  const nodes = reg.all().map((c) => c.id);
  const edges0 = rawEdges
    .map((e) => ({ ...e, from: resolve(e.from), to: resolve(e.to) }))
    .filter((e) => !floorSet.has(e.from) && !floorSet.has(e.to));
  const removed: RemovedEdge[] = [];
  const cleaned = cleanEdges(edges0, topic.graph.minEdgeConfidence);
  removed.push(...cleaned.removed);
  const acyclic = breakCycles(nodes, cleaned.kept);
  removed.push(...acyclic.removed);
  const reduced = transitiveReduction(nodes, acyclic.kept);
  removed.push(...reduced.removed);
  const edges = reduced.kept;
  const cycles = acyclic.removed.length;
  if (cycles) warnings.push(`${cycles} edge(s) removed to break prerequisite cycles`);

  // 5. Known concepts: knowing something implies knowing its prerequisites.
  const knownIds = new Set<string>();
  for (const name of topic.known) {
    const c = reg.find(name);
    if (c) knownIds.add(c.id);
    else warnings.push(`known concept "${name}" is not in the graph`);
  }
  for (const id of ancestors(knownIds, edges)) knownIds.add(id);
  for (const c of reg.all()) c.known = knownIds.has(c.id);

  // 6. Mind map themes for everything except the starting knowledge.
  const mapped = reg.all().filter((c) => !floorSet.has(c.id));
  const proposal = await provider.complete(
    themesTask(topic.name, mapped.map((c) => ({ id: c.id, name: c.name, definition: c.definition }))),
  );
  const themed = validateThemes(proposal, mapped.map((c) => c.id), { maxDepth: 3, maxChildren: 7 });
  warnings.push(...themed.warnings);

  // 7. Chapters: everything that isn't starting knowledge or already known.
  const teach = mapped.filter((c) => !c.known).map((c) => c.id);
  const chapters = buildChapters({
    ids: teach,
    edges,
    level: levels(nodes, edges),
    firstSeen: new Map(reg.all().map((c) => [c.id, c.firstSeen])),
    conceptTheme: themed.conceptTheme,
    themes: themed.themes,
    maxConcepts: topic.chapters.maxConcepts,
    minConcepts: topic.chapters.minConcepts,
  });
  const problems = validateChapters(chapters, teach, edges);
  if (problems.length) throw new Error(`chapter order is invalid:\n${problems.join("\n")}`);

  return {
    topic: { id: topic.id, name: topic.name, goal: topic.goal },
    generated: { provider: provider.name, source: { repo: topic.source.repo, ref: topic.source.ref, pages: pages.length } },
    concepts: reg.all().sort((a, b) => a.firstSeen - b.firstSeen || a.name.localeCompare(b.name)),
    edges,
    removedEdges: removed,
    themes: themed.themes,
    conceptTheme: themed.conceptTheme,
    chapters,
    warnings,
  };
}
