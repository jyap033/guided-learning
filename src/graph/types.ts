export type ConceptKind = "procedural" | "conceptual";

/** Where a concept came from. */
export type ConceptOrigin =
  | "docs" // found in the topic's own docs
  | "prerequisite" // found by expanding prerequisites below the docs
  | "floor"; // assumed starting knowledge (topic.yaml `floor`)

export interface Concept {
  id: string;
  name: string;
  aliases: string[];
  definition: string;
  kind: ConceptKind;
  origin: ConceptOrigin;
  /** Order of the first docs page that mentions it; later = taught later in the docs. */
  firstSeen: number;
  /** Docs pages that mention it (paths relative to the docs dir). */
  pages: string[];
  /** 0 for docs concepts, n for concepts found n prerequisite levels below them. */
  depth: number;
  /** True when the learner already knows it (directly or by implication). */
  known: boolean;
}

/** `from` must be learned before `to`. */
export interface Edge {
  from: string;
  to: string;
  confidence: number;
  why: string;
  origin: "docs" | "expansion";
}

export interface RemovedEdge extends Edge {
  reason: "low-confidence" | "self-loop" | "bidirectional" | "cycle" | "redundant";
}

export interface Theme {
  id: string;
  name: string;
  parent: string | null;
}

export interface Chapter {
  number: number;
  title: string;
  /** Name of the top-level theme this chapter belongs to; the course's "part". */
  part: string;
  theme: string; // top-level theme id
  concepts: string[]; // concept ids, in teaching order
}

export interface Curriculum {
  topic: { id: string; name: string; goal: string };
  generated: {
    provider: string;
    source: { repo: string; ref: string; pages: number };
  };
  concepts: Concept[];
  edges: Edge[];
  removedEdges: RemovedEdge[];
  themes: Theme[];
  conceptTheme: Record<string, string>;
  chapters: Chapter[];
  warnings: string[];
}
