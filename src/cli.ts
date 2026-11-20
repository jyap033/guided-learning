#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { loadTopic } from "./topic.ts";
import { CachedProvider, mapLimit, type LlmProvider } from "./llm/provider.ts";
import { ClaudeCodeProvider } from "./llm/claudeCode.ts";
import { AnthropicProvider } from "./llm/anthropic.ts";
import { buildCurriculum, fetchSource, ingest } from "./pipeline/build.ts";
import { renderCurriculum, renderMindmapFile, renderReport } from "./render/markdown.ts";
import { buildChapterLessons } from "./pipeline/lessons.ts";
import { chapterFileName, renderChapter } from "./render/lessons.ts";
import type { Curriculum } from "./graph/types.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (msg: string) => process.stderr.write(`[gl] ${msg}\n`);

const program = new Command()
  .name("gl")
  .description("Guided Learning: turn a topic's docs into a concept map, mind map and chapters.");

program
  .command("build")
  .description("Build the curriculum for a topic (topics/<id>/topic.yaml) into curricula/<id>/")
  .argument("<topic>", "topic id, e.g. nico")
  .option("--provider <name>", "claude-code (uses your Claude login) or anthropic-api (needs ANTHROPIC_API_KEY)", "claude-code")
  .option("--model <id>", "model to use (default: the provider's default)")
  .option("--concurrency <n>", "AI calls in parallel", "3")
  .option("--batch-chars <n>", "docs characters per extraction call", "90000")
  .action(async (id: string, o: { provider: string; model?: string; concurrency: string; batchChars: string }) => {
    const { topic, paths } = loadTopic(root, id);
    const provider = makeProvider(o, paths.llmCache);

    fetchSource(topic, paths, log);
    const pages = ingest(topic, paths);
    const cur = await buildCurriculum(topic, pages, {
      provider,
      concurrency: Number(o.concurrency),
      batchChars: Number(o.batchChars),
      log,
    });

    fs.mkdirSync(paths.out, { recursive: true });
    const docsBase = `${topic.source.repo}/blob/${topic.source.ref}/${topic.source.docsDir}`;
    const shortName = topic.name.replace(/\s*\(.*\)\s*$/, "");
    fs.writeFileSync(path.join(paths.out, "graph.json"), JSON.stringify(cur, null, 2) + "\n");
    fs.writeFileSync(path.join(paths.out, "curriculum.md"), renderCurriculum(cur, docsBase));
    fs.writeFileSync(path.join(paths.out, "mindmap.md"), renderMindmapFile(cur, shortName));
    fs.writeFileSync(path.join(paths.out, "report.md"), renderReport(cur));
    log(`done: ${cur.chapters.length} chapters, ${cur.concepts.length} concepts → ${path.relative(root, paths.out)}/`);
    const pruned = provider.pruneUnused(["extract", "dedupe", "expand", "themes"]);
    log(`AI calls: ${provider.calls} new, ${provider.hits} from cache${pruned ? `; removed ${pruned} stale cache entries` : ""}`);
    for (const w of cur.warnings) log(`warning: ${w}`);
  });

function makeProvider(o: { provider: string; model?: string }, cacheDir: string): CachedProvider {
  let inner: LlmProvider;
  if (o.provider === "claude-code") inner = new ClaudeCodeProvider({ model: o.model });
  else if (o.provider === "anthropic-api") inner = new AnthropicProvider({ model: o.model });
  else throw new Error(`unknown provider "${o.provider}"`);
  return new CachedProvider(inner, cacheDir, log);
}

/** Parse "1-3,5" into [1, 2, 3, 5]. */
export function parseRange(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [a, b] = part.split("-").map((x) => Number(x.trim()));
    if (!a || (b !== undefined && !b)) throw new Error(`bad chapter range "${spec}"`);
    for (let n = a; n <= (b ?? a); n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

program
  .command("lessons")
  .description("Write lessons, checks and a build task for chapters of a built curriculum")
  .argument("<topic>", "topic id, e.g. nico")
  .requiredOption("--chapters <range>", "chapters to write, e.g. 1-3 or 1,4")
  .option("--provider <name>", "claude-code or anthropic-api", "claude-code")
  .option("--model <id>", "model to use")
  .option("--concurrency <n>", "chapters in parallel", "2")
  .option("--page-chars <n>", "docs characters given per chapter", "120000")
  .action(async (id: string, o: { chapters: string; provider: string; model?: string; concurrency: string; pageChars: string }) => {
    const { topic, paths } = loadTopic(root, id);
    const graphFile = path.join(paths.out, "graph.json");
    if (!fs.existsSync(graphFile)) throw new Error(`no ${path.relative(root, graphFile)}; run "gl build ${id}" first`);
    const cur = JSON.parse(fs.readFileSync(graphFile, "utf8")) as Curriculum;
    const provider = makeProvider(o, paths.llmCache);
    fetchSource(topic, paths, log);
    const pages = ingest(topic, paths);
    const docsBase = `${topic.source.repo}/blob/${topic.source.ref}/${topic.source.docsDir}`;
    const numbers = parseRange(o.chapters);
    const files = new Map(cur.chapters.map((c) => [c.number, chapterFileName(c.number, c.title)]));
    const outDir = path.join(paths.out, "chapters");
    fs.mkdirSync(outDir, { recursive: true });

    await mapLimit(numbers, Number(o.concurrency), async (n) => {
      log(`chapter ${n}: writing`);
      const result = await buildChapterLessons(cur, pages, n, { provider, maxPageChars: Number(o.pageChars) });
      const file = files.get(n) as string;
      fs.writeFileSync(path.join(outDir, file), renderChapter(result, docsBase, { prev: files.get(n - 1), next: files.get(n + 1) }));
      fs.writeFileSync(path.join(outDir, file.replace(/\.md$/, ".json")), JSON.stringify(result.lessons, null, 2) + "\n");
      const major = result.review.issues.filter((i) => i.severity === "major").length;
      log(`chapter ${n}: done (${result.review.verdict}${result.revised ? ", rewritten once" : ""}, ${major} major / ${result.review.issues.length - major} minor issues left) → ${file}`);
    });
    log(`AI calls: ${provider.calls} new, ${provider.hits} from cache`);
  });

program.parseAsync().catch((err: unknown) => {
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
