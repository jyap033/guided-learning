# Decisions Log

A running record of the project's key decisions: what we chose, why, and what we
gave up. New decisions go at the bottom. Decisions are never deleted; if one is
reversed, mark it `Superseded by D-xxx` and add a new entry.

**Statuses**
- `Accepted` — decided, build on it.
- `Proposed` — recommended default; proceed unless someone objects.
- `Open` — needs a decision before the milestone listed.
- `Superseded` — replaced by a later decision.

**Template**

```markdown
## D-xxx — Title
- **Status:** Proposed | Accepted | Open | Superseded by D-yyy
- **Date:** YYYY-MM-DD
- **Context:** What problem or question prompted this.
- **Decision:** What we chose.
- **Alternatives considered:** What else, and why not.
- **Consequences:** What this makes easier/harder.
```

---

## Summary

| ID | Decision | Status |
|---|---|---|
| D-001 | Build a topic-agnostic learning tool; software topics first | Accepted |
| D-002 | NVIDIA NICo is the pilot topic | Accepted |
| D-003 | Model knowledge as a prerequisite DAG of concepts | Accepted |
| D-004 | Single-user, local-first MVP | Proposed |
| D-005 | CLI pipeline before web UI | Proposed |
| D-006 | TypeScript + Next.js stack | Proposed |
| D-007 | Claude as the LLM, behind a thin provider wrapper | Proposed |
| D-008 | SQLite (+ sqlite-vec) now, Postgres (+ pgvector) later | Proposed |
| D-009 | LLM proposes, deterministic code validates | Accepted |
| D-010 | How to do hands-on NICo exercises without real hardware | Open (before M2) |
| D-011 | How to capture the learner's starting knowledge | Open (before M4) |
| D-012 | Lazy, per-chapter content generation | Proposed |
| D-013 | Lessons must cite sources | Accepted |

---

## D-001 — Topic-agnostic learning tool, software topics first
- **Status:** Accepted
- **Date:** 2026-11-20
- **Context:** The immediate need is learning NICo, but the same problem — docs
  that assume too much prior knowledge — exists for almost every technical
  topic.
- **Decision:** Design the system to work for any topic. Nothing NICo-specific
  goes into code; topic specifics live in data (sources, generated graphs).
  Focus on software/technical topics first because they have docs to ground
  on and buildable exercises.
- **Alternatives considered:** A NICo-only course (faster to hand-craft, but
  doesn't scale and isn't the product the user wants).
- **Consequences:** Slightly more upfront design. M5 (second topic) is the test
  that we kept to this.

## D-002 — NVIDIA NICo as the pilot topic
- **Status:** Accepted
- **Date:** 2026-11-20
- **Context:** We need one real, hard topic to drive design and validate
  quality. The project owner wants to learn NICo (NVIDIA Infra Controller) and
  finds the docs too dense.
- **Decision:** Use NICo as the pilot. It is a good stress test: deep
  prerequisite tree spanning networking, hardware, Kubernetes, security and
  DPUs; open source (Apache 2.0) so docs and code are available.
- **Alternatives considered:** An easier topic (e.g. a web framework) — easier
  to succeed but wouldn't stress prerequisite discovery.
- **Consequences:** Exercises are harder because NICo targets real datacenter
  hardware (see D-010).

## D-003 — Prerequisite DAG of concepts as the core model
- **Status:** Accepted
- **Date:** 2026-11-20
- **Context:** "Fundamentals to advanced" needs a defensible order, and we need
  to skip what the learner already knows.
- **Decision:** Represent knowledge as a directed acyclic graph: nodes are
  concepts, edges are "A is a prerequisite of B". Chapters are derived from a
  topological order of this graph.
- **Alternatives considered:**
  - *Flat outline generated in one LLM call* — simple, but ordering is
    unverifiable and personalisation is hard.
  - *Fixed level buckets (beginner/intermediate/advanced)* — too coarse; doesn't
    capture which specific gaps matter.
- **Consequences:** Need dedup and cycle-breaking logic. Gains: provable
  ordering, skip-known is just graph pruning, a visual "map" for the learner.

## D-004 — Single-user, local-first MVP
- **Status:** Proposed
- **Date:** 2026-11-20
- **Context:** The first user is the project owner. Accounts, auth and
  multi-tenancy add a lot of work with no learning value yet.
- **Decision:** MVP runs locally for one learner. Data model keeps `topic_id`
  everywhere so multi-user can be added later.
- **Alternatives considered:** Hosted multi-user from day one.
- **Consequences:** Fast to build. Sharing curricula waits until after M4.

## D-005 — CLI pipeline before web UI
- **Status:** Proposed
- **Date:** 2026-11-20
- **Context:** The riskiest question is whether the AI breakdown is good, not
  whether we can build a UI.
- **Decision:** M1–M2 are CLI tools that output the graph, chapters and
  lessons as JSON/Markdown files. The web app (M3) is built on the same core
  modules.
