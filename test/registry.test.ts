import { describe, expect, it } from "vitest";
import { ConceptRegistry, matchKeys, normalizeKey } from "../src/graph/registry.ts";

describe("normalizeKey", () => {
  it("ignores case, punctuation, articles and a plural last word", () => {
    expect(normalizeKey("The VLANs")).toBe(normalizeKey("vlan"));
    expect(normalizeKey("Kubernetes Operators")).toBe("kubernetes operator");
    expect(normalizeKey("Policies")).toBe("policy");
    expect(normalizeKey("DNS")).toBe("dns");
    expect(normalizeKey("DPUs")).toBe(normalizeKey("DPU"));
    expect(normalizeKey("status")).toBe("status");
  });
  it("splits 'Long Name (ABBR)' into both keys", () => {
    expect(matchKeys("Baseboard Management Controller (BMC)")).toEqual(
      expect.arrayContaining(["baseboard management controller", "bmc"]),
    );
  });
});

describe("ConceptRegistry", () => {
  it("merges concepts that share a name or alias", () => {
    const r = new ConceptRegistry();
    const a = r.add({ name: "Baseboard Management Controller (BMC)", origin: "docs", depth: 0, firstSeen: 5, pages: ["x.md"] });
    const b = r.add({ name: "BMC", origin: "docs", depth: 0, firstSeen: 2, pages: ["y.md"] });
    const c = r.add({ name: "BMCs", origin: "prerequisite", depth: 1 });
    expect(b).toBe(a);
    expect(c).toBe(a); // plural acronym
    const concept = r.get(a)!;
    expect(concept.firstSeen).toBe(2);
    expect(concept.pages.sort()).toEqual(["x.md", "y.md"]);
  });
  it("keeps concepts apart when they only share an alias", () => {
    const r = new ConceptRegistry();
    const vlan = r.add({ name: "VLAN", aliases: ["pools.vlan-id"], origin: "docs", depth: 0 });
    const pools = r.add({ name: "NICo resource pools", aliases: ["pools.vlan-id", "pools.vni"], origin: "docs", depth: 0 });
    expect(pools).not.toBe(vlan);
  });
  it("merges when an alias names an existing concept", () => {
    const r = new ConceptRegistry();
    const k = r.add({ name: "Kubernetes", origin: "docs", depth: 0 });
    expect(r.add({ name: "K8s", aliases: ["Kubernetes"], origin: "docs", depth: 0 })).toBe(k);
  });
  it("absorb moves names over so later lookups find the kept concept", () => {
    const r = new ConceptRegistry();
    const k = r.add({ name: "Kubernetes", origin: "docs", depth: 0 });
    const d = r.add({ name: "K8s", origin: "prerequisite", depth: 2 });
    r.absorb(k, d);
    expect(r.find("K8s")?.id).toBe(k);
    expect(r.get(d)).toBeUndefined();
    expect(r.get(k)?.aliases).toContain("K8s");
  });
});
