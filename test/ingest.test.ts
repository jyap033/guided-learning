import { describe, expect, it } from "vitest";
import { batchPages, cleanMarkdown, listNavPages, type Page } from "../src/ingest/fern.ts";
import { mermaidLabel, renderMindmap } from "../src/render/mindmap.ts";

describe("listNavPages", () => {
  it("walks nested sections in order and skips other tabs and non-pages", () => {
    const nav = `
navigation:
  - tab: documentation
    layout:
      - page: Home
        path: index.md
      - changelog: ../changes
      - section: Overview
        contents:
          - page: What
            path: overview/what.md
          - section: Deep
            contents:
              - page: Deeper
                path: overview/deep.md
  - tab: api
    layout:
      - page: API
        path: api.md
`;
    expect(listNavPages(nav, "documentation")).toEqual([
      { title: "Home", section: [], path: "index.md" },
      { title: "What", section: ["Overview"], path: "overview/what.md" },
      { title: "Deeper", section: ["Overview", "Deep"], path: "overview/deep.md" },
    ]);
  });
});

describe("cleanMarkdown", () => {
  it("strips comments, front matter, JSX and images", () => {
    const raw = `---\ntitle: x\n---\n<!-- SPDX -->\n# Title\n<Note>Keep this</Note>\n![diagram](a.png)\n<Img src="x" />`;
    expect(cleanMarkdown(raw)).toBe("# Title\nKeep this\n[image: diagram]");
  });
});

describe("batchPages", () => {
  it("groups consecutive pages up to the size limit", () => {
    const p = (n: number, len: number): Page => ({ order: n, title: `${n}`, section: [], path: `${n}.md`, text: "x".repeat(len), hash: "" });
    expect(batchPages([p(0, 50), p(1, 40), p(2, 30), p(3, 200)], 100).map((b) => b.map((x) => x.order))).toEqual([[0, 1], [2], [3]]);
  });
});

describe("mind map rendering", () => {
  it("removes characters that break Mermaid", () => {
    expect(mermaidLabel('Redfish (DMTF) [API] "v1"')).toBe("Redfish DMTF API v1");
  });
  it("nests themes and concepts by indentation", () => {
    const text = renderMindmap(
      "NICo",
      [{ id: "net", name: "Networking", parent: null }, { id: "boot", name: "Booting", parent: "net" }],
      [{ id: "pxe", name: "PXE", aliases: [], definition: "", kind: "conceptual", origin: "docs", firstSeen: 0, pages: [], depth: 0, known: false }],
      { pxe: "boot" },
    );
    expect(text).toBe(["mindmap", "  root((NICo))", "    Networking", "      Booting", "        PXE"].join("\n"));
  });
});