- **Alternatives considered:** UI-first prototype.
- **Consequences:** Quick iteration on prompts and graph quality; outputs are
  easy to diff and review in Git.

## D-006 — TypeScript + Next.js
- **Status:** Proposed
- **Date:** 2026-11-20
- **Context:** Need one language for pipeline, API and UI.
- **Decision:** TypeScript throughout. Next.js for the web app. zod for schemas
  (shared between LLM output validation and API types).
- **Alternatives considered:** Python backend (stronger ML/data ecosystem,
  but we mostly call APIs, and a second language adds friction); separate
  SPA + API server (more moving parts).
- **Consequences:** One toolchain. If we later need heavy data/ML work, a
  Python worker can be added behind a queue.

## D-007 — Claude as the LLM, behind a thin wrapper
- **Status:** Proposed
- **Date:** 2026-11-20
- **Context:** Concept extraction and lesson writing need strong reasoning and
  long context; tutoring and simple steps can use cheaper models.
- **Decision:** Use the Claude API. A most-capable model for graph building
  and authoring; a smaller, faster model for dedup checks, quiz grading and
  tutor chat. All calls go through `llm/` (prompt templates, structured
  output, retries, caching, cost logging). Model IDs live in config.
- **Alternatives considered:** Hard-coding one provider's SDK everywhere
  (lock-in); multi-provider abstraction framework (overkill for MVP).
- **Consequences:** Can switch or mix models per task by config.

## D-008 — SQLite + sqlite-vec now, Postgres + pgvector later
- **Status:** Proposed
- **Date:** 2026-11-20
- **Context:** Local-first single-user MVP (D-004) needs relational data plus
  embeddings search.
- **Decision:** SQLite with the sqlite-vec extension, via an ORM/query builder
  that also supports Postgres (e.g. Drizzle), so migration to Postgres +
  pgvector is mechanical.
- **Alternatives considered:** Postgres from day one (needs a server);
  dedicated vector DB (unnecessary at this scale).
- **Consequences:** Zero-setup local dev. Migration needed when going hosted.

## D-009 — LLM proposes, code validates
- **Status:** Accepted
- **Date:** 2026-11-20
- **Context:** LLM output is non-deterministic and sometimes wrong.
- **Decision:** Use the LLM for judgement tasks (what concepts exist, what
  depends on what, how to explain). Use deterministic code for ordering,
  cycle detection, schema validation, and consistency checks. Every LLM call
  returns schema-validated JSON.
- **Alternatives considered:** End-to-end "generate the whole course" prompt.
- **Consequences:** More code, but results are checkable, reproducible and
  debuggable.

## D-010 — Hands-on NICo exercises without datacenter hardware
- **Status:** Open (decide before M2)
- **Date:** 2026-11-20
- **Context:** NICo manages real bare-metal servers, BMCs and DPUs. Most
  learners don't have that. "Build something" is a core goal.
- **Options:**
  1. Emulated lab: `kind`/`k3d` Kubernetes + QEMU/libvirt VMs as "servers" +
     a Redfish emulator (e.g. sushy-tools) as BMCs; run whatever NICo
     components can work in that setup.
  2. Prerequisite-only builds: hands-on for fundamentals (PXE, Redfish, K8s,
     mTLS), design-only exercises for NICo itself.
  3. Cloud bare-metal / lab access guidance for learners who have it.
- **Leaning:** 1 + 2 combined, with 3 as an optional track. Needs a spike to
  check which NICo components run in an emulated lab.
- **Consequences:** Determines what the capstone looks like.

## D-011 — Capturing the learner's starting knowledge
- **Status:** Open (decide before M4)
- **Date:** 2026-11-20
- **Context:** Skipping known material is a major time saver, but self-ratings
  are unreliable.
- **Options:** self-report checklist; adaptive placement quiz walking the DAG
  from the floor upward; both (self-report to prune, quiz to confirm).
- **Leaning:** Both. MVP starts with self-report only.

## D-012 — Lazy, per-chapter content generation
- **Status:** Proposed
- **Date:** 2026-11-20
- **Context:** Generating every lesson upfront is slow and costly, and much of
  it may be skipped or need adapting.
- **Decision:** Generate the graph and chapter outline upfront; generate
  lesson/check/exercise content when a chapter is opened (with the next chapter
  pre-generated in the background). Cache everything with prompt version +
  model + source hash.
- **Consequences:** Lower cost, content adapts to progress. First open of a
  chapter has a short wait.

## D-013 — Lessons must cite sources
- **Status:** Accepted
- **Date:** 2026-11-20
- **Context:** Learners can't tell when an AI explanation is wrong — that's
  why they're learning.
- **Decision:** Lessons are generated with retrieved source chunks and must
  cite them. Uncited factual claims are flagged in the UI. A review pass
  checks lessons against their sources.
- **Consequences:** Requires ingestion of good sources for prerequisite topics
  too (not just NICo docs), e.g. Kubernetes docs, Redfish spec, RFCs.
