import { z } from "zod";
import type { LlmTask } from "../llm/provider.ts";
import type { Page } from "../ingest/fern.ts";

const Kind = z.enum(["procedural", "conceptual"]);
const Confidence = z.number().min(0).max(1);

// ---------- 1. Extract concepts from docs pages ----------

export const ExtractSchema = z.object({
  concepts: z.array(
    z.object({
      name: z.string().describe("Canonical name, e.g. 'Baseboard Management Controller (BMC)'"),
      aliases: z.array(z.string()).describe("Other names or abbreviations used for it"),
      definition: z.string().describe("One or two plain-language sentences a newcomer can follow"),
      kind: Kind.describe("procedural = a how-to skill; conceptual = an idea to understand"),
      role: z
        .enum(["explained", "assumed"])
        .describe("explained = these pages teach it; assumed = used without being explained"),
      pages: z.array(z.string()).describe("Paths of the given pages that use it"),
    }),
  ),
  prerequisites: z.array(
    z.object({
      concept: z.string().describe("Name of a concept from the list above"),
      requires: z.string().describe("Name of a concept from the list above that must be understood first"),
      confidence: Confidence,
      why: z.string().describe("Short reason"),
    }),
  ),
});
export type ExtractResult = z.infer<typeof ExtractSchema>;

const EXTRACT_SYSTEM = `You build learning curricula from technical documentation.

You will be given a batch of documentation pages for a topic. Identify the concepts a learner must understand to follow these pages, and the prerequisite relations between them.

Rules:
- A concept is one teachable idea or skill (e.g. "PXE boot", "Redfish API", "Kubernetes operator", "ManagedHost"). Not a whole product area, and not a single config flag unless it is central.
- Include both concepts the pages explain and concepts they use without explaining ("assumed"). Assumed concepts are the most important output: they are the hidden prerequisites that make docs hard for newcomers. Look for terms, acronyms and technologies used without definition.
- Prefer general industry names for general concepts ("DHCP", "TLS certificate") and the docs' own names for topic-specific ones.
- Skip trivial ideas any working software engineer knows (what a file is, what a server is) unless the pages rely on a specific aspect of them.
- Prerequisites: "requires" means a learner cannot properly understand the concept without first understanding the other one. Only list direct, clear dependencies, both drawn from your concept list. Do not list "related" or "part of" relations as prerequisites. Use confidence below 0.6 for anything you are unsure of.
- Definitions must be accurate and based on the pages where possible. Write them for a newcomer.
- Typically 15-60 concepts per batch.`;

export function extractTask(topicName: string, pages: Page[]): LlmTask<ExtractResult> {
  const body = pages
    .map((p) => `<page path="${p.path}" title="${p.title}" section="${p.section.join(" > ")}">\n${p.text}\n</page>`)
    .join("\n\n");
  return {
    kind: "extract",
    promptVersion: "1",
    system: EXTRACT_SYSTEM,
    user: `Topic: ${topicName}\n\nDocumentation pages (in the docs' reading order):\n\n${body}`,
    schema: ExtractSchema,
  };
}

// ---------- 2. Merge duplicates the name matcher missed ----------

export const DedupeSchema = z.object({
  groups: z.array(
    z.object({
      keep: z.string().describe("id of the concept to keep"),
      merge: z.array(z.string()).describe("ids of concepts that are the same idea as `keep`"),
    }),
  ),
});
export type DedupeResult = z.infer<typeof DedupeSchema>;

export function dedupeTask(topicName: string, concepts: { id: string; name: string; definition: string }[]): LlmTask<DedupeResult> {
  return {
    kind: "dedupe",
    promptVersion: "1",
    system: `You clean up a list of concepts for a curriculum about ${topicName}. Find concepts that are the same idea under different names (synonyms, abbreviations, singular/plural, a product name and its generic description). Only merge true duplicates: a broader concept and a narrower one (e.g. "Networking" and "VLAN") are NOT duplicates. Return only groups that need merging; an empty list is fine.`,
    user: concepts.map((c) => `${c.id}\t${c.name}\t${c.definition}`).join("\n"),
    schema: DedupeSchema,
  };
}

// ---------- 3. Expand prerequisites below the docs ----------

export const ExpandSchema = z.object({
  results: z.array(
    z.object({
      concept: z.string().describe("The concept name exactly as given"),
      prerequisites: z.array(
        z.object({
          name: z.string(),
          definition: z.string().describe("One or two plain-language sentences"),
          kind: Kind,
          confidence: Confidence,
          why: z.string(),
        }),
      ),
    }),
  ),
});
export type ExpandResult = z.infer<typeof ExpandSchema>;

export function expandTask(input: {
  topicName: string;
  floor: string[];
  concepts: { name: string; definition: string }[];
  existingNames: string[];
}): LlmTask<ExpandResult> {
  return {
    kind: "expand",
    promptVersion: "1",
    system: `You map the prerequisite knowledge needed to learn ${input.topicName}.

For each concept you are given, list its DIRECT prerequisites: the concepts a learner must already understand before this one makes sense. Think like a teacher planning the order of lessons.

Rules:
- Only direct prerequisites (usually 0-4). If A needs B and B needs C, list only B for A.
- Stop at the learner's starting knowledge. The learner already knows: ${input.floor.join("; ")}. Never list those, or anything more basic, as prerequisites. A concept that needs nothing beyond that starting knowledge gets an empty list.
- Reuse an existing concept name when it fits (exact spelling). Existing names are listed in the message.
- Prerequisites must be genuinely required, not just related. Use confidence below 0.6 when unsure.
- Return one result per given concept, using the concept name exactly as given.`,
    user: `Existing concept names:\n${input.existingNames.join("\n")}\n\nConcepts to expand:\n${input.concepts
      .map((c) => `- ${c.name}: ${c.definition}`)
      .join("\n")}`,
    schema: ExpandSchema,
  };
}

// ---------- 4. Group concepts into a mind map ----------

export const ThemesSchema = z.object({
  themes: z.array(
    z.object({
      id: z.string().describe("short kebab-case id"),
      name: z.string(),
      parent: z.string().nullable().describe("id of the parent theme, or null for a top-level theme"),
    }),
  ),
  assignments: z.array(z.object({ concept: z.string().describe("concept id"), theme: z.string().describe("theme id") })),
});
export type ThemesResult = z.infer<typeof ThemesSchema>;

export function themesTask(topicName: string, concepts: { id: string; name: string; definition: string }[]): LlmTask<ThemesResult> {
  return {
    kind: "themes",
    promptVersion: "1",
    system: `You organise the concepts of a curriculum about ${topicName} into a mind map: a tree of themes, with every concept placed in exactly one theme.

Rules:
- 6-10 top-level themes that a newcomer would recognise (e.g. "Networking", "Kubernetes", "Security"), ordered from foundational to topic-specific. Topic-specific concepts get their own themes.
- Use sub-themes (parent = a top-level theme id) to keep every theme to about 7 children (sub-themes plus concepts). At most 3 levels of themes.
- Every concept id must appear in exactly one assignment. Assign concepts to the most specific fitting theme.
- Theme names are short (1-4 words).`,
    user: concepts.map((c) => `${c.id}\t${c.name}\t${c.definition}`).join("\n"),
    schema: ThemesSchema,
  };
}
