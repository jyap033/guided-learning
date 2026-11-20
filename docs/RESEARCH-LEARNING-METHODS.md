# Research: How People Best Learn Hard Technical Topics

| | |
|---|---|
| **Status** | v0.1 |
| **Date** | 2026-11-20 |
| **Question** | What does the published research say about the best way to learn a complex technical topic with a deep prerequisite tree (like NVIDIA NICo), and what should Guided Learning do because of it? |
| **Related** | [DESIGN.md](./DESIGN.md), [DECISIONS.md](./DECISIONS.md) (D-014 – D-021) |

---

## TL;DR

1. **Test, don't reread.** Retrieval practice and spaced review are the two
   techniques with the strongest evidence. Rereading, highlighting and
   summarising are weak. Every chapter needs quizzes, and old material needs
   to come back on a schedule.
2. **Novices need guidance; experts need room.** For new material, worked
   examples beat "figure it out yourself". As the learner improves, the
   guidance should fade, because too much of it starts to hurt.
3. **Gate progress on mastery.** Don't move on until the learner can show they
   understand. Step-by-step tutoring with feedback comes close to the
   effectiveness of a human tutor.
4. **Organise around a real build, not just a list of topics.** For complex
   skills, learning through progressively harder versions of a whole, real
   task beats learning every part in isolation first. Bring in prerequisites
   just in time.
5. **AI tutors help only with guardrails.** An AI that hands over answers
   raised practice scores but *lowered* exam scores. A tutor that guides
   without giving away answers avoided that harm. A carefully designed AI tutor
   beat an active-learning class.
6. **LLM-built prerequisite maps work, but need checks.** Recent papers
   support recursively finding prerequisites down to what the learner already
   knows. They also show that unchecked LLM extraction is noisy.

The current design already does #6 well, does #1 and #3 partly, and is
missing #2, #4 and #5. Section 4 lists the changes.

---

## 1. What works: the evidence

Effect sizes are given where the papers report them. A rough guide: d ≈ 0.2 is
small, 0.5 is medium, 0.8 or more is large.

### 1.1 Learning techniques ranked: Dunlosky et al. (2013)

A review of 10 common study techniques across hundreds of studies, rated by
how well the evidence holds up across learners, materials and settings.

| Rating | Technique | What it means for us |
|---|---|---|
| **High** | **Practice testing** (retrieval practice) | Quizzes are the main learning activity, not just a measurement |
| **High** | **Distributed practice** (spacing) | Spread review over days and weeks |
| Moderate | Interleaved practice | Mix problem types in review sessions |
| Moderate | Elaborative interrogation ("why is this true?") | Ask "why" questions |
| Moderate | Self-explanation | Ask the learner to explain steps in their own words |
| Low | Rereading, highlighting, summarising, keyword mnemonics, imagery | Don't build features around these |

Supporting studies:
- **Testing effect:** Roediger & Karpicke (2006). Students who were tested on a
  passage remembered much more a week later than students who reread it, even
  though rereaders *felt* more confident.
- **Spacing:** Cepeda et al. (2006), a meta-analysis of 317 experiments.
  Spaced practice beats massed practice, and the best gap grows with how long
  you need to remember the material.
- **Interleaving:** Rohrer & Taylor (2007). Mixing problem types improved
  later test scores, though practice felt harder.
- **Pretesting:** Richland, Kornell & Kao (2009). Trying to answer questions
  *before* studying improves learning, even when the attempts are wrong.

**Key takeaway:** what feels productive (rereading, smooth explanations) is
often not, and what feels hard (being tested, spacing, mixing) works. Bjork
(1994) calls these *desirable difficulties*. Learners will rate the effective
features as less pleasant, so the product should explain why they're there.

### 1.2 Tutoring and mastery

- **Bloom's 2-sigma problem** (Bloom, 1984): one-to-one tutoring combined
  with mastery learning produced results about 2 standard deviations above a
  regular class. This figure comes from small early studies and is usually
  treated as an upper bound, but it sets the target.
- **Mastery learning** (Kulik, Kulik & Bangert-Drowns, 1990, a
  meta-analysis): requiring learners to reach a mastery level before moving on
  gave an average effect of around 0.5 SD.
- **Intelligent tutoring systems** (VanLehn, 2011, a review): human tutoring
  d ≈ 0.79, *step-based* computer tutors d ≈ 0.76, systems that only check the
  final answer d ≈ 0.31. **Feedback on each step matters far more than
  feedback on the final answer.**
- **Feedback** (Hattie & Timperley, 2007): feedback is among the strongest
  influences on learning, but only when it tells the learner where they are,
  where they're going and what to do next. Bare praise or a grade does little.

