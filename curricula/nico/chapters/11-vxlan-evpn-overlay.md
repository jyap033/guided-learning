# Chapter 11: VXLAN/EVPN Overlay

*Part: Networking & Isolation · 7 concepts · [curriculum](../curriculum.md#chapter-11)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Chapter 9 gave you a routed **underlay**: DPUs peer with top-of-rack switches over eBGP and advertise their `/32` loopbacks. Chapter 10 showed how a DPU splits one physical port into PFs, VFs and SFs and how NICo hands out addresses from pools. This chapter covers the layer on top of that: the **overlay** that gives each tenant a private network across a shared, routed fabric.

You'll start at the hardware. The Mellanox firmware tools (`mst`, `mlxconfig`) inspect and change ConnectX/BlueField firmware settings, such as how many VFs a card exposes. Then you'll work through the overlay pieces in order. A **VRF** gives a tenant its own routing table. **VXLAN** wraps tenant Ethernet frames in UDP so they can cross the underlay, and a **VNI** labels which overlay each frame belongs to. **EVPN** is the BGP address family that tells every VTEP where each tenant address lives. **L2VNI/L3VNI** planning and **route targets** decide which VRFs can see which routes.

NICo needs all of this because tenant isolation on Ethernet is done by BlueField HBN on the DPU, using L3 VXLAN/EVPN and per-tenant VRFs. NICo never reconfigures the leaf switches. The network prerequisites ask you for datacenter-unique VNIs, an EVPN peering design and agreed route-target values before you deploy, so you need to read and plan these things yourself.

The chapter ends with a laptop lab. You'll build two "DPUs" as Linux network namespaces, give two tenants the *same* IP addresses, and watch VXLAN with separate VNIs and VRFs keep them apart.

**By the end of this chapter you can:**

- Use mst and mlxconfig to query and change ConnectX/BlueField firmware settings, and explain when those changes take effect
- Create Linux VRFs and show that overlapping tenant prefixes stay in separate routing tables
- Build and decode a VXLAN header, and work out the encapsulation overhead and its effect on MTU
- Explain how EVPN route types fill a VTEP's forwarding state, and describe NICo's two EVPN peering options
- Plan datacenter-unique L2VNI/L3VNI allocations and route-target import/export policies that match NICo's conventions
- Build a two-tenant VXLAN overlay on a laptop and prove the tenants are isolated

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [Mellanox firmware tools (mlxconfig, mst)](#mellanox-firmware-tools)
2. [VRF](#vrf)
3. [VXLAN and VNI](#vxlan-and-vni)
4. [VXLAN / EVPN](#vxlan-evpn)
5. [EVPN](#evpn)
6. [VNI (L2VNI / L3VNI)](#vni)
7. [Route targets (import/export)](#route-targets)
8. [Build task: Two tenants, same IPs: a VXLAN + VRF overlay on your laptop](#build-task)

<a id="mellanox-firmware-tools"></a>
## 1. Mellanox firmware tools (mlxconfig, mst)

*Builds on: PF and VF (SR-IOV) (ch. 10)*

### Before you read

- You run `mlxconfig ... set NUM_OF_VFS=16` on a ConnectX card and immediately check `/sys/class/net/<pf>/device/sriov_totalvfs`. Will it say 16?
- A dual-port card appears as PCI functions 03:00.0 and 03:00.1. Do you have to configure firmware settings separately through each function?

<details>
<summary>Answers</summary>

- **You run `mlxconfig ... set NUM_OF_VFS=16` on a ConnectX card and immediately check `/sys/class/net/<pf>/device/sriov_totalvfs`. Will it say 16?** No. mlxconfig writes to the card's non-volatile configuration as the 'Next Boot' value. The firmware only reads it on its next load (after a firmware reset or a cold reboot), so the OS keeps seeing the old value until then.
- **A dual-port card appears as PCI functions 03:00.0 and 03:00.1. Do you have to configure firmware settings separately through each function?** Usually not. mlxconfig works on the physical card, and either PF reaches the same settings store. Settings that really are per port carry a suffix such as LINK_TYPE_P1 or LINK_TYPE_P2.

</details>

### Explanation

In Chapter 10 you split a physical port into a **PF** (physical function) and **VFs** (virtual functions) with SR-IOV. One step is easy to miss. The *OS* can only create as many VFs as the *NIC firmware* allows, and that limit lives in a configuration store on the card itself, not in Linux.

NVIDIA's **Mellanox Firmware Tools (MFT)** are the standard CLI for that store on ConnectX NICs and BlueField DPUs:

- **`mst`** (Mellanox Software Tools service). `mst start` loads the access drivers and creates device nodes such as `/dev/mst/mt4125_pciconf0`. `mst status -v` lists each card with its PCI address. The number in the name is the device ID, for example mt4125 is ConnectX-6 Dx and mt41686 is BlueField-2.
- **`mlxconfig`** reads and writes firmware parameters: `mlxconfig -d <device> query [PARAMS]` and `mlxconfig -d <device> set PARAM=VALUE`. `<device>` can be an mst node or a PCI address such as `03:00.0`.
- **`mlxfwreset`** reloads the firmware so new settings take effect without a full power cycle, if the platform supports it.
- **`flint`** queries and burns firmware images. You only need `flint -d <dev> query` here, to read the firmware version.

Some parameters you'll meet often:

| Parameter | Meaning |
|---|---|
| `SRIOV_EN` | SR-IOV on/off in firmware |
| `NUM_OF_VFS` | maximum VFs the firmware will expose per PF |
| `LINK_TYPE_P1`, `LINK_TYPE_P2` | per port: 1 = InfiniBand, 2 = Ethernet (on VPI cards) |

Two habits prevent most mistakes:

1. **Settings are per physical card, and they apply at next boot.** `mlxconfig -e query` shows *Default*, *Current* and *Next Boot* columns. After a `set`, only *Next Boot* changes until you run `mlxfwreset` or cold-reboot.
2. **Firmware limit ≠ OS state.** `NUM_OF_VFS=8` lets you create up to 8 VFs. You still create them in Linux with `echo 8 > /sys/class/net/<pf>/device/sriov_numvfs`.

NICo's docs describe a BlueField reporting its operating mode (`Dpu` or `Nic`) through its BMC, and NICo deciding whether a card needs reconfiguring. Card-level firmware settings like these sit underneath that. Chapter 43 covers how NICo sequences NIC firmware work.

**Analogy.** mlxconfig is like the BIOS setup screen, but for the network card. You change a setting, it's saved, and it only applies after a restart. The analogy stops there: the settings live on the card, so they move with it to another server, and you change them from the running OS without opening any setup screen.

### Worked example: Enable 8 VFs on a ConnectX-6 Dx (reading real-format output)

**Step 1: Find the card.**

You need real hardware for these commands. On a laptop, just read the output.
```sh
sudo mst start
sudo mst status -v
```
Sample output:
```
DEVICE_TYPE      MST                          PCI       RDMA    NET               NUMA
ConnectX6DX(rev:0) /dev/mst/mt4125_pciconf0.1 03:00.1   mlx5_1  net-enp3s0f1np1   0
ConnectX6DX(rev:0) /dev/mst/mt4125_pciconf0   03:00.0   mlx5_0  net-enp3s0f0np0   0
```
Two PCI functions, one card (`mt4125_pciconf0`).

**Step 2: Query the current settings.**

```sh
sudo mlxconfig -d /dev/mst/mt4125_pciconf0 query SRIOV_EN NUM_OF_VFS LINK_TYPE_P1
```
```
Configurations:                              Next Boot
        SRIOV_EN                            False(0)
        NUM_OF_VFS                          0
        LINK_TYPE_P1                        ETH(2)
```

**Step 3: Stage the change.**

```sh
sudo mlxconfig -d /dev/mst/mt4125_pciconf0 set SRIOV_EN=1 NUM_OF_VFS=8
```
It shows the old and new values and asks `Apply new Configuration? (y/n)`. Add `-y` to skip the prompt in scripts. The output ends with a reminder that a reboot is needed for the new configuration to take effect.

**Step 4: Apply it and check all three columns.**

```sh
sudo mlxfwreset -d /dev/mst/mt4125_pciconf0 reset   # or cold-reboot the server
sudo mlxconfig -d /dev/mst/mt4125_pciconf0 -e query NUM_OF_VFS
```
After the reset, *Current* and *Next Boot* both show 8.

**Step 5: Create the VFs in the OS.**

```sh
echo 8 | sudo tee /sys/class/net/enp3s0f0np0/device/sriov_numvfs
lspci | grep -i 'virtual function'
```
The firmware allowed 8 VFs, and Linux has now created them.

### Your turn: finish it

You want port 1 of a VPI card at PCI address 0000:03:00.0 to run Ethernet. Fill in the blanks so the command runs without a confirmation prompt.

```text
sudo mlxconfig -y -d 0000:03:00.0 ___ LINK_TYPE_P1=___
# then: sudo mlxfwreset -d 0000:03:00.0 reset   (or cold reboot)
```

<details>
<summary>Answer</summary>

`set` and `2`: `sudo mlxconfig -y -d 0000:03:00.0 set LINK_TYPE_P1=2`. The value 2 means ETH and 1 means IB. The change is only staged as Next Boot until the firmware reset or a reboot.

</details>

### Your turn: on your own

No card on your laptop? Write a Python script that parses `mlxconfig query` output and reports every parameter that doesn't match a baseline `{"SRIOV_EN": "1", "NUM_OF_VFS": "16", "LINK_TYPE_P1": "2"}`. Test it on this sample (save it as `sample.txt`):
```
Device #1:
----------

Device type:    ConnectX6DX
Device:         /dev/mst/mt4125_pciconf0

Configurations:                              Next Boot
        SRIOV_EN                            True(1)
        NUM_OF_VFS                          8
        LINK_TYPE_P1                        ETH(2)
```

<details>
<summary>Hint 1</summary>

Everything after the line that starts with `Configurations:` is a name followed by a value.

</details>

<details>
<summary>Hint 2</summary>

Values look like `True(1)` or `ETH(2)` or plain `8`. If there is a number in parentheses, compare that number.

</details>

<details>
<summary>Hint 3</summary>

Use `re.match(r"\s+(\w+)\s+(\S+)", line)` for each config line, then `re.search(r"\((\d+)\)", value)` to pull out the number.

</details>

<details>
<summary>Answer</summary>

```python
import re
import sys

BASELINE = {"SRIOV_EN": "1", "NUM_OF_VFS": "16", "LINK_TYPE_P1": "2"}

def parse(text):
    cfg, in_cfg = {}, False
    for line in text.splitlines():
        if line.startswith("Configurations:"):
            in_cfg = True
            continue
        if in_cfg:
            m = re.match(r"\s+(\w+)\s+(\S+)", line)
            if m:
                name, val = m.groups()
                num = re.search(r"\((\d+)\)", val)
                cfg[name] = num.group(1) if num else val
    return cfg

cfg = parse(open(sys.argv[1]).read())
for k, want in BASELINE.items():
    have = cfg.get(k)
    if have != want:
        print(f"DRIFT {k}: have {have}, want {want}")
```
Run it with `python3 check.py sample.txt`. It prints `DRIFT NUM_OF_VFS: have 8, want 16`.

</details>

### Explain it

In your own words: Why does it matter that `NUM_OF_VFS` is stored on the card and not in the server's OS? Think about what happens when a card is moved to another server, and when someone reinstalls the OS.

### Check

**1. You ran `mlxconfig set NUM_OF_VFS=8` and haven't rebooted. Which `mlxconfig -e query` column shows 8?**

A. Default
B. Current
C. Next Boot
D. All three

<details>
<summary>Answer</summary>

**C.** Next Boot

`set` stages the value in non-volatile config for the next firmware load. *Current* only changes after `mlxfwreset` or a reboot. *Default* is the factory value and never changes.

</details>

**2. Firmware has `NUM_OF_VFS=8`, but `lspci` shows no virtual functions. What is the most likely reason?**

A. The firmware setting didn't apply
B. Nobody has written a count to sriov_numvfs in Linux yet
C. VFs only appear on the second PF
D. mst wasn't started

<details>
<summary>Answer</summary>

**B.** Nobody has written a count to sriov_numvfs in Linux yet

The firmware value is a ceiling. The OS creates VFs when you write to `sriov_numvfs`. mst only provides tool access and doesn't affect whether the OS sees VFs.

</details>

**Sources:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="vrf"></a>
## 2. VRF

*Builds on: IP networking fundamentals (ch. 3)*

### Before you read

- Two tenants both want to use 10.10.0.0/24. Can one Linux router hold a route to 10.10.0.0/24 for each tenant, pointing out of different interfaces, without the routes conflicting?
- If a packet arrives on an interface that belongs to tenant A's VRF, which routing table is used to forward it?

<details>
<summary>Answers</summary>

- **Two tenants both want to use 10.10.0.0/24. Can one Linux router hold a route to 10.10.0.0/24 for each tenant, pointing out of different interfaces, without the routes conflicting?** Yes, if each tenant's route lives in its own routing table. That is what a VRF is. In a single table the two routes would conflict.
- **If a packet arrives on an interface that belongs to tenant A's VRF, which routing table is used to forward it?** Tenant A's VRF table only (unless someone has deliberately configured route leaking). That is how routes from one tenant can't steer another tenant's traffic.

</details>

### Explanation

In Chapter 3 every router had **one** routing table: destination prefix → next hop or interface. Multi-tenancy breaks that model. Tenants pick their own address ranges, those ranges overlap, and a tenant's routes must never affect anyone else's traffic.

A **VRF (Virtual Routing and Forwarding)** instance is a separate routing table inside one device, plus a set of interfaces bound to it. Packets that arrive on a VRF's interface are routed using only that VRF's table. Routes learned or configured in one VRF don't appear in another. So two tenants can both use `10.10.0.0/24` on the same box, and neither one can route traffic into the other's network.

On Linux a VRF is a special network device:

```sh
ip link add red type vrf table 10   # VRF 'red' uses kernel table 10
ip link set red up
ip link set eth1 master red          # eth1 now belongs to red
```

Addresses and routes on `eth1` now go into table 10. `ip route show vrf red` shows them, and the main table doesn't. One Linux detail to know: if a lookup finds no match in a VRF table, the kernel can fall through to later routing rules. The `ip-vrf(8)` man page therefore recommends adding an `unreachable default` route with a very high metric to each VRF table.

The term **VRF-lite** means using VRFs on one device on its own. Across a fabric you also need a way to carry each VRF's traffic and routes between devices while keeping them separate. That is what the rest of this chapter covers: VNIs label the traffic, and EVPN with route targets carries the routes.

In NICo, VRFs provide routing-table isolation for virtual networks. On the Ethernet plane, BlueField HBN enforces isolation with VXLAN/EVPN and **per-tenant VRFs on the DPU**, and the leaf switches aren't touched. When a tenant releases a host, NICo tears down that tenant's VRF on the DPU, and the DPU stops advertising its routes.

**Analogy.** A VRF is like keeping a separate contacts list for each client on one shared phone. "Mum" in client A's list and "Mum" in client B's list are different numbers and never mix. Where it breaks down: a network admin can deliberately copy routes between VRFs (route leaking, or importing route targets), which a sensible phone wouldn't do on its own.

### Worked example: Overlapping prefixes in two VRFs on one Linux box

**Step 1: Start a disposable lab container.**

```sh
docker run --rm -it --privileged debian:stable-slim bash
apt-get update && apt-get install -y iproute2
```
Use `podman run` in the same way if you prefer Podman.

**Step 2: Create two VRFs.**

```sh
ip link add red  type vrf table 10
ip link add blue type vrf table 20
ip link set red up
ip link set blue up
ip -br link show type vrf
```

**Step 3: Give each VRF an interface with the same address.**

```sh
ip link add d-red  type dummy
ip link add d-blue type dummy
ip link set d-red  master red  up
ip link set d-blue master blue up
ip addr add 10.10.0.1/24 dev d-red
ip addr add 10.10.0.1/24 dev d-blue
```
No error, even though the address appears twice.

**Step 4: Compare the tables.**

```sh
ip route show vrf red    # 10.10.0.0/24 dev d-red ...
ip route show vrf blue   # 10.10.0.0/24 dev d-blue ...
ip route show            # main table: neither prefix
```

**Step 5: Ask each VRF where a packet goes.**

```sh
ip route get 10.10.0.5 vrf red    # ... dev d-red table 10
ip route get 10.10.0.5 vrf blue   # ... dev d-blue table 20
```
The same destination gets a different answer depending on the VRF.

### Your turn: finish it

In the same container, add a third tenant `green` with its own table and a dummy interface `d-green` holding 10.10.0.1/24. Fill in the blanks.

```text
ip link add green type vrf table ___
ip link set green up
ip link add d-green type dummy
ip link set d-green ___ green up
ip addr add 10.10.0.1/24 dev d-green
ip route show vrf green
```

<details>
<summary>Answer</summary>

Any table number not used yet, such as `30`, and `master`. The full lines are `ip link add green type vrf table 30` and `ip link set d-green master green up`. If you reused table 10, green and red would share one table, which defeats the point.

</details>

### Your turn: on your own

Give tenant `blue` a default route via 10.10.0.254, then show that `red`'s table didn't change.

<details>
<summary>Hint 1</summary>

`ip route add` accepts a `vrf NAME` selector.

</details>

<details>
<summary>Hint 2</summary>

The gateway is on d-blue's connected subnet, so it is reachable.

</details>

<details>
<summary>Hint 3</summary>

Use `ip route add vrf blue default via 10.10.0.254`, then compare `ip route show vrf blue` with `ip route show vrf red`.

</details>

<details>
<summary>Answer</summary>

```sh
ip route add vrf blue default via 10.10.0.254
ip route show vrf blue   # now has: default via 10.10.0.254 dev d-blue
ip route show vrf red    # unchanged: only 10.10.0.0/24
```
The route went only into table 20. In production you would also add `ip route add vrf red unreachable default metric 4278198272` so that red lookups with no match fail instead of falling through to other tables, as `ip-vrf(8)` recommends.

</details>

### Explain it

In your own words: Explain in your own words why a separate routing table per tenant on the DPU gives stronger isolation than one shared table with firewall rules that block cross-tenant traffic.

### Check

**1. What does a VRF isolate?**

A. Layer-2 broadcast domains
B. Routing tables (and the interfaces bound to them)
C. Physical ports
D. Firewall state

<details>
<summary>Answer</summary>

**B.** Routing tables (and the interfaces bound to them)

A VRF is a routing-table construct at layer 3. Layer-2 separation comes from VLANs and VNIs. A VRF doesn't partition the hardware ports or replace a firewall.

</details>

**2. On its own, can a VRF on one DPU keep tenant A's traffic separate as it crosses the fabric to another DPU?**

A. Yes, VRFs are fabric-wide automatically
B. No, traffic also needs a label (such as a VNI), and the routes need a control plane (such as EVPN) to carry the VRF across

<details>
<summary>Answer</summary>

**B.** No, traffic also needs a label (such as a VNI), and the routes need a control plane (such as EVPN) to carry the VRF across

A VRF is local to one device. To stretch it across the fabric, packets must carry a VRF identifier (an L3VNI) and the routes must be shared between devices (EVPN with route targets).

</details>

**Sources:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md)

<a id="vxlan-and-vni"></a>
## 3. VXLAN and VNI

*Builds on: VLAN (ch. 10), Underlay and overlay networks (ch. 9)*

### Before you read

- A VLAN ID is 12 bits. How many tenant segments can that label at most, and why is that a problem for a large cloud?
- If you wrap a full Ethernet frame inside a UDP/IP packet, does the packet get bigger or smaller, and why might that matter?

<details>
<summary>Answers</summary>

- **A VLAN ID is 12 bits. How many tenant segments can that label at most, and why is that a problem for a large cloud?** 4096 values (in practice 4094 usable). A large multi-tenant site can need far more segments than that, and VLANs also need layer-2 adjacency across switches.
- **If you wrap a full Ethernet frame inside a UDP/IP packet, does the packet get bigger or smaller, and why might that matter?** Bigger, by about 50 bytes for IPv4. If the underlay MTU doesn't allow for that, large frames get dropped or fragmented, or the overlay MTU has to be smaller.

</details>

### Explanation

Chapter 9 split the network into an **underlay** (the routed physical fabric) and an **overlay** (the virtual networks tenants see). Chapter 10 showed that VLANs mark frames with a 12-bit ID. That allows only 4096 IDs, and VLANs only work where layer 2 stretches. A routed fabric of `/31` links doesn't stretch layer 2.

**VXLAN (Virtual Extensible LAN)** fixes both problems by tunnelling. A **VTEP (VXLAN Tunnel Endpoint)** takes a tenant's whole Ethernet frame and wraps it:

```
[outer Ethernet 14][outer IPv4 20][UDP 8, dst 4789][VXLAN 8][ original tenant frame ]
```

The outer IP addresses are the two **VTEPs** (in NICo, the DPU loopbacks advertised as `/32` routes). That means the underlay only routes ordinary UDP packets between loopbacks and never sees tenant MACs or IPs. The receiving VTEP strips the outer headers and delivers the original frame, so the host behaves as if it were on the same local Ethernet as its peer.

The 8-byte VXLAN header holds a flags byte (`0x08` = the "I" bit, meaning the VNI is valid), three reserved bytes, the **VNI (VXLAN Network Identifier)** in bytes 4–6, and one more reserved byte. The VNI is **24 bits**, so 16,777,216 values. It tells the receiving VTEP which overlay segment, and therefore which tenant, the frame belongs to. Two tenants can send frames with identical inner addresses and they stay apart because the VNIs differ.

**MTU cost.** For IPv4 the overhead is 50 bytes. A standard 1500-byte inner MTU needs an underlay that carries at least 1550-byte IP packets. NICo's network guidance is an MTU of 1500 for overlays, and 9000 only if the underlay supports it end to end.

In NICo the DPU is the VTEP. It wraps tenant frames before they leave the server and unwraps them on arrival, which is how isolation is enforced without changing switch configuration. A VLAN tag can still appear on the host-to-DPU link (for example to pick a VM behind a hypervisor), while VXLAN carries traffic across the datacenter.

**Analogy.** VXLAN is like posting a letter inside another envelope. The outer envelope is addressed office-to-office (VTEP to VTEP), and the department code written on it is the VNI. The postal service (the underlay) only reads the outer address. Where it breaks down: unlike a real mailroom, nothing on the outer envelope says how to find the recipient's office. A VTEP needs a separate way to learn which remote VTEP has which MAC. That is EVPN's job, covered next.

### Worked example: Build and decode a VXLAN header in Python

**Step 1: Lay out the header.**

Byte 0 holds the flags (0x08), bytes 1–3 are reserved, bytes 4–6 are the VNI (big-endian), and byte 7 is reserved.

**Step 2: Encode VNI 5000.**

```python
import struct

def vxlan_header(vni: int) -> bytes:
    assert 0 <= vni < 2**24
    return struct.pack("!B3s3sB", 0x08, b"\x00" * 3, vni.to_bytes(3, "big"), 0)

h = vxlan_header(5000)
print(h.hex())   # 0800000000138800
```
5000 = 0x001388, which is bytes 4–6.

**Step 3: Decode it back.**

```python
flags = h[0]
vni = int.from_bytes(h[4:7], "big")
print(bool(flags & 0x08), vni)   # True 5000
```

**Step 4: Work out the MTU impact.**

```python
overhead = 14 + 20 + 8 + 8        # outer Eth + IPv4 + UDP + VXLAN = 50
inner_ip_mtu = 1500
print("underlay IP MTU needed:", inner_ip_mtu + overhead)  # 1550
```
The inner frame is 1514 bytes (1500 + 14). Add 36 bytes of outer IP, UDP and VXLAN headers and you get a 1550-byte underlay IP packet.

### Your turn: finish it

Finish this decoder. It should reject headers without the I flag and return the VNI.

```text
def decode(hdr: bytes) -> int:
    if not hdr[0] & 0x08:
        raise ValueError("I flag not set")
    return int.from_bytes(hdr[___:___], "big")

MAX_VNI = 2**___ - 1
print(decode(bytes.fromhex("0800000000271000")), MAX_VNI)
```

<details>
<summary>Answer</summary>

`hdr[4:7]` and `2**24 - 1`. It prints `10000 16777215` (bytes 4–6 are 00 27 10 = 0x002710 = 10000).

</details>

### Your turn: on your own

A packet capture gives you this UDP payload (hex), sent to port 4789: `080000000003e800 0242ac110002 0242ac110003 0800 ...`. Which VNI is it, and what are the inner destination and source MACs?

<details>
<summary>Hint 1</summary>

The first 8 bytes are the VXLAN header, and the inner Ethernet frame starts right after them.

</details>

<details>
<summary>Hint 2</summary>

An Ethernet frame starts with the destination MAC (6 bytes), then the source MAC (6 bytes), then the EtherType.

</details>

<details>
<summary>Hint 3</summary>

The VNI is bytes 4–6 of the header: `00 03 e8` = 0x0003e8 = 1000. Byte 7 (`00`) is reserved. EtherType 0x0800 means the inner frame carries IPv4.

</details>

<details>
<summary>Answer</summary>

VNI 1000. Inner destination MAC 02:42:ac:11:00:02, inner source MAC 02:42:ac:11:00:03, and the inner payload is IPv4. In Python: `p = bytes.fromhex('080000000003e8000242ac1100020242ac1100030800'); int.from_bytes(p[4:7],'big'); p[8:14].hex(':'); p[14:20].hex(':')` gives `1000`, `'02:42:ac:11:00:02'` and `'02:42:ac:11:00:03'`.

</details>

### Explain it

In your own words: Why does the underlay never need to know tenant MAC or IP addresses, and what does that make possible for an operator who has to change tenant assignments often?

### Check

**1. In a VXLAN packet between two DPUs, what are the outer source and destination IPs?**

A. The two tenant hosts' IPs
B. The two VTEPs' IPs (DPU loopbacks)
C. The ToR switches' IPs
D. The site controller's VIP

<details>
<summary>Answer</summary>

**B.** The two VTEPs' IPs (DPU loopbacks)

The outer header is addressed VTEP to VTEP. Tenant addresses are inside the payload, so the underlay only needs routes to the DPUs' `/32` loopbacks.

</details>

**2. Why is VXLAN's VNI field 24 bits rather than VLAN's 12?**

A. To carry the tenant's IP address
B. To label far more segments (about 16.7 million)
C. To hold the UDP port
D. For error checking

<details>
<summary>Answer</summary>

**B.** To label far more segments (about 16.7 million)

The larger ID space is the main reason VXLAN exists in large multi-tenant fabrics. The VNI is a segment label, not an address or a checksum.

</details>

**3. The underlay MTU is exactly 1500 everywhere. What happens to a tenant sending full 1500-byte IP packets over VXLAN?**

A. Nothing, VXLAN compresses the headers
B. The encapsulated packets are about 1550 bytes and exceed the underlay MTU
C. Only the VNI is lost

<details>
<summary>Answer</summary>

**B.** The encapsulated packets are about 1550 bytes and exceed the underlay MTU

VXLAN adds about 50 bytes. You either make the underlay MTU larger end to end or reduce the overlay MTU. VXLAN doesn't compress anything.

</details>

**Sources:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md)

<a id="vxlan-evpn"></a>
## 4. VXLAN / EVPN

*Builds on: BGP (ch. 9), VXLAN and VNI (ch. 11)*

### Before you read

- A VTEP receives a frame from a local host for MAC aa:bb:cc:00:00:02 in VNI 1000. To build the outer header, what does it need to know?
- Should the underlay ToR switches carry tenant routes in their normal IPv4 routing table?

<details>
<summary>Answers</summary>

- **A VTEP receives a frame from a local host for MAC aa:bb:cc:00:00:02 in VNI 1000. To build the outer header, what does it need to know?** Which remote VTEP IP that MAC sits behind in VNI 1000. It either learns this by flooding and watching replies, or a control plane such as EVPN tells it.
- **Should the underlay ToR switches carry tenant routes in their normal IPv4 routing table?** No. The underlay only needs VTEP loopbacks. Tenant reachability travels separately, in the EVPN address family, tagged per VRF.

</details>

### Explanation

You now have the two halves:

- **Data plane:** VXLAN wraps frames and labels them with a VNI (previous lesson).
- **Control plane:** something has to tell each VTEP *which remote VTEP* to send each tenant address to, and *which VTEPs* to include when a broadcast must be flooded.

Early VXLAN used *flood-and-learn*. Unknown traffic was flooded to every VTEP in the VNI (statically listed, or sent by multicast), and each VTEP learned MAC locations from the packets that came back. That generates a lot of flooding and needs either multicast or manual lists. **EVPN (Ethernet VPN)** replaces it. VTEPs use **BGP**, the protocol you already run in the underlay, with an extra **address family** called *L2VPN EVPN*, to advertise "MAC/IP X in VNI Y is behind VTEP Z". **VXLAN/EVPN** is the combination of the two.

In NICo this works as follows:

- **DPUs are the VTEPs.** HBN on the DPU (containerised Cumulus: FRR, configured via NVUE) does the encapsulation and runs BGP.
- **The underlay carries only loopbacks.** DPUs advertise `/32` loopbacks over eBGP unnumbered, and leaves filter DPU announcements to loopbacks only, aggregate them, and set max-prefix limits. Every DPU needs a route to the other DPUs' `/32`s, or to an aggregate or default route that covers them.
- **EVPN peering has two options:**
  1. *Dual-stacked sessions with the ToR.* ToRs accept EVPN sessions from DPUs alongside the IPv4 ones, and the spines carry EVPN too.
  2. *Route servers.* At least two redundant BGP route servers, which NICo doesn't deploy or manage. DPUs run multi-hop eBGP sessions to them with the EVPN family only and IPv4 unicast disabled.
- **Default route.** The tenant overlay needs a default route. It comes either from EVPN sessions at each tier of the network or from dedicated tenant gateways that leak a default route into the tenant VRF.

For FNN VPCs the overlay is **routed (L3)**. Each instance interface has a `/31` to its DPU gateway, and the DPU advertises that `/31` into the VPC's L3 VXLAN/EVPN overlay. Two interfaces from the same VPC prefix are *not* on the same Ethernet segment, so cluster software must work over routed connectivity, without broadcast discovery or ARP between nodes.

**Analogy.** VXLAN is the postal system and EVPN is a constantly updated company directory that says which office each person currently sits in. Without the directory you'd shout through every building (flood-and-learn). Where it breaks down: this directory is spread around by gossip (BGP), so after a change there is a short time before every office has the new entry.

### Worked example: Trace one packet from instance A1 to A2 in the same VPC

**Step 1: Underlay is ready.**

DPU1 (loopback 10.255.0.1) and DPU2 (10.255.0.2) advertise their `/32`s to the ToRs over eBGP unnumbered. DPU1's underlay table holds `10.255.0.2/32` (or an aggregate or default route that covers it) and no tenant prefixes.

**Step 2: EVPN tells DPU1 where A2 is.**

DPU2 sees A2's interface `/31` (say 10.20.0.2/31) and advertises it over L2VPN EVPN, tagged with the VPC's VRF and L3VNI, with next hop 10.255.0.2. DPU1 installs `10.20.0.2/31 via VTEP 10.255.0.2` into *that VPC's VRF*, not into the underlay table.

**Step 3: Encapsulate.**

A1 sends to its gateway, which is DPU1 at the other end of its `/31`. DPU1 looks up the destination in the VPC's VRF, finds VTEP 10.255.0.2, and wraps the packet: outer 10.255.0.1 → 10.255.0.2, UDP 4789, VNI = the VPC's L3VNI.

**Step 4: Cross the underlay.**

The ToRs and spines route a plain UDP packet between two loopbacks. They have no tenant state.

**Step 5: Decapsulate and deliver.**

DPU2 sees the VNI, maps it to the VPC's VRF, removes the outer headers, and routes the inner packet out of A2's `/31`.

### Your turn: finish it

Your site uses the route-server option, with two route servers at 192.0.2.10 and 192.0.2.11. Fill in the two siteConfig keys from NICo's network prerequisites (TOML).

```text
enable_route_servers = ___
route_servers = [___]
```

<details>
<summary>Answer</summary>

```toml
enable_route_servers = true
route_servers = ["192.0.2.10", "192.0.2.11"]
```
With these set, the DPU agent configures FRR/NVUE on each DPU with a `routeserver` BGP peer group: multi-hop TTL 255, external AS, and the L2VPN-EVPN address family only. You still have to build and run the route servers yourself.

</details>

### Your turn: on your own

A DPU's FRR config is changed by mistake so that it advertises its tenant instance `/31`s into the *IPv4 unicast* session with the ToR. According to NICo's underlay rules, what should the leaf do with them, and where should those routes be carried instead?

<details>
<summary>Hint 1</summary>

Look again at the route-filtering rule for leaf ports that face DPUs.

</details>

<details>
<summary>Hint 2</summary>

Which family carries tenant reachability, and inside what?

</details>

<details>
<summary>Hint 3</summary>

Leaves accept only DPU loopbacks (with max-prefix limits). Tenant routes go into EVPN, tagged with the VPC's VRF and L3VNI.

</details>

<details>
<summary>Answer</summary>

The leaf should filter them out, because DPU announcements are restricted to loopbacks only, and a max-prefix limit protects the port. Tenant `/31`s belong in the L2VPN EVPN family, advertised in the VPC's VRF. That keeps them out of the shared underlay, where they could clash with another tenant's overlapping addresses.

</details>

### Explain it

In your own words: Explain why splitting the network into an underlay that carries only loopbacks and an EVPN overlay that carries tenant routes per VRF lets NICo change tenant networks without touching any switch configuration.

### Check

**1. In NICo's design, which device is the VXLAN tunnel endpoint for a managed host?**

A. The ToR switch
B. The host's BMC
C. The BlueField DPU
D. The site controller

<details>
<summary>Answer</summary>

**C.** The BlueField DPU

The DPU is the VTEP and runs HBN. That is how NICo enforces isolation without leaf switch changes. The BMC is on the separate OOB network.

</details>

**2. Under the route-server option, which BGP address family do DPUs use on the overlay sessions?**

A. IPv4 unicast only
B. L2VPN EVPN only
C. Both IPv4 unicast and EVPN

<details>
<summary>Answer</summary>

**B.** L2VPN EVPN only

The docs say to disable IPv4 unicast on overlay sessions to route servers. Dual-stacked IPv4 + EVPN sessions belong to the other option, peering with the ToR.

</details>

**3. Two instances got addresses from the same FNN VPC prefix. Can they find each other by ARP broadcast?**

A. Yes, same prefix means same L2 segment
B. No, each interface is a routed /31 to its DPU, so they aren't L2-adjacent

<details>
<summary>Answer</summary>

**B.** No, each interface is a routed /31 to its DPU, so they aren't L2-adjacent

The FNN overlay is routed at L3. The docs warn explicitly not to depend on broadcast discovery or ARP between nodes.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md)

<a id="evpn"></a>
## 5. EVPN

*Builds on: BGP (ch. 9), VXLAN and VNI (ch. 11)*

### Before you read

- BGP in the underlay advertises IP prefixes. What extra kinds of information would a VTEP need to advertise to replace flood-and-learn?
- When a tenant leaves and its VRF is removed from a DPU, how do other VTEPs find out they should stop sending traffic there?

<details>
<summary>Answers</summary>

- **BGP in the underlay advertises IP prefixes. What extra kinds of information would a VTEP need to advertise to replace flood-and-learn?** MAC addresses (with their IPs) per VNI, membership ("I'm a VTEP in VNI X, include me in floods"), and IP prefixes per VRF. EVPN has a route type for each of these.
- **When a tenant leaves and its VRF is removed from a DPU, how do other VTEPs find out they should stop sending traffic there?** The DPU stops advertising those EVPN routes, BGP sends withdrawals, and the other VTEPs remove the entries.

</details>

### Explanation

**EVPN** is the control plane: a BGP address family (L2VPN EVPN, AFI 25 / SAFI 70) whose routes describe overlay reachability. BGP already gives you sessions, policy, scale and withdrawals, and EVPN just defines new kinds of route to send over them. The ones you'll see in a VXLAN fabric:

| Type | Name | Says |
|---|---|---|
| 2 | MAC/IP advertisement | "MAC m (optionally IP i) in VNI v is behind VTEP n" |
| 3 | Inclusive multicast | "VTEP n participates in VNI v, so include me when flooding" |
| 5 | IP prefix | "Prefix p in this VRF is reachable via VTEP n (L3VNI v)" |

Each route also carries:
- a **next hop**: the advertising VTEP's loopback;
- a **Route Distinguisher (RD)**, which makes otherwise identical prefixes from different VRFs unique inside BGP;
- one or more **Route Targets (RTs)**, extended-community tags that decide which VRFs import the route (covered in the last lesson).

A VTEP turns received routes into forwarding state. Type-2 routes fill a MAC table that maps VNI + MAC to a remote VTEP. Type-3 routes build the per-VNI **flood list** used for broadcast, unknown-unicast and multicast (BUM) traffic. Type-5 routes fill a VRF's routing table. Because DPUs only send routes for what they actually host, there is little flooding, and the data is accurate.

**Withdrawal** matters as much as advertisement. NICo's tenant cleanup depends on it. When NICo tears down a tenant VRF, the DPU stops advertising that VRF's BGP EVPN routes, the fabric withdraws them, and NICo returns the tenant IPs, VNI and DPU loopback allocations to their pools. NICo doesn't report the release complete until the DPU confirms it has left all tenant networks.

In NICo, EVPN runs in FRR inside HBN on the DPU, and it peers with ToRs or route servers as described in the previous lesson.

**Analogy.** EVPN is like a shared contacts feed that everyone subscribes to. Each person posts "you can reach me at office Z" (type-2), "add me to the team mailing list" (type-3), or "department P is in building Z" (type-5), and deletes the post when they leave. Where it breaks down: subscribers don't get every post. Route targets filter what each VRF accepts, so the feed is selective by design.

### Worked example: Turn EVPN routes into one VTEP's forwarding tables

**Step 1: Write down the received routes.**

Save as `evpn.py`:
```python
routes = [
    {"type": 2, "vni": 1000, "mac": "aa:aa:aa:00:00:01", "nexthop": "10.255.0.1"},
    {"type": 2, "vni": 1000, "mac": "aa:aa:aa:00:00:02", "nexthop": "10.255.0.2"},
    {"type": 2, "vni": 2000, "mac": "bb:bb:bb:00:00:02", "nexthop": "10.255.0.2"},
    {"type": 3, "vni": 1000, "nexthop": "10.255.0.1"},
    {"type": 3, "vni": 1000, "nexthop": "10.255.0.2"},
    {"type": 3, "vni": 2000, "nexthop": "10.255.0.1"},
    {"type": 3, "vni": 2000, "nexthop": "10.255.0.2"},
]
ME = "10.255.0.1"
```

**Step 2: Skip your own advertisements.**

A VTEP doesn't tunnel to itself, so ignore routes whose next hop is `ME`.

**Step 3: Build the tables.**

```python
def build(routes, me):
    fdb, flood = {}, {}
    for r in routes:
        if r["nexthop"] == me:
            continue
        if r["type"] == 2:
            fdb[(r["vni"], r["mac"])] = r["nexthop"]
        elif r["type"] == 3:
            flood.setdefault(r["vni"], []).append(r["nexthop"])
    return fdb, flood

fdb, flood = build(routes, ME)
print(fdb)
print(flood)
```

**Step 4: Read the result.**

```
{(1000, 'aa:aa:aa:00:00:02'): '10.255.0.2', (2000, 'bb:bb:bb:00:00:02'): '10.255.0.2'}
{1000: ['10.255.0.2'], 2000: ['10.255.0.2']}
```
A unicast frame to aa:aa:aa:00:00:02 in VNI 1000 is tunnelled to 10.255.0.2. A broadcast in VNI 2000 is copied to 10.255.0.2 only.

### Your turn: finish it

Fill in the blanks in this cut-down `build` function so it fills the MAC table from type-2 routes.

```text
def build_fdb(routes, me):
    fdb = {}
    for r in routes:
        if r["nexthop"] == me:
            continue
        if r["type"] == ___:
            fdb[(r["vni"], r["___"])] = r["nexthop"]
    return fdb
```

<details>
<summary>Answer</summary>

`2` and `mac`, which gives `if r["type"] == 2:` and `fdb[(r["vni"], r["mac"])] = r["nexthop"]`.

</details>

### Your turn: on your own

Tenant cleanup: VTEP 10.255.0.2 tears down the VRF behind VNI 2000 and withdraws everything it advertised for that VNI. Write `withdraw(routes, vni, nexthop)`, rebuild DPU1's tables, and say what DPU1 now does with a broadcast in VNI 2000.

<details>
<summary>Hint 1</summary>

A withdrawal removes routes, so filter the list.

</details>

<details>
<summary>Hint 2</summary>

Keep a route unless its VNI *and* its next hop both match the withdrawn ones.

</details>

<details>
<summary>Hint 3</summary>

`[r for r in routes if not (r["vni"] == vni and r["nexthop"] == nexthop)]`

</details>

<details>
<summary>Answer</summary>

```python
def withdraw(routes, vni, nexthop):
    return [r for r in routes if not (r["vni"] == vni and r["nexthop"] == nexthop)]

fdb, flood = build(withdraw(routes, 2000, "10.255.0.2"), ME)
print(fdb)    # {(1000, 'aa:aa:aa:00:00:02'): '10.255.0.2'}
print(flood)  # {1000: ['10.255.0.2']}
```
VNI 2000 has no remote flood targets left, so DPU1 sends nothing for VNI 2000 to 10.255.0.2. This is the effect NICo waits for before it reports a release complete.

</details>

### Explain it

In your own words: Why is it safer for tenant isolation that VTEPs learn remote MACs and prefixes from explicit BGP advertisements rather than from flooded data traffic?

### Check

**1. Which EVPN route type builds a VTEP's per-VNI flood list?**

A. Type 2
B. Type 3
C. Type 5

<details>
<summary>Answer</summary>

**B.** Type 3

Type-3 (inclusive multicast) routes announce membership in a VNI. Type-2 routes carry individual MAC/IPs, and type-5 routes carry IP prefixes in a VRF.

</details>

**2. What is the next hop in an EVPN route from a DPU?**

A. The tenant host's IP
B. The DPU's VTEP loopback
C. The ToR's interface IP
D. The route server's IP

<details>
<summary>Answer</summary>

**B.** The DPU's VTEP loopback

Other VTEPs tunnel to that address, which is why loopback reachability in the underlay is required. Route servers pass routes on but are not the next hop.

</details>

**3. During NICo tenant cleanup, what happens to the tenant's EVPN routes?**

A. They stay until the next tenant overwrites them
B. The DPU stops advertising them, the fabric withdraws them, and the VNI returns to its pool
C. An operator deletes them from each ToR by hand

<details>
<summary>Answer</summary>

**B.** The DPU stops advertising them, the fabric withdraws them, and the VNI returns to its pool

Per the lifecycle docs, tearing down the VRF withdraws the routes, and NICo returns the IP, VNI and loopback allocations, without any switch changes.

</details>

**Sources:** [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md)

<a id="vni"></a>
## 6. VNI (L2VNI / L3VNI)

*Builds on: VXLAN / EVPN (ch. 11), VRF (ch. 11)*

### Before you read

- Your site expects 300 VPCs. How many L3VNIs and how many L2VNIs does NICo's network prerequisites page say to plan for?
- Two sites in the same datacenter each pick VNI 100001 for one of their VPCs. Why is that a problem?

<details>
<summary>Answers</summary>

- **Your site expects 300 VPCs. How many L3VNIs and how many L2VNIs does NICo's network prerequisites page say to plan for?** One L3VNI per expected VPC (so at least 300) and one L2VNI for the admin network. All of them must be unique across the whole datacenter.
- **Two sites in the same datacenter each pick VNI 100001 for one of their VPCs. Why is that a problem?** VNIs must be datacenter-unique. If both sites' EVPN routes can meet in a shared fabric, the same VNI would map to two different tenants' VRFs, which breaks isolation and causes confusing forwarding.

</details>

### Explanation

You've seen that a VNI is the 24-bit label in the VXLAN header. In practice VNIs come in two kinds, depending on what they label:

- **L2VNI** labels a **layer-2 segment**, a bridged broadcast domain that is stretched between VTEPs. Frames are bridged, and MACs are learned through EVPN type-2 routes. Your laptop lab uses L2VNIs.
- **L3VNI** labels a **VRF**. Traffic *routed* between VTEPs inside a VRF carries the VRF's L3VNI, so the receiving VTEP knows which routing table to look up. This setup is called symmetric IRB: each side routes, and the VNI only identifies the VRF. EVPN type-5 (and type-2 MAC+IP) routes carry the L3VNI.

How NICo uses them, from the network prerequisites:

- **One L3VNI per VPC.** Each VPC needs a unique L3VNI to identify its VRF. FNN VPCs are routed, with `/31`s to the DPU gateway, so the L3VNI is what keeps them apart on the wire.
- **One L2VNI for the admin network**, which is where hosts sit when no tenant is assigned.
- **VNIs must be unique across the datacenter**, not just within one site.

VNIs are a **pool resource**. The sizing guide says each VPC holds one active VNI from the `vpc-vni` or `external-vpc-vni` pool, so the ranges you configure set an upper limit on how many VPCs a site can have. A VPC in the middle of an unreleased routing-profile transition temporarily holds two allocations, so leave headroom. You can grow an established pool with `nico-admin-cli resource-pool grow`. When a tenant releases a host, NICo returns its VNI allocation to the pool as part of network cleanup.

Planning tip: reserve separate, non-overlapping ranges per site and per kind (admin L2VNI, VPC L3VNIs). Write them down where both network and platform teams can see them. Some teams also make route-target numbers match VNIs for convenience, but routing policy is set by RTs, not by the VNI number.

**Analogy.** Think of an L2VNI as a shared corridor where everyone can call out to everyone else, and an L3VNI as a company's internal mail code: post marked with it goes to that company's mailroom (VRF), which then routes it onward. Where it breaks down: a building's corridor numbers are only unique inside that building, but VNIs must be unique across the whole datacenter, because traffic and routes from different sites can meet.

### Worked example: Plan and check VNI ranges for two sites in one datacenter

**Step 1: Size each site.**

Site A expects 200 VPCs and site B expects 150. Allow headroom for growth and for VPCs that briefly hold two allocations during a routing-profile transition: A gets 256 L3VNIs and B gets 256.

**Step 2: Choose ranges that don't overlap.**

```python
sites = {
    "site-a": {"admin_l2vni": [10010], "vpc_l3vni": range(100000, 100256)},
    "site-b": {"admin_l2vni": [10020], "vpc_l3vni": range(100256, 100512)},
}
```

**Step 3: Check range and uniqueness.**

```python
owner, clashes = {}, 0
for site, pools in sites.items():
    for kind, vnis in pools.items():
        for v in vnis:
            assert 1 <= v <= 2**24 - 1, f"VNI {v} out of range"
            if v in owner:
                clashes += 1
            else:
                owner[v] = f"{site}/{kind}"
print("VNIs:", len(owner), "clashes:", clashes)
```
Output: `VNIs: 514 clashes: 0`.

**Step 4: Record the plan.**

Share the table with the network team. NICo's pools and the fabric's expectations have to agree, and the same is true of route targets.

### Your turn: finish it

Fill in the minimum counts for a site with `expected_vpcs = 200`, following NICo's prerequisites.

```text
expected_vpcs = 200
l3vni_needed = ___        # per the docs
l2vni_needed = ___        # admin network
print(l3vni_needed + l2vni_needed)
```

<details>
<summary>Answer</summary>

`l3vni_needed = expected_vpcs` (200) and `l2vni_needed = 1`. It prints 201. Real plans add headroom on top.

</details>

### Your turn: on your own

Change site-b's range in the worked example to `range(100200, 100456)` and rerun the check. How many clashes are there, and what is the smallest change that fixes them?

<details>
<summary>Hint 1</summary>

The clashes are the VNIs inside both ranges.

</details>

<details>
<summary>Hint 2</summary>

Site A ends at 100255 (because range() excludes its end value), and site B now starts at 100200.

</details>

<details>
<summary>Hint 3</summary>

Count 100200 to 100255 inclusive. To fix it, start B at 100256 or later.

</details>

<details>
<summary>Answer</summary>

56 clashes (100200 to 100255). Move site B to `range(100256, 100512)`, or to any block that doesn't overlap A's. Changing the script won't help on its own: both sites' NICo VNI pools must be configured with the corrected ranges.

</details>

### Explain it

In your own words: Why does each VPC need its own L3VNI, even if two VPCs use completely different IP prefixes?

### Check

**1. What does an L3VNI identify?**

A. One bridged L2 segment
B. A VRF (tenant routing table)
C. A physical port
D. A BGP ASN

<details>
<summary>Answer</summary>

**B.** A VRF (tenant routing table)

An L3VNI tells the receiving VTEP which VRF to route the decapsulated packet in. A bridged segment is an L2VNI. Ports and ASNs are unrelated.

</details>

**2. How unique must NICo VNIs be?**

A. Unique per DPU
B. Unique per site
C. Unique across the datacenter

<details>
<summary>Answer</summary>

**C.** Unique across the datacenter

The prerequisites say VNIs must be datacenter-unique. Per-site uniqueness is the tempting wrong answer, but several sites can share a fabric.

</details>

**3. What caps the number of VPCs a NICo site can have at the same time?**

A. A hard-coded NICo limit
B. The VNI pool ranges the operator configures
C. The number of ToR switches

<details>
<summary>Answer</summary>

**B.** The VNI pool ranges the operator configures

Each VPC holds one active VNI from the `vpc-vni` or `external-vpc-vni` pool, so the configured ranges set the maximum. Pools can be grown.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md)

<a id="route-targets"></a>
## 7. Route targets (import/export)

*Builds on: VXLAN / EVPN (ch. 11), VRF (ch. 11)*

### Before you read

- A tenant VRF must reach NICo's DHCP and DNS VIPs, which sit in the site controller's VRF. Which side must import which routes for traffic to work in both directions?
- Does using the same number for a route target and a VNI connect them in any way?

<details>
<summary>Answers</summary>

- **A tenant VRF must reach NICo's DHCP and DNS VIPs, which sit in the site controller's VRF. Which side must import which routes for traffic to work in both directions?** Both sides. The tenant VRF must import the routes the site controller exports (the control-plane VIP tag), and the site controller must import the tenant's exported routes, otherwise replies have no way back.
- **Does using the same number for a route target and a VNI connect them in any way?** No. Matching the numbers is only a convenience for admins. Routing policy is set entirely by RT import/export configuration.

</details>

### Explanation

EVPN routes travel through BGP, but each VRF only installs *some* of them. **Route Targets (RTs)** decide which. An RT is a BGP extended-community tag, usually written `ASN:number`, for example `65000:50200`.

- **Export RT:** when a VRF advertises a route, it attaches its export RTs.
- **Import RT:** a VRF installs a received route only if the route carries at least one RT on the VRF's import list.

Don't confuse RTs with the **Route Distinguisher**, which only makes prefixes unique inside BGP. RTs are the policy.

Reachability needs routes in **both directions**. A reaches B only if A imports something B exports *and* B imports something A exports, so the return path works.

NICo's network prerequisites define conventional common RTs:

| RT | Purpose |
|---|---|
| `:50100` | Control-plane / service VIPs, exported by site controller DPUs (or the ToR if the site controllers have no DPUs) |
| `:50200` | Internal tenant routes |
| `:50300` | Maintenance network routes |
| `:50400` | Admin network routes |
| `:50500` | External tenant routes |

The policy rules are:
- Tenant and admin networks (`:50200` to `:50500`) **import `:50100`** so they can reach control-plane VIPs.
- Site controllers that export `:50100` **import `:50200` to `:50500`** so they can reach every managed endpoint.

These are conventions you set in configuration. A routing profile's name doesn't assign them automatically. NICo adds the common export RTs configured in `route_targets_on_exports` to the VPC's own native RT. **NICo's config and the network must use the same values.** If you choose 45001 instead of 50200 for internal tenants, change both sides.

This is how NICo's pods (DHCP, DNS, API, PXE and others) are reachable from the admin network and from tenant VPCs: their VIPs are advertised with `:50100`, and every network that needs them imports that tag.

**Analogy.** Route targets work like hashtags on a feed. Posts (routes) carry hashtags (export RTs), and each reader (VRF) follows certain hashtags (import RTs). Where it breaks down: following someone's posts doesn't let your messages reach them. Traffic needs the other side to follow your hashtag too.

### Worked example: Simulate NICo's RT conventions in Python

**Step 1: Model the VRFs.**

Save as `rt.py`. Each VPC exports its native RT plus a common tag:
```python
vrfs = {
    "site-controller": {"export": {"50100"}, "import": {"50200", "50300", "50400", "50500"}},
    "admin":           {"export": {"50400"}, "import": {"50100"}},
    "vpc-a":           {"export": {"vpc-a", "50200"}, "import": {"vpc-a", "50100"}},
    "vpc-b":           {"export": {"vpc-b", "50200"}, "import": {"vpc-b", "50100"}},
}
```

**Step 2: Define one-way and two-way visibility.**

```python
def sees(a, b):
    return bool(vrfs[a]["import"] & vrfs[b]["export"])

def reachable(a, b):
    return sees(a, b) and sees(b, a)
```

**Step 3: Print the reachability matrix.**

```python
names = list(vrfs)
for a in names:
    print(f"{a:16}", " ".join("Y" if a != b and reachable(a, b) else "." for b in names))
```
```
site-controller  . Y Y Y
admin            Y . . .
vpc-a            Y . . .
vpc-b            Y . . .
```

**Step 4: Interpret it.**

Every network can reach the control plane and the control plane can reach every network, but vpc-a and vpc-b can't reach each other. They both export `50200`, but neither imports it.

### Your turn: finish it

Add the maintenance network so it can reach the control-plane VIPs and the site controller can reach it back. Fill in the blanks.

```text
vrfs["maintenance"] = {"export": {"___"}, "import": {"___"}}
print(reachable("maintenance", "site-controller"))
```

<details>
<summary>Answer</summary>

`{"export": {"50300"}, "import": {"50100"}}`. It prints `True`: the site controller already imports 50300, and maintenance imports 50100.

</details>

### Your turn: on your own

The network team configured internal tenant exports as `45001`, but NICo's site controller still imports `50200`. Change vpc-a and vpc-b to export `45001` instead of `50200` and rerun. What breaks, and what is the correct fix?

<details>
<summary>Hint 1</summary>

Check `sees("site-controller", "vpc-a")`.

</details>

<details>
<summary>Hint 2</summary>

The tenant VRFs can still see the VIPs, so only one direction is missing.

</details>

<details>
<summary>Hint 3</summary>

Docs: the NICo config and the network must agree. Change both to the same value.

</details>

<details>
<summary>Answer</summary>

`reachable("vpc-a", "site-controller")` becomes False. The tenants still import 50100, but the site controller no longer imports anything the tenants export, so return traffic from DHCP, DNS, PXE and other services has no route back. Fix it by choosing one value and using it everywhere: either go back to 50200, or set 45001 in both NICo's config and the site controller's import list.

</details>

### Explain it

In your own words: Explain why reachability between two VRFs needs import/export configuration on *both* sides, and why getting this wrong tends to show up as a timeout rather than a clear error.

### Check

**1. Which common RT do NICo tenant and admin networks import to reach control-plane VIPs?**

A. :50100
B. :50200
C. :50400
D. :50500

<details>
<summary>Answer</summary>

**A.** :50100

:50100 is the control-plane/service VIP tag exported by site controller DPUs or the ToR. The others are tags that tenant, maintenance and admin networks export.

</details>

**2. Your team aligns RT numbers with VNIs. Which one actually decides whether a VRF installs a route?**

A. The VNI number
B. The RT import/export configuration
C. Whichever is larger

<details>
<summary>Answer</summary>

**B.** The RT import/export configuration

The docs say plainly that routing policy is governed by RT import/export, not by the VNI. Matching the numbers is only for convenience.

</details>

**3. Are NICo's :50100 to :50500 values assigned automatically from a routing profile's name?**

A. Yes
B. No, they are conventions that must be configured the same way in NICo and in the network

<details>
<summary>Answer</summary>

**B.** No, they are conventions that must be configured the same way in NICo and in the network

They are standard values you configure (for example via `route_targets_on_exports`). If the two sides disagree, reachability fails silently.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md)

<a id="build-task"></a>
## Build task: Two tenants, same IPs: a VXLAN + VRF overlay on your laptop

**Goal:** Build two simulated DPUs (VTEPs) joined by a routed /31 underlay with /32 loopbacks, then put two tenants on them that both use 10.10.0.0/24. Each tenant gets its own VRF and VNI. Prove that each tenant reaches only its own peer, and capture the VXLAN packets with their VNIs.

**Why it matters for NICo:** This is a small model of what NICo has BlueField HBN do on every DPU: the underlay carries only loopbacks, tenant traffic is wrapped in VXLAN with a per-tenant VNI, and each tenant's routes live in a separate VRF. The lab uses static L2VNIs. NICo's FNN VPCs use routed L3VNIs with EVPN, which the stretch goal introduces. Once you've watched it work, NICo's VNI pools, route targets and EVPN health signals will make much more sense.

**You need:**

- Docker Desktop, Docker Engine or Podman, able to run `--privileged` containers
- About 200 MB for a debian:stable-slim image plus iproute2, iputils-ping and tcpdump
- A text editor to create lab.sh and verify.sh on your laptop
- On a Linux host, the kernel must support the vxlan and vrf device types (standard on mainstream distros and in Docker Desktop's VM)

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Start the lab container</summary>

Everything runs in network namespaces inside one privileged container. This avoids Docker's inter-network filtering.
```sh
docker run -d --privileged --name vxlab debian:stable-slim sleep infinity
docker exec vxlab sh -c 'apt-get update && apt-get install -y iproute2 iputils-ping tcpdump'
```
With Podman, replace `docker` with `podman`.

</details>

<details>
<summary>Step 2: Write lab.sh</summary>

Create `lab.sh` on your laptop:
```sh
#!/bin/sh
# Two VTEPs, two tenants with overlapping IPs, VXLAN over a routed /31.
set -e

for ns in vtep1 vtep2 a1 a2 b1 b2; do
  ip netns add "$ns"
  ip -n "$ns" link set lo up
done

# --- underlay: routed /31 between VTEPs, /32 loopbacks as VTEP addresses ---
ip link add u1 type veth peer name u2
ip link set u1 netns vtep1
ip link set u2 netns vtep2
ip -n vtep1 link set u1 mtu 9000 up
ip -n vtep2 link set u2 mtu 9000 up
ip -n vtep1 addr add 172.16.0.0/31 dev u1
ip -n vtep2 addr add 172.16.0.1/31 dev u2
ip -n vtep1 addr add 10.255.0.1/32 dev lo
ip -n vtep2 addr add 10.255.0.2/32 dev lo
ip -n vtep1 route add 10.255.0.2/32 via 172.16.0.1
ip -n vtep2 route add 10.255.0.1/32 via 172.16.0.0

# segment VTEP VRF TABLE BRIDGE VXLAN VNI LOCAL REMOTE GATEWAY
segment() {
  ip -n "$1" link add "$2" type vrf table "$3"
  ip -n "$1" link set "$2" up
  ip -n "$1" link add "$4" type bridge
  ip -n "$1" link set "$4" master "$2" up
  # mtu must come BEFORE 'type': everything after 'type vxlan' is parsed as vxlan options
  ip -n "$1" link add "$5" mtu 1500 type vxlan id "$6" local "$7" remote "$8" dstport 4789
  ip -n "$1" link set "$5" master "$4" up
  ip -n "$1" addr add "$9" dev "$4"
}
segment vtep1 red  10 br-red  vx1000 1000 10.255.0.1 10.255.0.2 10.10.0.254/24
segment vtep1 blue 20 br-blue vx2000 2000 10.255.0.1 10.255.0.2 10.10.0.254/24
segment vtep2 red  10 br-red  vx1000 1000 10.255.0.2 10.255.0.1 10.10.0.253/24
segment vtep2 blue 20 br-blue vx2000 2000 10.255.0.2 10.255.0.1 10.10.0.253/24

# attach HOST VTEP BRIDGE ADDRESS
attach() {
  ip link add "$1-eth" type veth peer name "$1-port"
  ip link set "$1-eth" netns "$1"
  ip link set "$1-port" netns "$2"
  ip -n "$2" link set "$1-port" master "$3" up
  ip -n "$1" addr add "$4" dev "$1-eth"
  ip -n "$1" link set "$1-eth" up
}
attach a1 vtep1 br-red  10.10.0.1/24
attach a2 vtep2 br-red  10.10.0.2/24
attach b1 vtep1 br-blue 10.10.0.1/24
attach b2 vtep2 br-blue 10.10.0.2/24
echo "lab is up"
```
The underlay MTU is 9000 and the VXLAN devices are set to 1500, so the ~50 bytes of encapsulation fit without fragmentation. Note the order in the vxlan line: `mtu 1500` is a generic link option, so it goes before `type vxlan`. Put after the type, iproute2 rejects it with `vxlan: unknown command "mtu"?`.

</details>

<details>
<summary>Step 3: Run it and check the underlay</summary>

```sh
docker cp lab.sh vxlab:/lab.sh
docker exec vxlab sh /lab.sh
docker exec vxlab ip netns exec vtep1 ping -c1 -I 10.255.0.1 10.255.0.2
```
You should see `lab is up`, and the loopback-to-loopback ping must work first. VTEP reachability is the only thing the underlay provides.

</details>

<details>
<summary>Step 4: Inspect the VRFs and VNIs</summary>

```sh
docker exec vxlab ip -n vtep1 route show vrf red
docker exec vxlab ip -n vtep1 route show vrf blue
docker exec vxlab ip -n vtep1 -d link show vx1000 | grep -o 'vxlan id [0-9]*'
docker exec vxlab ip -n vtep1 route show     # underlay table: no 10.10.0.0/24
```
The same prefix appears in two VRF tables and not in the underlay table.

</details>

<details>
<summary>Step 5: Watch VXLAN on the wire</summary>

Terminal 1:
```sh
docker exec -it vxlab ip netns exec vtep2 tcpdump -lni u2 udp port 4789
```
Terminal 2:
```sh
docker exec vxlab ip netns exec a1 ping -c2 10.10.0.2
docker exec vxlab ip netns exec b1 ping -c2 10.10.0.2
```
Terminal 1 shows lines like `IP 10.255.0.1.NNNNN > 10.255.0.2.4789: VXLAN, flags [I] (0x08), vni 1000` followed by the inner `IP 10.10.0.1 > 10.10.0.2: ICMP echo request`, and then the same with `vni 2000`. Both pings use identical inner addresses, but the outer VNI differs.

</details>

<details>
<summary>Step 6: Write and run verify.sh</summary>

```sh
#!/bin/sh
fail() { echo "FAIL: $1"; exit 1; }
ip netns exec a1 ping -c2 -W2 10.10.0.2 >/dev/null || fail "red: a1 cannot reach 10.10.0.2"
ip netns exec b1 ping -c2 -W2 10.10.0.2 >/dev/null || fail "blue: b1 cannot reach 10.10.0.2"
a2mac=$(ip -n a2 -br link show a2-eth | awk '{print $3}')
b2mac=$(ip -n b2 -br link show b2-eth | awk '{print $3}')
seen_a=$(ip -n a1 neigh show 10.10.0.2 | awk '{print $5}')
seen_b=$(ip -n b1 neigh show 10.10.0.2 | awk '{print $5}')
[ "$seen_a" = "$a2mac" ] || fail "a1 resolved 10.10.0.2 to $seen_a, expected a2 $a2mac"
[ "$seen_b" = "$b2mac" ] || fail "b1 resolved 10.10.0.2 to $seen_b, expected b2 $b2mac"
ip -n vtep1 route show vrf red | grep -q br-red || fail "no route in VRF red"
ip -n vtep1 route show vrf blue | grep -q br-blue || fail "no route in VRF blue"
echo "PASS: two tenants, same IPs, separate VNIs and VRFs"
```
```sh
docker cp verify.sh vxlab:/verify.sh
docker exec vxlab sh /verify.sh
```

</details>

<details>
<summary>Step 7: Break it on purpose: VNI mismatch</summary>

Change blue's VNI on vtep2 only, then retest:
```sh
docker exec vxlab sh -c '
ip -n vtep2 link del vx2000
ip -n vtep2 link add vx2001 mtu 1500 type vxlan id 2001 local 10.255.0.2 remote 10.255.0.1 dstport 4789
ip -n vtep2 link set vx2001 master br-blue up
ip -n b1 neigh flush all
ip netns exec b1 ping -c2 -W2 10.10.0.2 || echo "blue broken as expected"
ip netns exec a1 ping -c2 -W2 10.10.0.2 && echo "red unaffected"'
```
The VTEPs disagree about blue's VNI, so blue breaks and red keeps working. This is why VNI plans have to be consistent and unique. Put it back:
```sh
docker exec vxlab sh -c '
ip -n vtep2 link del vx2001
ip -n vtep2 link add vx2000 mtu 1500 type vxlan id 2000 local 10.255.0.2 remote 10.255.0.1 dstport 4789
ip -n vtep2 link set vx2000 master br-blue up'
docker exec vxlab sh /verify.sh
```

</details>

**Check it works:** `docker exec vxlab sh /verify.sh` prints `PASS: two tenants, same IPs, separate VNIs and VRFs`, and tcpdump on vtep2's u2 shows VXLAN packets with `vni 1000` for the a1 ping and `vni 2000` for the b1 ping.

<details>
<summary>If you get stuck</summary>

- `Error: Unknown device type` on `type vxlan` or `type vrf`: the host kernel module isn't loaded. On a Linux host, run `sudo modprobe vxlan` and `sudo modprobe vrf`, then recreate the container.
- `vxlan: unknown command "mtu"?`: you put `mtu` after `type vxlan`. Move it before `type`, or set it afterwards with `ip -n <ns> link set <dev> mtu 1500`.
- `RTNETLINK answers: File exists` when you rerun lab.sh: the namespaces already exist. Start clean with `docker rm -f vxlab`, then repeat step 1.
- Pings fail but the loopback ping works: check `ip -n vtep1 -br link` for any interface that is DOWN (each bridge, VXLAN and port must be UP), and check that both VTEPs use the same VNI for a tenant.
- tcpdump shows nothing: make sure you're capturing in the vtep2 namespace on u2 (`ip netns exec vtep2 tcpdump -lni u2 ...`). `-l` stops output buffering.
- `Operation not permitted`: the container wasn't started with `--privileged`.

</details>

**Stretch goal:** Replace the static `remote` flooding with EVPN. Run two privileged containers on one user-defined Docker network (they share a bridge, so no router container is needed), each with the Debian `frr` package and `bgpd=yes` in /etc/frr/daemons. Create the VXLAN devices with `nolearning` and no `remote` (remember: `mtu` before `type`). Configure eBGP between the containers with `address-family l2vpn evpn`, `neighbor <peer> activate` and `advertise-all-vni`, and advertise each container's loopback /32 in IPv4 unicast. Verify with `vtysh -c 'show bgp l2vpn evpn route'`: you should see type-3 routes for each VNI from both VTEPs, and type-2 routes for the tenant MACs after a ping. Then delete one tenant's VXLAN device and watch its routes being withdrawn.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (build task): The troubleshooting hint says that rerunning lab.sh fails with `RTNETLINK answers: File exists`. The first command that fails on a rerun is `ip netns add vtep1`, and iproute2 reports that as `Cannot create namespace file "/run/netns/vtep1": File exists`. A learner searching for the quoted message won't find a match. *Fix:* Quote the actual netns error (or both messages) and keep the remedy: `docker rm -f vxlab`, then restart from step 1.
- **minor** (VXLAN and VNI): In the MTU step of the worked example, the code labels the 50 bytes as 'outer Eth + IPv4 + UDP + VXLAN' and adds that to the inner IP MTU to get the 'underlay IP MTU'. The outer Ethernet header isn't part of an IP MTU; the 14 bytes that count are the inner Ethernet header. The 1550 result is correct and the prose after the code explains it, but the code comment contradicts that explanation. *Fix:* Compute it as inner_frame = 1500 + 14, then underlay_ip_mtu = inner_frame + 20 + 8 + 8 = 1550. Say separately that the 50-byte figure is the size on the wire, including the outer Ethernet header.

---

[← 10-dpu-networking-addressing-pools.md](10-dpu-networking-addressing-pools.md) · [12-boot-network-services.md →](12-boot-network-services.md)
