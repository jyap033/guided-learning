# Guided Learning

Learn any technical topic and build something with it. Guided Learning uses AI
to find the prerequisite knowledge a topic depends on, puts it in order from
fundamentals to advanced, and turns it into chapters with lessons, checks and
hands-on exercises.

Pilot topic: **NVIDIA NICo** (NVIDIA Infra Controller).

## Status

**M1 — curriculum builder (command line).** Reads a topic's docs and produces:

- `curricula/<topic>/curriculum.md`: chapters in teaching order, each concept with
  a definition, what it needs, what it unlocks, and links to the docs
- `curricula/<topic>/mindmap.md`: the topic mind map (Mermaid)
- `curricula/<topic>/report.md`: counts, checks and warnings
- `curricula/<topic>/graph.json`: the full concept graph

Lessons, quizzes and exercises come in M2.

## Run it

Needs Node 22+ and **either** of:

- **Claude Code**, logged in (the default). The builder runs Claude Code in
  headless mode (`claude -p`), so it uses your Claude login and no API key.
- **A Claude API key** in `ANTHROPIC_API_KEY`, with `--provider anthropic-api`.

```bash
npm install
```

```bash
npm run gl -- build nico
```

The first run fetches the NICo docs at the commit pinned in
`topics/nico/topic.yaml` and makes a few dozen AI calls. Answers are cached in
`curricula/nico/llm-cache/`, so re-running is free unless a prompt or the docs
change.

Options: `--provider claude-code|anthropic-api`, `--model <id>`,
`--concurrency <n>`, `--batch-chars <n>`.

To add a topic, copy `topics/nico/topic.yaml` and point it at another
Fern-style docs site. Which docs sections to read, the learner's starting
knowledge (`floor`) and what they already know (`known`) are all set there.

```bash
npm test
```

```bash
npm run typecheck
```

## How it works

1. **Ingest** the docs pages in the docs' own navigation order.
2. **Extract** concepts (explained and assumed) and prerequisite links, batch by batch.
3. **Deduplicate**: name matching, then an AI pass for synonyms.
4. **Expand** prerequisites below the docs, level by level, until reaching the
   starting knowledge.
5. **Clean** the graph in code: drop weak links, resolve two-way links, break
   cycles at the weakest link, remove redundant links.
6. **Mind map**: the AI groups concepts into themes; code checks the tree.
7. **Chapters**: a topological sort that keeps themes together, cut into
   chapters, then checked so that no concept comes before its prerequisites.

The AI proposes; deterministic code validates (D-009). Every AI answer must
match a schema.

## Docs

- [Design document](docs/DESIGN.md)
- [Decisions log](docs/DECISIONS.md)
- [Research: learning methods](docs/RESEARCH-LEARNING-METHODS.md)
