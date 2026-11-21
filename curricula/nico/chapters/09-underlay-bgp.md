# Chapter 9: Underlay & BGP

*Part: Networking & Isolation · 6 concepts · [curriculum](../curriculum.md#chapter-9)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Chapters 3 and 8 covered how packets find their way across a subnet and how a host gets an address and boots. This chapter goes one layer down, to the physical fabric that every NICo-managed DPU plugs into. It covers how big a packet can be on that fabric, how the fabric is split into a physical **underlay** and virtual **overlays**, and how routes reach DPUs through **BGP**.

The order is deliberate. MTU comes first because it is a property of every link. Then the underlay/overlay split explains why the routing matters. Then BGP and its Autonomous System Numbers explain how routes move. Last, you'll see where all of this touches a real DPU: its two top-of-rack uplink ports, p0 and p1, and the BGP session on each one. That last piece is NICo-specific. A broken p0 session raises a health alert that stops a host from being allocated and blocks its normal PXE restart.

NICo doesn't configure your switches. The network team builds the underlay, and NICo makes each DPU a well-behaved BGP speaker on it. When a host gets stuck, though, the cause is often a cable, a switch port or a BGP session. So you need to understand both sides well enough to tell which side is broken.

The chapter ends with a laptop lab: two FRRouting containers playing a leaf switch and a DPU on a jumbo-frame Docker network. They form an eBGP session, exchange loopback routes, filter a leaked prefix, and show what happens when the DPU's uplink goes down.

**By the end of this chapter you can:**

- Calculate MTU and payload sizes for jumbo-frame and VXLAN-encapsulated links, and test a path's MTU with a don't-fragment ping
- Tell underlay from overlay for any address or network in a NICo site, and explain why tenant addresses never appear in the underlay
- Describe how an eBGP session advertises and withdraws routes, including what BGP unnumbered means and why leaves filter DPU announcements to /32 loopbacks
- Size and sanity-check a 32-bit ASN pool for a site in which every DPU gets its own ASN
- Explain the roles of a DPU's p0 and p1 uplinks and predict how NICo's BgpPeeringTor health alert affects allocation and PXE restarts when either session fails
- Build and break a two-node eBGP lab with FRRouting in Docker

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [Jumbo frames / MTU](#jumbo-frames-mtu)
2. [Underlay and overlay networks](#underlay-and-overlay-networks)
3. [BGP](#bgp)
4. [Autonomous System Number (ASN)](#autonomous-system-number)
5. [Top-of-rack (ToR) uplink](#top-of-rack-uplink)
6. [BGP Peering with Top-of-Rack Switch](#bgp-peering-with-top-of-rack-switch)
7. [Build task: Leaf and DPU: a two-container eBGP lab on a jumbo-frame fabric](#build-task)

<a id="jumbo-frames-mtu"></a>
## 1. Jumbo frames / MTU

### Before you read

- A link has an MTU of 1500. What is the largest ICMP payload you can send with `ping -s` without the packet needing fragmentation?
- Why would anyone want packets bigger than 1500 bytes?

<details>
<summary>Answers</summary>

- **A link has an MTU of 1500. What is the largest ICMP payload you can send with `ping -s` without the packet needing fragmentation?** 1472 bytes. The 1500-byte limit covers the whole IP packet: a 20-byte IPv4 header, an 8-byte ICMP header and the payload. 1500 − 28 = 1472.
- **Why would anyone want packets bigger than 1500 bytes?** Every packet costs header bytes plus per-packet processing at each NIC and switch. Larger packets (jumbo frames, usually 9000 bytes) move the same data in about a sixth as many packets, which matters on 100–400 Gb/s fabrics.

</details>

### Explanation

The **MTU (Maximum Transmission Unit)** is the largest IP packet a link will carry in one piece. On Linux the number you see in `ip link` is the IP packet size and doesn't include the 14-byte Ethernet header. The classic Ethernet MTU is **1500**. Any frame with an MTU larger than that is a **jumbo frame**. On high-speed data-center fabrics the usual value is **9000**, and switches often allow a bit more (commonly 9216) so they have headroom.

Three rules explain most MTU problems:

1. **Every hop must agree.** A path's usable MTU is the smallest MTU of any link on it. If one switch port is still at 1500, the whole path is effectively 1500.
2. **Too-big packets get dropped or fragmented, not delivered as-is.** When the sender sets the IP "don't fragment" (DF) bit, which most TCP traffic does, a router that can't forward the packet should send back an ICMP "fragmentation needed" message. A receiving interface with a smaller MTU usually just drops the frame. Firewalls often block that ICMP message too. The result is an **MTU black hole**: small packets such as pings, DNS queries and SSH keystrokes work, but large transfers hang.
3. **Tunnels eat bytes.** An overlay (next lesson) wraps each packet in extra headers. VXLAN over IPv4 adds **50 bytes** to the IP packet: outer IPv4 (20) + UDP (8) + VXLAN (8) + the inner Ethernet header (14). Over IPv6 it adds 70. If you want a 1500-byte packet inside the tunnel, the underlay must carry at least 1550.

NICo's network prerequisites say it directly: use **MTU 1500 for overlays (VXLAN/Geneve), and 9000 only if the underlay supports it end-to-end**. That means the default works everywhere, and you enable jumbo frames only after confirming every link on the path supports them. When you configure NICo, the admin network definition in `siteConfig` (`[networks.admin]`) includes an `mtu` field, so this is a number you choose and set yourself.

To test a path, send a ping with the DF bit set and a payload of MTU − 28. On Linux that is `ping -M do -s 8972 <ip>` for a 9000 path. On macOS it is `ping -D -s 8972 <ip>`.

**Analogy.** MTU is like the height limit on a road's bridges. A truck's route is limited by the lowest bridge, not the average one. A tunnel is a trailer around your cargo: it adds height, so cargo that fit before may now hit the bridge. The analogy breaks down because a truck driver sees the low bridge coming. A network packet usually gets no warning: it's silently dropped, and the only sign is that big transfers stall.

### Worked example: Watch an MTU mismatch become a black hole

**Step 1: Start a lab container.**

Network namespaces give you two isolated "hosts" inside one privileged container:
```bash
docker run --rm -it --privileged debian:stable-slim bash
apt-get update -qq && apt-get install -y -qq iproute2 iputils-ping
```

**Step 2: Build a point-to-point link.**

Create two namespaces joined by a veth pair (a virtual cable) and give it a /31:
```bash
ip netns add a; ip netns add b
ip link add va type veth peer name vb
ip link set va netns a; ip link set vb netns b
ip -n a addr add 10.0.0.0/31 dev va
ip -n b addr add 10.0.0.1/31 dev vb
ip -n a link set va up; ip -n b link set vb up
```

**Step 3: Set jumbo frames on both ends and test.**

```bash
ip -n a link set va mtu 9000
ip -n b link set vb mtu 9000
ip netns exec a ping -c2 -M do -s 8972 10.0.0.1   # 8972 + 28 = 9000: works
ip netns exec a ping -c2 -M do -s 8973 10.0.0.1   # 9001: fails locally
```
The second ping fails right away with a "message too long" error. The sender knows its own MTU and refuses.

**Step 4: Create the mismatch.**

Lower only the far end:
```bash
ip -n b link set vb mtu 1500
ip netns exec a ping -c2 -W1 -M do -s 1472 10.0.0.1   # works
ip netns exec a ping -c2 -W1 -M do -s 8972 10.0.0.1   # 100% packet loss, no error
```
The sender still thinks 9000 is fine. The receiver drops the frame, and nothing reports back. That silence is what makes a black hole.

**Step 5: Draw the conclusion.**

Small packets succeed and large ones vanish. To find the problem, test with DF-set pings of increasing size, then compare `ip link show` on every hop. Type `exit` to remove the container.

### Your turn: finish it

An underlay link runs at MTU 9000 and carries VXLAN over IPv4. Fill in the ping payload that tests the full 9000 bytes, and the largest MTU you can give the overlay interfaces.

```text
# Test the underlay at its full MTU (IPv4 header 20 + ICMP header 8)
ping -M do -s ___ 10.255.0.12

# VXLAN over IPv4 adds 50 bytes to every packet
# Largest overlay MTU that fits: ___
```

<details>
<summary>Answer</summary>

8972 (9000 − 28) and 8950 (9000 − 50).

</details>

### Your turn: on your own

A team sets the underlay to MTU 9000 on every link. Then they also set the tenant overlay interfaces to MTU 9000 "to match". Pings and SSH work, but large file copies between tenant hosts hang. Explain why, and give two ways to fix it.

<details>
<summary>Hint 1</summary>

What gets added to each tenant packet before it crosses the underlay?

</details>

<details>
<summary>Hint 2</summary>

A full 9000-byte tenant packet plus VXLAN headers is how many bytes on the underlay?

</details>

<details>
<summary>Hint 3</summary>

9000 + 50 = 9050 is more than 9000. Either shrink the inner packet or grow the outer link.

</details>

<details>
<summary>Answer</summary>

VXLAN encapsulation adds 50 bytes (IPv4 outer), so a full-size 9000-byte tenant packet becomes 9050 bytes on the underlay. That exceeds the 9000 MTU, so it gets dropped (or fragmented, where that's allowed). Small packets fit, so pings and SSH work, but bulk TCP transfers send full-size segments and stall. Fix 1: lower the overlay MTU to 8950 or less. Fix 2: raise the underlay MTU everywhere on the path to at least 9050 (switches commonly support 9216). Or follow NICo's conservative guidance and keep overlays at 1500.

</details>

### Explain it

In your own words: Why does an MTU mismatch usually break large transfers while small pings keep working, and why does that make it so hard to diagnose?

### Check

**1. On a link with MTU 1500, what happens with `ping -M do -s 1500 <peer>`?**

A. It succeeds, because 1500 equals the MTU
B. It fails, because the IP packet would be 1528 bytes
C. It succeeds after the kernel fragments the packet
D. It succeeds only if the peer also has MTU 1500

<details>
<summary>Answer</summary>

**B.** It fails, because the IP packet would be 1528 bytes

`-s` sets only the ICMP payload. Add 8 bytes of ICMP header and 20 of IPv4 header and you get 1528, which is over 1500. `-M do` forbids fragmentation, so the kernel refuses to send it. The "fragments" option is exactly what `-M do` prevents.

</details>

**2. What MTU does NICo's network guidance recommend for overlays?**

A. 9000 always, because the fabric is high-speed
B. 1500 for overlays; 9000 only if the underlay supports it end-to-end
C. Whatever the DPU auto-detects
D. 1450, to leave room for VXLAN

<details>
<summary>Answer</summary>

**B.** 1500 for overlays; 9000 only if the underlay supports it end-to-end

The prerequisites table says exactly this. Jumbo frames are an option you enable after confirming every hop supports them, not a default. 1450 is a common rule of thumb when the underlay is stuck at 1500, but it isn't NICo's stated guidance.

</details>

**3. Which 50 bytes does VXLAN over IPv4 add to an inner IP packet?**

A. Outer Ethernet 14 + outer IPv4 20 + UDP 8 + VXLAN 8
B. Outer IPv4 20 + UDP 8 + VXLAN 8 + inner Ethernet 14
C. Outer IPv4 20 + TCP 20 + VXLAN 10
D. Two Ethernet headers of 25 bytes each

<details>
<summary>Answer</summary>

**B.** Outer IPv4 20 + UDP 8 + VXLAN 8 + inner Ethernet 14

The underlay's IP MTU limits the outer IP packet. Inside it are UDP, VXLAN and the whole inner Ethernet frame, including its 14-byte header. The outer Ethernet header also exists, but like any Ethernet header it isn't counted against the IP MTU. VXLAN runs over UDP, not TCP.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="underlay-and-overlay-networks"></a>
## 2. Underlay and overlay networks

*Builds on: IP networking fundamentals (ch. 3)*

### Before you read

- Two tenants both use 10.0.0.0/24 inside their private networks on the same physical switches. How can the switches avoid confusing them?
- Guess: when NICo moves a host from one tenant to another, does it reconfigure the leaf switches?

<details>
<summary>Answers</summary>

- **Two tenants both use 10.0.0.0/24 inside their private networks on the same physical switches. How can the switches avoid confusing them?** The switches never see the tenant addresses. Each tenant packet is wrapped in an outer packet addressed between two infrastructure endpoints, and an identifier in the wrapper says which tenant network it belongs to.
- **Guess: when NICo moves a host from one tenant to another, does it reconfigure the leaf switches?** No. NICo enforces Ethernet isolation on the DPU (HBN with VXLAN/EVPN and per-tenant VRFs), and its docs say this needs no leaf switch configuration changes. The physical network is expected to be stable and pre-configured.

</details>

### Explanation

A NICo site has two kinds of network stacked on top of each other.

The **underlay** is the real, physical, routed network: leaf (top-of-rack) and spine switches, the cables between them, and the DPU uplinks cabled to the leaves. It has one job, which is to move IP packets between infrastructure addresses. The most important of those are the **DPU loopbacks**. A loopback is an address bound to a virtual interface that never goes down, so it stays reachable while any uplink works. Each DPU gets one IP from NICo's DPU loopback pool, and DPUs advertise these as `/32` routes. The underlay is designed, cabled and configured by your network team. NICo's scope page draws that line explicitly.

An **overlay** is a virtual network built *on top of* the underlay by **tunneling**. The source DPU wraps each packet in a new outer packet addressed from its own loopback to the destination DPU's loopback. The underlay routes that outer packet like any other. The destination DPU removes the wrapper and delivers the original. A device that wraps and unwraps like this is a **tunnel endpoint (VTEP)**, and in NICo the DPUs are the VTEPs. Chapter 11 covers the wrapper format (VXLAN) and how endpoints learn about each other (EVPN). For now, remember that each overlay has its own identifier, so overlays can reuse the same addresses without clashing.

NICo uses several overlays:

- **Tenant VPCs**: a tenant's private network. Each VPC gets its own L3VNI, which identifies its VRF (a separate routing table).
- **The admin network**: where a host sits when no tenant owns it. It uses one site-wide L2VNI.

This split is what makes NICo practical. Tenant changes (joining a VPC, moving to the admin network on release) happen in the overlay, on the DPU. The switch configuration stays the same: the switches only ever need to route between DPU loopbacks, whichever loopbacks happen to be advertised. That's why, during tenant cleanup, NICo returns a host's interfaces to the admin overlay, withdraws its tenant routes and returns tenant IP, VNI and DPU-loopback allocations to their pools, all without touching a switch.

**Analogy.** The underlay is the postal service: trucks, sorting centers and street addresses. An overlay is a company's internal mail. You put an envelope addressed to "Desk 4B" inside a postal envelope addressed to the other office's street address. The post office never reads "Desk 4B", and two companies can both have a Desk 4B. The analogy breaks down on speed and automation: DPUs wrap and unwrap millions of packets per second, and the inner and outer addresses are both IP.

### Worked example: Follow one tenant packet across the fabric

**Step 1: Set up the scene.**

Host A (DPU loopback 10.255.0.11) and Host B (DPU loopback 10.255.0.12) are in the same tenant VPC. Tenant instance A is 10.100.0.4, and instance B is 10.100.0.6. A sends a packet to B.

**Step 2: Overlay lookup on DPU A.**

DPU A looks up 10.100.0.6 in the VPC's routing table (its VRF). The answer isn't a switch port. It's "behind the VTEP at 10.255.0.12".

**Step 3: Encapsulate.**

DPU A wraps the original packet:
```text
[outer IP 10.255.0.11 -> 10.255.0.12][UDP][VXLAN: VPC id][inner: 10.100.0.4 -> 10.100.0.6 ...]
```
The outer header uses underlay addresses only.

**Step 4: Underlay forwarding.**

Leaf and spine switches route on the **outer** destination, 10.255.0.12. They know it because DPU B advertised 10.255.0.12/32 with BGP (next lessons). They never look at 10.100.x.x.

**Step 5: Decapsulate.**

DPU B removes the outer headers, sees from the VXLAN ID which VPC the packet belongs to, and delivers the inner packet to instance B.

**Step 6: Note who owns what.**

Network team: the switches, plus routes between loopbacks. NICo (via the DPU agent and HBN): the VPC routing tables, encapsulation, and the DPU's BGP advertisements. Changing which VPC a host belongs to touches only the second group.

### Your turn: finish it

Classify each item as underlay or overlay.

```text
leaf1 <-> spine1 link, 172.16.0.0/31     -> underlay
DPU loopback 10.255.0.11/32              -> ___
Tenant VPC prefix 10.100.0.0/16          -> overlay
Admin network (host IP when no tenant)   -> ___
```

<details>
<summary>Answer</summary>

DPU loopback -> underlay (it's the tunnel endpoint address the switches route to). Admin network -> overlay (it's a virtual network with its own L2VNI, carried over the underlay).

</details>

### Your turn: on your own

A network engineer asks: "For tenant isolation to work, which prefixes must the leaf switches have routes for? Do they need the tenant VPC prefixes?" Answer them, and explain what happens on the network side when a tenant releases a host.

<details>
<summary>Hint 1</summary>

Which addresses appear in the outer header that switches actually route on?

</details>

<details>
<summary>Hint 2</summary>

NICo's prerequisites list what DPUs need to receive: other DPUs' /32 routes, an aggregate covering them, or a default route.

</details>

<details>
<summary>Hint 3</summary>

On release, NICo moves the host to the admin overlay, withdraws tenant EVPN routes and reclaims tenant IP, VNI and DPU-loopback allocations. Does any leaf or spine switch configuration need to change?

</details>

<details>
<summary>Answer</summary>

The underlay switches need reachability only between DPU loopbacks: each DPU's /32, or an aggregate or default route that covers them. They don't need tenant VPC prefixes, because those appear only inside the tunnel. When a tenant releases a host, NICo removes the tenant configuration on the DPU and moves its interfaces to the admin overlay. The DPU stops advertising that tenant's EVPN routes, the fabric withdraws them, and NICo returns tenant IP, VNI and DPU-loopback allocations to their pools. None of this needs a leaf or spine configuration change: BGP carries the route changes automatically, and the switches' filters and sessions stay as the network team set them up.

</details>

### Explain it

In your own words: Why does separating the underlay from overlays let NICo change tenant isolation without asking the network team to reconfigure switches?

### Check

**1. In a NICo site, which device acts as the tunnel endpoint (VTEP) for tenant traffic?**

A. The leaf switch
B. The spine switch
C. The DPU
D. The site controller

<details>
<summary>Answer</summary>

**C.** The DPU

NICo's docs state that DPUs are the VTEPs and advertise /32 loopbacks for them. Many traditional designs put VTEPs on the leaf switches, which is why the leaf option is tempting. NICo deliberately moves that role to the DPU so switches don't need per-tenant configuration.

</details>

**2. Which of these does NICo's scope page assign to your network team rather than to NICo?**

A. Tenant isolation at the DPU layer
B. BGP route advertisement from DPUs
C. Leaf and spine switch configuration and the physical underlay design
D. Returning hosts to the admin overlay on release

<details>
<summary>Answer</summary>

**C.** Leaf and spine switch configuration and the physical underlay design

NICo handles DPU-side isolation and BGP advertisement from DPUs. It expects the underlay to be stable and pre-configured, and it doesn't manage switches.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md)

<a id="bgp"></a>
## 3. BGP

*Builds on: CIDR prefixes and /31 point-to-point subnets (ch. 3)*

### Before you read

- Static routes work for a home router. Why would a data center with thousands of DPUs need a routing *protocol* instead?
- Guess: what does "BGP unnumbered" mean?

<details>
<summary>Answers</summary>

- **Static routes work for a home router. Why would a data center with thousands of DPUs need a routing *protocol* instead?** Routes have to appear and disappear automatically as devices come, go and fail. Hand-maintaining thousands of static routes on every switch is impossible, and static routes don't react to a dead link.
- **Guess: what does "BGP unnumbered" mean?** The two ends of a BGP session don't need IPv4 addresses configured on the link. They find each other with automatic IPv6 link-local addresses and still exchange IPv4 routes (RFC 5549).

</details>

### Explanation

**BGP (Border Gateway Protocol)** is the protocol routers use to tell each other which prefixes they can reach. It runs the internet, and modern data centers use it inside the fabric too.

The core ideas:

- **Sessions.** Two BGP speakers (**peers** or **neighbors**) open a TCP connection on **port 179** and keep it alive with keepalive messages. If no keepalive arrives within the **hold time**, the session is declared dead. A healthy session is in the **Established** state. Other states such as Idle, Connect and Active mean it isn't up.
- **Advertisements and withdrawals.** Over the session, each side sends **UPDATE** messages: "I can reach 10.255.0.11/32" (advertise), or "I no longer can" (withdraw). When a session dies, everything learned over it is withdrawn.
- **AS_PATH.** Each route carries the list of routing domains (Autonomous Systems, next lesson) it has passed through. Shorter paths are generally preferred. If a router sees its own AS number in a path, it drops the route, which prevents loops.
- **eBGP vs iBGP.** A session between different AS numbers is **external BGP (eBGP)**. One within the same AS is iBGP. Data-center designs, including NICo's, use eBGP on every link.

**BGP unnumbered** removes per-link IP planning. Instead of putting a /31 on every switch-to-DPU cable, each end uses its automatic IPv6 link-local address to find the peer and set up the session. IPv4 routes are then carried with an IPv6 next hop (RFC 5549). NICo's prerequisites require **eBGP unnumbered on all leaf switches facing DPUs**.

In NICo, each DPU is a BGP speaker. It runs eBGP with its leaf switches (or route servers) and advertises its **/32 loopback** into the underlay. It also advertises tenant routes, such as each instance's connected /31, into that VPC's overlay (EVPN, chapter 11). The prerequisites also ask the network team to protect the fabric: **filter DPU announcements to loopbacks only**, aggregate at the leaf or pod level, and set **max-prefix limits** on DPU-facing ports. If a peer sends more prefixes than its max-prefix limit, the session is normally shut down.

**Analogy.** BGP is like neighbors passing along "I know how to get to X" notes, where each note lists everyone who has already forwarded it. If you see your own name on a note, you throw it away. The analogy breaks down because BGP notes are also *retracted*: when the session to a neighbor drops, everything that neighbor told you is forgotten at once.

### Worked example: Trace a DPU loopback across a leaf-spine fabric

**Step 1: Lay out the fabric.**

```text
DPU-1 (AS 4200000101) -- leaf1 (AS 4200000001) -- spine (AS 4200000900) -- leaf2 (AS 4200000002) -- DPU-2 (AS 4200000102)
```
Every link is an eBGP session, and every device has a different AS.

**Step 2: Originate the route.**

DPU-1 advertises `10.255.0.11/32` to leaf1 with AS_PATH `4200000101`.

**Step 3: Watch the path grow.**

Each eBGP hop adds its own AS to the front of the path:
- leaf1 → spine: `4200000001 4200000101`
- spine → leaf2: `4200000900 4200000001 4200000101`
- leaf2 → DPU-2: `4200000002 4200000900 4200000001 4200000101`

DPU-2 now has a route to DPU-1's VTEP, so overlay tunnels between them can work.

**Step 4: See loop prevention.**

If leaf2 advertised the route back toward the spine, the spine would see `4200000900` already in the path and drop it.

**Step 5: See filtering protect the fabric.**

Suppose a bug makes DPU-1 also announce `10.100.0.0/16` (a tenant prefix) on its underlay session. leaf1's inbound filter accepts only /32s from the loopback range, so the bad route is discarded. If DPU-1 floods hundreds of prefixes, the max-prefix limit shuts the session down instead of polluting every switch.

**Step 6: See a failure.**

If DPU-1's cable is pulled, leaf1 stops getting keepalives. When the hold time expires, the session drops, and leaf1 withdraws `10.255.0.11/32` from the spine, which withdraws it from leaf2, and so on. Routing converges without anyone editing a config.

### Your turn: finish it

Here is FRRouting-style config for a DPU that peers unnumbered on both uplinks and advertises its loopback. FRR is the routing suite Cumulus-based HBN uses. NICo's DPU agent generates the real configuration, so you'd never hand-write this on a managed DPU. Fill in the blanks.

```text
router bgp 4200000101
 bgp router-id 10.255.0.11
 neighbor p0 interface remote-as external
 neighbor ___ interface remote-as external
 address-family ipv4 unicast
  network ___
 exit-address-family
```

<details>
<summary>Answer</summary>

`p1` (the second uplink) and `10.255.0.11/32` (the DPU's loopback as a /32). `neighbor <ifname> interface` is FRR's unnumbered syntax, and `remote-as external` means "any AS different from mine", which is eBGP.

</details>

### Your turn: on your own

A leaf's DPU-facing port has an inbound filter that accepts only /32s from 10.255.0.0/24, plus a max-prefix limit of 10. A misconfigured DPU starts announcing its loopback and 200 other prefixes. What does the leaf end up with, and why is this better than having no limits?

<details>
<summary>Hint 1</summary>

Consider the filter and the limit separately.

</details>

<details>
<summary>Hint 2</summary>

The filter discards anything that isn't a /32 in the loopback range. What counts toward max-prefix in your router depends on the implementation, but the general idea is that it caps how much one peer can send.

</details>

<details>
<summary>Hint 3</summary>

When a max-prefix limit is exceeded, the usual behavior is to tear down the session.

</details>

<details>
<summary>Answer</summary>

The filter means only valid loopback /32s can be installed, so the 200 bogus prefixes never reach the routing table. If the volume trips the max-prefix limit, the leaf shuts down that one session. That DPU loses connectivity, but the bad routes don't spread through the fabric. Without these guards, one broken DPU could inject routes that hijack or black-hole traffic for the whole site. This is why NICo's prerequisites ask for loopback-only filtering and max-prefix limits on DPU-facing ports.

</details>

### Explain it

In your own words: Why does BGP's ability to withdraw routes when a session drops matter so much in a fabric where links and DPUs fail regularly?

### Check

**1. What does it mean that NICo's leaf switches use eBGP unnumbered toward DPUs?**

A. The session carries no routes, only keepalives
B. Peers find each other with IPv6 link-local addresses, so no per-link IPv4 subnet is needed, and IPv4 routes still flow (RFC 5549)
C. The DPU doesn't need an AS number
D. BGP runs over UDP instead of TCP

<details>
<summary>Answer</summary>

**B.** Peers find each other with IPv6 link-local addresses, so no per-link IPv4 subnet is needed, and IPv4 routes still flow (RFC 5549)

"Unnumbered" refers to the link addressing, not to routes or AS numbers. Each DPU still has its own ASN, and BGP still runs over TCP port 179.

</details>

**2. Which routes should a leaf accept from a DPU on the underlay session, according to NICo's prerequisites?**

A. Anything the DPU sends
B. Only the DPU's loopback announcements, with max-prefix limits on the port
C. Only a default route
D. Tenant VPC prefixes, so the leaf can route tenant traffic

<details>
<summary>Answer</summary>

**B.** Only the DPU's loopback announcements, with max-prefix limits on the port

The prerequisites say to filter DPU announcements to loopbacks only and to set max-prefix limits. Tenant prefixes belong in the overlay, and a default route is something the DPU *receives*, not something it sends.

</details>

**3. A router receives a route whose AS_PATH already contains its own AS number. What does it do?**

A. Prefers it because it is familiar
B. Discards it to prevent a loop
C. Forwards it without changes
D. Shortens the path by removing its AS

<details>
<summary>Answer</summary>

**B.** Discards it to prevent a loop

AS_PATH loop detection is BGP's basic loop-prevention mechanism. The next lesson shows how data-center ASN design builds on it.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [overview/scope-and-boundaries.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/scope-and-boundaries.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md)

<a id="autonomous-system-number"></a>
## 4. Autonomous System Number (ASN)

*Builds on: BGP (ch. 9)*

### Before you read

- An ASN can be 16-bit or 32-bit. Roughly how many private 16-bit ASNs exist?
- Guess: a host has two DPUs. Do they share an ASN?

<details>
<summary>Answers</summary>

- **An ASN can be 16-bit or 32-bit. Roughly how many private 16-bit ASNs exist?** 1023 (64512–65534). That is too few for a site with thousands of DPUs, each needing its own ASN.
- **Guess: a host has two DPUs. Do they share an ASN?** No. NICo gives every DPU its own unique ASN, including multiple DPUs in the same host.

</details>

### Explanation

An **Autonomous System (AS)** is a routing domain under one administrative policy, and its **Autonomous System Number (ASN)** is the identifier BGP uses for it. ASNs are what go into the AS_PATH from the last lesson, and they decide whether a session is eBGP or iBGP.

Two sizes exist:

- **16-bit ASNs** (0–65535). The private range, for internal use and never shown on the internet, is **64512–65534**, which is only 1023 numbers.
- **32-bit (4-byte) ASNs** (up to 4294967295). The private range is **4200000000–4294967294**, about 95 million numbers (RFC 6996). You'll sometimes see them in "asdot" notation, `high.low`, where `high = asn // 65536` and `low = asn % 65536`.

**RFC 7938** describes how to run BGP as the only routing protocol in a large data center. Its core advice is to use eBGP everywhere and plan ASNs so that BGP's AS_PATH loop detection does useful work. For example, all spines can share one ASN, so a route can never take a spine → leaf → spine detour. This avoids **path hunting**: when a prefix disappears, BGP speakers would otherwise try ever-longer alternate paths before finally giving up.

NICo's rules come straight from its network prerequisites:

- **Every DPU gets a unique ASN** from a pool you give NICo. In multi-DPU hosts, **each DPU has its own**.
- **32-bit ASNs are required**, so there are enough unique numbers.
- Follow **RFC 7938** to prevent path hunting and loops.
- If you use route servers, they need their own ASN, typically **shared across the redundant route-server set**.

So the pool size is driven by the expected number of DPUs, not hosts. You'll see ASNs in other places too. The MetalLB config for the site controller has a `myASN` (the cluster-side ASN, the same for all nodes) and a `peerASN` for each node's ToR. The quick-start example uses values such as `4244766850`, from the private 32-bit range.

**Analogy.** An ASN is like an area code. Calls route between area codes, and seeing your own area code show up in the middle of a call's routing history means something looped. Giving every DPU its own ASN is like giving every building its own area code, which is only possible because the 32-bit range is huge. The analogy breaks down because area codes are geographic and permanent, while NICo hands ASNs out of a pool and gets them back.

### Worked example: Size and check an ASN pool

**Step 1: Count DPUs, not hosts.**

The site has 300 hosts with 1 DPU each and 50 hosts with 2 DPUs each. DPUs = 300 + 100 = **400** ASNs needed for DPUs.

**Step 2: Add headroom and other speakers.**

Plan for growth (say 2×, so 800), and keep separate ASNs for leaves, spines, the site controller's MetalLB side and any route-server set. Those are outside NICo's DPU pool.

**Step 3: Pick a range in private 32-bit space.**

For example, DPU pool `4200100000–4200100799`, leaves `4200000001…`, spines one shared `4200000900`, in the spirit of RFC 7938.

**Step 4: Check it with Python.**

```python
first, last = 4200100000, 4200100799
print(last - first + 1)                       # 800
print(4200000000 <= first and last <= 4294967294)  # True: private 32-bit
print(divmod(first, 65536))                   # (64088, 28832) -> asdot 64088.28832
```

**Step 5: Confirm 16-bit wouldn't work.**

64512–65534 holds 1023 numbers, which is already tight at 800 DPUs before switches or growth. NICo requires 32-bit anyway.

### Your turn: finish it

Complete this helper so it prints `64086.60005 True`.

```text
PRIVATE_32BIT_FIRST = 4200000000
PRIVATE_32BIT_LAST = ___

def asdot(asn):
    high, low = divmod(asn, ___)
    return f"{high}.{low}"

def is_private_32bit(asn):
    return PRIVATE_32BIT_FIRST <= asn <= PRIVATE_32BIT_LAST

print(asdot(4200000101), is_private_32bit(4200000101))
```

<details>
<summary>Answer</summary>

`PRIVATE_32BIT_LAST = 4294967294` and `divmod(asn, 65536)`. 4200000101 = 64086 × 65536 + 60005.

</details>

### Your turn: on your own

A site plans 600 hosts, each with 2 DPUs, plus a redundant pair of BGP route servers. How many ASNs does NICo's DPU pool need at minimum, how many ASNs does the route-server set typically use, and why can't the 16-bit private range work?

<details>
<summary>Hint 1</summary>

NICo assigns ASNs per DPU, not per host.

</details>

<details>
<summary>Hint 2</summary>

The prerequisites say the route-server set typically shares one ASN.

</details>

<details>
<summary>Hint 3</summary>

Compare your DPU count to 65534 − 64512 + 1.

</details>

<details>
<summary>Answer</summary>

600 × 2 = 1200 DPU ASNs at minimum (plan more for growth). The route-server set typically uses one shared ASN. The 16-bit private range has only 1023 numbers, which is fewer than 1200 before you even count switches, so it can't give every DPU a unique ASN. That's why NICo requires 32-bit ASNs, whose private range has about 95 million.

</details>

### Explain it

In your own words: Why does giving every DPU its own ASN, and following RFC 7938's ASN layout, make the fabric's routing more predictable when something fails?

### Check

**1. A host has two BlueField DPUs. How does NICo assign ASNs?**

A. One ASN per host, shared by both DPUs
B. Each DPU gets its own unique ASN from the pool
C. Both DPUs reuse the leaf switch's ASN
D. Only the first DPU gets an ASN

<details>
<summary>Answer</summary>

**B.** Each DPU gets its own unique ASN from the pool

The prerequisites say this explicitly: in multi-DPU hosts, each DPU has its own ASN. Sharing an ASN would make AS_PATH loop detection treat the two DPUs as the same domain.

</details>

**2. What problem does RFC 7938's ASN planning (for example, spines sharing one ASN) help prevent?**

A. IP address exhaustion
B. Path hunting and routing loops
C. MTU black holes
D. DHCP relay failures

<details>
<summary>Answer</summary>

**B.** Path hunting and routing loops

NICo cites RFC 7938 specifically to prevent path hunting and loops. Shared spine ASNs make AS_PATH loop detection reject detour paths. The other options are real problems, but ASNs don't solve them.

</details>

**3. In the MetalLB config for the site controller, which ASN is the same for every node?**

A. peerASN
B. myASN
C. Neither, both differ per node
D. Both are the same for every node

<details>
<summary>Answer</summary>

**B.** myASN

The quick-start table says `myASN` is the cluster-side ASN, the same for all nodes, while `peerASN` is the ToR ASN for each node.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="top-of-rack-uplink"></a>
## 5. Top-of-rack (ToR) uplink

*Builds on: BGP (ch. 9), BlueField DPU (ch. 7)*

### Before you read

- A BlueField DPU has two network ports facing the fabric. Why might they be cabled to two *different* switches?
- Guess: are both uplink ports equal in NICo's eyes, or does one matter more?

<details>
<summary>Answers</summary>

- **A BlueField DPU has two network ports facing the fabric. Why might they be cabled to two *different* switches?** For redundancy. If one switch or cable fails, the DPU still has a working uplink through the other.
- **Guess: are both uplink ports equal in NICo's eyes, or does one matter more?** One matters more. p0 is the primary: NICo's docs state that normal PXE boot requires p0, so losing p0 has bigger consequences than losing p1.

</details>

### Explanation

A **top-of-rack (ToR) switch** is the leaf switch in a rack that the servers plug into. In an **end-of-row (EoR)** design the switch sits at the end of a row instead. The DPU's links to these switches are its **ToR uplinks**.

A BlueField DPU (chapter 7) has two physical uplink ports, named **p0** and **p1** on the DPU's Arm OS. Each one is a separate link into the underlay, and each runs its own BGP session to the switch at the other end. That's where the DPU advertises its loopback and learns the routes it needs.

NICo's physical cabling guidance:

- **Connect DPUs to ToR/EoR switches, dual-homed recommended for redundancy.** p0 goes to one switch and p1 to another. If one switch reboots for an upgrade, the DPU stays reachable through the other.
- **Keep separate out-of-band connectivity for DPU BMCs.** The BMC's management traffic doesn't travel over p0 or p1. It uses the OOB network from chapter 7.

The site controller's reference design works the same way: one DPU or NIC with two uplinks, each cabled to a different ToR switch running BGP unnumbered.

The two ports are **not interchangeable in NICo's policy**. NICo's health documentation states that **normal PXE boot requires p0**. p1 adds redundancy for traffic, but NICo treats p0 as the primary uplink for provisioning. In practice:

- p0 cabled wrong, switch port misconfigured, or link down: the host can't make normal PXE progress, even if p1 works perfectly.
- p1 down while p0 is fine: the host loses redundancy. Whether NICo flags it as a problem depends on a site setting covered in the next lesson.

There's also a division of labor. The network team owns the switch ports: making them BGP unnumbered, assigning the ToR's ASN, and applying the loopback filter and max-prefix limit. NICo owns the DPU side. When an uplink misbehaves, the first question is which end is wrong.

**Analogy.** p0 and p1 are like a building's main entrance and its side door. Both get you inside, and having two keeps the building usable if one is blocked. But deliveries for move-in day (PXE provisioning) only come through the main entrance. The analogy breaks down because a side door doesn't carry equal traffic, while both uplinks can carry routed traffic at the same time.

### Worked example: Plan and sanity-check a rack's uplink cabling

**Step 1: List the endpoints.**

Rack R12 has two ToR switches, `tor-a` and `tor-b`, and eight hosts with one DPU each.

**Step 2: Dual-home each DPU.**

```text
host  DPU port  ->  switch:port
h01   p0        ->  tor-a:swp1
h01   p1        ->  tor-b:swp1
h02   p0        ->  tor-a:swp2
h02   p1        ->  tor-b:swp2
...
```
With p0 always on tor-a and p1 always on tor-b, a pattern like "tor-b down" is easy to recognize.

**Step 3: Keep the BMC separate.**

Each DPU BMC (and host BMC) gets its own cable to the OOB switch, not to tor-a or tor-b.

**Step 4: Predict the failure modes.**

- tor-b reboots: every DPU loses p1 but keeps p0. Traffic continues and provisioning isn't blocked by p0.
- tor-a reboots: every DPU loses p0. Traffic can flow over p1, but normal PXE for these hosts is blocked until p0 returns.
- One cable on h05 p0 is bad: only h05 is affected.

**Step 5: Hand the switch side to the network team.**

Ask for: BGP unnumbered on tor-a:swp1–8 and tor-b:swp1–8, loopback-only inbound filters, and max-prefix limits on those ports.

### Your turn: finish it

Complete the cabling plan for host h09 in a dual-homed rack where p0 always goes to tor-a.

```text
host  DPU port  ->  switch:port
h09   p0        ->  ___:swp9
h09   p1        ->  ___:swp9
h09   DPU BMC   ->  ___
```

<details>
<summary>Answer</summary>

p0 -> tor-a:swp9, p1 -> tor-b:swp9, DPU BMC -> the OOB management switch (not a ToR data port).

</details>

### Your turn: on your own

During racking, a technician swaps h03's cables: p0 now lands on tor-b:swp3 and p1 on tor-a:swp3. Both switch ports are configured identically for BGP unnumbered. Will h03 work? Now suppose p0 is instead plugged into an unconfigured spare port on tor-b. What happens?

<details>
<summary>Hint 1</summary>

With unnumbered BGP and identical port config, does the switch care which DPU port is attached?

</details>

<details>
<summary>Hint 2</summary>

What does NICo require from p0 specifically?

</details>

<details>
<summary>Hint 3</summary>

An unconfigured port means no BGP session on that uplink.

</details>

<details>
<summary>Answer</summary>

In the first case h03 should work. Both ports run BGP unnumbered with the same policy, so sessions come up on both uplinks. It only breaks the rack's neat "p0 = tor-a" pattern, which makes failures harder to read. In the second case, p0 has no working BGP session. Normal PXE boot requires p0, so h03 can't complete normal provisioning even though p1 is healthy. The fix is to cable p0 to a configured port, or have the network team configure the spare port.

</details>

### Explain it

In your own words: Why does dual-homing a DPU to two switches improve availability, yet still leave a single point of failure for provisioning?

### Check

**1. Which statement about the DPU's uplinks matches NICo's documentation?**

A. p0 and p1 are fully interchangeable
B. Normal PXE boot requires p0
C. Normal PXE boot requires p1
D. PXE uses the DPU BMC's OOB port, so uplinks don't matter

<details>
<summary>Answer</summary>

**B.** Normal PXE boot requires p0

The BgpPeeringTor probe docs state this explicitly, and it's why p0 failures carry heavier consequences. The BMC's OOB port handles management traffic, not the host's PXE path through the DPU.

</details>

**2. What cabling does NICo recommend for DPUs?**

A. Both ports to the same ToR, bonded
B. Dual-homed to ToR/EoR switches for redundancy, with separate OOB connectivity for DPU BMCs
C. Only p0 connected; p1 left empty
D. DPU BMC traffic carried over p1

<details>
<summary>Answer</summary>

**B.** Dual-homed to ToR/EoR switches for redundancy, with separate OOB connectivity for DPU BMCs

This is the physical cabling guidance in the network prerequisites. Using the same switch for both ports leaves that switch as a single point of failure, and BMC traffic belongs on the OOB network.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md)

<a id="bgp-peering-with-top-of-rack-switch"></a>
## 6. BGP Peering with Top-of-Rack Switch

*Builds on: Top-of-rack (ToR) uplink (ch. 9)*

### Before you read

- A DPU's p0 BGP session is down but p1 is up, and traffic still flows. Should NICo let a tenant be allocated this host?
- Guess: if only p1's session is down, is the host blocked?

<details>
<summary>Answers</summary>

- **A DPU's p0 BGP session is down but p1 is up, and traffic still flows. Should NICo let a tenant be allocated this host?** No. A p0 transport failure raises a BgpPeeringTor alert with PreventAllocations, and it blocks the normal PXE restart, because normal PXE boot requires p0.
- **Guess: if only p1's session is down, is the host blocked?** Not by that alone. A lone p1 transport failure is either unclassified or suppressed, depending on the site's `min_dpu_functioning_links` setting, so it doesn't carry PreventAllocations.

</details>

### Explanation

Each uplink runs a BGP session between the DPU and the ToR switch at the other end, configured by the DPU agent through HBN on the DPU side. NICo watches these sessions and reports problems through the health system you met in earlier chapters, using the probe ID **`BgpPeeringTor`**.

How `BgpPeeringTor` behaves, per NICo's health probe docs:

- When a problem involves one expected uplink, the alert's **`target` is p0 or p1**, and the message names the failed condition.
- It's raised by both the NVUE and FRR code paths when a **BGP transport session is unavailable**, meaning the session isn't up.
- **A p0 transport alert includes `PreventAllocations`**, because normal PXE boot requires p0. The host can't be given to a tenant.
- **A lone p1 transport failure is unclassified or suppressed**, depending on `min_dpu_functioning_links`, so it doesn't block anything on its own.
- **With a positive minimum**, when both sessions are unavailable, the alerts carry **`PreventAllocations` and `PreventHostStateChanges`**, which freezes the host's state machine too.
- A minimum greater than the two expected uplinks is a misconfiguration and produces a critical alert (untargeted `BgpPeeringTor` on NVUE, `BgpStats` on FRR).

**The p0 PXE gate.** The host state machine checks p0 before rebooting a host into a tenant boot. During initial provisioning, `WaitingForNetworkConfig` waits for current DPU observations, matching config versions, health alerts that block state changes, **and the primary p0 PXE gate**. Right before a normal PXE restart, `WaitingForRebootToReady` repeats the aggregate health and p0 checks. So a broken p0 transport stops the PXE restart. Two exceptions skip these checks: **instance deletion** and **explicit custom iPXE requests**. A live `UpdateInstanceConfig` doesn't restart the host and doesn't apply the p0 PXE gate.

Related probes: `BgpPeeringRouteServer` (a session to a route server is down), `UnexpectedBgpPeer` (a session with a peer that isn't configured, which blocks allocations and state changes) and `BgpDaemonEnabled` (FRR isn't running at all).

**Analogy.** The p0 session is like a pre-flight check on the main engine. A plane with one engine dead can't take off with passengers (PreventAllocations), and the crew won't start the departure (the PXE restart) until it passes. A problem with the backup engine alone may only be logged, depending on airline policy (`min_dpu_functioning_links`). The analogy breaks down because a plane checks once, while NICo re-checks p0 just before each normal PXE restart.

### Worked example: Triage a host stuck before its PXE restart

**Step 1: Read the alert.**

A host isn't progressing to tenant boot. Its health report contains `BgpPeeringTor` with target **p0**, saying the transport session is unavailable.

**Step 2: Work out what's blocked.**

The p0 transport alert carries `PreventAllocations`, and the p0 PXE gate in `WaitingForNetworkConfig` / `WaitingForRebootToReady` stops the normal PXE restart. So the host stays where it is, as designed.

**Step 3: Decide which side owns the fault.**

A BGP session needs both ends. On the DPU side, is FRR running? (A `BgpDaemonEnabled` alert would say so.) Is there an `UnexpectedBgpPeer` alert pointing at the wrong neighbor? On the switch side, is the link up, is the port configured for BGP unnumbered, and has a max-prefix limit tripped? Switch config belongs to the network team.

**Step 4: Check for a pattern.**

Are many hosts in the rack showing p0 alerts at once? If p0 always lands on tor-a, that points at tor-a itself (a reboot, upgrade or config push), not at individual cables.

**Step 5: Confirm recovery.**

Once the session is Established again, the DPU agent's next health reports no longer contain the p0 transport alert, and the state machine can pass the gate on a later check.

### Your turn: finish it

Fill in the decision table using NICo's documented BgpPeeringTor policy.

```text
Situation                                  | BgpPeeringTor result                                 | Blocks normal PXE restart?
p0 transport down, p1 up                   | alert, target p0, PreventAllocations                 | ___
p1 transport down, p0 up                   | ___                                                  | no
both down, min_dpu_functioning_links > 0   | alerts with PreventAllocations + PreventHostStateChanges | yes
```

<details>
<summary>Answer</summary>

Row 1: yes. The primary p0 PXE gate blocks it, because normal PXE boot requires p0. Row 2: unclassified or suppressed, depending on `min_dpu_functioning_links`. It doesn't carry PreventAllocations on its own.

</details>

### Your turn: on your own

An operator sees that a host with a p0 `BgpPeeringTor` transport alert was still deleted successfully, and another host with the same alert booted an explicit custom iPXE script. A colleague says the p0 gate must be broken. Are they right? What would you check if a third host with this alert is stuck before its normal PXE restart?

<details>
<summary>Hint 1</summary>

Which operations does the documentation say bypass the aggregate health and p0 checks?

</details>

<details>
<summary>Hint 2</summary>

Deletion and custom iPXE are both listed.

</details>

<details>
<summary>Hint 3</summary>

For the stuck host, think about both ends of the session and about whether its rack-mates show the same alert.

</details>

<details>
<summary>Answer</summary>

The colleague is wrong. NICo's docs say instance deletion and explicit custom iPXE requests bypass the `WaitingForRebootToReady` health and p0 checks, so both observations are expected. The gate applies to the normal PXE restart, which is why the third host is stuck. For that host: confirm the alert targets p0 and is a transport failure. Check the physical link and the ToR port's BGP unnumbered configuration with the network team. Check whether a max-prefix limit tripped. Look for `BgpDaemonEnabled` or `UnexpectedBgpPeer` alerts on the DPU side. See whether other hosts whose p0 goes to the same switch are also alerting, which would point at the switch.

</details>

### Explain it

In your own words: Why does NICo block allocation and the PXE restart when p0's BGP session is down, even though p1 could still carry traffic?

### Check

**1. Which classification does a p0 BgpPeeringTor transport alert include?**

A. None; it's informational
B. PreventAllocations
C. Only SuppressExternalAlerting
D. It depends on the tenant

<details>
<summary>Answer</summary>

**B.** PreventAllocations

The probe docs state that a p0 transport alert includes PreventAllocations because normal PXE boot requires p0. Informational behavior applies only to a lone p1 failure, and even then it depends on `min_dpu_functioning_links`.

</details>

**2. Which operation is NOT subject to the p0 PXE gate before restarting?**

A. A normal PXE restart into the tenant OS
B. Initial provisioning in WaitingForNetworkConfig
C. Instance deletion
D. The check in WaitingForRebootToReady

<details>
<summary>Answer</summary>

**C.** Instance deletion

Instance deletion and explicit custom iPXE requests bypass these checks. The other three are exactly where the gate is applied.

</details>

**3. A DPU agent finds a BGP session with a peer that isn't among its configured host routes or route servers. Which probe fires?**

A. BgpPeeringTor
B. BgpPeeringRouteServer
C. UnexpectedBgpPeer
D. BgpStats

<details>
<summary>Answer</summary>

**C.** UnexpectedBgpPeer

UnexpectedBgpPeer targets the unexpected peer and prevents allocations and host state changes. BgpPeeringTor and BgpPeeringRouteServer are about expected sessions being down, and BgpStats is about failing to collect or validate FRR statistics.

</details>

**Sources:** [architecture/health/health_probe_ids.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/health/health_probe_ids.md), [architecture/networking_integrations.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/networking_integrations.md)

<a id="build-task"></a>
## Build task: Leaf and DPU: a two-container eBGP lab on a jumbo-frame fabric

**Goal:** Run two FRRouting containers, `leaf1` and `dpu1`, on a Docker network with MTU 9000. They form an eBGP session with private 32-bit ASNs. dpu1 advertises its /32 loopback plus a leaked prefix, and leaf1 accepts only the loopback. You'll prove the jumbo path works, and then break dpu1's uplink (playing p0) to watch the session drop and the route get withdrawn.

**Why it matters for NICo:** This is a small, working copy of what every NICo-managed DPU does on its p0 uplink: eBGP to a ToR with a unique 32-bit ASN, advertising a /32 loopback for its tunnel endpoint, over a jumbo-capable underlay, behind loopback-only filtering and max-prefix limits on the switch. When a real host gets stuck on a `BgpPeeringTor` p0 alert, you'll know what an unhealthy session looks like from both ends and which commands show it.

**You need:**

- Docker Engine or Docker Desktop (Linux or macOS); Podman with docker-compatible CLI also works
- Internet access to pull `quay.io/frrouting/frr:9.1.0` and `debian:stable-slim`
- About 300 MB of disk space
- A working directory, e.g. `mkdir -p ~/bgp-lab && cd ~/bgp-lab`

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Create the jumbo-frame fabric</summary>

Create a user-defined network with a fixed subnet and MTU 9000:
```bash
docker network create --subnet 172.30.9.0/24 \
  -o com.docker.network.driver.mtu=9000 fabric
```
Docker takes 172.30.9.1 as the gateway. A real DPU uplink would be unnumbered or use a /31, but a Docker bridge needs a gateway, so this lab uses a /24 and numbered peers.

</details>

<details>
<summary>Step 2: Write the FRR config files</summary>

The `daemons` file tells FRR which daemons to start:
```bash
cat > daemons <<'EOF'
zebra=yes
bgpd=yes
vtysh_enable=yes
zebra_options="  -A 127.0.0.1 -s 90000000"
bgpd_options="   -A 127.0.0.1"
EOF
```
leaf1 accepts only /32s from the loopback range and caps how many prefixes the DPU can send:
```bash
cat > leaf1.conf <<'EOF'
frr defaults datacenter
hostname leaf1
!
interface lo
 ip address 10.255.0.1/32
!
ip prefix-list DPU-LOOPBACKS seq 10 permit 10.255.0.0/24 ge 32
!
router bgp 4200000001
 bgp router-id 10.255.0.1
 neighbor 172.30.9.3 remote-as 4200000101
 address-family ipv4 unicast
  network 10.255.0.1/32
  neighbor 172.30.9.3 activate
  neighbor 172.30.9.3 prefix-list DPU-LOOPBACKS in
  neighbor 172.30.9.3 maximum-prefix 10
 exit-address-family
!
EOF
```
dpu1 advertises its loopback **and**, standing in for a bug, a tenant-looking /24:
```bash
cat > dpu1.conf <<'EOF'
frr defaults datacenter
hostname dpu1
!
interface lo
 ip address 10.255.0.11/32
 ip address 192.0.2.1/24
!
router bgp 4200000101
 bgp router-id 10.255.0.11
 neighbor 172.30.9.2 remote-as 4200000001
 address-family ipv4 unicast
  network 10.255.0.11/32
  network 192.0.2.0/24
  neighbor 172.30.9.2 activate
 exit-address-family
!
EOF
```
`frr defaults datacenter` gives fast timers (3 s keepalive, 9 s hold), as used in data centers.

</details>

<details>
<summary>Step 3: Start the leaf and the DPU</summary>

```bash
for n in leaf1:172.30.9.2 dpu1:172.30.9.3; do
  name=${n%%:*}; ip=${n##*:}
  docker run -d --name $name --hostname $name --privileged \
    --network fabric --ip $ip \
    -v "$PWD/daemons:/etc/frr/daemons" \
    -v "$PWD/$name.conf:/etc/frr/frr.conf" \
    quay.io/frrouting/frr:9.1.0
done
sleep 15
docker exec dpu1 ip link show eth0     # expect: mtu 9000
```

</details>

<details>
<summary>Step 4: Inspect the session and the routes</summary>

```bash
docker exec leaf1 vtysh -c 'show bgp ipv4 unicast summary'
docker exec leaf1 vtysh -c 'show ip route bgp'
docker exec dpu1  vtysh -c 'show ip route bgp'
```
On leaf1 the neighbor 172.30.9.3 should show an uptime and a received-prefix count of **1** in the State/PfxRcd column. A word like `Active` or `Connect` there means the session isn't up. The leaf's route table should contain `10.255.0.11/32 via 172.30.9.3` and **not** `192.0.2.0/24`, because the prefix list discarded the leak. dpu1 should have learned `10.255.0.1/32`.

Then prove the loopbacks reach each other over BGP-learned routes:
```bash
docker exec leaf1 ping -c 3 -I 10.255.0.1 10.255.0.11
```

</details>

<details>
<summary>Step 5: Test the jumbo path</summary>

Use a throwaway Debian container on the same fabric, which has the full `ping` with `-M do`:
```bash
docker run --rm --network fabric debian:stable-slim sh -c '
  apt-get update -qq && apt-get install -y -qq iputils-ping >/dev/null
  ping -c 2 -M do -s 8972 172.30.9.3
  ping -c 2 -M do -s 8973 172.30.9.3 || echo "8973 refused: path MTU is 9000"'
```
The 8972-byte payload makes exactly 9000-byte packets and should succeed. 8973 should fail with "message too long".

</details>

<details>
<summary>Step 6: Break p0 and watch the withdrawal</summary>

Here eth0 plays the DPU's p0. Take it down, then watch the leaf:
```bash
docker exec dpu1 ip link set eth0 down
sleep 12
docker exec leaf1 vtysh -c 'show bgp ipv4 unicast summary'   # neighbor no longer Established
docker exec leaf1 vtysh -c 'show ip route bgp'               # 10.255.0.11/32 is gone
```
The leaf noticed only when its 9-second hold timer expired, and then it withdrew the route. In NICo this is the moment the DPU agent would report a `BgpPeeringTor` p0 transport alert. Restore the link:
```bash
docker exec dpu1 ip link set eth0 up
sleep 30
docker exec leaf1 vtysh -c 'show ip route bgp'               # 10.255.0.11/32 is back
```
(dpu1's default route via the Docker gateway doesn't come back after the link flap. The lab doesn't need it.)

</details>

<details>
<summary>Step 7: Clean up</summary>

```bash
docker rm -f leaf1 dpu1
docker network rm fabric
```

</details>

**Check it works:** With both containers running and eth0 up, `docker exec leaf1 vtysh -c 'show ip route bgp'` lists `10.255.0.11/32 via 172.30.9.3` and no `192.0.2.0/24`. `docker exec leaf1 ping -c 3 -I 10.255.0.1 10.255.0.11` gets 3 replies. The Debian container's `ping -M do -s 8972 172.30.9.3` succeeds. After `docker exec dpu1 ip link set eth0 down` and about 12 seconds, the 10.255.0.11/32 route is gone from leaf1. After bringing eth0 back up, it returns.

<details>
<summary>If you get stuck</summary>

- If `docker run` can't find `quay.io/frrouting/frr:9.1.0`, choose another 9.x or 10.x tag from quay.io/repository/frrouting/frr. The config uses only long-standing FRR syntax.
- If `show bgp ... summary` prints nothing or says BGP isn't running, check that `bgpd=yes` is in the mounted `daemons` file and look at `docker logs leaf1 2>&1 | tail -30` (FRR logs to stderr).
- If the session is stuck in `Active` or `Connect`, the two peer addresses or ASNs don't match. leaf1 must point at 172.30.9.3 with remote-as 4200000101, and dpu1 at 172.30.9.2 with remote-as 4200000001. Try `docker exec leaf1 ping -c1 172.30.9.3`.
- If 192.0.2.0/24 does show up on leaf1, the prefix list isn't applied. Check the spelling of `DPU-LOOPBACKS` in both the `ip prefix-list` line and the `neighbor ... prefix-list ... in` line.
- If the 8972-byte ping fails but small pings work, the network was created without the MTU option. Remove the containers and the network, then recreate the network with `-o com.docker.network.driver.mtu=9000`.
- `ip link show eth0` inside a container shows `eth0@ifNN`. That's normal for a veth interface.

</details>

**Stretch goal:** Make dpu1 dual-homed. Create a second network, `fabric-p1` (172.30.10.0/24, MTU 9000), start a `leaf2` container on it with its own ASN (e.g. 4200000002) and the same loopback-only filter, attach dpu1 with `docker network connect --ip 172.30.10.3 fabric-p1 dpu1`, and add a second neighbor to dpu1's config (then `docker restart dpu1`). Take down dpu1's p0 interface (eth0) and confirm that the p1 session to leaf2 stays Established and leaf2 still has 10.255.0.11/32. Then write down which NICo health outcome each failure would produce: p0 down gives a `BgpPeeringTor` alert on p0 with PreventAllocations, and a lone p1 failure depends on `min_dpu_functioning_links`. For extra difficulty, convert the p1 session to BGP unnumbered (`neighbor eth1 interface remote-as external`). You may need to start the containers with `--sysctl net.ipv6.conf.all.disable_ipv6=0` so the link has an IPv6 link-local address.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (BGP): The explanation says "Data-center designs, including NICo's, use eBGP on every link." The docs only require eBGP unnumbered on leaf switches facing DPUs (plus multi-hop eBGP to route servers) and say to follow RFC 7938. They make no claim about the leaf–spine links, which the network team owns. *Fix:* Reword to: "RFC 7938-style data-center designs use eBGP on every link, and NICo requires eBGP unnumbered on every leaf port facing a DPU."

---

[← 08-boot-network-services-uefi-firmware.md](08-boot-network-services-uefi-firmware.md) · [10-dpu-networking-addressing-pools.md →](10-dpu-networking-addressing-pools.md)
