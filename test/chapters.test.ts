import { describe, expect, it } from "vitest";
import { buildChapters, validateChapters } from "../src/graph/chapters.ts";
import { levels } from "../src/graph/dag.ts";
import { validateThemes } from "../src/graph/themes.ts";
import type { Edge, Theme } from "../src/graph/types.ts";

const e = (from: string, to: string): Edge => ({ from, to, confidence: 0.9, why: "", origin: "docs" });

describe("buildChapters", () => {
  const themes: Theme[] = [
    { id: "net", name: "Networking", parent: null },
    { id: "k8s", name: "Kubernetes", parent: null },
    { id: "nico", name: "NICo", parent: null },
  ];
  const conceptTheme: Record<string, string> = {
    ip: "net", dhcp: "net", pxe: "net", vlan: "net",
    container: "k8s", pod: "k8s", operator: "k8s",
    site: "nico", host: "nico", lifecycle: "nico",
  };
  const edges = [
    e("ip", "dhcp"), e("dhcp", "pxe"), e("ip", "vlan"),
    e("container", "pod"), e("pod", "operator"),
    e("operator", "site"), e("pxe", "host"), e("vlan", "host"), e("host", "lifecycle"), e("site", "lifecycle"),
  ];
  const ids = Object.keys(conceptTheme);
  const input = {
    ids, edges, conceptTheme, themes,
    level: levels(ids, edges),
    firstSeen: new Map(ids.map((id, i) => [id, i])),
    maxConcepts: 4, minConcepts: 2,
  };

  it("never teaches a concept before its prerequisites", () => {
    const chapters = buildChapters(input);
    expect(validateChapters(chapters, ids, edges)).toEqual([]);
  });

  it("keeps a theme together when the prerequisites allow it", () => {
    const chapters = buildChapters(input);
    expect(chapters.map((c) => c.title)).toEqual(["Networking", "Kubernetes", "NICo"]);
    expect(chapters[0]?.concepts.sort()).toEqual(["dhcp", "ip", "pxe", "vlan"]);
  });

  it("teaches foundational themes first, in the order the themes are listed", () => {
    // NICo concept with no prerequisites, seen first in the docs: still taught after the earlier themes
    const chapters = buildChapters({ ...input, ids: [...ids, "health"], conceptTheme: { ...conceptTheme, health: "nico" }, firstSeen: new Map([["health", -1], ...input.firstSeen]) });
    expect(chapters[0]?.part).toBe("Networking");
    expect(chapters[chapters.length - 1]?.concepts).toContain("health");
  });

  it("names chapters after their sub-themes", () => {
    const sub: Theme[] = [...themes, { id: "boot", name: "Booting", parent: "net" }, { id: "addr", name: "Addressing", parent: "net" }];
    const chapters = buildChapters({ ...input, themes: sub, conceptTheme: { ...conceptTheme, ip: "addr", vlan: "addr", dhcp: "boot", pxe: "boot" } });
    const net = chapters.filter((c) => c.part === "Networking");
    expect(net.map((c) => c.title).join(" | ")).toMatch(/Addressing|Booting/);
    expect(validateChapters(chapters, ids, edges)).toEqual([]);
  });

  it("splits a theme that is too big", () => {
    const chapters = buildChapters({ ...input, maxConcepts: 2, minConcepts: 1 });
    expect(chapters.filter((c) => c.theme === "net")).toHaveLength(2);
    expect(chapters.find((c) => c.title === "Networking (part 2)")).toBeDefined();
    expect(validateChapters(chapters, ids, edges)).toEqual([]);
  });

  it("validateChapters reports out-of-order prerequisites", () => {
    const bad = [{ number: 1, title: "x", part: "Networking", theme: "net", concepts: ["dhcp", "ip"] }];
    expect(validateChapters(bad, ["ip", "dhcp"], [e("ip", "dhcp")])[0]).toMatch(/before its prerequisite/);
  });
});

describe("validateThemes", () => {
  it("repairs bad parents, puts unassigned concepts in Other, and drops empty themes", () => {
    const res = validateThemes(
      {
        themes: [
          { id: "a", name: "A", parent: "missing" },
          { id: "b", name: "B", parent: "a" },
          { id: "empty", name: "Empty", parent: null },
        ],
        assignments: [{ concept: "x", theme: "b" }, { concept: "x", theme: "a" }],
      },
      ["x", "y"],
      { maxDepth: 3, maxChildren: 7 },
    );
    expect(res.conceptTheme).toEqual({ x: "b", y: "other" });
    expect(res.themes.map((t) => t.id).sort()).toEqual(["a", "b", "other"]);
    expect(res.themes.find((t) => t.id === "a")?.parent).toBeNull();
    expect(res.warnings.length).toBeGreaterThan(0);
  });
});
