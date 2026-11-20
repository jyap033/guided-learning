# NVIDIA NICo (NVIDIA Infra Controller): build report

## Counts

| | |
|---|---|
| Docs pages read | 36 |
| Concepts from the docs | 299 |
| Background concepts below the docs | 19 (depth 1: 19) |
| Starting knowledge | 3 |
| Prerequisite links kept | 504 |
| Links removed | 389 (low-confidence: 110, self-loop: 18, bidirectional: 36, cycle: 1, redundant: 224) |
| Mind map themes | 63 |
| Chapters | 49 |

## Checks passed

- The prerequisite graph has no cycles.
- Every taught concept is in exactly one chapter.
- No concept is taught before any of its prerequisites.

## Warnings

- 3 extracted prerequisite link(s) named concepts that weren't in the list; skipped
- 1 edge(s) removed to break prerequisite cycles
- mind map: the root has 10 children (aim for ≤ 7)
- mind map: NICo Architecture has 8 children (aim for ≤ 7)
- mind map: SuperNIC Lockdown has 8 children (aim for ≤ 7)
- mind map: Discovery & Ingestion has 8 children (aim for ≤ 7)
- mind map: Managed Host States has 8 children (aim for ≤ 7)
- mind map: NIC Firmware Recovery has 8 children (aim for ≤ 7)
- mind map: Health Model has 8 children (aim for ≤ 7)

## Links removed to break cycles

- PowerSequence Reboot Barrier → Maintenance Activities (confidence 0.6): Power sequence is one of the activities.
