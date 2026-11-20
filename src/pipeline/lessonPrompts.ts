import { z } from "zod";
import type { LlmTask } from "../llm/provider.ts";
import type { Page } from "../ingest/fern.ts";

const Step = z.object({
  subgoal: z.string().describe("Short label for this step, e.g. 'Find the BMC address'"),
  detail: z.string().describe("What to do or observe in this step (Markdown; code blocks allowed)"),
});

const Check = z.object({
  question: z.string(),
  options: z.array(z.string()).describe("2-5 options for multiple choice; empty for a short-answer question"),
  answer: z.string().describe("For multiple choice, exactly one of the options"),
  explanation: z.string().describe("Why this is the answer, and why the tempting wrong answers are wrong"),
});

/**
 * Schema for one chapter's lessons (D-015). Built per chapter so the model can
 * only name this chapter's concepts and the docs pages it was given.
 */
export function chapterLessonSchema(conceptIds: string[], pagePaths: string[]) {
  const ConceptId = z.enum(conceptIds as [string, ...string[]]);
  const Source = pagePaths.length ? z.enum(pagePaths as [string, ...string[]]) : z.string();
  return z
    .object({
      intro: z.string().describe("Advance organiser: what this chapter covers, how it connects to earlier chapters, and why NICo needs it. 2-4 short paragraphs."),
      objectives: z.array(z.string()).describe("3-6 things the learner can do after this chapter, starting with a verb"),
      lessons: z.array(
        z.object({
          concept: ConceptId,
          prequestions: z
            .array(z.object({ question: z.string(), answer: z.string() }))
            .describe("1-2 questions to attempt BEFORE reading; guessing is expected"),
          explanation: z.string().describe("Plain-language explanation for a newcomer (Markdown, 150-400 words). Build on the listed prerequisites."),
          analogy: z.string().describe("One everyday analogy, with where it breaks down"),
          workedExample: z.object({ title: z.string(), steps: z.array(Step).describe("3-6 labelled steps") }),
          completionProblem: z.object({
            prompt: z.string(),
            partialSolution: z.string().describe("The solution with one or two key parts replaced by ___"),
            answer: z.string(),
          }),
          independentProblem: z.object({
            prompt: z.string(),
            hints: z.array(z.string()).describe("2-3 hints, from a gentle nudge to nearly the answer"),
            answer: z.string(),
          }),
          selfExplanation: z.string().describe("A 'why' question the learner answers in their own words"),
          checks: z.array(Check).describe("2-3 retrieval questions"),
          sources: z.array(Source).describe("Docs pages this lesson's facts come from; empty if none apply"),
        }),
      ),
      buildTask: z.object({
        title: z.string(),
        goal: z.string(),
        whyItMatters: z.string().describe("How this build relates to running NICo"),
        setup: z.array(z.string()).describe("What the learner needs installed or prepared"),
        steps: z.array(Step).describe("4-8 steps"),
        verify: z.string().describe("A command or observation that proves the task is done"),
        hints: z.array(z.string()).describe("Common failures and how to get past them"),
        stretch: z.string().describe("An optional harder extension"),
      }),
    })
    .superRefine((v, ctx) => {
      const seen = v.lessons.map((l) => l.concept);
      for (const id of conceptIds) {
        if (seen.filter((s) => s === id).length !== 1) {
          ctx.addIssue({ code: "custom", message: `concept ${id} must have exactly one lesson` });
        }
      }
      v.lessons.forEach((l, i) =>
        l.checks.forEach((c, j) => {
          if (c.options.length && !c.options.includes(c.answer)) {
            ctx.addIssue({ code: "custom", path: ["lessons", i, "checks", j], message: "answer must be one of the options" });
          }
        }),
      );
    });
}
export type ChapterLessons = z.infer<ReturnType<typeof chapterLessonSchema>>;

export interface ChapterContext {
  topicName: string;
  goal: string;
  chapter: { number: number; title: string; part: string };
  concepts: { id: string; name: string; definition: string; kind: string; needs: string[]; unlocks: string[] }[];
  earlierChapters: { number: number; title: string }[];
  /** Concepts the learner can assume (taught earlier or starting knowledge). */
  alreadyCovered: string[];
  pages: Page[];
}