### 1.3 How much guidance? Cognitive load and its limits

- **Cognitive load theory** (Sweller, 1988): working memory is small. Novices
  solving problems with no guidance spend their capacity searching, not
  learning.
- **Worked examples** (Sweller & Cooper, 1985): for novices, studying a
  worked solution beats solving the same problem unaided.
- **Minimal guidance fails for novices** (Kirschner, Sweller & Clark, 2006):
  pure discovery, "just read the docs" and unguided projects work poorly for
  beginners. This is exactly the experience the project owner described with
  the NICo docs.
- **Expertise reversal effect** (Kalyuga et al., 2003): guidance that helps
  novices *hurts* learners who already know the material. Guidance should
  fade as competence grows: full worked example → partly completed example →
  independent problem.
- **Productive failure** (Kapur; meta-analysis Sinha & Kapur, 2021, 53
  studies): trying a problem *before* being taught, then being taught, can
  beat teach-first, with an estimated g ≈ 0.87 after correcting for
  publication bias. The benefit is mostly for conceptual understanding and
  transfer, depends on faithful implementation, and is weaker for young
  learners. **How this fits with Kirschner et al.:** a short, deliberate
  attempt *followed by* full instruction is helpful. Leaving people alone with
  the material is not.

### 1.4 Active engagement

- **Active learning in STEM** (Freeman et al., 2014, a meta-analysis of 225
  studies): active learning raised exam scores by about 0.47 SD and reduced
  failure rates by about 1.5 times compared with lectures.
- **ICAP framework** (Chi & Wylie, 2014): learning improves in the order
  **Passive < Active < Constructive < Interactive**. Reading is passive.
  Clicking through is active. Explaining, predicting or designing is
  constructive. A back-and-forth dialogue that builds on your answers is
  interactive.
- **Self-explanation** (Chi et al., 1989): strong learners explain worked
  examples to themselves. Prompting people to do so helps.

### 1.5 Complex skills: whole tasks beat isolated parts

This is the most important finding for a "learn it and build something"
product.

- **4C/ID model** (van Merriënboer, Clark & de Croock, 2002): for complex
  professional skills, organise learning around **whole, realistic tasks**
  from simple to complex. Each task class comes with supporting information
  (concepts) given just in time, and part-task practice only for routines
  that must become automatic. Learning every part fully before ever doing a
  whole task leads to poor transfer.
- **First principles of instruction** (Merrill, 2002): across instructional
  theories, learning is promoted when it is **centred on real problems** and
  goes through *activate* prior knowledge → *demonstrate* → *apply* →
  *integrate* into the learner's own work.
- **Cognitive apprenticeship** (Collins, Brown & Newman, 1989): experts make
  their thinking visible (modelling), coach, provide scaffolds, then fade.
  Learners move from simple to complex and from guided to independent.
