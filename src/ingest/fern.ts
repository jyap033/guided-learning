import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";

/** One documentation page, in the order the docs teach it. */
export interface Page {
  /** Position in the docs' own navigation: the teaching-order signal (D-020). */
  order: number;
  title: string;
  /** Nav sections this page sits under, outermost first. */
  section: string[];
  /** Path relative to the docs directory. */
  path: string;
  text: string;
  hash: string;
}

interface NavEntry {
  page?: string;
  path?: string;
  section?: string;
  contents?: NavEntry[];
  layout?: NavEntry[];
  tab?: string;
}

/**
 * Walk a Fern navigation file and return the pages, in nav order, for one tab.
 * Entries that aren't plain pages (changelogs, API references, links) are skipped.
 */
export function listNavPages(navYaml: string, tab: string): { title: string; section: string[]; path: string }[] {
  const nav = YAML.parse(navYaml) as { navigation?: NavEntry[] };
  const out: { title: string; section: string[]; path: string }[] = [];
  const walk = (entries: NavEntry[] | undefined, section: string[]) => {
    for (const e of entries ?? []) {
      if (e.page && e.path) out.push({ title: e.page, section, path: e.path });
      if (e.section) walk(e.contents, [...section, e.section]);
      else if (e.contents) walk(e.contents, section);
    }
  };
  for (const t of nav.navigation ?? []) {
    if (t.tab === tab) walk(t.layout ?? t.contents, []);
  }
  return out;
}

/** Turn docs Markdown/MDX into plain Markdown text for the model. */
export function cleanMarkdown(raw: string): string {
  return (
    raw
      // front matter
      .replace(/^---\n[\s\S]*?\n---\n/, "")
      // HTML comments (SPDX headers etc.)
      .replace(/<!--[\s\S]*?-->/g, "")
      // MDX imports/exports
      .replace(/^(import|export) .*$/gm, "")
      // images: keep alt text only
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? `[image: ${alt}]` : ""))
      // self-closing JSX/HTML tags, then remaining tags (keep inner text)
      .replace(/<[A-Za-z][^>]*\/>/g, "")
      .replace(/<\/?[A-Za-z][^>]*>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export function loadFernPages(opts: {
  docsRoot: string; // directory the nav paths are relative to
  navFile: string;
  tab: string;
  includeSections: string[];
  extraPages: string[];
}): Page[] {
  const entries = listNavPages(fs.readFileSync(opts.navFile, "utf8"), opts.tab).filter(
    (e) => opts.includeSections.length === 0 || (e.section[0] !== undefined && opts.includeSections.includes(e.section[0])),
  );
  for (const extra of opts.extraPages) {
    if (!entries.some((e) => e.path === extra)) {
      entries.push({ title: path.basename(extra, ".md"), section: ["Extra"], path: extra });
    }
  }
  const pages: Page[] = [];
  for (const e of entries) {
    const file = path.join(opts.docsRoot, e.path);
    if (!fs.existsSync(file)) continue; // nav can point at pages that no longer exist
    const text = cleanMarkdown(fs.readFileSync(file, "utf8"));
    if (!text) continue;
    pages.push({
      order: pages.length,
      title: e.title,
      section: e.section,
      path: e.path,
      text,
      hash: crypto.createHash("sha256").update(text).digest("hex").slice(0, 16),
    });
  }
  return pages;
}

/** Group consecutive pages into batches of roughly `maxChars` characters. */
export function batchPages(pages: Page[], maxChars: number): Page[][] {
  const batches: Page[][] = [];
  let cur: Page[] = [];
  let size = 0;
  for (const p of pages) {
    if (cur.length > 0 && size + p.text.length > maxChars) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += p.text.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