const LESSON_SYSTEM = `You write lessons for a self-paced course that takes a software engineer from fundamentals to building with a complex infrastructure system. Your lessons follow learning research:

- Start each concept with 1-2 prequestions the learner tries before reading (pretesting). Guesses are fine.
- Explain in plain language, building only on concepts the learner has already covered. Define every new term.
- Give a worked example with labelled steps (subgoal labels), then a partly completed problem, then an independent problem with hints that go from a nudge to nearly the answer. Guidance fades.
- End with a "why" question for the learner to explain in their own words, and 2-3 retrieval check questions. Wrong options should be plausible misconceptions.
- Be accurate. Where the provided docs pages cover a fact, follow them and list them in "sources". For general background knowledge not in the pages, rely on well-established facts and leave "sources" empty. Never invent NICo commands, flags, APIs or behaviour that the pages don't show.
- Examples should be concrete and runnable on a normal Linux or macOS machine where possible (shell commands, small scripts, config snippets).

The chapter ends with one build task that combines the chapter's concepts. It must work on a laptop with common free tools (Linux/macOS shell, Python, Docker or Podman, QEMU/libvirt if really needed) and no datacenter hardware. It needs a clear way to verify it is done.

Write for a capable adult: direct, friendly, no filler.`;

export function chapterLessonTask(ctx: ChapterContext): LlmTask<ChapterLessons> {
  const concepts = ctx.concepts
    .map(
      (c) =>
        `- id: ${c.id}\n  name: ${c.name}\n  kind: ${c.kind}\n  definition: ${c.definition}\n  needs: ${c.needs.join("; ") || "(nothing beyond earlier chapters)"}\n  unlocks: ${c.unlocks.join("; ") || "-"}`,
    )
    .join("\n");
  const pages = ctx.pages
    .map((p) => `<page path="${p.path}" title="${p.title}">\n${p.text}\n</page>`)
    .join("\n\n");
  return {
    kind: "lessons",
    promptVersion: "1",
    system: LESSON_SYSTEM,
    user: `Course: ${ctx.topicName}
Course goal: ${ctx.goal}

Chapter ${ctx.chapter.number}: ${ctx.chapter.title} (part: ${ctx.chapter.part})
Earlier chapters: ${ctx.earlierChapters.map((c) => `${c.number}. ${c.title}`).join("; ") || "none (this is the first chapter)"}
Already covered (you may build on these): ${ctx.alreadyCovered.join("; ") || "only basic programming and terminal use"}

Concepts to teach in this chapter, in this order (one lesson each, use these ids):
${concepts}

Relevant docs pages:
${pages || "(none: these are background concepts; rely on well-established knowledge)"}`,
    schema: chapterLessonSchema(
      ctx.concepts.map((c) => c.id),
      ctx.pages.map((p) => p.path),
    ),
  };
}

/** Rewrite a chapter to fix the reviewer's issues. */
export function reviseTask(ctx: ChapterContext, lessons: ChapterLessons, review: Review): LlmTask<ChapterLessons> {
  const base = chapterLessonTask(ctx);
  return {
    ...base,
    kind: "revise",
    user: `${base.user}

A previous draft of this chapter is below, followed by a reviewer's issues. Return the full corrected chapter. Fix every issue; keep what was fine.

Previous draft (JSON):
${JSON.stringify(lessons)}

Reviewer's issues:
${review.issues.map((i) => `- [${i.severity}] ${i.where}: ${i.problem} Fix: ${i.fix}`).join("\n")}`,
  };
}

// ---------- Review pass (DESIGN §11) ----------

export const ReviewSchema = z.object({
  verdict: z.enum(["ok", "minor-issues", "major-issues"]),
  issues: z.array(
    z.object({
      where: z.string().describe("Concept id or 'build task'"),
      severity: z.enum(["minor", "major"]),
      problem: z.string(),
      fix: z.string(),
    }),
  ),
});
export type Review = z.infer<typeof ReviewSchema>;

export function reviewTask(ctx: ChapterContext, lessons: ChapterLessons): LlmTask<Review> {
  const pages = ctx.pages.map((p) => `<page path="${p.path}">\n${p.text}\n</page>`).join("\n\n");
  return {
    kind: "review",
    promptVersion: "1",
    system: `You are a strict technical reviewer for a course chapter. Check it against the docs pages provided and well-established technical knowledge. Report:
- factual errors or claims about the system that the pages don't support (major),
- invented commands, flags or APIs (major),
- check questions whose answer is wrong or ambiguous (major),
- build steps that would not work as written, or a verify step that doesn't prove the task (major),
- explanations that rely on a concept not yet covered, or are confusing (minor).
Do not report style preferences. An empty issue list with verdict "ok" is a fine answer.`,
    user: `Chapter ${ctx.chapter.number}: ${ctx.chapter.title}
Already covered before this chapter: ${ctx.alreadyCovered.join("; ") || "basics only"}

Chapter content (JSON):
${JSON.stringify(lessons, null, 1)}

Docs pages:
${pages || "(none)"}`,
    schema: ReviewSchema,
  };
}
