import type { Page } from "../ingest/fern.ts";
import type { LlmProvider } from "../llm/provider.ts";
import type { Curriculum } from "../graph/types.ts";
import { chapterLessonTask, reviseTask, reviewTask, type ChapterContext, type ChapterLessons, type Review } from "./lessonPrompts.ts";

export interface ChapterResult {
  context: ChapterContext;
  lessons: ChapterLessons;
  review: Review;
  /** True when a first draft had major issues and was rewritten. */
  revised: boolean;
}

/**
 * Build the prompt context for one chapter: its concepts with their
 * prerequisites and what they unlock, what earlier chapters covered, and the
 * docs pages that mention the chapter's concepts (most-mentioned first, up to
 * `maxPageChars`).
 */
export function chapterContext(cur: Curriculum, pages: Page[], chapterNumber: number, maxPageChars: number): ChapterContext {
  const chapter = cur.chapters.find((c) => c.number === chapterNumber);
  if (!chapter) throw new Error(`no chapter ${chapterNumber} (there are ${cur.chapters.length})`);
  const byId = new Map(cur.concepts.map((c) => [c.id, c]));
  const chapterOf = new Map<string, number>();
  for (const ch of cur.chapters) for (const id of ch.concepts) chapterOf.set(id, ch.number);
  const label = (id: string) => {
    const n = chapterOf.get(id);
    return `${byId.get(id)?.name ?? id}${n ? ` (ch. ${n})` : ""}`;
  };

  const concepts = chapter.concepts.map((id) => {
    const c = byId.get(id);
    if (!c) throw new Error(`chapter ${chapterNumber} names unknown concept ${id}`);
    return {
      id,
      name: c.name,
      definition: c.definition,
      kind: c.kind,
      needs: cur.edges.filter((e) => e.to === id).map((e) => label(e.from)),
      unlocks: cur.edges.filter((e) => e.from === id).map((e) => label(e.to)),
    };
  });

  const earlier = cur.chapters.filter((c) => c.number < chapterNumber);
  const alreadyCovered = [
    ...cur.concepts.filter((c) => c.origin === "floor" || c.known).map((c) => c.name),
    ...earlier.flatMap((c) => c.concepts).map((id) => byId.get(id)?.name ?? id),
  ];

  // pages that mention this chapter's concepts, most mentions first
  const mentions = new Map<string, number>();
  for (const id of chapter.concepts) for (const p of byId.get(id)?.pages ?? []) mentions.set(p, (mentions.get(p) ?? 0) + 1);
  const ranked = pages
    .filter((p) => mentions.has(p.path))
    .sort((a, b) => (mentions.get(b.path) ?? 0) - (mentions.get(a.path) ?? 0) || a.order - b.order);
  const chosen: Page[] = [];
  let size = 0;
  for (const p of ranked) {
    if (size + p.text.length > maxPageChars) continue;
    chosen.push(p);
    size += p.text.length;
  }
  chosen.sort((a, b) => a.order - b.order);

  return {
    topicName: cur.topic.name,
    goal: cur.topic.goal,
    chapter: { number: chapter.number, title: chapter.title, part: chapter.part },
    concepts,
    earlierChapters: earlier.map((c) => ({ number: c.number, title: c.title })),
    alreadyCovered,
    pages: chosen,
  };
}

export async function buildChapterLessons(
  cur: Curriculum,
  pages: Page[],
  chapterNumber: number,
  opts: { provider: LlmProvider; maxPageChars: number },
): Promise<ChapterResult> {
  const context = chapterContext(cur, pages, chapterNumber, opts.maxPageChars);
  const order = new Map(context.concepts.map((c, i) => [c.id, i]));
  const sorted = (l: ChapterLessons) => {
    // keep lessons in the chapter's teaching order
    l.lessons.sort((a, b) => (order.get(a.concept) ?? 0) - (order.get(b.concept) ?? 0));
    return l;
  };
  let lessons = sorted(await opts.provider.complete(chapterLessonTask(context)));
  let review = await opts.provider.complete(reviewTask(context, lessons));
  let revised = false;
  if (review.issues.some((i) => i.severity === "major")) {
    // one rewrite with the reviewer's notes, then review the result again
    lessons = sorted(await opts.provider.complete(reviseTask(context, lessons, review)));
    review = await opts.provider.complete(reviewTask(context, lessons));
    revised = true;
  }
  return { context, lessons, review, revised };
}
