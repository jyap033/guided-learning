# Chapter 24: GPU Fabrics

*Part: Networking & Isolation · 5 concepts · [curriculum](../curriculum.md#chapter-24)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Earlier chapters covered the Ethernet side of a NICo site: the BGP underlay (ch. 9), the VXLAN/EVPN overlay that BlueField DPUs build (ch. 11), and multi-tenancy with the DPU as the enforcement boundary (ch. 23). An AI cluster has more than one network, though. GPUs exchange most of their data over networks that never touch the Ethernet overlay.

This chapter maps those networks. You'll learn the three **network planes** (Ethernet, InfiniBand or Spectrum-X, and NVLink) and what kind of traffic each carries. Then you'll look at the two GPU fabrics in detail. The first is **InfiniBand**, where every NIC port belongs to exactly one fabric and is identified by a **GUID** and a **LID**. The second is **NVLink**, which joins GPUs across the trays of a rack into one large GPU domain. The chapter ends with the rule that holds all of this together: the **static network fabric principle**. NICo never reconfigures leaf or spine switches when tenants change. It isolates tenants through the DPU and through fabric manager APIs (UFM for InfiniBand, NMX-C for NVLink).

This matters for operating NICo because a host is only safe to hand to a tenant once it is isolated on *every* plane it is cabled to. Separating a tenant on Ethernet does nothing for its InfiniBand ports. Later chapters cover the actual isolation mechanisms: InfiniBand P_Key partitioning with UFM and NMX-C partitions (ch. 30). This chapter gives you the vocabulary and the mental model those chapters assume.

**By the end of this chapter you can:**

- Classify a given traffic flow in an AI cluster onto the Ethernet, InfiniBand/Spectrum-X or NVLink plane, and name the mechanism NICo uses to isolate tenants on that plane
- Explain how a host's InfiniBand ports map to fabrics, and resolve a tenant's (device, fabric, device_instance) selection to a specific port the way NICo's NIC-selection design does
- Describe an NVLink scale-up domain such as GB200 NVL72, and interpret NICo's NVLink health probes (NvlinkUnhealthy, NmxcUnreachable, NmxtUnreachable)
- Tell an InfiniBand GUID from a LID, read both from Linux sysfs or ibstat output, and pick the right one for identity or routing
- Explain why NICo keeps leaf and spine switch configuration static across tenant changes, and list what *does* change on each plane

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [Network planes (Ethernet, InfiniBand, NVLink)](#network-planes)
2. [InfiniBand fabric](#infiniband-fabric)
3. [NVLink scale-up fabric](#nvlink-scale-up-fabric)
4. [InfiniBand GUID and LID](#infiniband-guid-and-lid)
5. [Static network fabric principle](#static-network-fabric-principle)
6. [Build task: Multi-plane isolation planner on a fake InfiniBand host](#build-task)

<a id="network-planes"></a>
## 1. Network planes (Ethernet, InfiniBand, NVLink)

*Builds on: Multi-tenancy (ch. 23)*

### Before you read

- A GPU server in an AI cluster often has a DPU plus several more high-speed NICs. Why might it need more than one kind of network card?
- If you isolate two tenants from each other on Ethernet using VRFs, does that also stop their GPUs from talking over InfiniBand?

<details>
<summary>Answers</summary>

- **A GPU server in an AI cluster often has a DPU plus several more high-speed NICs. Why might it need more than one kind of network card?** The different kinds of traffic need different networks. One network carries traffic in and out of the cluster (users, storage, the internet). Separate high-bandwidth, low-latency networks carry GPU-to-GPU traffic between servers. A third kind of link, NVLink, connects GPUs directly to each other without using a NIC at all.
- **If you isolate two tenants from each other on Ethernet using VRFs, does that also stop their GPUs from talking over InfiniBand?** No. InfiniBand is a physically separate network with its own switches and its own isolation mechanism (P_Keys, managed through UFM). Every plane has to be isolated on its own.

</details>

### Explanation

A **network plane** is a separate physical network in the cluster, with its own cables, switches and isolation mechanism. A large AI cluster has three tenant-facing planes, plus the out-of-band management network you met in ch. 8.

Two terms first:
- **North-south (N/S)** traffic crosses the cluster edge: users connecting over SSH or APIs, pulling container images, reading datasets from storage, reaching the internet.
- **East-west (E/W)** traffic stays inside the cluster, between servers or GPUs. In AI training this is mostly GPU collective operations such as all-reduce, which move huge amounts of data and are very sensitive to latency.

**The planes:**

| Plane | Carries | Typical hardware |
|---|---|---|
| Ethernet | N/S traffic | BlueField DPU uplinks to leaf/ToR switches |
| InfiniBand or Spectrum-X | E/W GPU traffic between servers (*scale-out*) | ConnectX/SuperNIC ports to IB switches, or NVIDIA's Spectrum-X Ethernet platform |
| NVLink | E/W direct GPU-to-GPU links (*scale-up*) | NVLink/NVSwitch, which spans a whole rack in GB200 NVL72 |

*Scale-out* adds more servers and links them over a network. *Scale-up* makes one larger GPU domain whose GPUs act almost like a single machine. Both are east-west; they differ in reach.

**Why NICo cares:** one of NICo's core responsibilities is to *enforce network isolation across Ethernet, InfiniBand, and NVLink planes*. Each plane uses a different mechanism:

| Plane | NICo isolation mechanism |
|---|---|
| Ethernet (N/S) | BlueField HBN: L3 VXLAN/EVPN, VRFs, Network Security Groups |
| InfiniBand (E/W) | UFM-based P_Key partition assignment per tenant |
| NVLink | NMX-C gRPC partition management |
| Spectrum-X (E/W) | SP-X partitioning |

Before a host is assigned to a tenant, NICo sets up isolation on **every applicable plane**. When the tenant releases the host, NICo clears that isolation and sets it up again for the next tenant. A host that is isolated on Ethernet but still sits in the previous tenant's InfiniBand partition is *not* isolated.

The OOB management network (BMCs, DPU OOB ports) is not a tenant data plane. NICo uses it to manage hardware, and tenants never get to it.

**Analogy.** Think of an office tower. The street entrance with its security desk is the Ethernet plane: everything going in or out of the building passes through it. A private freight-elevator network that links every floor is InfiniBand: heavy loads move fast between floors and never touch the street. Inside one large suite, the connecting doors between rooms are NVLink: very fast, but they only reach the rooms of that suite. Each one needs its own locks. Where the analogy breaks down: in a building, a locked front door also slows down intruders inside. In a cluster, the planes are fully independent, so locking one does nothing for the others.

### Worked example: Classifying a training job's traffic onto planes

**Step 1: List the flows.**

A tenant runs a training job on 4 GB200 NVL72 racks:
1. The engineer opens SSH to a node and pulls a container image from a public registry.
2. Each step, GPUs inside one rack exchange tensor shards (tensor parallelism).
3. Each step, gradients are all-reduced across the 4 racks (data parallelism).
4. Checkpoints are written to an external storage service.

**Step 2: Decide N/S vs E/W for each flow.**

Flows 1 and 4 cross the cluster edge, so they are **N/S**. Flows 2 and 3 stay between GPUs inside the cluster, so they are **E/W**.

**Step 3: Split E/W into scale-up vs scale-out.**

Flow 2 stays inside one rack's NVLink domain: **NVLink** (scale-up). Flow 3 crosses racks, and NVLink does not reach that far: **InfiniBand or Spectrum-X** (scale-out).

**Step 4: Attach NICo's isolation mechanism.**

- Flows 1, 4 → Ethernet → DPU HBN VRF/VXLAN for the tenant's VPC
- Flow 2 → NVLink → NMX-C partition that holds the tenant's GPUs
- Flow 3 → InfiniBand → UFM P_Key partition that holds the tenant's IB ports (or SP-X partitioning on Spectrum-X)

**Step 5: Check on your own laptop.**

Your laptop has one plane. Run:
```bash
ip -br link            # Linux: Ethernet/Wi-Fi interfaces (macOS: ifconfig -l)
ls /sys/class/infiniband 2>/dev/null || echo "no InfiniBand devices"
```
On a GPU node you would also see entries under `/sys/class/infiniband` and NVLink status from `nvidia-smi nvlink --status`. On a laptop, expect only Ethernet/Wi-Fi.

### Your turn: finish it

Fill in the two blanks (each `___` is a bare Python value, so include the quotes) so this lookup table correctly describes each plane. `traffic` is the N/S vs E/W axis; `scope` says whether E/W traffic is scale-out or scale-up.

```text
PLANES = {
    "ethernet":   {"traffic": "north-south", "scope": "cluster edge", "nico_mechanism": "BlueField HBN (VXLAN/EVPN, VRFs)"},
    "infiniband": {"traffic": "east-west",   "scope": "scale-out",    "nico_mechanism": ___},
    "nvlink":     {"traffic": "east-west",   "scope": ___,            "nico_mechanism": "NMX-C partition management"},
}
```

<details>
<summary>Answer</summary>

Replace the first `___` with `"UFM P_Key partition assignment"` (any string naming UFM P_Key partitions is right) and the second with `"scale-up"`. NVLink is east-west like InfiniBand, but it only links GPUs inside one NVLink domain, so it is scale-up rather than scale-out.

</details>

### Your turn: on your own

A host has 1 BlueField DPU, 8 InfiniBand ports and 4 GPUs in an NVL72 rack. The operator's runbook says: "To isolate tenant B from tenant A, put B's DPU in its own VRF." List every gap in that runbook and what NICo does to close each one.

<details>
<summary>Hint 1</summary>

Count the planes this host is cabled to.

</details>

<details>
<summary>Hint 2</summary>

A VRF on the DPU only affects traffic that passes through the DPU. Does InfiniBand or NVLink traffic pass through it?

</details>

<details>
<summary>Hint 3</summary>

Add the two missing mechanisms: one for the 8 IB ports, one for the 4 GPUs.

</details>

<details>
<summary>Answer</summary>

A VRF only isolates the Ethernet (N/S) plane. The runbook leaves out (1) InfiniBand: the host's 8 IB ports must be put into tenant B's P_Key partition through UFM, and removed from A's. (2) NVLink: the 4 GPUs must be placed in B's NMX-C NVLink partition, and removed from A's. NICo sets up all three before allocation and clears them on release.

</details>

### Explain it

In your own words: Why can't one isolation mechanism, such as a DPU VRF, protect all three planes? Answer in terms of where each plane's traffic physically flows.

### Check

**1. Gradient all-reduce between GPUs in *different* racks typically travels over which plane?**

A. NVLink
B. InfiniBand or Spectrum-X
C. The OOB management network
D. The Ethernet N/S plane through the DPU

<details>
<summary>Answer</summary>

**B.** InfiniBand or Spectrum-X

Cross-rack GPU traffic is east-west scale-out traffic, so it goes over InfiniBand or Spectrum-X. NVLink is tempting, but it is scale-up and only reaches within one NVLink domain, such as one NVL72 rack. The N/S Ethernet plane carries traffic in and out of the cluster. The OOB network is for management only.

</details>

**2. Which mechanism does NICo use to isolate tenants on the NVLink plane?**

A. BlueField HBN VRFs
B. UFM P_Key partitions
C. NMX-C gRPC partition management
D. VLANs on the NVLink switches configured per tenant

<details>
<summary>Answer</summary>

**C.** NMX-C gRPC partition management

NVLink isolation goes through NMX-C partitions. HBN VRFs are for Ethernet, and P_Keys are for InfiniBand. Per-tenant switch configuration would break NICo's static-fabric principle.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md)

<a id="infiniband-fabric"></a>
## 2. InfiniBand fabric

*Builds on: Network planes (Ethernet, InfiniBand, NVLink) (ch. 24)*

### Before you read

- A dual-port InfiniBand NIC sits in one PCIe slot. How many devices do you think Linux shows under /sys/class/infiniband for it?
- Can the two ports of that NIC be plugged into two different InfiniBand networks?

<details>
<summary>Answers</summary>

- **A dual-port InfiniBand NIC sits in one PCIe slot. How many devices do you think Linux shows under /sys/class/infiniband for it?** Two. Each port appears as its own PCI function (for example ca:00.0 and ca:00.1) and its own InfiniBand device (for example ibp202s0f0 and ibp202s0f1).
- **Can the two ports of that NIC be plugged into two different InfiniBand networks?** Yes. Each port is cabled to one switch, and that switch belongs to one fabric. The two ports can go to different fabrics, so a single host can span several fabrics.

</details>

### Explanation

**InfiniBand (IB)** is a high-speed network built for cluster computing. It has its own switches and cables and does not use Ethernet. It is *lossless*: senders only transmit when the receiver has buffer space, so switches don't drop packets. It also supports **RDMA** (remote direct memory access), where one machine's NIC reads or writes another machine's memory without involving the CPU. This makes it a good fit for GPU collective traffic.

An **InfiniBand fabric** is one separate IB network: a set of switches and the ports cabled to them, managed together. Each fabric has a **subnet manager (SM)**, software that discovers the topology, assigns addresses and programs the switches' forwarding tables. NVIDIA's **UFM** (Unified Fabric Manager) is the management platform that runs this for a fabric and exposes APIs. NICo calls those APIs. It does not install or operate UFM.

The key rules:
- **Each NIC port connects to exactly one fabric**, because the cable goes to one switch.
- **A host can span several fabrics.** For example, one port can go to `IbFabric1` and another to `IbFabric2`.

**How NICo models it.** NICo treats each port as a separate **device**, a PCI function that sends and receives IB traffic. A dual-port ConnectX-6 becomes two devices. During discovery, Scout reports one record per device with its `guid` and PCI properties. NICo's NIC-selection design proposes extending each record with the `fabric` the device connects to and a stable PCI `slot` (instead of a driver-specific sysfs path). In that design, an empty fabric means the site's default fabric, which is all a single-fabric MVP needs.

The design summarises this per instance type as **capabilities**: one entry per device model and fabric, with a `count`. Both ports on `IbFabric1` gives one entry with `count: 2`. Ports on two fabrics gives two entries with `count: 1`. Capabilities leave out GUIDs and slots, because those differ from machine to machine.

A tenant picks an IB interface by `device` (model name), `fabric` and `device_instance` (the n-th match). The design resolves this by **sorting the matching devices by PCI slot** and taking the n-th one. Machines of the same type have the same slot layout, so the same request picks the same physical port on every machine. GUIDs would not work for this: they are unique per card, so sorting by GUID would give a different order on each machine.

**Analogy.** Picture separate railway networks run by different companies. Each platform (port) is wired into exactly one company's track network (fabric). A big station (host) can have platforms on several networks. Each network has its own control centre (subnet manager) that assigns signal numbers and sets the switches. Where it breaks down: real stations can transfer passengers between networks. InfiniBand fabrics in a NICo site stay separate, and traffic doesn't cross between them.

### Worked example: From hardware to discovery records to capabilities

**Step 1: Inventory the ports.**

A host has two dual-port ConnectX-6 cards. Linux shows four IB devices:
```text
ca:00.0  ibp202s0f0   cabled to IbFabric1
ca:00.1  ibp202s0f1   cabled to IbFabric2
ea:00.0  ibp234s0f0   cabled to IbFabric1
ea:00.1  ibp234s0f1   cabled to IbFabric2
```
The name encodes the PCI address: `p202` is bus 0xca in decimal (202), `s0` is slot 0, `f0`/`f1` is the function.

**Step 2: Write one discovery record per device.**

Each port becomes one record with its own GUID. In the design doc's proposed format (with `fabric` and `slot`):
```json
{"guid": "1111", "fabric": "IbFabric1", "pci_properties": {"slot": "0000:ca:00.0", "device": "MT28908 Family [ConnectX-6]"}}
```
...and the same again for `ca:00.1` (IbFabric2), `ea:00.0` (IbFabric1) and `ea:00.1` (IbFabric2).

**Step 3: Collapse into capabilities.**

Group by (device, fabric) and count:
```json
[
  {"type": "Infiniband", "name": "MT28908 Family [ConnectX-6]", "count": 2, "fabric": "IbFabric1"},
  {"type": "Infiniband", "name": "MT28908 Family [ConnectX-6]", "count": 2, "fabric": "IbFabric2"}
]
```
No GUIDs or slots appear here, so every machine with the same cabling reports identical capabilities.

**Step 4: Resolve a tenant selection.**

Request: `{device: ConnectX-6, fabric: IbFabric1, device_instance: 1}`.
The IbFabric1 matches sorted by slot are `0000:ca:00.0`, `0000:ea:00.0`. Index 1 is `ea:00.0`, which the tenant sees as `ibp234s0f0`.

### Your turn: finish it

Complete NICo-style device selection: filter by model and fabric, sort deterministically, then pick the n-th match.

```text
def select(devices, device, fabric, device_instance):
    matches = [d for d in devices
               if d["pci_properties"]["device"] == device and d["fabric"] == fabric]
    matches.sort(key=lambda d: ___)
    return matches[___]["guid"]
```

<details>
<summary>Answer</summary>

`d["pci_properties"]["slot"]` as the sort key, and `device_instance` as the index.

</details>

### Your turn: on your own

Hardware: GUID 1234 at slot 0000:cb:00.0 on IbFabric1; GUID 2345 at 0000:cd:00.0 on IbFabric2; GUID 3456 at 0000:ea:00.0 on IbFabric1; GUID 4567 at 0000:eb:00.0 on IbFabric2. All are ConnectX-6. (a) Which GUID does {fabric: IbFabric2, device_instance: 1} select? (b) A colleague suggests sorting by GUID instead. Give one case where that would select a different physical slot on another machine of the same instance type.

<details>
<summary>Hint 1</summary>

Only look at the IbFabric2 rows, then order them by slot.

</details>

<details>
<summary>Hint 2</summary>

For (b), imagine a second machine with the same slots but different GUIDs, because GUIDs come from the factory.

</details>

<details>
<summary>Hint 3</summary>

Suppose on machine 2 the card in slot cd has a *higher* GUID than the card in slot eb.

</details>

<details>
<summary>Answer</summary>

(a) The IbFabric2 devices sorted by slot are cd (2345), then eb (4567). Index 1 is GUID 4567. (b) On another machine, the GUIDs might be eb=1000 and cd=9000. Sorting by GUID would make instance 0 the eb slot on that machine but the cd slot on this one. The same tenant config would then hit different hardware. PCI slots are the same on every machine of the instance type, so sorting by slot keeps the selection consistent.

</details>

### Explain it

In your own words: Why does NICo let tenants select IB interfaces by (device, fabric, device_instance) instead of by GUID or MAC? What would break for a tenant who runs the same config on 100 instances?

### Check

**1. A host has one dual-port IB NIC with port 1 on IbFabric1 and port 2 on IbFabric2. How does the instance-type capability list represent it?**

A. One entry with count: 2 and two fabrics listed
B. Two entries, each with count: 1 and its own fabric
C. One entry with count: 1, because it is one physical card
D. Two entries that include each port's GUID

<details>
<summary>Answer</summary>

**B.** Two entries, each with count: 1 and its own fabric

Each port is a separate device, and capabilities are grouped by device and fabric. Different fabrics give separate entries. Counting the physical card is the misconception NICo's model avoids. GUIDs are left out because they differ per machine.

</details>

**2. Which statement about InfiniBand fabrics is correct?**

A. A host can only connect to one IB fabric
B. Each NIC port connects to one fabric, but a host can span several fabrics
C. Each port can join several fabrics at once through VLANs
D. IB fabrics are segments of the Ethernet underlay

<details>
<summary>Answer</summary>

**B.** Each NIC port connects to one fabric, but a host can span several fabrics

A port is cabled to a single switch, and that switch belongs to one fabric. Different ports can go to different fabrics. IB has nothing to do with VLANs or the Ethernet underlay.

</details>

**Sources:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md), [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md)

<a id="nvlink-scale-up-fabric"></a>
## 3. NVLink scale-up fabric

*Builds on: Network planes (Ethernet, InfiniBand, NVLink) (ch. 24)*

### Before you read

- In a GB200 NVL72 rack, roughly how many GPUs can talk to each other directly over NVLink without going through a network card?
- If the NVLink fabric in a rack is only partly formed, should NICo still hand that rack's hosts to a tenant who wants an NVLink partition?

<details>
<summary>Answers</summary>

- **In a GB200 NVL72 rack, roughly how many GPUs can talk to each other directly over NVLink without going through a network card?** All 72. The GPUs sit in 18 compute trays (4 per tray), and NVLink switch trays connect them all into one NVLink domain.
- **If the NVLink fabric in a rack is only partly formed, should NICo still hand that rack's hosts to a tenant who wants an NVLink partition?** No. NICo gates instance allocation on NVLink cluster readiness. If the fabric isn't healthy or fully formed, provisioning is blocked.

</details>

### Explanation

**NVLink** is NVIDIA's direct GPU-to-GPU interconnect. Its bandwidth per GPU is much higher than any NIC's. Inside a classic 8-GPU HGX server, NVSwitch chips on the board connect the GPUs. In rack-scale systems like **GB200 NVL72**, NVLink leaves the server: the 18 compute trays (4 GPUs each) are cabled to dedicated **NVLink switch trays**, which joins 72 GPUs into a single **NVLink domain**. This is **scale-up**: making one bigger GPU domain, as opposed to scaling out over InfiniBand.

A tenant usually needs only part of a domain, so the fabric is split into **NVLink partitions**. GPUs in one partition can reach each other over NVLink, and GPUs in different partitions cannot.

**Who manages it.** The NVLink switch trays run NVOS. Two services on the fabric matter here:
- **NMX-C** is the controller (fabric manager role). It forms the domain, reports GPU and controller health, and creates and changes partitions. NICo uses its gRPC API.
- **NMX-T** is the telemetry service. It runs only on the switch marked *primary*, and NICo checks that it is reachable on TCP port 9352 by default.

NICo doesn't deploy NMX-C. It consumes it.

**What NICo does on this plane:**
- Configures GPU membership in NVLink partitions through NMX-C when it provisions for a tenant.
- Gates allocation on fabric readiness, and batches GB200 allocations by NVL domain so NVLink topology stays intact.
- Monitors health with probes:
  - `NmxControllerHealth`: NMX-C reports the controller as Unhealthy.
  - `NvlinkUnhealthy`: a GPU is reported as `Degraded`, `NoNvlink` or `DegradedBw`. This blocks allocation.
  - `NmxcUnreachable`: NMX-C could not be used for 3 consecutive passes by default. A single failed pass is not reported. This is informational and does not block allocation.
  - `SwitchUnreachable` / `NmxtUnreachable`: the NVOS port or the NMX-T port does not accept TCP connections (also debounced, 3 consecutive failed checks by default).
- Isolates a host when needed (for example, a compute tray due for swap) by removing its GPUs from every partition.

**Analogy.** An NVLink domain is like a large open-plan office floor where any desk can talk to any other desk directly. Partitions are movable glass walls that split the floor into team rooms, and NMX-C is the facilities manager who moves the walls. Where it breaks down: office walls block sound only partly, whereas a partition is a hard boundary. GPUs outside it cannot exchange NVLink traffic at all.

### Worked example: Deciding whether a rack's hosts can be allocated

**Step 1: Identify the domain.**

Rack R3 is one GB200 NVL72 domain: 18 compute trays × 4 GPUs = 72 GPUs, connected by NVLink switch trays. One switch is marked primary, so it hosts NMX-T.

**Step 2: Check controller and reachability alerts.**

No `NmxcUnreachable` alert has been raised on R3. Remember what that does and doesn't mean: the alert needs 3 consecutive failed passes (by default), and a rack skipped by change detection is only checked at its full check (every 10m by default). So this tells you there has been no *sustained, detected* outage, not that NMX-C is reachable right now. The switches show no `SwitchUnreachable` alert, and the primary shows no `NmxtUnreachable`, with the same caveat.

**Step 3: Check GPU health.**

Host `tray-07` has an `NvlinkUnhealthy` alert with one entry: `target` = a GPU's NMX-C UID, `message` = `degraded_bw`. The alert carries `PreventAllocations`.

**Step 4: Decide.**

Normal allocation will skip `tray-07` until NMX-C reports that same GPU UID as `Healthy`. `Unknown`, or the GPU missing from the response, keeps it flagged. The other trays stay allocatable. Targeted allocation with `allow_unhealthy_machine` can bypass the check, but that is a deliberate operator decision.

### Your turn: finish it

Complete these helpers so they follow NICo's NvlinkUnhealthy rules. Each `___` sits inside existing quotes, so fill in just the word.

```text
UNHEALTHY = {"Degraded", "NoNvlink", "___"}

def raises_alert(state):
    return state in UNHEALTHY

def clears_existing_alert(state):
    # Unknown or absent keeps a flagged GPU flagged
    return state == "___"
```

<details>
<summary>Answer</summary>

DegradedBw completes the unhealthy set, and Healthy is the only state that clears an existing alert.

</details>

### Your turn: on your own

An operator sees `NmxcUnreachable` on rack R7, but none of R7's hosts have `NvlinkUnhealthy`, and normal allocations on R7 still succeed. They conclude that the NVLink fabric must be fine. What's wrong with that reasoning?

<details>
<summary>Hint 1</summary>

Check what classification NmxcUnreachable carries. Does it block allocations?

</details>

<details>
<summary>Hint 2</summary>

NvlinkUnhealthy is evaluated from NMX-C's GPU-health query. What happens to that query when NMX-C is unreachable?

</details>

<details>
<summary>Hint 3</summary>

Combine the two: missing alerts aren't evidence of health when the data source is down.

</details>

<details>
<summary>Answer</summary>

`NmxcUnreachable` carries only the `Hardware` classification, so it doesn't block allocations by itself. Allocations succeeding says nothing about fabric health. With NMX-C unreachable, the GPU-health query fails and the monitor can't re-evaluate, so `NvlinkUnhealthy` alerts are neither raised nor updated. Having no GPU alerts just means NICo has no current data. The operator should restore NMX-C connectivity before trusting the NVLink state.

</details>

### Explain it

In your own words: Why does NICo batch GB200 allocations by NVL domain and block provisioning when the NVLink fabric isn't fully formed, instead of handing out hosts one by one?

### Check

**1. Which NICo health probe blocks normal allocation of a host?**

A. NmxcUnreachable
B. NvlinkUnhealthy
C. NmxtUnreachable
D. SwitchUnreachable

<details>
<summary>Answer</summary>

**B.** NvlinkUnhealthy

`NvlinkUnhealthy` carries `PreventAllocations`. The reachability probes (`NmxcUnreachable`, `SwitchUnreachable`, `NmxtUnreachable`) carry only `Hardware` and do not block allocation. It's tempting to assume a controller outage blocks everything, but it doesn't.

</details>

**2. Why does only the primary NVLink switch ever get an NmxtUnreachable alert?**

A. Non-primary switches have no NVOS
B. Only switches marked is_primary host NMX-T
C. NICo only monitors one switch per rack
D. NMX-T runs on the compute trays

<details>
<summary>Answer</summary>

**B.** Only switches marked is_primary host NMX-T

NMX-T runs only on the primary switch, so only that switch is probed on the NMX-T port. Every switch in the `ready` state still gets `SwitchUnreachable` checks on its NVOS port.

</details>

**Sources:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md), [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md)

<a id="infiniband-guid-and-lid"></a>
## 4. InfiniBand GUID and LID

*Builds on: InfiniBand fabric (ch. 24)*

### Before you read

- An IB port has a 64-bit ID that was written in at the factory, and a 16-bit number it was given when it joined the network. Which one would you use to recognise the same port after the network is rebuilt?
- Could two ports on two different InfiniBand fabrics have the same LID?

<details>
<summary>Answers</summary>

- **An IB port has a 64-bit ID that was written in at the factory, and a 16-bit number it was given when it joined the network. Which one would you use to recognise the same port after the network is rebuilt?** The 64-bit factory ID, the GUID. The 16-bit LID is assigned by the subnet manager and can change.
- **Could two ports on two different InfiniBand fabrics have the same LID?** Yes. A LID is only unique inside one subnet, and each fabric's subnet manager assigns LIDs on its own.

</details>

### Explanation

InfiniBand gives every port two kinds of identifier. They do different jobs, much like a MAC address and an IP address on Ethernet.

**GUID (Globally Unique Identifier)** is a 64-bit ID, written in hex such as `0x0c42a10300aa00f1`. The manufacturer burns it in, so it stays the same whichever fabric the port is plugged into. There are several: a *node GUID* for the device, a *port GUID* per port, and a *system image GUID* shared by a card's devices. Virtual Functions (VFs) have no factory GUID, so software assigns them one. In NICo's design, NICo allocates the GUIDs for VF interfaces, and a configuration script provided through FMDS writes them where the OS expects them. Use the GUID for **identity**: it answers "which port is this?"

**LID (Local Identifier)** is a 16-bit address that the **subnet manager** assigns when the port comes up. Switches forward packets by destination LID, using tables the SM programs. Unicast LIDs run from 0x0001 to 0xBFFF. A LID of 0 means the SM hasn't assigned one yet, which usually means the port isn't active. A LID is only unique **within one subnet** and can change if the SM reassigns it. Use the LID for **routing** ("how do I reach it right now?"), never as a long-term key. (A 128-bit *GID*, made from the subnet prefix plus the port GUID, is used when addressing has to work beyond one subnet.)

**Where they show up in NICo:**
- Discovery records carry each device's `guid`.
- The `IbPortDown` health alert reports the **GUIDs** of ports that aren't active.
- The NIC-selection design sketches FMDS instance status that gives the tenant each interface's `guid`, `lid` and addresses, and proposes adding `pf_guid` for VFs. The exact format is still marked TBD in that doc.
- Tenant instance configs deliberately contain **no** GUIDs, so one config works across machines and still works after a NIC is replaced.

On Linux you can read both from sysfs (`/sys/class/infiniband/<dev>/node_guid` and `ports/1/lid`) or with `ibstat`.

**Analogy.** A GUID is like a person's passport number: issued once, the same in every country. A LID is like the room number a hotel front desk (the subnet manager) gives you at check-in. Staff use the room number to deliver things to you, but another hotel can give someone else the same number, and you might get a different room next time. Where it breaks down: a passport can be reissued, but a port's factory GUID never changes. A port also only ever stays at one hotel at a time, since it sits on one fabric.

### Worked example: Reading GUID and LID from sysfs

**Step 1: Build a fake sysfs entry.**

Your laptop has no IB hardware, so recreate the real file layout:
```bash
D=$(mktemp -d)/infiniband/ibp203s0f0
mkdir -p "$D/ports/1"
echo 0c42:a103:00aa:00f1 > "$D/node_guid"
echo 0x1a               > "$D/ports/1/lid"
echo "4: ACTIVE"         > "$D/ports/1/state"
echo 0x1                > "$D/ports/1/sm_lid"
```

**Step 2: Read the GUID.**

```bash
cat "$D/node_guid"            # 0c42:a103:00aa:00f1
tr -d ':' < "$D/node_guid"    # 0c42a10300aa00f1  (the form used in tools/APIs)
```

**Step 3: Read the LID and convert to decimal.**

```bash
printf '%d\n' "$(cat "$D/ports/1/lid")"   # 26
```
`ibstat` on a real host prints the same port as, for example:
```text
Node GUID: 0x0c42a10300aa00f1
Port 1:
    State: Active
    Base lid: 26
    SM lid: 1
    Port GUID: 0x0c42a10300aa00f1
```

**Step 4: Interpret.**

The GUID tells you *which port* this is, and it matches the `guid` in NICo's discovery data. The LID 26 tells you how switches in *this* subnet reach it, and SM lid 1 is the subnet manager's own address. If `state` were `1: DOWN`, the LID would usually be 0 and NICo would list this GUID in an `IbPortDown` alert.

### Your turn: finish it

Complete this parser for one sysfs IB device directory.

```text
from pathlib import Path

def read_port(dev_dir, port=1):
    p = Path(dev_dir) / "ports" / str(port)
    guid = (Path(dev_dir) / "node_guid").read_text().strip().replace(":", "")
    lid = int((p / "lid").read_text().strip(), ___)
    state = (p / "state").read_text().strip()
    return {"guid": guid, "lid": lid, "active": ___}
```

<details>
<summary>Answer</summary>

Use base `16` (sysfs writes the LID as hex, e.g. `0x1a`, and Python's `int("0x1a", 16)` accepts the prefix), and `"ACTIVE" in state` for the active flag (the file holds `4: ACTIVE` when up).

</details>

### Your turn: on your own

A tenant's MPI launcher has a hard-coded table mapping hostnames to LIDs. After the fabric team restarts UFM's subnet manager, some jobs can't connect. Another tenant on a different fabric reports a port with the same LID as one of yours. Explain both observations and say what the launcher should use instead.

<details>
<summary>Hint 1</summary>

Who assigns LIDs, and is that assignment guaranteed to stay the same?

</details>

<details>
<summary>Hint 2</summary>

What is the scope in which a LID is unique?

</details>

<details>
<summary>Hint 3</summary>

Which identifier stays fixed, and where can software on the host read the current LID at runtime?

</details>

<details>
<summary>Answer</summary>

The subnet manager assigns LIDs. After the SM restarted it handed out LIDs again, and some changed, so the hard-coded table went stale. LIDs are only unique within one subnet, so a port on a different fabric can legitimately have the same LID. The launcher should identify ports by GUID and look up the current LID at runtime, for example from `ibstat` or `/sys/class/infiniband/<dev>/ports/1/lid` on the host. (NICo's design also sketches FMDS returning a `lid` next to each interface's `guid`.)

</details>

### Explain it

In your own words: Why does NICo report port GUIDs (not LIDs) in IbPortDown alerts and discovery data, even though tenants still need the LID at runtime?

### Check

**1. Who assigns an InfiniBand port's LID?**

A. The NIC manufacturer, at the factory
B. The subnet manager of the fabric
C. NICo, from an IP address pool
D. The tenant OS driver

<details>
<summary>Answer</summary>

**B.** The subnet manager of the fabric

The SM (for example, the one UFM runs) assigns LIDs. The manufacturer sets the GUID, not the LID. NICo does allocate VF GUIDs, but it doesn't hand out LIDs from its pools.

</details>

**2. A port's sysfs lid file reads 0x0. What's the most likely meaning?**

A. The port is the subnet manager
B. The port hasn't been assigned a LID, typically because it isn't active
C. It is a multicast port
D. LID 0 is the first normal unicast address

<details>
<summary>Answer</summary>

**B.** The port hasn't been assigned a LID, typically because it isn't active

LID 0 is reserved and means "not assigned". Unicast LIDs start at 0x0001. The SM's own LID shows up in `sm_lid`, and it is not zero.

</details>

**3. Why do NICo tenant instance configs leave out GUIDs?**

A. GUIDs are secret
B. Configs must work across all machines of an instance type and keep working after hardware is replaced
C. GUIDs change on every reboot
D. UFM does not use GUIDs

<details>
<summary>Answer</summary>

**B.** Configs must work across all machines of an instance type and keep working after hardware is replaced

GUIDs are stable but specific to each card, so a config keyed on them couldn't be shared between machines and would break when a NIC is swapped. GUIDs do not change on reboot. That is a property of LIDs, which can change when the SM reassigns them.

</details>

**Sources:** [architecture/infiniband/nic_selection.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/infiniband/nic_selection.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

<a id="static-network-fabric-principle"></a>
## 5. Static network fabric principle

*Builds on: BlueField DPU (ch. 7), Multi-tenancy (ch. 23)*

### Before you read

- When a host moves from tenant A to tenant B, do you think someone needs to push a new config to the leaf switch it's cabled to?
- If the leaf switch config doesn't change, how can the network learn that tenant B's routes now live behind this host?

<details>
<summary>Answers</summary>

- **When a host moves from tenant A to tenant B, do you think someone needs to push a new config to the leaf switch it's cabled to?** No. In NICo, leaf and spine switches are never reconfigured for tenant changes. The DPU changes its HBN configuration, and the IB and NVLink fabric managers change partitions through their APIs.
- **If the leaf switch config doesn't change, how can the network learn that tenant B's routes now live behind this host?** Dynamically, through BGP EVPN. The DPU advertises tenant B's routes and withdraws tenant A's. The fabric learns routes at runtime while its configuration stays the same.

</details>

### Explanation

NICo's fifth operational principle: **the network fabric stays static even during tenancy changes.** Leaf switches, spine switches and routers are *not* reconfigured when tenants change, or when hosts are provisioned and released. All tenant isolation happens in two places:

1. **On the DPU** (Ethernet). BlueField HBN builds the tenant's VRFs and VXLAN/EVPN overlay on the host's own DPU (ch. 7, 11). Leaf switches need no configuration changes.
2. **Through fabric manager APIs.** UFM assigns InfiniBand P_Key partitions, NMX-C sets NVLink partition membership, and Spectrum-X uses SP-X partitioning.

**What changes and what doesn't.** On a tenant change, the DPU's desired config changes. The DPU agent picks it up when it polls every 30 seconds and applies it through HBN. The DPU then advertises the new tenant's EVPN routes and withdraws the old ones. So the *routing state* in the fabric changes, which is normal BGP behaviour. The *switch configuration* does not.

**Why build it this way:**
- **Lower risk.** A bad tenant change can only affect one DPU, not a switch that hundreds of hosts depend on.
- **Scale.** Thousands of provisioning events don't turn into thousands of switch config pushes.
- **Clear ownership.** The network team owns the leaf/spine/router configuration, cabling, UFM and NMX-C deployment. NICo owns tenant isolation.
- **Zero trust.** The DPU, not the host, enforces the boundary. On release it fails closed: it goes back to the admin overlay, and NICo doesn't report the release complete until the DPU confirms it has left all tenant networks.

**What the principle doesn't cover.** NICo does interact with some switches during *bring-up and maintenance*. For example, it installs certificates on NVLink switches and rotates their NVOS admin password during switch ingestion. That is part of the infrastructure lifecycle, not a per-tenant change.

**Analogy.** In a hotel, guests change every day, but nobody moves walls or rewires the corridors. Front desk reprograms the key cards (DPU config, partition membership), and the corridors (leaf/spine) stay exactly as they were. Where it breaks down: a key card is only checked at the door, while a DPU inspects and routes every packet. Also, the fabric's routing tables do change dynamically as the DPU advertises routes, which would be like corridor signs updating themselves.

### Worked example: Diffing a tenant change across all planes

**Step 1: State the change.**

Host `h01` moves from tenant **acme** (VRF `acme-vrf`, P_Key `0x8001`, NVLink partition `acme-nvl`) to tenant **globex** (VRF `globex-vrf`, P_Key `0x8002`, partition `globex-nvl`).

**Step 2: Ethernet plane.**

The DPU's desired HBN config drops `acme-vrf` and adds `globex-vrf` and its VNI. The DPU withdraws acme's EVPN routes and advertises globex's. Leaf switches learn the new routes through BGP, and their config stays the same.

**Step 3: InfiniBand plane.**

Through UFM, h01's port GUIDs are removed from P_Key `0x8001` and added to `0x8002`. (Release also includes an InfiniBand device reset.)

**Step 4: NVLink plane.**

Through NMX-C, h01's GPUs leave partition `acme-nvl` and join `globex-nvl`.

**Step 5: Prove the leaf is untouched.**

Treat the leaf's config as a file you hash before and after:
```bash
printf 'router:\n  bgp:\n    autonomous-system: 65101\n' > leaf01.yaml
before=$(cat leaf01.yaml | sha256sum)   # macOS: shasum -a 256
# ... tenant change happens on the DPU and through UFM/NMX-C ...
after=$(cat leaf01.yaml | sha256sum)
[ "$before" = "$after" ] && echo "leaf config unchanged"
```

### Your turn: finish it

Complete this function so it lists the actions for a tenant change and makes the static-fabric rule explicit. The first `___` sits inside existing quotes; the second is a bare Python value.

```text
def tenant_change_actions(old, new):
    return {
        "dpu_hbn": f"remove VRF {old['vrf']}, add VRF {new['vrf']}",
        "ufm": f"move port GUIDs from P_Key {old['pkey']} to {new['pkey']}",
        "___": f"move GPUs from partition {old['nvl']} to {new['nvl']}",
        "leaf_switch_config": ___,
    }
```

<details>
<summary>Answer</summary>

Use the key nmx_c for the NVLink action (giving `"nmx_c"`), and `None` (no change) for `leaf_switch_config`.

</details>

### Your turn: on your own

A network engineer proposes: "For extra safety, let's also put each tenant on its own VLAN on the leaf switch ports whenever NICo provisions a host." Give three concrete reasons this works against NICo's design, and say where the isolation they want already happens.

<details>
<summary>Hint 1</summary>

Think about what happens across thousands of provision/release events.

</details>

<details>
<summary>Hint 2</summary>

Who owns leaf configuration according to NICo's scope boundaries, and what happens to the blast radius when it changes?

</details>

<details>
<summary>Hint 3</summary>

Where is the zero-trust enforcement point, and what does NICo already do on the leaf-facing side?

</details>

<details>
<summary>Answer</summary>

(1) It turns every provisioning event into a switch config push, and at scale that becomes a large, risky change stream. (2) It expands the blast radius: one bad push can disrupt every host on that leaf, while a DPU change only affects one host. It also blurs ownership, since leaf/spine configuration belongs to the network team, not to NICo. (3) It's redundant and moves enforcement away from the trust anchor: the DPU already isolates the tenant with HBN VRFs and VXLAN/EVPN, independently of the host, and fails closed to the admin overlay on release. The fabric only needs to carry the underlay and learn the EVPN routes the DPU advertises.

</details>

### Explain it

In your own words: In your own words: how can the fabric's routing state change on every tenant change while NICo still claims the fabric is static? What exactly is held constant?

### Check

**1. Which of these happens on a NICo tenant change?**

A. The leaf switch gets a new per-tenant VRF stanza
B. The DPU's HBN config changes and its EVPN route advertisements change
C. The spine switches are rebooted to clear old routes
D. The network team edits UFM's subnet manager config by hand

<details>
<summary>Answer</summary>

**B.** The DPU's HBN config changes and its EVPN route advertisements change

Isolation is set up on the DPU, and routes change dynamically through BGP EVPN. Leaf and spine switches don't get per-tenant config. UFM partitions are changed through its API, not by hand.

</details>

**2. During switch ingestion, NICo installs TLS certificates on NVLink switches. Does that violate the static network fabric principle?**

A. Yes, NICo should never touch any switch
B. No, the principle is about tenant changes; bring-up and maintenance are infrastructure lifecycle
C. Yes, but only because the switches are NVLink switches
D. No, because certificates are not configuration

<details>
<summary>Answer</summary>

**B.** No, the principle is about tenant changes; bring-up and maintenance are infrastructure lifecycle

The principle says switches aren't reconfigured *when tenants change*. Certificate installation and password rotation happen during switch bring-up and maintenance, not per tenant. Certificates are still configuration, so that answer gives the wrong reason.

</details>

**Sources:** [overview/operational-principles.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/operational-principles.md), [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [architecture/state_machines/switch_configure_certificate.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch_configure_certificate.md)

<a id="build-task"></a>
## Build task: Multi-plane isolation planner on a fake InfiniBand host

**Goal:** Build a small Python tool that inventories a simulated host's InfiniBand devices from a sysfs-style tree (GUID, LID, state, PCI slot), resolves tenant (device, fabric, device_instance) selections the way NICo's NIC-selection design does, and writes a per-plane isolation plan for two successive tenants. A hash check proves the leaf switch config never changes.

**Why it matters for NICo:** Before NICo hands out a host, it must isolate the tenant on every plane the host is cabled to: DPU HBN for Ethernet, UFM P_Keys for InfiniBand, NMX-C partitions for NVLink. It does this without touching leaf or spine switches. This build has you resolve ports to GUIDs, tell identity (GUID) from routing (LID), spot inactive ports the way IbPortDown does, and check that a tenant change leaves the switch configuration alone. Note: the plan files you write are a teaching simulation, not NICo, UFM or NMX-C API formats.

**You need:**

- Linux or macOS shell (bash or zsh)
- Python 3.8+ (no extra packages)
- sha256sum (Linux) or shasum -a 256 (macOS)
- An empty working directory, e.g. mkdir ~/gpu-fabrics && cd ~/gpu-fabrics

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Create a fake sysfs with four IB devices</summary>

Save as `make_fake_sysfs.sh` and run `bash make_fake_sysfs.sh`. It mirrors the real layout of `/sys/class/infiniband/<dev>/{node_guid,device,ports/1/lid,ports/1/state}`. The GUIDs are deliberately *not* in slot order.
```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT=${1:-./fakesys}
rm -rf "$ROOT"
mk() { # name slot guid lid state
  local name=$1 slot=$2 guid=$3 lid=$4 state=$5
  mkdir -p "$ROOT/devices/$slot" "$ROOT/class/infiniband/$name/ports/1"
  ln -s "../../../devices/$slot" "$ROOT/class/infiniband/$name/device"
  echo "$guid"  > "$ROOT/class/infiniband/$name/node_guid"
  echo "$lid"   > "$ROOT/class/infiniband/$name/ports/1/lid"
  echo "$state" > "$ROOT/class/infiniband/$name/ports/1/state"
  echo "MT28908 Family [ConnectX-6]" > "$ROOT/devices/$slot/label"
}
mk ibp203s0f0 0000:cb:00.0 0c42:a103:00aa:00f1 0x1a "4: ACTIVE"
mk ibp205s0f0 0000:cd:00.0 0c42:a103:00aa:00b2 0x1b "4: ACTIVE"
mk ibp234s0f0 0000:ea:00.0 0c42:a103:00aa:0031 0x2c "4: ACTIVE"
mk ibp235s0f0 0000:eb:00.0 0c42:a103:00aa:0042 0x0  "1: DOWN"
echo "created $ROOT"
```
Check: `ls fakesys/class/infiniband` shows four devices. Running `cat fakesys/class/infiniband/ibp235s0f0/ports/1/lid` prints `0x0`, an unassigned LID.

</details>

<details>
<summary>Step 2: Describe which fabric each port is cabled to</summary>

NICo's NIC-selection design points out that software on the host can't work out which fabric a port is cabled to. How NICo itself learns the port-to-fabric mapping isn't covered in this chapter, so in this lab you supply it as a file. Create `fabrics.json`, keyed by GUID:
```json
{
  "0c42a10300aa00f1": "IbFabric1",
  "0c42a10300aa00b2": "IbFabric2",
  "0c42a10300aa0031": "IbFabric1",
  "0c42a10300aa0042": "IbFabric2"
}
```

</details>

<details>
<summary>Step 3: Write the inventory and selector</summary>

Save as `inventory.py`:
```python
#!/usr/bin/env python3
import json
import sys
from pathlib import Path


def inventory(sys_root, fabric_map):
    out = []
    for dev in sorted((Path(sys_root) / "class" / "infiniband").iterdir()):
        port = dev / "ports" / "1"
        guid = (dev / "node_guid").read_text().strip().replace(":", "")
        pci = (dev / "device").resolve()
        state = (port / "state").read_text().strip()
        out.append({
            "name": dev.name,
            "guid": guid,
            "lid": int((port / "lid").read_text().strip(), 16),
            "active": "ACTIVE" in state,
            "fabric": fabric_map.get(guid, ""),
            "pci_properties": {
                "slot": pci.name,
                "device": (pci / "label").read_text().strip(),
            },
        })
    return out


def select(devices, device, fabric, device_instance):
    matches = [d for d in devices
               if d["pci_properties"]["device"] == device and d["fabric"] == fabric]
    matches.sort(key=lambda d: d["pci_properties"]["slot"])
    if device_instance >= len(matches):
        raise SystemExit(f"no instance {device_instance} of {device} on {fabric}")
    return matches[device_instance]


if __name__ == "__main__":
    sys_root, fabric_file = sys.argv[1], sys.argv[2]
    devs = inventory(sys_root, json.loads(Path(fabric_file).read_text()))
    if len(sys.argv) == 3:
        print(json.dumps(devs, indent=2))
    elif sys.argv[3] == "--down":
        for d in devs:
            if not d["active"]:
                print("port not active:", d["guid"], d["name"])
    else:
        d = select(devs, sys.argv[3], sys.argv[4], int(sys.argv[5]))
        print(d["guid"], d["name"], d["pci_properties"]["slot"], "lid", d["lid"])
```
Try it:
```bash
python3 inventory.py fakesys fabrics.json
python3 inventory.py fakesys fabrics.json --down
python3 inventory.py fakesys fabrics.json "MT28908 Family [ConnectX-6]" IbFabric1 1
```
The last command should print `0c42a10300aa0031 ibp234s0f0 0000:ea:00.0 lid 44`.

</details>

<details>
<summary>Step 4: Create the leaf config and two tenants</summary>

The leaf file stands in for a switch config owned by the network team. Make it read-only:
```bash
cat > leaf01.yaml <<'EOF'
# Stand-in for the leaf switch startup config. Owned by the network team.
interface:
  swp1:
    description: dpu-host01-p0
  swp2:
    description: dpu-host01-p1
router:
  bgp:
    autonomous-system: 65101
EOF
chmod a-w leaf01.yaml
sha256sum leaf01.yaml > leaf01.sha256   # macOS: shasum -a 256 leaf01.yaml > leaf01.sha256
```
Create `acme.json`:
```json
{"tenant": "acme", "vrf": "acme-vrf", "vni": 50001, "pkey": "0x8001",
 "nvlink_partition": "acme-nvl-0", "gpus": ["GPU-0", "GPU-1", "GPU-2", "GPU-3"],
 "ib_interfaces": [
   {"device": "MT28908 Family [ConnectX-6]", "fabric": "IbFabric1", "device_instance": 0},
   {"device": "MT28908 Family [ConnectX-6]", "fabric": "IbFabric2", "device_instance": 0}]}
```
And `globex.json`, which uses instance 1 on both fabrics:
```json
{"tenant": "globex", "vrf": "globex-vrf", "vni": 50002, "pkey": "0x8002",
 "nvlink_partition": "globex-nvl-0", "gpus": ["GPU-0", "GPU-1", "GPU-2", "GPU-3"],
 "ib_interfaces": [
   {"device": "MT28908 Family [ConnectX-6]", "fabric": "IbFabric1", "device_instance": 1},
   {"device": "MT28908 Family [ConnectX-6]", "fabric": "IbFabric2", "device_instance": 1}]}
```

</details>

<details>
<summary>Step 5: Write the per-plane planner</summary>

Save as `plan.py` in the same directory. It writes one file per plane and never touches the leaf config:
```python
#!/usr/bin/env python3
import json
import sys
from pathlib import Path

from inventory import inventory, select

sys_root, fabric_file, tenant_file, out_dir = sys.argv[1:5]
devs = inventory(sys_root, json.loads(Path(fabric_file).read_text()))
t = json.loads(Path(tenant_file).read_text())
out = Path(out_dir) / t["tenant"]
out.mkdir(parents=True, exist_ok=True)

ports = [select(devs, i["device"], i["fabric"], i["device_instance"])
         for i in t["ib_interfaces"]]
plan = {
    "dpu_hbn.json": {"plane": "ethernet", "vrf": t["vrf"], "l3vni": t["vni"]},
    "ufm.json": {"plane": "infiniband", "pkey": t["pkey"],
                 "port_guids": [p["guid"] for p in ports]},
    "nmxc.json": {"plane": "nvlink", "partition": t["nvlink_partition"],
                  "gpus": t["gpus"]},
}
for name, body in plan.items():
    (out / name).write_text(json.dumps(body, indent=2) + "\n")
    print(f"wrote {out / name}")
down = [p["guid"] for p in ports if not p["active"]]
if down:
    print("WARNING: selected IB ports not ACTIVE:", ", ".join(down))
```
Run both tenants in turn, as if the host were released by acme and given to globex:
```bash
python3 plan.py fakesys fabrics.json acme.json out
python3 plan.py fakesys fabrics.json globex.json out
```
globex should print a WARNING for `0c42a10300aa0042`. That is the DOWN port, and in NICo an `IbPortDown` alert would block allocation.

</details>

<details>
<summary>Step 6: Compare the two tenants plane by plane</summary>

```bash
diff out/acme/dpu_hbn.json out/globex/dpu_hbn.json
diff out/acme/ufm.json out/globex/ufm.json
diff out/acme/nmxc.json out/globex/nmxc.json
```
All three plane files differ between the tenants: VRF/VNI, P_Key plus port GUIDs, and the NVLink partition. (`diff` exits non-zero when files differ; that's expected here.) Then check the leaf config:
```bash
sha256sum -c leaf01.sha256     # macOS: shasum -a 256 -c leaf01.sha256
```
It should report `leaf01.yaml: OK`.

</details>

**Check it works:** From the working directory, run: `python3 plan.py fakesys fabrics.json acme.json out && python3 plan.py fakesys fabrics.json globex.json out && grep -h -A3 port_guids out/acme/ufm.json out/globex/ufm.json && sha256sum -c leaf01.sha256` (on macOS use `shasum -a 256 -c leaf01.sha256`). You're done when: acme's port_guids are `0c42a10300aa00f1` and `0c42a10300aa00b2`; globex's are `0c42a10300aa0031` and `0c42a10300aa0042`; the globex run prints a WARNING for `0c42a10300aa0042`; and the checksum line reads `leaf01.yaml: OK`.

<details>
<summary>If you get stuck</summary>

- `ln: ... File exists`: run make_fake_sysfs.sh again. It deletes ./fakesys first. If you passed a custom path, pass the same one again.
- `ModuleNotFoundError: No module named 'inventory'`: run plan.py from the directory that contains inventory.py. Python puts the script's own directory on the import path.
- `no instance 0 of MT28908 ... on IbFabric1`: the device name must match the label exactly, including the brackets. Quote it in the shell. Also check that fabrics.json uses GUIDs *without* colons.
- If your selections come out as 0031/0042 for acme, you sorted by GUID instead of by `pci_properties.slot`. Slot order (cb, cd, ea, eb) is what makes the choice the same on every machine.
- `ValueError: invalid literal for int()` on the LID: sysfs LIDs are hex (`0x1a`). Parse them with `int(text, 16)`, not `int(text)`.
- On macOS, `sha256sum` may be missing. Use `shasum -a 256` both to create and to check the .sha256 file.

</details>

**Stretch goal:** Add a second fake host (`fakesys2`) with the same slots and fabric cabling but completely different GUIDs (and a matching `fabrics2.json`). Write `capabilities.py`, which groups devices by (device, fabric) into `{type: Infiniband, name, count, fabric}` entries with no GUIDs or slots. Show that both hosts produce byte-identical capability JSON, while acme.json resolves to different GUIDs on each host but the same PCI slots. As a further step, make the planner refuse (exit non-zero) any selection that lands on an inactive port, the way IbPortDown keeps a host out of allocation.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (Network planes (Ethernet, InfiniBand, NVLink)): The explanation says the OOB management network is used only by NICo and that "tenants never get to it." That is too absolute: what-is-nico.md says recursive DNS (unbound) is provided "to managed machines and tenant instances via the OOB network." *Fix:* Soften it. For example: "The OOB management network (BMCs, DPU OOB ports) is not a tenant data plane. NICo uses it to manage hardware, and tenants cannot reach BMCs or management interfaces through it (some site services such as recursive DNS are reached over it)." Alternatively, just drop "tenants never get to it."

---

[← 23-nico-architecture-bluefield-dpu.md](23-nico-architecture-bluefield-dpu.md) · [25-observability.md →](25-observability.md)
