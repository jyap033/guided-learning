import type { ChapterResult } from "../pipeline/lessons.ts";

/** Show code-like text in a fenced block so indentation and ___ blanks survive Markdown. */
export function asCode(text: string): string {
  const t = text.replace(/^\n+|\s+$/g, "");
  return t.includes("```") ? t : "```text\n" + t + "\n```";
}

const details = (summary: string, body: string) => `<details>\n<summary>${summary}</summary>\n\n${body.trim()}\n\n</details>`;

/** One chapter as a Markdown page. Answers sit in collapsed blocks so the learner tries first. */
export function renderChapter(r: ChapterResult, docsBase: string, opts: { prev?: string; next?: string } = {}): string {
  const { context: ctx, lessons: l, review } = r;
  const name = new Map(ctx.concepts.map((c) => [c.id, c.name]));
  const out: string[] = [];
  out.push(`# Chapter ${ctx.chapter.number}: ${ctx.chapter.title}`, "");
  out.push(`*Part: ${ctx.chapter.part} · ${ctx.concepts.length} concepts · [curriculum](../curriculum.md#chapter-${ctx.chapter.number})*`, "");
  out.push("> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.", "");
  out.push(l.intro.trim(), "");
  out.push("**By the end of this chapter you can:**", "", ...l.objectives.map((o) => `- ${o}`), "");
  out.push("**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.", "");

  out.push("## Contents", "");
  l.lessons.forEach((x, i) => out.push(`${i + 1}. [${name.get(x.concept)}](#${x.concept})`));
  out.push(`${l.lessons.length + 1}. [Build task: ${l.buildTask.title}](#build-task)`, "");

  l.lessons.forEach((x, i) => {
    const c = ctx.concepts.find((k) => k.id === x.concept);
    out.push(`<a id="${x.concept}"></a>`, `## ${i + 1}. ${name.get(x.concept)}`, "");
    if (c?.needs.length) out.push(`*Builds on: ${c.needs.join(", ")}*`, "");
    out.push("### Before you read", "");
    for (const q of x.prequestions) out.push(`- ${q.question}`);
    out.push("", details("Answers", x.prequestions.map((q) => `- **${q.question}** ${q.answer}`).join("\n")), "");
    out.push("### Explanation", "", x.explanation.trim(), "", `**Analogy.** ${x.analogy.trim()}`, "");
    out.push(`### Worked example: ${x.workedExample.title}`, "");
    x.workedExample.steps.forEach((s, k) => out.push(`**Step ${k + 1}: ${s.subgoal}.**`, "", s.detail.trim(), ""));
    out.push("### Your turn: finish it", "", x.completionProblem.prompt.trim(), "", asCode(x.completionProblem.partialSolution), "");
    out.push(details("Answer", x.completionProblem.answer), "");
    out.push("### Your turn: on your own", "", x.independentProblem.prompt.trim(), "");
    x.independentProblem.hints.forEach((h, k) => out.push(details(`Hint ${k + 1}`, h), ""));
    out.push(details("Answer", x.independentProblem.answer), "");
    out.push("### Explain it", "", `In your own words: ${x.selfExplanation.trim()}`, "");
    out.push("### Check", "");
    x.checks.forEach((q, k) => {
      out.push(`**${k + 1}. ${q.question.trim()}**`, "");
      if (q.options.length) {
        q.options.forEach((o, m) => out.push(`${String.fromCharCode(65 + m)}. ${o}`));
        out.push("");
      }
      const letter = q.options.indexOf(q.answer);
      out.push(details("Answer", `${letter >= 0 ? `**${String.fromCharCode(65 + letter)}.** ` : ""}${q.answer}\n\n${q.explanation}`), "");
    });
    out.push(
      x.sources.length
        ? `**Sources:** ${x.sources.map((p) => `[${p}](${docsBase}/${p})`).join(", ")}`
        : "**Sources:** general background knowledge; no NICo docs page covers this directly.",
      "",
    );
  });

  const b = l.buildTask;
  out.push(`<a id="build-task"></a>`, `## Build task: ${b.title}`, "");
  out.push(`**Goal:** ${b.goal}`, "", `**Why it matters for NICo:** ${b.whyItMatters}`, "");
  out.push("**You need:**", "", ...b.setup.map((s) => `- ${s}`), "");
  out.push("Try each step yourself first. The details are there when you need them.", "");
  b.steps.forEach((s, k) => out.push(details(`Step ${k + 1}: ${s.subgoal}`, s.detail), ""));
  out.push(`**Check it works:** ${b.verify}`, "");
  if (b.hints.length) out.push(details("If you get stuck", b.hints.map((h) => `- ${h}`).join("\n")), "");
  out.push(`**Stretch goal:** ${b.stretch}`, "");

  out.push("## Review notes", "");
  if (r.rewrites) out.push(`The draft was rewritten ${r.rewrites === 1 ? "once" : "twice"} using review issues; the notes below are from the last review.`, "");
  if (ctx.feedback.length) out.push(`This chapter was written with ${ctx.feedback.length} finding(s) from testing earlier versions (\`topics/<topic>/feedback.yaml\`).`, "");
  if (!review.issues.length) out.push(`Automated review: **${review.verdict}**, no issues found.`, "");
  else {
    out.push(`Automated review: **${review.verdict}**. Issues to fix before relying on this chapter:`, "");
    for (const i of review.issues) out.push(`- **${i.severity}** (${name.get(i.where) ?? i.where}): ${i.problem} *Fix:* ${i.fix}`);
    out.push("");
  }
  const nav = [opts.prev && `[← ${opts.prev}](${opts.prev})`, opts.next && `[${opts.next} →](${opts.next})`].filter(Boolean);
  if (nav.length) out.push("---", "", nav.join(" · "), "");
  return out.join("\n");
}

export function chapterFileName(n: number, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  return `${String(n).padStart(2, "0")}-${slug}.md`;
}
