#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { loadTopic } from "./topic.ts";
import { CachedProvider, type LlmProvider } from "./llm/provider.ts";
import { ClaudeCodeProvider } from "./llm/claudeCode.ts";
import { AnthropicProvider } from "./llm/anthropic.ts";
import { buildCurriculum, fetchSource, ingest } from "./pipeline/build.ts";
import { renderCurriculum, renderMindmapFile, renderReport } from "./render/markdown.ts";

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
    let inner: LlmProvider;
    if (o.provider === "claude-code") inner = new ClaudeCodeProvider({ model: o.model });
    else if (o.provider === "anthropic-api") inner = new AnthropicProvider({ model: o.model });
    else throw new Error(`unknown provider "${o.provider}"`);
    const provider = new CachedProvider(inner, paths.llmCache, log);

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
    log(`AI calls: ${provider.calls} new, ${provider.hits} from cache`);
    for (const w of cur.warnings) log(`warning: ${w}`);
  });

program.parseAsync().catch((err: unknown) => {
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
