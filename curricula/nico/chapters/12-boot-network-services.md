# Chapter 12: Boot & Network Services

*Part: Networking & Isolation · 5 concepts · [curriculum](../curriculum.md#chapter-12)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Chapter 8 covered how a machine gets an address (DHCP) and how firmware picks what to boot (boot order, boot source override). Chapters 9–11 built the network: an underlay that BGP routes over, IP pools, and a VXLAN/EVPN overlay in which each tenant network gets a VNI. This chapter connects those pieces to the services NICo uses to boot and connect the machines it manages.

The chapter has five ideas. First, **PXE/iPXE boot**: how a machine with an empty disk loads a program over the network, and what NICo's PXE Service sends it. Second, **resource pools**: the ranges of loopback IPs, VLAN IDs and VNIs that NICo hands out. NICo's docs require all three ranges to be non-empty. Leaving one empty is a misconfiguration that can make setup fail, or leave you with a deployment that is hard to fix afterward. Third, the two physical **network segment types**, `Underlay` and `HostInband`. They decide which network a BMC, a DPU's management port or a host's OS interface sits on. Fourth, the **VNI pool** as a capacity question: how its size limits the number of overlay networks a site can create, and how to add room safely. Fifth, **DPU mode vs NIC mode**. This decides whether a host's DHCP is answered by a server on its own DPU or by the central `nico-dhcp` service.

Why NICo needs all of this: NICo promises that a racked machine reaches the ready state without anyone touching it. That only works if every machine can boot from the network, every endpoint is on the right segment, every allocation comes from a pool that isn't empty, and every DHCP request reaches the right server. If any one of these is wrong, hosts sit there unprovisioned. The build task at the end combines all five ideas into one small server that runs on a laptop, and a QEMU VM network-boots from it.

**By the end of this chapter you can:**

- Trace a network boot from firmware DHCP, through an iPXE script, to the artifact NICo's PXE Service serves to a DPU or an x86 host
- Size and check the three NICo resource pools (lo-ip, vlan-id, vni), and explain why each one must be non-empty
- Assign BMCs, DPU OOB interfaces and host OS interfaces to the correct segment type, Underlay or HostInband
- Estimate how many VPCs a VNI pool supports (assuming one VNI per VPC), and plan an added range that avoids VNIs already in use on the fabric
- Predict which DHCP server answers a host, based on whether its BlueField is in DPU mode, in NIC mode or absent

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [PXE / iPXE boot](#pxe-ipxe-boot)
2. [NICo resource pools](#nico-resource-pools)
3. [Underlay and HostInband network segments](#underlay-and-hostinband-network-segments)
4. [VNI resource pool](#vni-resource-pool)
5. [DPU mode vs NIC mode](#dpu-mode-vs-nic-mode)
6. [Build task: Toy boot-and-network controller: network-boot a QEMU VM from your own PXE + pool server](#build-task)

<a id="pxe-ipxe-boot"></a>
## 1. PXE / iPXE boot

*Builds on: DHCP (ch. 8), UEFI firmware and Secure Boot (ch. 5), PF and VF (SR-IOV) (ch. 10)*

### Before you read

- A brand-new server has an empty disk. When it powers on, what is the very first thing it must get from the network before it can download anything?
- Guess: why would a system load a small network bootloader (iPXE) first, instead of having the firmware download the OS directly?

<details>
<summary>Answers</summary>

- **A brand-new server has an empty disk. When it powers on, what is the very first thing it must get from the network before it can download anything?** An IP address, plus directions to a boot file. DHCP provides both. Without an address, the machine can't talk to any server.
- **Guess: why would a system load a small network bootloader (iPXE) first, instead of having the firmware download the OS directly?** The network boot built into firmware is limited. Classic PXE uses slow TFTP and can't run scripts. iPXE adds HTTP, scripting and variables (such as the machine's MAC address), so the server can give each machine its own instructions and deliver large images efficiently.

</details>

### Explanation

**Network booting** means the firmware loads its first program from the network instead of from a local disk.

**Classic PXE** (Preboot eXecution Environment) works like this:
1. The firmware sends a DHCP request. The reply contains an IP address, a *next-server* and a *boot filename*.
2. The firmware downloads that file, a small *network bootstrap program*. It usually uses TFTP, a very simple and slow file-transfer protocol.
3. The program runs and continues the boot.

**UEFI HTTP boot** lets UEFI firmware fetch a boot URL over HTTP directly. If Secure Boot is on (ch. 5), the firmware only runs EFI binaries that have valid signatures.

**iPXE** is an open-source network bootloader, and it is often the program loaded in step 2. It runs **iPXE scripts**: plain text files that start with `#!ipxe`. In a script, `${net0/mac}` expands to the NIC's MAC address and `${buildarch}` expands to the CPU architecture. `chain URL` downloads the next script or binary and runs it. The client fills in the variables before making the request, so the server can return a different script for each machine.

**What NICo does.** The **PXE Service** (`nico-pxe`) serves boot artifacts over HTTP: iPXE scripts, cloud-init user-data and OS images. It is **stateless**. For each request, it asks the API Service (NICo Core) over mTLS/gRPC which artifact this host should get. The Redfish workflow describes these cases:
- A **DPU** is set to boot via *HTTP IPv4 UEFI* and power-cycled through Redfish. It fetches `nico.efi` and cloud-init user-data containing its `machine_id` and `server_uri`, then installs `dpu-agent`.
- An **x86 host** gets `scout.efi` with `cli_cmd=auto-detect` for discovery.
- The host's UEFI boot order puts the **DPU's PF MAC first** (ch. 10), so the host network-boots through the DPU.

Managed hosts are configured to always boot from PXE. If PXE finds a local bootable device, the host boots that device. NICo supports any OS that can be installed via iPXE. After it hands off the boot, NICo manages nothing inside the OS.

One current caveat: DPF is now the default for *DPU* provisioning. Setting `"dpf_enabled": false` for a host keeps it on the *deprecated* iPXE path. Hosts are still booted with PXE/iPXE.

**Analogy.** Think of checking in at a conference. The front desk (DHCP) gives you a badge (your IP address) and a slip that says "go to booth 4" (the boot filename). At booth 4 (the PXE Service), a clerk looks up your badge number with head office (the API Service) and hands you a personal agenda (an iPXE script) that sends you to the right sessions (kernel, image, cloud-init). Where the analogy breaks down: a real attendee remembers who they are. A booting machine remembers nothing, so its whole identity comes from what it sends (MAC, architecture) and what the server sends back.

### Worked example: Serve and fetch an iPXE script on your laptop

**Step 1: Write an iPXE script.**

```bash
mkdir -p ~/pxe-lab && cd ~/pxe-lab
cat > boot.ipxe <<'EOF'
#!ipxe
dhcp
echo Booting ${net0/mac} on ${buildarch}
chain http://10.0.2.2:8000/next.ipxe?mac=${net0/mac:hexhyp}
EOF
```
The `#!ipxe` line marks the file as an iPXE script. `${net0/mac:hexhyp}` writes the MAC with hyphens instead of colons, which is safe to put in a URL.

**Step 2: Serve it over HTTP.**

```bash
python3 -m http.server 8000
```
This plain HTTP file server plays the role of NICo's PXE Service. Leave it running.

**Step 3: Fetch it the way iPXE would.**

In a second terminal:
```bash
curl -i http://localhost:8000/boot.ipxe
```
You get `200 OK` and the script exactly as you wrote it. The `${...}` placeholders are still there because **iPXE expands them on the client**, not on the server. The request also appears in the server's terminal, because Python's http.server logs to stderr.

**Step 4: Map it to the full chain.**

The real flow: firmware DHCP provides an address and a boot file or URL → the firmware loads iPXE (or, with UEFI HTTP boot, an EFI binary directly) → iPXE runs this script → `chain` fetches the next artifact. In NICo, the server answering that request is `nico-pxe`. It asks NICo Core which artifact this machine should get: `nico.efi` plus cloud-init (`machine_id`, `server_uri`) for a DPU, or `scout.efi` for an x86 host.

**Step 5: (Optional) Boot a real VM.**

If you have QEMU installed, `qemu-system-x86_64 -m 256 -nographic -boot n -netdev user,id=n0,bootfile=http://10.0.2.2:8000/boot.ipxe -device e1000,netdev=n0` network-boots a VM. QEMU's built-in DHCP gives the VM the URL, and the emulated NIC's boot ROM is iPXE. The server log shows the VM fetch `boot.ipxe` and then request `next.ipxe`, which returns 404 because that file doesn't exist yet. Quit QEMU with Ctrl-a then x.

### Your turn: finish it

Fill in the two blanks so this iPXE script is valid and hands off to a per-host URL on the toy server.

```text
___
echo Fetching per-host script for ${net0/mac}
___ http://10.0.2.2:8080/host?mac=${net0/mac:hexhyp}
```

<details>
<summary>Answer</summary>

Line 1 is `#!ipxe`, the header every iPXE script needs. Line 3 starts with `chain`, the command that downloads the URL and runs it as the next script or binary.

</details>

### Your turn: on your own

Write a small Python HTTP server on 127.0.0.1:8081. A request like `GET /boot?arch=arm64` should get an iPXE script saying it would chain `nico.efi` (the DPU case). `arch=x86_64` should get one saying it would chain `scout.efi` (the host case). Anything else gets a 404. An iPXE client would call it with `chain http://SERVER:8081/boot?arch=${buildarch}`. Test it with curl. (This is a toy, not NICo's real API.)

<details>
<summary>Hint 1</summary>

Use `http.server.BaseHTTPRequestHandler` and override `do_GET`.

</details>

<details>
<summary>Hint 2</summary>

Pass `urllib.parse.urlparse(self.path).query` to `parse_qs` to get the `arch` value.

</details>

<details>
<summary>Hint 3</summary>

Keep a dict like `{"arm64": "#!ipxe\necho would chain nico.efi (DPU)\n", "x86_64": ...}`. Send the matching body with `send_response`, a `Content-Length` header, `end_headers()` and `wfile.write()`.

</details>

<details>
<summary>Answer</summary>

```python
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

SCRIPTS = {
    "arm64": "#!ipxe\necho would chain nico.efi (DPU)\n",
    "x86_64": "#!ipxe\necho would chain scout.efi (host)\n",
}

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        arch = parse_qs(urlparse(self.path).query).get("arch", [""])[0]
        body = SCRIPTS.get(arch, "#!ipxe\necho unknown arch\n").encode()
        self.send_response(200 if arch in SCRIPTS else 404)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

HTTPServer(("127.0.0.1", 8081), H).serve_forever()
```
To test: `curl -i 'http://127.0.0.1:8081/boot?arch=arm64'` returns 200 with the nico.efi line, `arch=x86_64` returns the scout.efi line, and `arch=riscv64` returns 404.

</details>

### Explain it

In your own words: Why does NICo keep the PXE Service stateless and have it ask the API Service for each host's artifact, instead of giving it its own list of which host boots what?

### Check

**1. Which statement about NICo's PXE Service is correct?**

A. It keeps its own database of which image each host should boot
B. It serves iPXE scripts, cloud-init user-data and OS images over HTTP, and asks the API Service which artifact each host gets
C. It hands out IP addresses to hosts while they boot
D. It sets the host boot order on the BMC over Redfish

<details>
<summary>Answer</summary>

**B.** It serves iPXE scripts, cloud-init user-data and OS images over HTTP, and asks the API Service which artifact each host gets

nico-pxe is stateless, and only the API Service reads and writes PostgreSQL. IP addresses come from DHCP (nico-dhcp or the DPU-local server), not from PXE. The boot order is set over Redfish in a separate step of the workflow.

</details>

**2. A BlueField DPU is set to boot via HTTP IPv4 UEFI and power-cycled. What does the PXE server give it?**

A. scout.efi with cli_cmd=auto-detect
B. nico.efi with cloud-init user-data containing machine_id and server_uri
C. A TFTP-only pxelinux.0 and nothing else
D. The tenant's chosen OS image

<details>
<summary>Answer</summary>

**B.** nico.efi with cloud-init user-data containing machine_id and server_uri

The PXE server chooses the artifact by architecture. ARM DPUs get nico.efi plus cloud-init, which leads to dpu-agent being installed. scout.efi is for x86 hosts during discovery. The tenant OS is installed on the host later, not on the DPU.

</details>

**3. Why does NICo put the DPU's PF MAC first in the host's UEFI boot order?**

<details>
<summary>Answer</summary>

So the host network-boots through the DPU's network path. That path leads to NICo's PXE Service, which returns the artifact NICo has chosen for the host.

The docs say `set_boot_order_dpu_first` prioritises the DPU's PF MAC, "ensuring the host boots through the DPU's network path." If the boot order started with a local disk or a different NIC, the host would bypass NICo's control of the boot.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [overview/operational-principles.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/operational-principles.md), [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="nico-resource-pools"></a>
## 2. NICo resource pools

*Builds on: VXLAN and VNI (ch. 11), CIDR prefixes and /31 point-to-point subnets (ch. 3)*

### Before you read

- If two DPUs got the same loopback IP, what would go wrong on a BGP/EVPN fabric?
- Guess: what would happen if an operator left the VNI range empty in the site config?

<details>
<summary>Answers</summary>

- **If two DPUs got the same loopback IP, what would go wrong on a BGP/EVPN fabric?** Each DPU uses its loopback as its unique identity on the fabric: as its BGP router ID or its VXLAN tunnel endpoint. With a duplicate, routes and tunnels meant for one DPU would reach the other, or be rejected. That's why one central allocator hands loopbacks out from a pool.
- **Guess: what would happen if an operator left the VNI range empty in the site config?** NICo would have nothing to hand out when it needs a VNI. NICo's docs require all three ranges (lo-ip, vlan-id, vni) to be non-empty. An empty range is a misconfiguration. The Quick Start warns that missing required values can make setup fail, or leave a deployment that is hard to fix afterward.

</details>

### Explanation

A **resource pool** is a range of identifiers that NICo owns and hands out one value at a time. A single allocator, NICo Core backed by PostgreSQL, gives out every value, so no two objects get the same one. When a value is no longer needed, it goes back into the pool.

The site configuration (the `siteConfig` TOML in `helm-prereqs/values/nico-core.yaml`) defines three pools:

| Pool | Quick Start description | Related idea |
|---|---|---|
| `[pools.lo-ip]` | Loopback IP range allocated to bare-metal hosts | Device loopbacks (the docs also mention DPU-loopback allocations) |
| `[pools.vlan-id]` | VLAN ID allocation range | VLANs (ch. 10) |
| `[pools.vni]` | VXLAN Network Identifier range | VNIs in the overlay (ch. 11) |

The Quick Start states that **the `[pools.lo-ip]`, `[pools.vlan-id]` and `[pools.vni]` ranges must be non-empty**. It also warns that missing required values can make setup fail, or produce an incorrectly configured deployment that is hard to fix afterward. The exact field syntax is documented in inline comments in that values file, so read it there instead of guessing.

A **loopback** address is a single address (a `/32`) that belongs to the device itself, not to any one link. On a routed fabric, it is the device's stable identity: BGP uses it, and so does VXLAN as the tunnel endpoint. Compare this with the `/31` point-to-point subnets from ch. 3. A `/31` holds two addresses and addresses the *link* between two routers. A loopback holds one address and addresses the *device*. So a lo-ip range written as `10.99.0.0/24` has room for at most 256 loopbacks. The docs also say to keep DPU loopbacks and VXLAN tunnel endpoints on IPv4, even on sites that use IPv6 elsewhere.

Pools come up at several points in the lifecycle:
- **Day 0 ingestion**: NICo allocates and configures IP address pools for BGP, loopback and the host OS.
- **Tenant release (Day 2)**: when a tenant VRF is torn down, NICo returns the tenant IP, VNI and DPU-loopback allocations to their pools.

When planning a pool, check two things. **Capacity**: is the range big enough for the fleet plus growth? **Overlap**: does the range collide with something the network team already uses, such as the admin network or the OOB network? Python's `ipaddress` module can answer both.

**Analogy.** Think of the ticket rolls at a deli counter, with one roll for each kind of ticket. Each customer takes the next ticket, so no two people hold the same number. If one roll is empty, that part of the counter can't serve anyone, which is why all three rolls must be loaded before opening. Where the analogy breaks down: deli tickets get thrown away. NICo's values go back into the pool when a tenant leaves and are handed out again later.

### Worked example: Size and sanity-check three pools with Python

**Step 1: Write the planned ranges down.**

```python
# pools_check.py: toy planning script, not NICo's config format
import ipaddress

lo_ip   = ipaddress.ip_network("10.99.0.0/24")
vlan_id = (100, 1099)
vni     = (10000, 10999)
admin   = ipaddress.ip_network("10.98.0.0/22")   # existing admin network
```

**Step 2: Compute capacity.**

```python
print("lo-ip  :", lo_ip.num_addresses)            # 256
print("vlan-id:", vlan_id[1] - vlan_id[0] + 1)    # 1000
print("vni    :", vni[1] - vni[0] + 1)            # 1000
```
Each loopback is a /32, so the usual LAN rule of losing two addresses per subnet (network and broadcast) doesn't apply.

**Step 3: Check value limits.**

```python
assert 1 <= vlan_id[0] <= vlan_id[1] <= 4094, "VLAN IDs are 1-4094"
assert 1 <= vni[0] <= vni[1] <= 2**24 - 1, "VNIs are 24-bit"
```

**Step 4: Check for overlaps.**

```python
assert not lo_ip.overlaps(admin), "lo-ip overlaps the admin network"
print("ok")
```
Run `python3 pools_check.py`. Then change `admin` to `10.99.0.0/16` and run it again: the overlap assertion fails. It's better to find that collision now than after ingestion.

### Your turn: finish it

Complete the validator so it rejects a config in which any of NICo's three required pools is missing or empty. `pools` maps a pool name to a list of ranges.

```text
REQUIRED = ("lo-ip", "vlan-id", "___")

def check(pools):
    for name in REQUIRED:
        if ___:
            raise ValueError(f"pool {name} must be non-empty")

check({"lo-ip": [("10.99.0.1", "10.99.0.254")], "vlan-id": [(100, 199)], "vni": []})
```

<details>
<summary>Answer</summary>

The first blank is `vni`, which gives `REQUIRED = ("lo-ip", "vlan-id", "vni")`. The second blank is `not pools.get(name)`. With both filled in, the sample call raises `ValueError: pool vni must be non-empty`: an empty list is falsy, and a missing key returns None.

</details>

### Your turn: on your own

Your site will have 150 managed hosts, each with one DPU. Assume each DPU needs one loopback from lo-ip. What is the smallest single CIDR block that fits them? Would that block also fit a planned expansion to 300 DPUs? Show the arithmetic and a one-line Python check.

<details>
<summary>Hint 1</summary>

A loopback is one /32, so a block holds 2^(32 − prefix length) loopbacks.

</details>

<details>
<summary>Hint 2</summary>

A /25 holds 128 and a /24 holds 256.

</details>

<details>
<summary>Hint 3</summary>

150 > 128, so a /25 is too small. 300 > 256, so the expansion needs a /23 (512) or a second range.

</details>

<details>
<summary>Answer</summary>

The smallest block for 150 DPUs is a /24 (256 addresses), because a /25 holds only 128. A /24 won't fit 300 DPUs. For that you need a /23 (512) or a second range added to the pool. Python check: `import ipaddress; print(ipaddress.ip_network('10.99.0.0/24').num_addresses >= 150, ipaddress.ip_network('10.99.0.0/24').num_addresses >= 300)` prints `True False`.

</details>

### Explain it

In your own words: Why do NICo's docs require all three pools to be filled in up front, instead of letting an operator leave one empty and fill it in when it's first needed?

### Check

**1. A site config leaves the VNI range empty but defines lo-ip and vlan-id. How should you treat this?**

A. Fine: NICo generates VNIs automatically from the VLAN IDs
B. Fine: it's a supported setup for sites that don't plan to use VPCs
C. A misconfiguration: the docs require all three pool ranges to be non-empty
D. Fine, as long as the VLAN pool is large

<details>
<summary>Answer</summary>

**C.** A misconfiguration: the docs require all three pool ranges to be non-empty

The Quick Start says the lo-ip, vlan-id and vni ranges must be non-empty, and warns that missing required values can make setup fail or leave a deployment that is hard to fix. The docs don't describe any VNI-free mode, and they don't say NICo derives VNIs from VLANs. VLAN IDs and VNIs are separate identifier spaces (12-bit vs 24-bit).

</details>

**2. When a tenant releases a host and NICo tears down the tenant VRF, what happens to the tenant IP, VNI and DPU-loopback allocations?**

A. They stay reserved for that tenant forever
B. They are returned to their pools
C. They are deleted, permanently shrinking the pools
D. The network team has to reclaim them by hand on the leaf switches

<details>
<summary>Answer</summary>

**B.** They are returned to their pools

The Day 2 cleanup section says NICo returns tenant IP, VNI and DPU-loopback allocations to their pools. The fabric stays static, so nobody reconfigures the leaf switches.

</details>

**3. Which of these is NOT one of the three resource pools the NICo site config requires?**

A. lo-ip
B. vlan-id
C. vni
D. bmc-mac

<details>
<summary>Answer</summary>

**D.** bmc-mac

BMC MAC addresses are burned into the hardware and listed in expected_machines.json. NICo doesn't allocate them. The three required pools are lo-ip, vlan-id and vni.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md)

<a id="underlay-and-hostinband-network-segments"></a>
## 3. Underlay and HostInband network segments

*Builds on: Underlay and overlay networks (ch. 9), Out-of-band (OOB) management (ch. 7), BlueField DPU (ch. 7)*

### Before you read

- A host has a BlueField DPU. Its host BMC, DPU BMC and DPU OOB port all need IP addresses before NICo can do anything. Which network do you think they sit on: the tenant overlay, or something else?
- A host has no DPU at all. Where does its operating system's NIC get a DHCP address from?

<details>
<summary>Answers</summary>

- **A host has a BlueField DPU. Its host BMC, DPU BMC and DPU OOB port all need IP addresses before NICo can do anything. Which network do you think they sit on: the tenant overlay, or something else?** Something else: the physical management network. NICo calls this the Underlay segment type, and it is normally a dedicated OOB network. These ports need addresses before any tenant overlay exists, and their DHCP requests are relayed to the central nico-dhcp.
- **A host has no DPU at all. Where does its operating system's NIC get a DHCP address from?** With no DPU, there's no local DHCP server. The request goes through a relay to the central nico-dhcp, on a physical segment of type HostInband.

</details>

### Explanation

A **network segment** in NICo is a network (a subnet/VLAN) that NICo knows about and allocates addresses on. NICo runs a state machine for segments (ch. 4). This lesson covers two *physical* segment types. Both are served by the central `nico-dhcp` service, which receives requests through DHCP relays on the switches and forwards them to NICo Core for IP address management.

**Underlay** is the conventional management segment. It carries:
- host BMCs
- DPU BMCs
- DPU OOB (out-of-band) interfaces

Underlay is normally a dedicated OOB network (ch. 7), with a DHCP relay on every BMC-facing network pointing at the `nico-dhcp` VIP. Site Explorer probes the BMCs it finds here over Redfish. NICo's `Underlay` segment type is *not* the same thing as the BGP underlay fabric from ch. 9, even though both are physical networks rather than overlays.

**HostInband** is a physical segment for **zero-DPU hosts**: hosts that have no DPU, or whose DPU policy is `nic` (lesson 5). It carries:
- the host OS interface, whose DHCP requests go to the central `nico-dhcp`
- optionally, that same host's BMC, sharing one subnet/VLAN with the host OS NIC

Two rules apply:
1. The sharing exception covers **host BMCs only**. A **DPU BMC or DPU OOB interface always stays on Underlay**.
2. On HostInband, Site Explorer treats only **BMC-typed interfaces** as Redfish endpoints. Ordinary host data interfaces are not Redfish targets.

What about a host whose DPU runs in DPU mode? A **DHCP server on the DPU itself** answers its OS DHCP requests. Those requests never reach the physical underlay, so that host's OS interface isn't on HostInband. The host's BMC and the DPU's BMC and OOB port are still on Underlay.

Sharing HostInband with a BMC comes with its own requirements for allocation, relay, DNS subdomain and isolation. A later chapter (ch. 29) covers them.

**Analogy.** Think of an office building. The Underlay is a locked service corridor that only facilities staff use to reach the electrical panels (the BMCs and DPU management ports). HostInband is an ordinary hallway, shared by a tenant office that has no reception desk of its own (a zero-DPU host). That office's own panel may also be reached from the hallway, but the building's main panels (DPU BMCs) never are. Where the analogy breaks down: anyone can walk down a real hallway. Sharing HostInband comes with specific isolation requirements, and only BMC-typed doors get knocked on (probed over Redfish).

### Worked example: Place every interface in a two-host rack

**Step 1: List the endpoints.**

Host A has one BlueField in DPU mode. Host B has no DPU. The endpoints are A-host-BMC, A-DPU-BMC, A-DPU-OOB, A-host-OS, B-host-BMC and B-host-OS.

**Step 2: Put management ports on Underlay first.**

A-host-BMC, A-DPU-BMC and A-DPU-OOB go on **Underlay**. The DPU BMC and DPU OOB *must* be there. The host BMC is there in the conventional layout.

**Step 3: Handle the DPU-mode host OS.**

A-host-OS gets DHCP from the **DHCP server running on A's DPU**. The request stays local and never reaches the physical underlay, so A-host-OS isn't on any physical NICo segment.

**Step 4: Handle the zero-DPU host.**

B-host-OS goes on **HostInband**, with its DHCP relayed to the central `nico-dhcp`. B-host-BMC goes on **Underlay**, or it can optionally share the HostInband subnet with B-host-OS.

**Step 5: Check what Site Explorer will probe.**

The Redfish targets are every BMC on Underlay, plus B-host-BMC if it sits on HostInband as a BMC-typed interface. B-host-OS is not a target, because ordinary data interfaces on HostInband are not Redfish targets.

### Your turn: finish it

Fill in the blank segment types in this toy Python mapping for host C. Its DPU policy is `nic`, so it is treated as a zero-DPU host, and its BMC shares the host OS subnet.

```text
placement = {
    "C-host-OS":  "___",
    "C-host-BMC": "HostInband",
    "C-DPU-BMC":  "___",
}
print(placement)
```

<details>
<summary>Answer</summary>

`"C-host-OS": "HostInband"` and `"C-DPU-BMC": "Underlay"`. The shared-HostInband exception covers the host BMC and host OS of a zero-DPU (or `nic`-policy) host. It never covers a DPU BMC or DPU OOB interface.

</details>

### Your turn: on your own

To reduce the number of VLANs, an operator puts the DPU BMCs of several DPU-mode hosts on the same HostInband subnet as some zero-DPU hosts' OS NICs. Explain which rule this breaks and what the correct layout is.

<details>
<summary>Hint 1</summary>

Which endpoint types does the HostInband sharing exception allow?

</details>

<details>
<summary>Hint 2</summary>

The docs say the exception "does not apply to a DPU BMC or DPU OOB interface".

</details>

<details>
<summary>Hint 3</summary>

Move the DPU BMCs back to Underlay. Only zero-DPU hosts' OS NICs and, optionally, their own host BMCs belong on HostInband.

</details>

<details>
<summary>Answer</summary>

HostInband is for zero-DPU host OS interfaces and, optionally, those hosts' own BMCs. DPU BMCs and DPU OOB interfaces must be on Underlay, which is normally the dedicated OOB network with a DHCP relay to nico-dhcp. The correct layout: DPU BMCs and DPU OOB ports on Underlay; the zero-DPU hosts' OS NICs (and optionally their host BMCs) on HostInband; the DPU-mode hosts' OS DHCP handled locally by their DPUs.

</details>

### Explain it

In your own words: Why does it make sense that a DPU-mode host's OS DHCP never reaches the physical underlay, while a zero-DPU host's OS DHCP has to travel over HostInband to the central nico-dhcp?

### Check

**1. Which interface may NOT be placed on a HostInband segment?**

A. The OS NIC of a zero-DPU host
B. The host BMC of a zero-DPU host
C. A DPU OOB interface
D. The host BMC of a host whose DPU policy is nic

<details>
<summary>Answer</summary>

**C.** A DPU OOB interface

The shared-HostInband exception covers zero-DPU hosts, including hosts with DPU policy nic: their OS NIC and, optionally, their host BMC. DPU BMCs and DPU OOB interfaces always need Underlay.

</details>

**2. On a HostInband segment, which interfaces does Site Explorer probe over Redfish?**

A. Every address on the segment
B. Only BMC-typed interfaces
C. None, because Site Explorer only scans Underlay
D. Only host OS interfaces

<details>
<summary>Answer</summary>

**B.** Only BMC-typed interfaces

Site Explorer scans Underlay BMCs, plus BMC-typed interfaces in the supported shared-HostInband topology. Ordinary host data interfaces on HostInband are not Redfish targets.

</details>

**3. Does the central nico-dhcp serve the host OS of a host whose DPU is managed in DPU mode?**

<details>
<summary>Answer</summary>

No. A DHCP server on the DPU, configured by dpu-agent, handles that host's requests locally, so they never reach the physical underlay.

The docs say nico-dhcp "does not serve the local overlay DHCP of a host with a managed DPU." It serves endpoints on Underlay and HostInband.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md)

<a id="vni-resource-pool"></a>
## 4. VNI resource pool

*Builds on: NICo resource pools (ch. 12)*

### Before you read

- In ch. 11, each tenant network (VPC/VRF) got its own VNI. Suppose a site's VNI pool holds exactly 500 values and each VPC takes one VNI. What's the most VPCs that can exist at once?
- Guess: what would go wrong if two tenant VPCs were given the same VNI?

<details>
<summary>Answers</summary>

- **In ch. 11, each tenant network (VPC/VRF) got its own VNI. Suppose a site's VNI pool holds exactly 500 values and each VPC takes one VNI. What's the most VPCs that can exist at once?** 500, under that assumption. Once every VNI is handed out, a new VPC can't get one until an allocation goes back to the pool or more values are added.
- **Guess: what would go wrong if two tenant VPCs were given the same VNI?** VXLAN/EVPN uses the VNI to tell overlay networks apart on the wire. If two tenants shared a VNI, the fabric couldn't keep their traffic separate, so isolation would break. That's why VNIs come from a single allocator.

</details>

### Explanation

The **VNI resource pool** is the `[pools.vni]` range from lesson 2, looked at as a capacity question. The Quick Start describes it as the site's "VXLAN Network Identifier range". Operators fill it in in `siteConfig`, it must be non-empty, and NICo allocates VNIs for the overlay from it. Ch. 11 showed that VXLAN/EVPN uses the VNI to tell overlay networks apart on the wire, so two tenant networks must never share one.

**A working assumption.** In ch. 11, each tenant VPC (VRF) had its own L3VNI. This lesson carries that model forward and *assumes* each VPC needs one VNI from the pool. The docs pages for this chapter don't say exactly how many VNIs NICo allocates per VPC. Treat the arithmetic below as planning under that assumption, and check it against your release's VPC documentation before you size a real site.

**Under that assumption, the pool caps the VPC count.** The number of free VNIs is the number of new VPCs you can still create. Once the pool is empty, new overlay networks can't get a VNI. When a tenant VRF is torn down during Day 2 cleanup, NICo returns its VNI allocation to the pool.

**Plan capacity.** Size the pool for the VPCs you expect, with room to grow. A range from `lo` to `hi` inclusive holds `hi - lo + 1` VNIs, and multiple ranges add together.

**Respect the identifier space.** A VNI is a 24-bit field, so the largest valid value is 16,777,215. That's far more than VLAN IDs (12-bit, 1–4094), and the small VLAN space is one reason VXLAN exists.

**Avoid collisions.** Pick ranges that don't overlap VNIs the network team already uses on the fabric for other purposes. NICo doesn't touch the leaf switches ("the network fabric stays static"), but the fabric's own VNIs share the same EVPN space as NICo's.

**Growing a pool on a live site.** The pages for this chapter don't document how to grow an established pool. Before changing anything, look up the supported procedure for your release in the NICo operations docs or the `nico-admin-cli` reference, and don't guess commands. Whatever the procedure is, plan the change the same way: add a *new, non-overlapping* range alongside the existing one. Shrinking or rewriting a range that is in use could strand VNIs that live tenant networks depend on.

**Analogy.** Think of a phone company that owns a block of numbers. It can sign up as many subscribers as the block has numbers. When the block runs out, it gets an extra block instead of renumbering everyone, and a cancelled line's number goes back into stock. Where the analogy breaks down: people dial phone numbers, but a VNI is a label inside a packet. And if two carriers held overlapping blocks, the result wouldn't just be a wrong number: tenant traffic would leak across isolation boundaries.

### Worked example: Simulate VNI exhaustion and an added range

**Step 1: Model a small pool.**

```python
# vni_sim.py: toy model assuming one VNI per VPC; not NICo code
free = list(range(10000, 10003))   # 3 VNIs
vpcs = {}

def create(name):
    if not free:
        print(f"{name}: FAILED, VNI pool exhausted")
        return
    vpcs[name] = free.pop(0)
    print(f"{name}: vni {vpcs[name]}")
```

**Step 2: Fill it up.**

```python
for n in ["vpc-a", "vpc-b", "vpc-c", "vpc-d"]:
    create(n)
```
The first three VPCs get 10000–10002, and vpc-d fails. Under the one-VNI-per-VPC assumption, the pool size capped the VPC count at 3.

**Step 3: Teardown returns capacity.**

```python
free.append(vpcs.pop("vpc-b"))   # like a tenant VRF being torn down
create("vpc-d")                  # gets 10001
```

**Step 4: Add a non-overlapping range.**

```python
free.extend(range(11000, 11002))   # stand-in for adding a new range to the pool
create("vpc-e"); create("vpc-f")
```
Run `python3 vni_sim.py`. The existing VPCs keep their VNIs. Only the new ones draw from the added range.

### Your turn: finish it

Complete the expression so `capacity` is the total number of VNIs across all configured ranges (bounds are inclusive). With the ranges shown, it should print 1500.

```text
ranges = [(10000, 10999), (20000, 20499)]
capacity = sum(___ for lo, hi in ranges)
print(capacity)
```

<details>
<summary>Answer</summary>

`hi - lo + 1`. The bounds are inclusive, so 10000–10999 holds 1000 VNIs and 20000–20499 holds 500, for a total of 1500.

</details>

### Your turn: on your own

The site's VNI pool is 10000–10999. Assume each VPC uses one VNI. There are 950 VPCs now, and the business expects 1,400 within a year. The network team already uses VNIs 11000–11199 on the fabric. Propose a range to add, state how many VPCs the pool will support in total, and list the checks you'd run before applying it.

<details>
<summary>Hint 1</summary>

Current capacity is 1000, so you need at least 400 more, plus some margin.

</details>

<details>
<summary>Hint 2</summary>

The obvious next block, starting at 11000, collides with the network team's VNIs.

</details>

<details>
<summary>Hint 3</summary>

Something like 11200–11799 (600 VNIs) brings the total to 1600. Check that it overlaps nothing, that every value is at most 16,777,215, and that you add it alongside the existing range instead of rewriting that range.

</details>

<details>
<summary>Answer</summary>

Example: add 11200–11799 (600 VNIs). Total capacity becomes 1000 + 600 = 1600, which covers 1,400 with 200 to spare. Checks: (1) The new range doesn't overlap 10000–10999 or the fabric's 11000–11199. (2) Every value is at most 2^24−1 = 16,777,215. (3) The new range is added alongside the existing one, and the in-use 10000–10999 range is left untouched. (4) The one-VNI-per-VPC assumption holds according to your release's docs. (5) You apply it with the pool-growth procedure your NICo release documents, then confirm that a new VPC can be created.

</details>

### Explain it

In your own words: Why is adding a new, separate VNI range safer than rewriting the existing range into a bigger one somewhere else?

### Check

**1. Assume each VPC uses one VNI. A VNI pool holds 3 VNIs and 3 VPCs exist. A tenant asks for a 4th VPC. What happens?**

A. NICo reuses one of the existing VPCs' VNIs
B. NICo falls back to a VLAN ID from the vlan-id pool
C. The VPC can't get a VNI until one is returned to the pool or the pool gets more values
D. NICo reconfigures the leaf switches to create more VNIs

<details>
<summary>Answer</summary>

**C.** The VPC can't get a VNI until one is returned to the pool or the pool gets more values

Under that assumption, the pool size caps the VPC count. Sharing a VNI would break isolation, VLAN IDs come from a separate pool, and NICo doesn't reconfigure leaf switches because the fabric stays static.

</details>

**2. Before NICo can allocate a VNI for a new overlay network, which siteConfig pool must still have free values?**

A. [pools.lo-ip]
B. [pools.vlan-id]
C. [pools.vni]
D. The expected_machines.json manifest

<details>
<summary>Answer</summary>

**C.** [pools.vni]

VNIs come only from the VXLAN Network Identifier range in [pools.vni]. lo-ip holds loopback IP addresses and vlan-id holds 12-bit VLAN IDs, and neither can stand in for a VNI. expected_machines.json lists the hardware to ingest and isn't a pool.

</details>

**3. Roughly how many distinct VNI values does the VXLAN header allow?**

A. 4,094 (12-bit)
B. About 16.7 million (24-bit)
C. About 4.3 billion (32-bit)

<details>
<summary>Answer</summary>

**B.** About 16.7 million (24-bit)

A VNI is 24 bits, so the largest value is 16,777,215. 4,094 is the usable VLAN ID range (12-bit), which is a common mix-up.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [overview/operational-principles.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/operational-principles.md)

<a id="dpu-mode-vs-nic-mode"></a>
## 5. DPU mode vs NIC mode

*Builds on: BlueField DPU (ch. 7), DHCP (ch. 8)*

### Before you read

- A BlueField has its own ARM CPU and OS. If that OS isn't running a networking stack, what is the card still useful for?
- If a host's BlueField is in NIC mode, who answers the host OS's DHCP request?

<details>
<summary>Answers</summary>

- **A BlueField has its own ARM CPU and OS. If that OS isn't running a networking stack, what is the card still useful for?** It can still pass traffic as an ordinary high-speed NIC. That's NIC mode: the host sees a network card, and nothing on the card's ARM cores manages the traffic.
- **If a host's BlueField is in NIC mode, who answers the host OS's DHCP request?** The central nico-dhcp, through a DHCP relay on a HostInband segment. There is no DPU-local DHCP server, because that server only exists when the DPU runs in DPU mode under NICo's management.

</details>

### Explanation

A BlueField can run in one of two **operating modes**, set at the firmware level:

- **DPU mode**: the card's ARM OS sits in the data path and manages networking. In this mode, NICo runs `dpu-agent`, HBN (containerised Cumulus) for VXLAN/EVPN isolation, the metadata service and a **per-host DHCP server** on the card. The DPU is NICo's enforcement boundary, as the "machine is untrustworthy" principle requires.
- **NIC mode**: the card behaves like a plain NIC. Nothing on the ARM side manages the host's traffic, so that host has no NICo agent, no HBN and no local DHCP server.

**Effect on DHCP:**

| Host type | Who answers host OS DHCP | Segment |
|---|---|---|
| BlueField in DPU mode (managed) | DHCP server on the DPU (requests stay off the physical underlay) | n/a (local) |
| BlueField in NIC mode (DPU policy `nic`) | central `nico-dhcp` via relay | HostInband |
| No DPU (zero-DPU host) | central `nico-dhcp` via relay | HostInband |

NICo treats a NIC-mode host like a zero-DPU host. For example, its host BMC may share the HostInband subnet.

**Effect on ingestion.** Site Explorer works out a target mode from the host's **DPU policy** and the device's **part number**. Mode changes need a **host power cycle**, and ingestion waits until they take effect. A device that reports NIC mode counts toward pairing completeness but **is not attached as a managed DPU**. Hosts with `dpu_policy = "ignore"` skip DPU matching entirely. A missing Redfish mode doesn't block attachment by itself.

**Site controller nodes are different.** If those nodes have BlueField-3s, the docs require them to be in DPU mode and fully provisioned before the Kubernetes cluster is built. NICo does not manage those DPUs.

In practice, a host's DPU mode tells you three things: which DHCP server it uses, which segment its OS NIC sits on, and whether NICo can enforce isolation on its DPU.

**Analogy.** Think of a building entrance. In DPU mode, a security guard stands at the door, checks who comes in and out (isolation) and hands out visitor passes on the spot (local DHCP). In NIC mode, people still walk through the doorway, but no guard is posted, so visitors must get a pass from the central reception desk (nico-dhcp on HostInband). Where the analogy breaks down: a building can post a guard in seconds. Switching a BlueField's mode is a firmware change that needs a host power cycle.

### Worked example: Decide the DHCP path for three hosts

**Step 1: Write the decision as code.**

```python
# mode_path.py: toy decision table, not NICo code
def dhcp_path(mode):
    if mode == "dpu":
        return "DPU-local DHCP server (stays off the underlay)"
    if mode in ("nic", "none"):
        return "central nico-dhcp via relay on HostInband"
    raise ValueError(mode)
```

**Step 2: Apply it to an inventory.**

```python
for host, mode in [("h1", "dpu"), ("h2", "nic"), ("h3", "none")]:
    print(host, mode, "->", dhcp_path(mode))
```
Run `python3 mode_path.py`. Only h1 uses a DPU-local server. Both h2 and h3 depend on a working HostInband segment and relay.

**Step 3: Predict ingestion behaviour.**

h1: its DPU is paired and attached as a managed DPU, and dpu-agent and HBN run on it. h2: the NIC-mode device counts toward pairing completeness but isn't attached as a managed DPU. h3: there's no DPU to pair.

**Step 4: Note the isolation consequence.**

Only h1 has a NICo-managed enforcement point in the host's own data path. For h2 and h3, getting an address depends on the HostInband segment's allocation, relay, DNS and isolation setup (covered in ch. 29).

### Your turn: finish it

Complete the function so it returns the network segment type that carries a host's OS DHCP, or None when DHCP is handled locally on the DPU.

```text
def os_segment(mode):
    if mode == "___":
        return None
    return "___"

print(os_segment("nic"), os_segment("dpu"))
```

<details>
<summary>Answer</summary>

Compare with `dpu` (`if mode == "dpu":`) and return `"HostInband"`. The script then prints `HostInband None`.

</details>

### Your turn: on your own

After a policy change, a host's BlueField was switched to NIC mode and the host was power-cycled. Now the host OS never gets an IP address, although the host BMC is still reachable on the OOB network. Before the change, the host OS got its address without problems. Explain the likely cause and what to check.

<details>
<summary>Hint 1</summary>

Before the change, which DHCP server answered the host OS?

</details>

<details>
<summary>Hint 2</summary>

In NIC mode, the DPU-local DHCP server no longer exists.

</details>

<details>
<summary>Hint 3</summary>

Check that the host OS NIC is on a HostInband segment with a DHCP relay pointing to the nico-dhcp VIP, and that the HostInband segment is configured in NICo.

</details>

<details>
<summary>Answer</summary>

In DPU mode, the DHCP server on the host's DPU answered the host OS, so no relay on the physical network was ever needed. In NIC mode that server no longer exists, and the host OS's DHCP must go through a relay to the central nico-dhcp on a HostInband segment. Most likely the host OS NIC's VLAN/subnet isn't set up as HostInband, or it has no relay to the nico-dhcp VIP. Check the switch relay configuration, confirm that NICo has the HostInband segment configured, and watch `kubectl logs -n nico-system -l app.kubernetes.io/name=nico-dhcp --tail=20` for the host's requests.

</details>

### Explain it

In your own words: Why can NICo enforce tenant isolation on a host whose BlueField is in DPU mode, but not through the BlueField of a host in NIC mode?

### Check

**1. A host's BlueField runs in NIC mode. Who answers its host OS DHCP request?**

A. A DHCP server on the BlueField
B. Central nico-dhcp via relay on HostInband
C. Nobody, because NIC-mode hosts must use static IPs
D. The top-of-rack switch's built-in DHCP server

<details>
<summary>Answer</summary>

**B.** Central nico-dhcp via relay on HostInband

Zero-DPU hosts and DPU-NIC-mode hosts use the central nico-dhcp on HostInband. The DPU-local server exists only in DPU mode. The ToR only relays requests and doesn't assign addresses.

</details>

**2. During pairing, Site Explorer finds a BlueField reporting NIC mode. What does it do?**

A. Blocks ingestion until the device is replaced
B. Counts it toward pairing completeness but doesn't attach it as a managed DPU
C. Attaches it as a managed DPU and installs dpu-agent
D. Removes the host from expected machines

<details>
<summary>Answer</summary>

**B.** Counts it toward pairing completeness but doesn't attach it as a managed DPU

The validation step says this about NIC-mode devices. They don't run NICo's DPU software, so they aren't managed DPUs, but they don't make the pairing incomplete either.

</details>

**3. What does changing a BlueField's mode require before ingestion can continue?**

<details>
<summary>Answer</summary>

A host power cycle. Ingestion waits until the mode change has taken effect.

Site Explorer resolves the target mode from the DPU policy and part number. A successful mode-change request defers ingestion to a later pass, after the power cycle has applied the change.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [overview/operational-principles.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/operational-principles.md)

<a id="build-task"></a>
## Build task: Toy boot-and-network controller: network-boot a QEMU VM from your own PXE + pool server

**Goal:** Build a small Python server that plays two roles, a PXE Service and a pool allocator. It serves iPXE scripts, works out each machine's DHCP path and segment from its DPU mode, and hands out loopback IPs and VNIs from pools that must be non-empty. It refuses new VPCs once the VNI pool is empty (the toy assumes one VNI per VPC). Then you network-boot a real (emulated) machine against it.

**Why it matters for NICo:** This is a laptop-sized model of what NICo has to get right before a racked host can provision itself. The firmware chains through iPXE to a per-host script from a stateless server. Every identifier comes from a pool that must be filled in. Each machine's DPU mode decides whether its DHCP is answered on the DPU or by the central nico-dhcp on HostInband. When nico-pxe, nico-dhcp or a pool misbehaves on a real site, you debug it by asking these same questions.

**You need:**

- Linux or macOS with Python 3.11+ (the script uses `tomllib`). Check with `python3 --version`
- curl
- QEMU with x86 system emulation: `sudo apt install qemu-system-x86` (Debian/Ubuntu), `sudo dnf install qemu-system-x86` (Fedora), or `brew install qemu` (macOS; Apple Silicon runs it emulated, which is slower but works)
- Port 8080 free on your machine
- A working directory, e.g. `mkdir -p ~/ch12-lab && cd ~/ch12-lab`

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Write the toy site config</summary>

This file uses a format made up for the lab (`toy_pools`). It is **not** NICo's `siteConfig` schema.
```bash
cat > toy-site.toml <<'EOF'
# Toy site config for this lab. NOT NICo's siteConfig schema.
[toy_pools.lo-ip]
kind = "ipv4"
ranges = [["10.99.0.1", "10.99.0.4"]]

[toy_pools.vlan-id]
kind = "int"
ranges = [[100, 199]]

[toy_pools.vni]
kind = "int"
ranges = [[5001, 5003]]

[[machines]]
name = "vm-host-1"
mac = "52:54:00:aa:bb:01"
dpu = "none"

[[machines]]
name = "rack-host-2"
mac = "52:54:00:aa:bb:02"
dpu = "dpu"

[[machines]]
name = "rack-host-3"
mac = "52:54:00:aa:bb:03"
dpu = "nic"
EOF
```

</details>

<details>
<summary>Step 2: Write the server</summary>

```bash
cat > toy_pxe.py <<'EOF'
#!/usr/bin/env python3
"""Toy PXE + pool server for the Chapter 12 lab. Not NICo code."""
import ipaddress
import json
import sys
import tomllib
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

with open(sys.argv[1], "rb") as f:
    CFG = tomllib.load(f)


def expand(pool):
    items = []
    for lo, hi in pool["ranges"]:
        if pool["kind"] == "ipv4":
            a = int(ipaddress.IPv4Address(lo))
            b = int(ipaddress.IPv4Address(hi))
            items += [str(ipaddress.IPv4Address(i)) for i in range(a, b + 1)]
        else:
            items += list(range(lo, hi + 1))
    return items


FREE = {}
for name in ("lo-ip", "vlan-id", "vni"):
    FREE[name] = expand(CFG["toy_pools"][name])
    if not FREE[name]:
        sys.exit(f"config error: pool '{name}' is empty; all three pools must be non-empty")

MACHINES = {m["mac"].lower(): m for m in CFG["machines"]}
LOOPBACKS = {}
VPCS = {}

BOOT = """#!ipxe
echo toy-pxe: booting ${net0/mac}
chain http://10.0.2.2:8080/host?mac=${net0/mac:hexhyp}
"""


def plan(m):
    if m["dpu"] == "dpu":
        return {"host_os_dhcp": "local DHCP server on the DPU",
                "host_os_segment": "overlay via the DPU",
                "bmc_segment": "Underlay (host BMC, DPU BMC, DPU OOB)"}
    return {"host_os_dhcp": "central nico-dhcp via DHCP relay",
            "host_os_segment": "HostInband",
            "bmc_segment": "Underlay, or HostInband if shared"}


def alloc_loopback(mac):
    if mac not in LOOPBACKS:
        if not FREE["lo-ip"]:
            return None
        LOOPBACKS[mac] = FREE["lo-ip"].pop(0)
    return LOOPBACKS[mac]


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body, ctype="text/plain"):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if url.path == "/boot.ipxe":
            self.reply(200, BOOT)
        elif url.path == "/host":
            mac = query.get("mac", [""])[0].lower().replace("-", ":")
            m = MACHINES.get(mac)
            if m is None:
                print(f"UNKNOWN mac={mac}", flush=True)
                self.reply(404, f"#!ipxe\necho unknown MAC {mac}\n")
                return
            lo = alloc_loopback(mac)
            p = plan(m)
            print(f"BOOT {m['name']} mac={mac} loopback={lo} dhcp={p['host_os_dhcp']}", flush=True)
            script = "#!ipxe\n"
            script += f"echo host {m['name']} dpu-mode={m['dpu']}\n"
            script += f"echo loopback {lo}\n"
            script += f"echo host OS DHCP: {p['host_os_dhcp']}\n"
            script += f"echo host OS segment: {p['host_os_segment']}\n"
            script += "shell\n"
            self.reply(200, script)
        elif url.path == "/state":
            state = {"free": {k: len(v) for k, v in FREE.items()},
                     "loopbacks": LOOPBACKS, "vpcs": VPCS,
                     "plans": {m["name"]: plan(m) for m in MACHINES.values()}}
            self.reply(200, json.dumps(state, indent=2) + "\n", "application/json")
        else:
            self.reply(404, "not found\n")

    def do_POST(self):
        url = urlparse(self.path)
        name = parse_qs(url.query).get("name", [""])[0]
        if url.path != "/vpc" or not name:
            self.reply(400, "use POST /vpc?name=NAME\n")
            return
        if name not in VPCS:
            if not FREE["vni"]:
                print(f"VNI pool exhausted; cannot create VPC {name}", flush=True)
                self.reply(409, "vni pool exhausted\n")
                return
            VPCS[name] = FREE["vni"].pop(0)
        self.reply(201, f"vpc {name} vni {VPCS[name]}\n")


print("toy-pxe listening on :8080", flush=True)
HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
EOF
```
Start it in terminal 1 and leave it running: `python3 toy_pxe.py toy-site.toml`. The server's own `BOOT ...` lines go to stdout and the per-request access log goes to stderr. Both show up in the terminal.

</details>

<details>
<summary>Step 3: Act as iPXE with curl</summary>

In terminal 2:
```bash
curl -s localhost:8080/boot.ipxe
curl -s 'localhost:8080/host?mac=52-54-00-aa-bb-02'
curl -s 'localhost:8080/host?mac=52-54-00-aa-bb-03'
curl -s 'localhost:8080/host?mac=52-54-00-aa-bb-02'   # again: same loopback (idempotent)
curl -s localhost:8080/state
```
rack-host-2 (DPU mode) prints `host OS DHCP: local DHCP server on the DPU` and `host OS segment: overlay via the DPU`. rack-host-3 (NIC mode) prints `host OS DHCP: central nico-dhcp via DHCP relay` and `host OS segment: HostInband`. In this order, rack-host-2 gets loopback 10.99.0.1 and rack-host-3 gets 10.99.0.2. The second request for host-2 returns 10.99.0.1 again instead of taking a new address. The `/state` JSON shows the same per-machine plans that the `/host` scripts printed: rack-host-2 differs from vm-host-1 and rack-host-3.

</details>

<details>
<summary>Step 4: Prove empty pools are rejected</summary>

```bash
sed 's/ranges = \[\[5001, 5003\]\]/ranges = []/' toy-site.toml > empty-vni.toml
python3 toy_pxe.py empty-vni.toml; echo "exit=$?"
```
Expect `config error: pool 'vni' is empty; all three pools must be non-empty` and `exit=1`. The process exits before it binds the port, so it doesn't clash with the server still running in terminal 1.

</details>

<details>
<summary>Step 5: Network-boot a real VM</summary>

In terminal 3:
```bash
qemu-system-x86_64 -m 256 -nographic -boot n \
  -netdev user,id=n0,bootfile=http://10.0.2.2:8080/boot.ipxe \
  -device e1000,netdev=n0,mac=52:54:00:aa:bb:01
```
QEMU's built-in DHCP gives the VM an address and the boot URL. The NIC's boot ROM is iPXE, which fetches `boot.ipxe` and chains to `/host?mac=52-54-00-aa-bb-01`. Inside the VM, `10.0.2.2` is your laptop. With `-nographic` the VM console may stay blank. That's fine: **terminal 1 is your evidence**. Wait up to a minute (longer on Apple Silicon), then quit QEMU with Ctrl-a then x. If you ran the curl step first, vm-host-1 gets the next free loopback, 10.99.0.3.

</details>

<details>
<summary>Step 6: Exhaust the VNI pool</summary>

```bash
for v in red green blue purple; do
  curl -s -o /dev/null -w "$v %{http_code}\n" -X POST "localhost:8080/vpc?name=$v"
done
curl -s localhost:8080/state
```
The pool holds 3 VNIs (5001–5003), and the toy gives each VPC one VNI. You get three `201`s, then `purple 409`. Terminal 1 prints `VNI pool exhausted; cannot create VPC purple`.

</details>

**Check it works:** You're done when all four of these are true. (1) Terminal 1 shows a `GET /boot.ipxe` request from the QEMU VM, followed by `BOOT vm-host-1 mac=52:54:00:aa:bb:01 loopback=10.99.0.3 dhcp=central nico-dhcp via DHCP relay`. The address is 10.99.0.3 if you ran the curl step first; otherwise it is whichever loopback was free next. (2) `curl -s localhost:8080/state` lists a loopback for `52:54:00:aa:bb:01`, shows VNIs 5001–5003 assigned to red/green/blue with `"vni": 0` free, and shows `"host_os_segment": "HostInband"` for vm-host-1 and rack-host-3. (3) The fourth VPC POST returned 409. (4) Starting the server with `empty-vni.toml` prints the 'pool vni is empty' message and exits with code 1.

<details>
<summary>If you get stuck</summary>

- `ModuleNotFoundError: tomllib` means your Python is older than 3.11. Install a newer Python, or run the server in a container: `docker run --rm -it -p 8080:8080 -v "$PWD":/lab -w /lab python:3.12-slim python3 toy_pxe.py toy-site.toml`. QEMU on the host still reaches it at 10.0.2.2:8080.
- `Address already in use` means an earlier server is still running. Stop it with Ctrl-C, or find it with `lsof -i :8080`.
- If the server prints `UNKNOWN mac=...`, the VM's MAC doesn't match the config. Make sure the `-device ... mac=` value is exactly `52:54:00:aa:bb:01`.
- If QEMU never reaches the server, check that the bootfile URL uses 10.0.2.2 (QEMU user-mode networking's address for the host), not localhost. `localhost` works in your curl commands only because curl runs on the host.
- On macOS, if the firewall asks whether Python may accept incoming connections, allow it. Otherwise the VM's requests are dropped.
- No text in the QEMU console is normal with `-nographic`. Rely on the server log, or remove `-nographic` to get a graphical window if you have a display.
- Restarting the server resets all allocations, because state lives only in memory. Loopback numbers in later steps then depend on the order of requests after the restart.

</details>

**Stretch goal:** Add a `DELETE /vpc?name=NAME` endpoint that returns the VPC's VNI to the free list. Add an `/extend-vni?lo=6001&hi=6002` endpoint that adds a new range only if it overlaps neither the existing pool nor a `reserved_vnis` list you add to the config (standing in for VNIs the network team uses). Confirm that `purple` can be created after either a delete or an extension. Then boot a second QEMU VM with MAC `52:54:00:aa:bb:03` (rack-host-3, NIC mode). Terminal 1 should show it getting the *same* loopback rack-host-3 received in the curl step (10.99.0.2), not a new one, with `dhcp=central nico-dhcp via DHCP relay`. This shows allocation is idempotent per machine no matter who makes the request. Its script (`curl -s 'localhost:8080/host?mac=52-54-00-aa-bb-03'`) should print `host OS segment: HostInband`. To see the lo-ip pool run out, add two more `[[machines]]` entries, restart the server, and request five different MACs. The fifth gets `loopback None`.

## Review notes

The draft was rewritten twice using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **ok**, no issues found.

---

[← 11-vxlan-evpn-overlay.md](11-vxlan-evpn-overlay.md) · [13-building-images.md →](13-building-images.md)
