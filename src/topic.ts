import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const TopicSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  goal: z.string(),
  source: z.object({
    type: z.literal("fern-docs"),
    repo: z.string(),
    ref: z.string(),
    docsDir: z.string(),
    nav: z.string(),
    tab: z.string().default("documentation"),
    includeSections: z.array(z.string()).default([]),
    extraPages: z.array(z.string()).default([]),
  }),
  floor: z.array(z.string()).min(1),
  known: z.array(z.string()).default([]),
  expansion: z
    .object({
      maxDepth: z.number().int().min(0).default(4),
      batchSize: z.number().int().min(1).default(40),
    })
    .default({ maxDepth: 4, batchSize: 40 }),
  graph: z
    .object({ minEdgeConfidence: z.number().min(0).max(1).default(0.6) })
    .default({ minEdgeConfidence: 0.6 }),
  chapters: z
    .object({
      maxConcepts: z.number().int().min(2).default(10),
      minConcepts: z.number().int().min(1).default(3),
    })
    .default({ maxConcepts: 10, minConcepts: 3 }),
});
export type Topic = z.infer<typeof TopicSchema>;

export interface TopicPaths {
  topicFile: string;
  /** Working files that can be regenerated (not committed). */
  work: string;
  /** Committed outputs: the curriculum, mind map, graph, AI answer cache. */
  out: string;
  llmCache: string;
  sourceCheckout: string;
}

export function loadTopic(root: string, id: string): { topic: Topic; paths: TopicPaths } {
  const topicFile = path.join(root, "topics", id, "topic.yaml");
  if (!fs.existsSync(topicFile)) {
    throw new Error(`No topic file at ${topicFile}`);
  }
  const topic = TopicSchema.parse(YAML.parse(fs.readFileSync(topicFile, "utf8")));
  const work = path.join(root, ".work", id);
  const out = path.join(root, "curricula", id);
  return {
    topic,
    paths: {
      topicFile,
      work,
      out,
      llmCache: path.join(out, "llm-cache"),
      sourceCheckout: path.join(work, "source"),
    },
  };
}