- **Subgoal labels** (Margulieux, Guzdial & Catrambone, 2012): in programming
  instruction, labelling the steps of a worked example ("1. find the BMC
  address, 2. authenticate, 3. …") improves problem solving and transfer.

**What this means for us:** a pure bottom-up path (all of networking → all of
Kubernetes → … → finally NICo) is the "isolated parts first" approach the
research warns against. The learner should touch a simplified version of the
real goal early and keep coming back to it in more complex forms.

### 1.6 Prior knowledge, maps and placement

- **Advance organisers** (Ausubel, 1960): showing the big picture and how new
  ideas connect before the details improves learning.
- **Concept and knowledge maps** (Nesbit & Adesope, 2006, a meta-analysis):
  studying and building concept maps improves retention and transfer compared
  with text alone. This supports showing the curriculum map.
- **Knowledge space theory** (Doignon & Falmagne, 1985), the basis of the
  ALEKS system: a learner's knowledge is modelled as a set of concepts
  consistent with the prerequisite structure. Adaptive questions can locate
  the learner quickly, because knowing a concept implies knowing its
  prerequisites. This is a principled way to do placement (D-011).
- **Bayesian knowledge tracing** (Corbett & Anderson, 1995): estimate, for
  each concept, the probability that the learner has mastered it, updated
  after every answer. This is the standard model behind mastery decisions in
  tutoring systems.

### 1.7 Things that don't work (avoid)

- **Learning styles** ("visual" or "auditory" learners): Pashler et al. (2008)
  found no adequate evidence that matching teaching to a style helps. Don't
  personalise on this.
- Rereading, highlighting and summary-only study (Dunlosky et al., 2013).
- Unguided discovery for novices (Kirschner et al., 2006).

## 2. Evidence on AI tutors (2024–2026)

- **AI without guardrails can harm learning** (Bastani et al., *PNAS*, 2025).
  This was a field experiment with nearly 1,000 high-school maths students.
  Students using a standard ChatGPT-style assistant did much better *during*
  practice, but when access was removed they scored **17% worse than students
  who never had it**. A version prompted to guide without giving answers
  largely avoided the harm. **Lesson:** an AI tutor that does the work for
  you is a crutch.
- **A well-designed AI tutor beat active learning** (Kestin et al.,
  *Scientific Reports*, 2025). This was a randomised crossover trial in a
  university physics course. Students learned more in less time with an AI
  tutor built on research-based principles (structured steps, no answer
  giveaways, prompts to think, self-pacing) than in an in-class
  active-learning session. They also reported more engagement. A
  non-peer-reviewed re-analysis argues the "more than double" claim is
  overstated, but the direction holds. It is one course, so treat it as
  promising rather than proven.

**Together:** *how* the AI tutor is designed decides whether it helps or
harms. Socratic, scaffolded and answer-withholding works. A plain answer
machine doesn't.

## 3. Evidence on LLM-built prerequisite maps

- **RPKT** (Tang et al., arXiv 2508.11892, 2025): uses an LLM to trace
  prerequisites recursively from what the learner wants to learn until it
  reaches the edge of what they know, using simple know/don't-know answers.
  This is almost exactly our §6.3 design, which supports the approach. There
  is no independent evaluation yet.
- **InstructKG** (arXiv 2602.17111, 2026): builds course knowledge graphs
  with "depends-on" and "part-of" edges. It argues that plain LLM extraction
  is not accurate enough, and improves it with signals from the source
  material: the **order in which the material teaches things** and the role
  each concept plays in context. We can use the order of the NICo docs (and
  the prerequisite topics' docs) as a signal.
- **Capture-Calibrate-Coach** (arXiv 2605.25419, 2026): extracts concepts and
  prerequisite links from course material. **Few-shot prompting beat
  zero-shot** for both concepts and links.
- **Knowledge-gap detection from AI chats** (arXiv 2606.10736, 2026, work in
  progress): GPT-4 prerequisite graph built from lesson PDFs. It **dropped
  every judgement that was bidirectional or ambiguous**, keeping only confident
  edges.
- **GPT for curriculum concepts and prerequisites** (arXiv 2504.08856, 2025):
  evaluates GPT's ability to generate course concepts and score dependencies
  between pairs of concepts.

**Takeaway:** the DAG approach (D-003) and "LLM proposes, code validates"
(D-009) are in line with current research. We should add few-shot examples,
grounding in the order the docs teach things, confidence scores on edges, and
a way to drop or flag ambiguous edges.

## 4. Implications for Guided Learning

Each recommendation is recorded as a decision in DECISIONS.md.

| # | Change | Evidence | Decision |
|---|---|---|---|
| 1 | **Project spine.** Break the capstone into a sequence of increasingly real "build tasks", starting with a toy version in chapter 1–2. Order concepts from the DAG but deliver them just in time for the next build task. | 4C/ID, Merrill, cognitive apprenticeship | D-014 |
| 2 | **Lesson shape:** prequestion → explanation with a worked example (subgoal-labelled) → partly completed example → independent problem → self-explanation prompt. Guidance fades as mastery rises. | Pretesting, worked examples, expertise reversal, subgoals, self-explanation, productive failure | D-015 |
| 3 | **Retrieval practice plus spaced review.** Quizzes are part of the lesson, not just an end check. A spaced-review queue resurfaces past concepts, mixed together. | Dunlosky, Roediger & Karpicke, Cepeda, Rohrer & Taylor | D-016 |
| 4 | **Mastery gating.** Track per-concept mastery (start simple, move to knowledge tracing later). A chapter's build task unlocks at about 80% mastery of its concepts. Remediate on failure. | Bloom, Kulik, Corbett & Anderson | D-017 |
| 5 | **Guardrailed Socratic tutor.** It gives hints in stages (nudge → hint → partial step → worked solution only after a real attempt), asks the learner to try first, and gives step-level feedback. It never just solves the exercise. | Bastani 2025, Kestin 2025, VanLehn, Hattie & Timperley | D-018 |
| 6 | **Placement uses the DAG.** An adaptive quiz walks the graph (knowledge space theory), so a few questions can rule in or out whole subtrees. Answers to prequestions update the same model. | Doignon & Falmagne, Richland et al. | D-011 (updated) |
| 7 | **Map as an advance organiser.** Every chapter opens with where it sits on the map and why it matters for the end goal (NICo). | Ausubel, Nesbit & Adesope | D-019 |
| 8 | **Better graph extraction.** Few-shot prompts, doc teaching order as a signal, confidence on each edge, drop or flag ambiguous and bidirectional edges, "part-of" as well as "depends-on" edges. | InstructKG, Capture-Calibrate-Coach, arXiv 2606.10736, RPKT | D-020 |
| 9 | **Don't build:** learning-style personalisation, highlight or reread features, summary-only lessons. Explain "desirable difficulty" to the learner so harder features don't feel like bad UX. | Pashler 2008, Dunlosky 2013, Bjork 1994 | D-021 |

### What a chapter looks like after these changes

```
Chapter 4 — Remote server management (BMC, IPMI, Redfish)
  0. Where this sits on the map · why NICo needs it        (advance organiser)
  1. Prequestions: 3 quick questions, guesses OK           (pretesting)
  2. Concept: What is a BMC?
       explanation + worked example (subgoal labels)
       → quick check (retrieval)
       → "explain in your own words why the BMC is separate from the OS"
  3. Concept: Redfish API
       worked example: power-cycle a server via curl
       → completion problem: fill in the missing request
       → independent problem: read the boot order
  4. Build task 4 of the project spine:
       "Add a Redfish emulator to your lab and power-cycle a fake server
        from a script" (tutor gives hints in stages, never the answer)
  5. Mastery check → unlock chapter 5, or remediation
  + Spaced review items from chapters 1–3, mixed together
```

## 5. Open questions from the research

- **How strict to make mastery gating** for a self-directed adult. A hard
  lock may frustrate; a soft gate ("you can skip, but here's what you'll
  miss") may be better. To be tested with the pilot user.
- **Productive failure vs worked examples first.** The evidence points to
  worked-example-first for brand-new procedures, and a short attempt first
  for conceptual "why" ideas. Concepts may need a `kind` field
  (`procedural` | `conceptual`) to pick the lesson shape.
- **Measuring whether it works.** Add a small pre/post test per chapter and a
  delayed retention check (e.g. a week later) so we evaluate actual learning,
  not practice scores. Bastani et al. show why practice scores mislead.

## References

**Learning science**
- Ausubel, D. P. (1960). The use of advance organizers in the learning and retention of meaningful verbal material. *Journal of Educational Psychology, 51*(5), 267–272.
- Bjork, R. A. (1994). Memory and metamemory considerations in the training of human beings. In J. Metcalfe & A. Shimamura (Eds.), *Metacognition: Knowing about knowing* (pp. 185–205). MIT Press.
- Bloom, B. S. (1984). The 2 sigma problem: The search for methods of group instruction as effective as one-to-one tutoring. *Educational Researcher, 13*(6), 4–16.
- Cepeda, N. J., Pashler, H., Vul, E., Wixted, J. T., & Rohrer, D. (2006). Distributed practice in verbal recall tasks: A review and quantitative synthesis. *Psychological Bulletin, 132*(3), 354–380.
- Chi, M. T. H., Bassok, M., Lewis, M. W., Reimann, P., & Glaser, R. (1989). Self-explanations: How students study and use examples in learning to solve problems. *Cognitive Science, 13*(2), 145–182.
- Chi, M. T. H., & Wylie, R. (2014). The ICAP framework: Linking cognitive engagement to active learning outcomes. *Educational Psychologist, 49*(4), 219–243.
- Collins, A., Brown, J. S., & Newman, S. E. (1989). Cognitive apprenticeship: Teaching the crafts of reading, writing, and mathematics. In L. B. Resnick (Ed.), *Knowing, learning, and instruction* (pp. 453–494). Erlbaum.
- Corbett, A. T., & Anderson, J. R. (1995). Knowledge tracing: Modeling the acquisition of procedural knowledge. *User Modeling and User-Adapted Interaction, 4*, 253–278.
- Doignon, J.-P., & Falmagne, J.-C. (1985). Spaces for the assessment of knowledge. *International Journal of Man-Machine Studies, 23*, 175–196.
- Dunlosky, J., Rawson, K. A., Marsh, E. J., Nathan, M. J., & Willingham, D. T. (2013). Improving students' learning with effective learning techniques. *Psychological Science in the Public Interest, 14*(1), 4–58.
- Freeman, S., et al. (2014). Active learning increases student performance in science, engineering, and mathematics. *PNAS, 111*(23), 8410–8415.
- Hattie, J., & Timperley, H. (2007). The power of feedback. *Review of Educational Research, 77*(1), 81–112.
- Kalyuga, S., Ayres, P., Chandler, P., & Sweller, J. (2003). The expertise reversal effect. *Educational Psychologist, 38*(1), 23–31.
- Kirschner, P. A., Sweller, J., & Clark, R. E. (2006). Why minimal guidance during instruction does not work. *Educational Psychologist, 41*(2), 75–86.
- Kulik, C.-L. C., Kulik, J. A., & Bangert-Drowns, R. L. (1990). Effectiveness of mastery learning programs: A meta-analysis. *Review of Educational Research, 60*(2), 265–299.
- Margulieux, L. E., Guzdial, M., & Catrambone, R. (2012). Subgoal-labeled instructional material improves performance and transfer in learning to develop mobile applications. *Proc. ICER 2012*, 71–78.
- Merrill, M. D. (2002). First principles of instruction. *Educational Technology Research and Development, 50*(3), 43–59.
- Nesbit, J. C., & Adesope, O. O. (2006). Learning with concept and knowledge maps: A meta-analysis. *Review of Educational Research, 76*(3), 413–448.
- Pashler, H., McDaniel, M., Rohrer, D., & Bjork, R. (2008). Learning styles: Concepts and evidence. *Psychological Science in the Public Interest, 9*(3), 105–119.
- Richland, L. E., Kornell, N., & Kao, L. S. (2009). The pretesting effect: Do unsuccessful retrieval attempts enhance learning? *Journal of Experimental Psychology: Applied, 15*(3), 243–257.
- Roediger, H. L., & Karpicke, J. D. (2006). Test-enhanced learning: Taking memory tests improves long-term retention. *Psychological Science, 17*(3), 249–255.
- Rohrer, D., & Taylor, K. (2007). The shuffling of mathematics problems improves learning. *Instructional Science, 35*, 481–498.
- Sinha, T., & Kapur, M. (2021). When problem solving followed by instruction works: Evidence for productive failure. *Review of Educational Research, 91*(5), 761–798. https://doi.org/10.3102/00346543211019105
- Sweller, J. (1988). Cognitive load during problem solving: Effects on learning. *Cognitive Science, 12*(2), 257–285.
- Sweller, J., & Cooper, G. A. (1985). The use of worked examples as a substitute for problem solving in learning algebra. *Cognition and Instruction, 2*(1), 59–89.
- van Merriënboer, J. J. G., Clark, R. E., & de Croock, M. B. M. (2002). Blueprints for complex learning: The 4C/ID-model. *Educational Technology Research and Development, 50*(2), 39–64.
- VanLehn, K. (2011). The relative effectiveness of human tutoring, intelligent tutoring systems, and other tutoring systems. *Educational Psychologist, 46*(4), 197–221.

**AI tutoring**
- Bastani, H., Bastani, O., Sungu, A., Ge, H., Kabakcı, Ö., & Mariman, R. (2025). Generative AI without guardrails can harm learning: Evidence from high school mathematics. *PNAS, 122*(26), e2422633122. https://papers.ssrn.com/abstract=4895486
- Kestin, G., Miller, K., et al. (2025). AI tutoring outperforms in-class active learning: An RCT introducing a novel research-based design in an authentic educational setting. *Scientific Reports, 15*, 17458. https://pmc.ncbi.nlm.nih.gov/articles/PMC12179260/
- Ford, C. (2025). AI tutoring outperforms in-class active learning: A re-analysis (blog post, not peer-reviewed). https://www.clayford.net/posts/ai_tutoring_nature/

**LLM-built prerequisite graphs**
- Tang, J., Guo, Q., Tang, Z., & Shang, Y. (2025). RPKT: Learning what you don't know — Recursive prerequisite knowledge tracing in conversational AI tutors for personalized learning. arXiv:2508.11892. https://arxiv.org/abs/2508.11892
- Instructor-aligned knowledge graphs for personalized learning (InstructKG) (2026). arXiv:2602.17111. https://www.arxiv.org/pdf/2602.17111
- Capture-Calibrate-Coach: A graph-based framework for knowledge monitoring estimation and adaptive feedback (2026). arXiv:2605.25419. https://arxiv.org/pdf/2605.25419
- Detecting knowledge gaps from conversational AI interactions using curriculum prerequisite graphs (2026). arXiv:2606.10736. https://arxiv.org/pdf/2606.10736
- GPT-based curriculum concept and prerequisite generation (2025). arXiv:2504.08856. https://arxiv.org/pdf/2504.08856

*Caveat on sources: the classic learning-science papers are long-established
and widely replicated. The 2025–2026 AI and LLM-graph papers are recent;
several are preprints with no independent replication yet. Effect sizes for
the AI studies come from abstracts and summaries, not full-text checks.*
