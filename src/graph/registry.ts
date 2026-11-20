import type { Concept, ConceptKind, ConceptOrigin } from "./types.ts";

/** Lowercase, drop punctuation, singularise the last word. Used only as a matching key. */
export function normalizeKey(name: string): string {
  // plural acronyms: "DPUs" -> "DPU", "VLANs" -> "VLAN"
  const singularAcronyms = name.replace(/\b([A-Z][A-Z0-9]+)s\b/g, "$1");
  const words = singularAcronyms
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\.(?=\s|$)/g, "")
    .trim()
    .split(/\s+/)
    .filter((w) => w && w !== "the" && w !== "a" && w !== "an");
  const last = words.length - 1;
  const lastWord = words[last];
  if (lastWord && lastWord.length > 4 && /[^su]s$/.test(lastWord) && !lastWord.endsWith("is")) {
    words[last] = lastWord.endsWith("ies") ? lastWord.slice(0, -3) + "y" : lastWord.slice(0, -1);
  }
  return words.join(" ");
}

/** Keys a name should match on: the name itself, and "Long Name (ABBR)" split into both parts. */
export function matchKeys(name: string): string[] {
  const keys = new Set<string>([normalizeKey(name)]);
  const m = name.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m && m[1] && m[2]) {
    keys.add(normalizeKey(m[1]));
    keys.add(normalizeKey(m[2]));
  }
  keys.delete("");
  return [...keys];
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\(.*?\)/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "concept"
  );
}

export interface ConceptInput {
  name: string;
  aliases?: string[];
  definition?: string;
  kind?: ConceptKind;
  origin: ConceptOrigin;
  firstSeen?: number;
  pages?: string[];
  depth: number;
}

/**
 * Holds the concept set and merges duplicates deterministically: two names are
 * the same concept if any of their match keys (name or aliases) collide.
 */
export class ConceptRegistry {
  private byId = new Map<string, Concept>();
  private byKey = new Map<string, string>();

  get size(): number {
    return this.byId.size;
  }

  all(): Concept[] {
    return [...this.byId.values()];
  }

  get(id: string): Concept | undefined {
    return this.byId.get(id);
  }

  find(name: string): Concept | undefined {
    for (const k of matchKeys(name)) {
      const id = this.byKey.get(k);
      if (id) return this.byId.get(id);
    }
    return undefined;
  }

  /** Add a concept or merge it into an existing match. Returns the concept id. */
  add(input: ConceptInput): string {
    const names = [input.name, ...(input.aliases ?? [])];
    const existing = names.map((n) => this.find(n)).find((c) => c !== undefined);
    if (existing) {
      this.mergeInto(existing, input);
      return existing.id;
    }
    let id = slugify(input.name);
    for (let n = 2; this.byId.has(id); n++) id = `${slugify(input.name)}-${n}`;
    const concept: Concept = {
      id,
      name: input.name.trim(),
      aliases: [],
      definition: input.definition?.trim() ?? "",
      kind: input.kind ?? "conceptual",
      origin: input.origin,
      firstSeen: input.firstSeen ?? Number.MAX_SAFE_INTEGER,
      pages: [...new Set(input.pages ?? [])],
      depth: input.depth,
      known: false,
    };
    this.byId.set(id, concept);
    this.indexNames(concept, names);
    return id;
  }

  private mergeInto(c: Concept, input: ConceptInput): void {
    const names = [input.name, ...(input.aliases ?? [])];
    for (const n of names) {
      if (n.trim() && n.trim() !== c.name && !c.aliases.includes(n.trim())) c.aliases.push(n.trim());
    }
    if (!c.definition && input.definition) c.definition = input.definition.trim();
    if (input.firstSeen !== undefined) c.firstSeen = Math.min(c.firstSeen, input.firstSeen);
    if (input.pages) c.pages = [...new Set([...c.pages, ...input.pages])];
    c.depth = Math.min(c.depth, input.depth);
    // docs beats prerequisite; floor stays floor
    if (c.origin === "prerequisite" && input.origin === "docs") c.origin = "docs";
    if (input.origin === "floor") c.origin = "floor";
    this.indexNames(c, names);
  }

  private indexNames(c: Concept, names: string[]): void {
    for (const n of names) for (const k of matchKeys(n)) if (!this.byKey.has(k)) this.byKey.set(k, c.id);
  }

  /** Merge concept `dropId` into `keepId` (used by the AI dedupe pass). */
  absorb(keepId: string, dropId: string): void {
    const keep = this.byId.get(keepId);
    const drop = this.byId.get(dropId);
    if (!keep || !drop || keep === drop) return;
    this.mergeInto(keep, {
      name: drop.name,
      aliases: drop.aliases,
      definition: drop.definition,
      origin: drop.origin,
      firstSeen: drop.firstSeen,
      pages: drop.pages,
      depth: drop.depth,
    });
    this.byId.delete(dropId);
    for (const [k, v] of this.byKey) if (v === dropId) this.byKey.set(k, keepId);
  }
}
