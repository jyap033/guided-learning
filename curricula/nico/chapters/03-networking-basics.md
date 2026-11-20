# Chapter 3: Networking Basics

*Part: Foundations · 6 concepts · [curriculum](../curriculum.md#chapter-3)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

NICo is a network-controlled system. You talk to it over HTTP APIs, it hands out IP addresses to BMCs and DPUs, it carves address pools into tiny `/31` links, and its prerequisites page asks you to firewall the control plane so everything not allowed is blocked. Before Chapter 4 (microservices) and Chapter 6 (BMCs and Redfish), you need a working picture of how bytes get from one machine to another and how a server decides whether to answer.

The chapter goes from the top of the stack down and then back up. First, **HTTP and web APIs**: what a request, a header, a status code and a bearer token are, since every NICo REST call looks like this. Next come **IP addresses**, which say *who* a host is, and **Layer 2 Ethernet**, which covers how a switch moves frames using the MAC addresses you met in Chapter 1. **IP networking fundamentals** puts those together: subnets, gateways, ARP and routers. **CIDR prefixes** give you the arithmetic NICo's network page relies on, such as `/27`, `/31` and `/32`. **Firewall rules** decide which of those packets a machine accepts.

Most examples run on your laptop with `curl`, `python3`, `ip` (Linux) or `ifconfig`/`netstat` (macOS), and Docker or Podman. The chapter ends with a build task: you run a small token-protected HTTP API in a container, call it from two client containers with fixed IPs, and add an nftables firewall so only one client can reach it.

**By the end of this chapter you can:**

- Make HTTP API calls with curl, including an Authorization: Bearer header, and read the status codes (200, 401, 403, 404, 5xx) you get back
- Read IPv4 addresses and CIDR prefixes, work out block sizes, and size /31 and /32 pools using the formulas on NICo's network prerequisites page
- Explain how an Ethernet switch learns MAC addresses and forwards, floods or filters frames
- Trace a packet from one host to another through a gateway, saying which addresses stay the same and which change at each hop
- Write a default-deny nftables ruleset that allows only specific source addresses, protocols and ports, and predict what a blocked client will see

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [HTTP and web APIs](#http-and-web-apis)
2. [IP addressing basics](#ip-addressing-basics)
3. [Layer 2 Ethernet networking](#layer-2-ethernet-networking)
4. [IP networking fundamentals](#ip-networking-fundamentals)
5. [CIDR prefixes and /31 point-to-point subnets](#cidr-prefixes-and-31-point-to-point-subnets)
6. [Firewall rules](#firewall-rules)
7. [Build task: Lock down a token-protected API with fixed IPs and an nftables firewall](#build-task)

<a id="http-and-web-apis"></a>
## 1. HTTP and web APIs

### Before you read

- You call a web API and get back the number 401. Guess: does that mean the server is broken, the thing you asked for doesn't exist, or something about who you are?
- When a script sends an API token with a request, where in the request do you think the token goes?

<details>
<summary>Answers</summary>

- **You call a web API and get back the number 401. Guess: does that mean the server is broken, the thing you asked for doesn't exist, or something about who you are?** It's about who you are. 401 Unauthorized means the server didn't get valid credentials, for example a missing or expired token. A broken server returns 5xx, and a missing resource returns 404.
- **When a script sends an API token with a request, where in the request do you think the token goes?** Usually in a request header called `Authorization`, in the form `Authorization: Bearer <token>`. It doesn't go in the URL, because URLs end up in logs and browser history.

</details>

### Explanation

**HTTP** (HyperText Transfer Protocol) is a text-based request/response protocol. A **client** (curl, a browser, `nicocli`) opens a TCP connection to a **server** and sends a **request**. The server sends back one **response**.

A request has:
- a **method**: `GET` (read), `POST` (create or act), `PUT`/`PATCH` (update), `DELETE`
- a **path**, e.g. `/v2/org/ncx/nico/user/current`
- **headers**, which are `Name: value` lines such as `Host`, `Content-Type: application/json` or `Authorization`
- an optional **body**, usually JSON for APIs

A response has a **status code**, headers and an optional body. The first digit of the status code tells you who to blame:
- `2xx` success (200 OK, 201 Created)
- `3xx` redirect (go elsewhere, e.g. from http to https)
- `4xx` client error: 400 bad request, **401** no valid credentials, **403** valid credentials but not allowed, **404** no such resource
- `5xx` server error: the server failed, so retrying or reading its logs is your move

A **web API** is a server that returns data (usually JSON) instead of web pages. A **REST** API names things with paths and acts on them with methods.

**Tokens.** HTTP doesn't remember you between requests, so you send proof of identity with every request. A common way is a **bearer token**: a string you get from an identity provider and send as `Authorization: Bearer <token>`. Whoever holds ("bears") the token is treated as you, so treat it like a password. NICo's quick start gets a token from its dev Keycloak and calls the REST API exactly this way:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://localhost:8388/v2/org/ncx/nico/service-account/current
```

**HTTPS** is HTTP inside a TLS-encrypted connection. Over plain HTTP, anyone on the path can read your token. When you expose NICo REST through a TLS ingress, its chart adds a `force-ssl-redirect` annotation by default, because a TLS block alone would leave port 80 serving the API in cleartext. Contour honours that default annotation. Other controllers, such as ingress-nginx, need their own annotation. The tokens are JWTs, which you'll take apart in Chapter 19.

**Analogy.** An HTTP request works like a form you hand in at a service counter. The method is the box you tick ("read", "create"), the path is the department, the headers are the details stapled on top ("reply in JSON", "here is my ID badge"), and the status code is the clerk's stamp: approved, "no ID", "not your department", or "our system is down". The analogy breaks down because the clerk forgets you the moment you leave. Every request has to carry the badge again. And anyone who photocopies the badge (the token) can use it as if they were you.

### Worked example: Watch a real HTTP conversation with curl -v

**Step 1: Start a throwaway server.**

In one terminal:
```bash
mkdir -p /tmp/httpdemo && cd /tmp/httpdemo && echo hello > hi.txt
python3 -m http.server 8000
```
Python now serves the files in that directory on port 8000.

**Step 2: Send a request and read both directions.**

In a second terminal:
```bash
curl -v http://localhost:8000/hi.txt
```
Lines starting with `>` are what curl sent: `> GET /hi.txt HTTP/1.1`, `> Host: localhost:8000`, `> User-Agent: curl/...`. Lines starting with `<` are the response: `< HTTP/1.0 200 OK`, `< Content-type: text/plain`, then the body `hello`.

**Step 3: Trigger a client error.**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/nope.txt
```
This prints `404`. `-o /dev/null` throws the body away and `-w '%{http_code}'` prints only the status. You'll use this pattern a lot in scripts.

**Step 4: Add a header.**

```bash
curl -v -H 'Authorization: Bearer abc123' http://localhost:8000/hi.txt
```
You'll see `> Authorization: Bearer abc123` in what curl sent. This server ignores the header and still returns 200. Headers are just data, and **the server decides** what they mean. An API like NICo REST would check the token and return 401 if it were invalid.

**Step 5: Map it to NICo.**

NICo's quick start checks a token with `curl ... /v2/org/ncx/nico/user/current -H "Authorization: Bearer $TOKEN"` against `nico-rest-api` on port 8388. It's the same structure: a method (GET), a path, an Authorization header, and a status code that tells you whether it worked.

### Your turn: finish it

Fill in the blanks so the command sends your token correctly and prints only the HTTP status code of the response.

```text
curl -s -o /dev/null -w '%{___}\n' \
  -H "___: Bearer $TOKEN" \
  http://localhost:8388/v2/org/ncx/nico/service-account/current
```

<details>
<summary>Answer</summary>

The first blank is `http_code`, which makes curl's `-w` print the status code. The second is `Authorization`, the header that carries the bearer token. Full command:
```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:8388/v2/org/ncx/nico/service-account/current
```

</details>

### Your turn: on your own

A teammate port-forwards Keycloak to their laptop, fetches a token from `http://localhost:8082/...`, and calls `nico-rest-api` with it. Every call returns 401. The token string looks fine. Based on the NICo quick start, explain the most likely cause, say how to get a working token, and give a curl command that would confirm it by printing only the status code for `/v2/org/ncx/nico/user/current` on `http://localhost:8388`.

<details>
<summary>Hint 1</summary>

401 means the server got credentials it didn't accept. Ask what the server checks inside the token besides whether it's present.

</details>

<details>
<summary>Hint 2</summary>

The quick start has a specific warning about fetching tokens through a port-forward to localhost.

</details>

<details>
<summary>Hint 3</summary>

The JWT `iss` (issuer) claim records the URL the token came from. A token issued via `localhost` has a different issuer from the in-cluster Keycloak URL that `nico-rest-api` expects.

</details>

<details>
<summary>Answer</summary>

The token was issued through `localhost`, so its `iss` claim doesn't match the in-cluster issuer that `nico-rest-api` expects, and the API rejects it with 401. Fetch tokens from inside the cluster instead, for example with `TOKEN=$(helm-prereqs/keycloak/get-token.sh)`, which runs curl from a throwaway in-cluster pod. Then check it:
```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:8388/v2/org/ncx/nico/user/current
```
You should now get `200` instead of `401`. (Port-forwarding to `nico-rest-api` itself is fine. The problem is only where the token was issued.)

</details>

### Explain it

In your own words: Why does HTTP need a token on every request instead of logging you in once? What does that design imply about how carefully you must handle the token string?

### Check

**1. Your script calls an API and gets `403`. What is the best interpretation?**

A. The server crashed while handling the request
B. The server didn't receive any credentials
C. Your credentials were understood, but they don't allow this action
D. The path you requested doesn't exist

<details>
<summary>Answer</summary>

**C.** Your credentials were understood, but they don't allow this action

403 Forbidden means the server knows who you are and still says no. Missing or invalid credentials give 401. A crash gives 5xx. A missing path gives 404. People often mix up 401 and 403: 401 asks "who are you?", 403 says "I know who you are, and no."

</details>

**2. Where does a bearer token normally go in an HTTP API request?**

A. In the URL path, e.g. /token/abc123/machines
B. In the Authorization header as `Bearer <token>`
C. In a cookie that curl creates automatically
D. Nowhere. The server remembers you after the first request.

<details>
<summary>Answer</summary>

**B.** In the Authorization header as `Bearer <token>`

The convention, and what NICo's quick start uses, is `Authorization: Bearer <token>`. Putting tokens in URLs leaks them into logs. curl doesn't invent cookies on its own. HTTP is stateless, so the server doesn't remember you between requests.

</details>

**3. Why is plain HTTP (not HTTPS) risky for an API that uses bearer tokens?**

<details>
<summary>Answer</summary>

Without TLS, the request, including the Authorization header, crosses the network unencrypted. Anyone who can see the traffic can copy the token and act as you until it expires.

The token *is* the credential, so exposing it is like exposing a password. This is why NICo's REST ingress chart adds a `force-ssl-redirect` annotation by default when you enable TLS. Contour honours it; other controllers such as ingress-nginx need their own annotation. Without a redirect, a TLS block alone leaves port 80 serving the API in cleartext. Some people assume tokens are safe because they look random. Randomness stops guessing, not copying.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="ip-addressing-basics"></a>
## 2. IP addressing basics

### Before you read

- A NIC already has a MAC address burned in at the factory. Why might a machine also need an IP address?
- Is 10.180.126.160 an address you could reach directly from anywhere on the internet?

<details>
<summary>Answers</summary>

- **A NIC already has a MAC address burned in at the factory. Why might a machine also need an IP address?** A MAC address only works on the local network segment and says nothing about where the device is. An IP address is a logical, assigned address. It encodes which network a host belongs to, so packets can be routed to it from other networks.
- **Is 10.180.126.160 an address you could reach directly from anywhere on the internet?** No. 10.0.0.0/8 is a private range (RFC 1918). It's used inside organisations and datacenters and isn't routed on the public internet.

</details>

### Explanation

An **IP address** is a number that identifies a network interface so that packets can be delivered to it. Strictly, it belongs to an *interface*, not a machine. A server with three NICs and a BMC can have several IP addresses.

**IPv4** addresses are 32-bit numbers written as four decimal **octets** (8 bits each, 0–255) separated by dots: `10.180.126.160`. That gives about 4.3 billion addresses, which is not enough for the world, so some ranges are reserved as **private**, meaning they're reused inside every organisation and never routed on the public internet:
- `10.0.0.0` – `10.255.255.255`
- `172.16.0.0` – `172.31.255.255`
- `192.168.0.0` – `192.168.255.255`

Other special addresses: `127.0.0.1` is **loopback**, meaning "this machine itself". `0.0.0.0` in a server's listen address means "all my interfaces".

**IPv6** addresses are 128-bit, written in hex groups like `2001:db8::10`. NICo supports some IPv6 setups, but its docs still require IPv4 for DPU loopbacks and VXLAN tunnel endpoints, so IPv4 is the focus here.

**MAC vs IP.** The MAC address (Chapter 1) is a fixed hardware identifier that only matters on the local Ethernet segment. The IP address is *assigned*, either **statically** (typed into config) or **dynamically** by **DHCP**, a service that hands out addresses when a device boots. Part of an IP address says *which network* the host is on, which is what makes routing possible (next lessons).

NICo deals with this constantly. Its network prerequisites say each managed host with a DPU needs 1 IP for the host BMC plus 2 per DPU (DPU ARM OS + DPU BMC), and NICo hands these out over DHCP. Site controller nodes are handled differently: they get their control-plane `/31` addresses statically at OS install time, while their BMC and DPU management IPs come from the parent datacenter's DHCP.

**Analogy.** An IP address is like a postal address, and a MAC address is like a person's name. Inside one house (the local segment) a name is enough to find someone. To send a letter across the country you need the address, because the address says *where* they are. The analogy breaks down because a person keeps their name for life while an interface can get a different IP each time it boots (DHCP), and one device can have several IP addresses at once.

### Worked example: Inspect your own addresses and decode one

**Step 1: List your interfaces' IPv4 addresses.**

Linux:
```bash
ip -4 addr show
```
macOS:
```bash
ifconfig | grep 'inet '
```
You'll see `127.0.0.1` on the loopback interface (`lo` / `lo0`) and probably a private address like `192.168.1.23` on Wi-Fi or Ethernet. Each interface has its own.

**Step 2: See the 32 bits behind the dots.**

```bash
python3 -c "a='10.180.126.160'; print('.'.join(f'{int(o):08b}' for o in a.split('.')))"
```
This prints `00001010.10110100.01111110.10100000`: four 8-bit octets, 32 bits in total.

**Step 3: Classify addresses with the standard library.**

```bash
python3 -c "
import ipaddress
for a in ['10.180.126.160','172.20.5.4','172.32.0.1','8.8.8.8','127.0.0.1']:
    ip = ipaddress.ip_address(a)
    print(a, 'private' if ip.is_private else 'public', 'loopback' if ip.is_loopback else '')
"
```
`172.32.0.1` comes out public, because the private 172 range stops at 172.31.255.255. This is a common trap.

**Step 4: Connect it to NICo's address counts.**

For a managed host with one DPU, NICo's management network needs 1 (host BMC) + 2 (DPU ARM OS + DPU BMC) = **3 IPs**. Each of those is a separate interface with its own address, assigned by NICo's DHCP service.

### Your turn: finish it

Complete this Python snippet so it prints each octet of the address as an 8-digit binary number, and prints whether the address is private.

```text
import ipaddress

addr = "192.168.10.77"
print(".".join(f"{int(o):___}" for o in addr.split(".")))
print(ipaddress.ip_address(addr).___)
```

<details>
<summary>Answer</summary>

The first blank is `08b`, a zero-padded, 8-wide binary format. The second is `is_private`. The output is `11000000.10101000.00001010.01001101` and then `True`.

</details>

### Your turn: on your own

You're planning NICo's management network for managed hosts. You have 12 hosts with one DPU each and 4 hosts with two DPUs each. Using the per-host rule from NICo's network prerequisites, how many IP addresses does this network need for the hosts?

<details>
<summary>Hint 1</summary>

Find the per-host rule: it's a fixed number for the host plus some number per DPU.

</details>

<details>
<summary>Hint 2</summary>

The rule is 1 (host BMC) + 2 per DPU (DPU ARM OS + DPU BMC).

</details>

<details>
<summary>Hint 3</summary>

One-DPU host: 1 + 2 = 3. Two-DPU host: 1 + 4 = 5. Multiply and add.

</details>

<details>
<summary>Answer</summary>

12 × 3 = 36 and 4 × 5 = 20, so you need 56 IP addresses. (When you turn that into a subnet, you'd also budget for addresses the subnet itself reserves. That's covered in the CIDR lesson.)

</details>

### Explain it

In your own words: Why do networks use assigned IP addresses at all, when every NIC already has a globally unique MAC address?

### Check

**1. Which of these addresses is in an RFC 1918 private range?**

A. 172.32.0.1
B. 172.20.5.4
C. 8.8.8.8
D. 193.168.1.1

<details>
<summary>Answer</summary>

**B.** 172.20.5.4

The private 172 range is 172.16.0.0–172.31.255.255, so 172.20.5.4 is inside it and 172.32.0.1 is just outside. 193.168.1.1 looks like 192.168 but isn't. 8.8.8.8 is a public DNS resolver.

</details>

**2. Which statement about MAC and IP addresses is correct?**

A. A MAC address is assigned by DHCP and an IP address is burned into the NIC
B. An interface's IP address can change (e.g. via DHCP) while its MAC address normally stays fixed
C. A machine can only have one IP address
D. IP addresses only matter on the local switch, while MAC addresses are used across the internet

<details>
<summary>Answer</summary>

**B.** An interface's IP address can change (e.g. via DHCP) while its MAC address normally stays fixed

MACs are hardware identifiers and IPs are logical, assigned addresses. The options that swap the two, or that say a machine has one IP, are common misconceptions. A server, its BMC and its DPU all have separate IPs.

</details>

**3. How many bits are in an IPv4 address, and how many in each octet?**

<details>
<summary>Answer</summary>

32 bits in total, 8 bits per octet (four octets).

That's why each dotted number runs from 0 to 255 (2^8 = 256 values). The CIDR lesson builds on this: a prefix like /24 counts bits from the left of those 32.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md)

<a id="layer-2-ethernet-networking"></a>
## 3. Layer 2 Ethernet networking

*Builds on: Network interface card (NIC) (ch. 2)*

### Before you read

- A switch receives data addressed to a MAC address it has never seen. What do you think it does with it?
- Does an ordinary Ethernet switch read IP addresses to decide where to send traffic?

<details>
<summary>Answers</summary>

- **A switch receives data addressed to a MAC address it has never seen. What do you think it does with it?** It **floods** the frame out of every port except the one it came in on, so the destination gets it wherever it is. It doesn't drop the frame.
- **Does an ordinary Ethernet switch read IP addresses to decide where to send traffic?** No. A Layer 2 switch only looks at Ethernet MAC addresses. IP addresses are inside the frame, and the switch ignores them.

</details>

### Explanation

Networking is described in **layers**. **Layer 2** (the *data link* layer) is about getting data between devices on the **same local segment**, meaning devices joined by cables and switches with no router in between. Ethernet is the dominant Layer 2 technology.

The unit of data at Layer 2 is a **frame**. An Ethernet frame contains:
- **destination MAC** and **source MAC** (the 48-bit addresses from Chapter 1)
- an **EtherType** saying what's inside (e.g. `0x0800` = IPv4)
- the **payload**, up to the **MTU** (maximum transmission unit, usually 1500 bytes; "jumbo" frames go up to 9000)
- a checksum

A **switch** connects many NICs. It keeps a **MAC address table** (also called a forwarding table) that maps MAC → port. For each frame it:
1. **Learns**: records "the source MAC lives on the port this frame came in on".
2. **Forwards**: if the destination MAC is in the table, it sends the frame out of that one port only.
3. **Floods**: if the destination is unknown, or is the **broadcast** address `ff:ff:ff:ff:ff:ff`, it sends the frame out of every port except the incoming one.

All devices that receive each other's broadcasts form one **broadcast domain**, also called an L2 segment. Broadcasts are useful for discovery (ARP and DHCP both start with one), but they don't scale. Every broadcast reaches every device, and one mistake can spread across the whole segment.

This is why NICo's network design avoids large shared L2 segments for tenants. Each tenant interface gets its own routed point-to-point link, and the docs say cluster software must not depend on "broadcast discovery, ARP between nodes, or an L2-advertised service VIP". The docs also say to set the MTU to 1500 for overlays, and to use 9000 only if every device on the path supports it.

**Analogy.** A switch is like a mail clerk in an office building who learns where people sit by watching where their outgoing mail comes from. Once the clerk has seen a letter from Priya at desk 4, letters *to* Priya go straight to desk 4. A letter for someone the clerk hasn't seen yet gets copied to every desk. The analogy breaks down because a real clerk would read the street address on an envelope from outside the building. A Layer 2 switch never looks at IP addresses. Anything for another network has to go to a router.

### Worked example: See your MAC, MTU and neighbours, then simulate a switch

**Step 1: Find your NIC's MAC and MTU.**

Linux:
```bash
ip link show
```
Look for lines like `link/ether 3c:22:fb:12:34:56` and `mtu 1500`. macOS: `ifconfig en0` shows `ether ...` and `mtu 1500`.

**Step 2: See MACs your machine has learned on the segment.**

Linux: `ip neigh`. macOS: `arp -a`. Each line pairs a neighbour's IP with its MAC, e.g. your home router. Your machine only knows MACs on its own L2 segment. It will never learn the MAC of a server on the internet.

**Step 3: Write a toy learning switch.**

Save as `switch.py` and run `python3 switch.py`:
```python
mac_table = {}
PORTS = [1, 2, 3, 4]
BCAST = "ff:ff:ff:ff:ff:ff"

def switch_frame(in_port, src, dst):
    mac_table[src] = in_port
    if dst == BCAST or dst not in mac_table:
        return [p for p in PORTS if p != in_port]
    return [mac_table[dst]]

print(switch_frame(1, "aa", "bb"))  # [2, 3, 4]  bb unknown -> flood
print(switch_frame(2, "bb", "aa"))  # [1]        aa learned on port 1
print(switch_frame(1, "aa", "bb"))  # [2]        bb learned on port 2
print(switch_frame(3, "cc", BCAST)) # [1, 2, 4]  broadcast always floods
```

**Step 4: Read the result.**

The first frame floods because the switch has never seen `bb`. After `bb` replies, both MACs are known and traffic between them goes out of one port only. Broadcasts flood whatever the table says. The switch never looked at an IP address.

### Your turn: finish it

Fill in the two blanks so the function learns the source MAC correctly and never floods a frame back out of the port it arrived on.

```text
mac_table = {}

def switch_frame(in_port, src, dst, ports):
    mac_table[___] = in_port
    if dst == "ff:ff:ff:ff:ff:ff" or dst not in mac_table:
        return [p for p in ports if p != ___]
    return [mac_table[dst]]
```

<details>
<summary>Answer</summary>

The first blank is `src`: the switch learns where the *sender* lives. The second is `in_port`: floods go to every port except the one the frame came in on.

</details>

### Your turn: on your own

A 4-port switch starts with an empty MAC table. Host A is on port 1, B on port 2 and C on port 3. Port 4 has nothing attached. For each frame in order, say which port(s) it goes out of and what the switch learns: (1) A→B, (2) B→A, (3) A→C, (4) C→broadcast.

<details>
<summary>Hint 1</summary>

For each frame, first update the table with the source, then look up the destination.

</details>

<details>
<summary>Hint 2</summary>

An unknown destination or a broadcast means flood to all ports except the incoming one, including empty port 4.

</details>

<details>
<summary>Hint 3</summary>

After frame 2 the table holds A=1 and B=2, but C is still unknown when frame 3 arrives.

</details>

<details>
<summary>Answer</summary>

(1) The switch learns A=1. B is unknown, so it floods to ports 2, 3, 4. (2) It learns B=2. A is known, so the frame goes to port 1 only. (3) A is already known on port 1. C is unknown, so it floods to 2, 3, 4. (4) It learns C=3. Broadcast floods to 1, 2, 4. At the end the table is A=1, B=2, C=3.

</details>

### Explain it

In your own words: Why does a switch learn from the *source* address of a frame rather than the destination? What would go wrong if it tried to learn from the destination?

### Check

**1. A switch receives a frame whose destination MAC is not in its table. What does it do?**

A. Drops the frame
B. Sends it out every port except the one it came in on
C. Sends it back to the sender with an error
D. Forwards it to the default gateway

<details>
<summary>Answer</summary>

**B.** Sends it out every port except the one it came in on

Unknown unicast frames are flooded. Dropping them would break the first conversation between any two hosts. Switches don't send errors back. "Default gateway" is a Layer 3 idea that a Layer 2 switch doesn't have.

</details>

**2. Which field does a Layer 2 switch use to make its forwarding decision?**

A. Destination IP address
B. Destination MAC address
C. TCP port
D. Source IP address

<details>
<summary>Answer</summary>

**B.** Destination MAC address

Layer 2 switches forward on the destination MAC and learn from the source MAC. IP addresses and ports belong to higher layers and are handled by routers and firewalls.

</details>

**3. What is a broadcast domain, and why do large ones cause trouble?**

<details>
<summary>Answer</summary>

It's the set of devices that all receive each other's broadcast frames (destination ff:ff:ff:ff:ff:ff). Large ones cause trouble because every broadcast reaches every device, which wastes bandwidth and CPU and lets faults spread across the whole segment.

This is why NICo's tenant design uses routed point-to-point links instead of one big shared segment, and tells you not to rely on broadcast discovery. It's not that broadcasts are slow. The problem is that they don't scale.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md)

<a id="ip-networking-fundamentals"></a>
## 4. IP networking fundamentals

*Builds on: Layer 2 Ethernet networking (ch. 3), IP addressing basics (ch. 3)*

### Before you read

- Your laptop (192.168.1.20) sends a packet to a server at 10.0.0.5 on another network. Your laptop has to put a destination MAC address on the Ethernet frame. Whose MAC address does it use?
- When a packet crosses a router, does its destination IP address change?

<details>
<summary>Answers</summary>

- **Your laptop (192.168.1.20) sends a packet to a server at 10.0.0.5 on another network. Your laptop has to put a destination MAC address on the Ethernet frame. Whose MAC address does it use?** The MAC of its **default gateway** (the router), not the server's. The laptop can't reach the server's MAC at Layer 2. It hands the frame to the router, which passes it on.
- **When a packet crosses a router, does its destination IP address change?** No (ignoring NAT). The destination IP stays the same from end to end. Each router rewrites the *Ethernet* header with new source and destination MACs for the next link.

</details>

### Explanation

Now you can combine IP addresses (who) with Layer 2 (local delivery).

A **subnet** is a range of IP addresses whose hosts sit on the same L2 segment and can reach each other directly. A host's address is written with its subnet size, e.g. `192.168.1.20/24`: the first 24 bits (`192.168.1`) are the **network part**, and every address that starts with them is "on-link". (The next lesson covers the `/24` arithmetic.)

To send a packet, a host checks its **routing table**:
1. **Is the destination in one of my subnets?** If so, deliver directly: use **ARP** (Address Resolution Protocol) to broadcast "who has 192.168.1.77?", get the MAC from the reply, and send the frame to that MAC.
2. **Otherwise**, send it to a **gateway**, a router on my subnet, usually the **default route** (`0.0.0.0/0`, "everything else"). The host ARPs for the *gateway's* IP and puts the *gateway's* MAC on the frame, while the IP packet inside still says `dst 10.0.0.5`.

A **router** is a device with interfaces in several subnets. It receives the frame, removes the Ethernet header, looks up the destination IP in its own routing table, decrements the **TTL** (time to live, a hop counter that stops loops), and sends the packet in a *new* frame on the next link. So **IP addresses stay the same end to end, and MAC addresses change at every hop**.

Any Linux box can act as a router if forwarding is enabled (`net.ipv4.ip_forward=1`). NICo's quick start requires that on every Kubernetes node, because pod traffic is routed through the node.

NICo's tenant networks are built this way on purpose. Each instance interface has a tiny subnet shared only with its DPU, which acts as the gateway and routes everything. Even interfaces whose addresses come from the same VPC prefix are **not** L2-adjacent, so ARP between them won't work. They talk through routers.

**Analogy.** Think of sending a parcel overseas. The address label (destination IP) stays the same all the way. Each courier leg gets a new handover slip (the Ethernet frame): your house to the local depot, depot to airport, airport to the foreign depot. Your local courier never needs the recipient's door number abroad, only the depot's. The analogy breaks down because real routers make every hop decision on their own from their routing tables. No route is planned in advance, and if two routers disagree a packet can loop until its TTL runs out.

### Worked example: Watch your machine choose between direct delivery and the gateway

**Step 1: Read your routing table.**

Linux:
```bash
ip route
```
Typical output:
```
default via 192.168.1.1 dev wlan0
192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.20
```
The second line says the subnet is on-link. The first says everything else goes to 192.168.1.1. macOS: `netstat -rn -f inet`.

**Step 2: Ask the kernel what it would do for a destination.**

Linux:
```bash
ip route get 1.1.1.1        # -> via 192.168.1.1 (gateway)
ip route get 192.168.1.1    # -> dev wlan0 (direct, no 'via')
```
macOS: `route -n get 1.1.1.1` shows `gateway:`.

**Step 3: Confirm the gateway's MAC is what goes on the wire.**

```bash
ip neigh show 192.168.1.1   # Linux
arp -n 192.168.1.1          # macOS
```
That MAC is the destination MAC on every frame you send to the internet.

**Step 4: Count the routers on a path.**

```bash
traceroute -n 1.1.1.1
```
(Install `traceroute` if it's missing.) Each numbered line is a router that decremented the TTL. Line 1 is your gateway.

**Step 5: Reproduce the decision in code.**

```bash
python3 -c "
import ipaddress
net = ipaddress.ip_network('192.168.1.0/24')
for d in ['192.168.1.77','10.0.0.5']:
    print(d, 'direct' if ipaddress.ip_address(d) in net else 'via gateway')
"
```

### Your turn: finish it

Complete the function so it returns which IP the host must ARP for: the destination itself when it's on-link, otherwise the gateway.

```text
import ipaddress

def arp_target(my_net, gateway, dst):
    net = ipaddress.ip_network(my_net)
    if ipaddress.ip_address(dst) in ___:
        return dst
    return ___

print(arp_target("192.168.1.0/24", "192.168.1.1", "192.168.1.77"))
print(arp_target("192.168.1.0/24", "192.168.1.1", "10.0.0.5"))
```

<details>
<summary>Answer</summary>

The first blank is `net`, which tests whether the destination is in the local subnet. The second is `gateway`, since off-subnet traffic goes to the router. The output is `192.168.1.77` and then `192.168.1.1`.

</details>

### Your turn: on your own

Host H is 10.1.1.5/24 with default gateway 10.1.1.1. It sends a packet to 10.1.2.9, which is behind the router on another /24. For the frame leaving H, give the destination MAC (whose?), the destination IP and the source IP. Then say what changes and what stays the same when the router passes the packet on toward 10.1.2.9.

<details>
<summary>Hint 1</summary>

Is 10.1.2.9 inside 10.1.1.0/24? Compare the first three octets.

</details>

<details>
<summary>Hint 2</summary>

Off-subnet means H ARPs for the gateway, not the final host.

</details>

<details>
<summary>Hint 3</summary>

The router builds a new Ethernet frame. Only Layer 2 addresses are rewritten (plus TTL).

</details>

<details>
<summary>Answer</summary>

10.1.2.9 isn't in 10.1.1.0/24, so the frame leaving H has destination MAC = the router's (10.1.1.1's) MAC, destination IP = 10.1.2.9, source IP = 10.1.1.5. At the router, a new frame is built: source MAC = router's interface on 10.1.2.0/24, destination MAC = 10.1.2.9's MAC (found by the router's own ARP). The IP addresses stay the same and the TTL goes down by 1.

</details>

### Explain it

In your own words: NICo's docs say two instance interfaces with addresses from the same VPC prefix are *not* L2-adjacent and can't ARP for each other. In your own words, explain how they can still exchange packets, and why the network designers might prefer that.

### Check

**1. As a packet crosses a router (no NAT), what changes?**

A. The destination IP address
B. The source IP address
C. The Ethernet source and destination MAC addresses
D. Nothing, routers just copy the frame

<details>
<summary>Answer</summary>

**C.** The Ethernet source and destination MAC addresses

Routers strip the old frame and build a new one for the next link, so the MACs change and the TTL drops. The IP addresses stay the same end to end. Thinking the destination IP changes mixes routing up with NAT. "Just copies" describes a switch.

</details>

**2. Host 10.1.1.5/24 wants to send to 10.1.2.9. What does it ARP for?**

A. 10.1.2.9
B. Its default gateway's IP
C. ff:ff:ff:ff:ff:ff
D. It doesn't need ARP for off-subnet destinations

<details>
<summary>Answer</summary>

**B.** Its default gateway's IP

10.1.2.9 is outside 10.1.1.0/24, so the host hands the packet to its gateway and needs the gateway's MAC. It can't ARP for 10.1.2.9 because that host isn't on its segment. ff:ff... is the broadcast MAC an ARP request is sent *to*, not something you ARP *for*.

</details>

**3. Why does NICo's quick start require `net.ipv4.ip_forward=1` on every Kubernetes node?**

<details>
<summary>Answer</summary>

With it set to 1, the Linux kernel forwards packets that arrive for other destinations, so it acts as a router. Kubernetes nodes have to route traffic between pods, services and the outside network, which they can't do if forwarding is off.

With forwarding off, Linux drops packets that aren't addressed to the host itself, and pod networking breaks. Forwarding doesn't open ports or speed anything up. It turns routing on.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="cidr-prefixes-and-31-point-to-point-subnets"></a>
## 5. CIDR prefixes and /31 point-to-point subnets

*Builds on: IP networking fundamentals (ch. 3)*

### Before you read

- How many IP addresses do you think `10.180.126.160/28` contains?
- A normal subnet loses two addresses (the network and broadcast addresses). How could a subnet with only two addresses still be useful?

<details>
<summary>Answers</summary>

- **How many IP addresses do you think `10.180.126.160/28` contains?** 16. A /28 fixes 28 of the 32 bits, which leaves 4 bits free, and 2^4 = 16 (10.180.126.160–10.180.126.175).
- **A normal subnet loses two addresses (the network and broadcast addresses). How could a subnet with only two addresses still be useful?** On a point-to-point link with exactly two ends, no broadcast address is needed, so RFC 3021 lets a /31 use both addresses, one for each end. NICo uses /31s for exactly this.

</details>

### Explanation

**CIDR** (Classless Inter-Domain Routing) notation writes a block of addresses as `address/prefix-length`. The **prefix length** is how many leading bits are fixed (the network part). The rest are free (the host part).

**Size of a block = 2^(32 − prefix).**

| Prefix | Addresses | Typical use |
|---|---|---|
| /24 | 256 | a LAN |
| /27 | 32 | NICo's typical control-plane service IP pool |
| /28 | 16 | NICo's example MetalLB VIP pools |
| /31 | 2 | point-to-point link |
| /32 | 1 | a single host, e.g. a loopback |

The same prefix can be written as a **netmask**: /24 = `255.255.255.0`. A block must start on a multiple of its size: `10.0.0.16/28` is valid, `10.0.0.20/28` is not.

In a normal subnet, the **first address** is the network address and the **last** is the broadcast address, so neither can be given to a host. Usable hosts = size − 2. A /24 has 254 usable addresses. Networks often keep a few more back, for example one for the gateway. NICo's admin network definition includes a `gateway` and a `reserve_first` field, which reserves addresses at the start of the prefix so they aren't handed out. NICo's docs also say the admin pool must allow for any network and broadcast addresses the subnet needs.

Two special cases:
- **/31**: two addresses, both usable (RFC 3021). A point-to-point link has exactly two ends and doesn't need broadcast, so nothing is wasted. NICo uses /31s for the link between each site controller's host OS and its DPU, and for every tenant interface (one /31 per PF or VF, with the DPU as the other end). NICo's docs give **/31 as the minimum prefix size** for its pools.
- **/32**: one address, meaning "exactly this host". Each DPU has a /32 **loopback**, an address on a virtual interface that never goes down, and advertises it as its VXLAN tunnel endpoint.

NICo's docs size its main IPv4 prefix with the formula `(servers + DPUs) * 2 + 2`. The docs don't explain the parts, but the `* 2` fits a pattern of two addresses (one /31's worth) per device. Either way, you can use the formula as given.

**Analogy.** A CIDR prefix is like a phone number prefix. If the first 28 of 32 digits are fixed, only the last 4 vary, so the block holds 2^4 numbers. A /31 is a private line with exactly two handsets, one at each end, which needs no reception desk number (network address) and no announcement number (broadcast). The analogy breaks down because phone prefixes are decimal and IP prefixes are binary, so the block sizes are always powers of two and the boundaries rarely fall on neat decimal numbers.

### Worked example: Take apart NICo-sized blocks with Python's ipaddress module

**Step 1: Size the example MetalLB pool.**

```bash
python3 -c "
import ipaddress
n = ipaddress.ip_network('10.180.126.160/28')
print(n.num_addresses, n.network_address, n.broadcast_address, n.netmask)
"
```
This prints `16 10.180.126.160 10.180.126.175 255.255.255.240`. 2^(32−28) = 16.

**Step 2: Check alignment.**

```bash
python3 -c "import ipaddress; ipaddress.ip_network('10.180.126.164/28')"
```
This raises `ValueError: ... has host bits set`, because .164 isn't a multiple of 16. Blocks must start on a boundary.

**Step 3: Look inside a /31 and a /32.**

```bash
python3 -c "
import ipaddress
print(list(ipaddress.ip_network('10.0.0.0/31').hosts()))
print(list(ipaddress.ip_network('10.0.0.9/32').hosts()))
"
```
Recent Python 3 versions print both addresses for the /31 (`10.0.0.0`, `10.0.0.1`). Nothing is reserved. The /32 gives just `10.0.0.9`.

**Step 4: Carve a pool into /31 links.**

```bash
python3 -c "
import ipaddress
for link in list(ipaddress.ip_network('10.50.0.0/29').subnets(new_prefix=31)):
    a, b = link
    print(link, 'DPU side', a, 'host side', b)
"
```
A /29 (8 addresses) gives four /31 links.

**Step 5: Apply NICo's sizing formula.**

For 10 servers with 1 DPU each: `(10 + 10) * 2 + 2 = 42` addresses. The smallest power of two that holds 42 is 64, so you'd ask for a **/26**.

### Your turn: finish it

You need tenant /31s for 20 hosts, each with one DPU using the PF and one VF (two /31s per host per tenant network). Fill the blanks so the script carves the right number of /31s from the block and confirms it's big enough.

```text
import ipaddress

needed = 20 * ___
pool = ipaddress.ip_network("10.50.0.0/25")
links = list(pool.subnets(new_prefix=___))
print(len(links), "links available,", needed, "needed")
print("OK" if len(links) >= needed else "too small")
```

<details>
<summary>Answer</summary>

The first blank is `2` (two /31s per host: PF + VF), so `needed` = 40. The second is `31`. A /25 has 128 addresses, which makes 64 /31s, so the output is `64 links available, 40 needed` and then `OK`.

</details>

### Your turn: on your own

A site will have 40 servers and 40 DPUs. Using NICo's network prerequisites: (a) How many addresses does the single main IPv4 prefix need, and what's the smallest CIDR prefix length that fits? (b) The additional prefix(es) need `DPUs * 2` addresses. What's the smallest single prefix for that? (c) How many addresses does each DPU's loopback take, and what prefix length is that?

<details>
<summary>Hint 1</summary>

Formula (a) is `(servers + DPUs) * 2 + 2`. Work it out, then find the next power of two at or above it.

</details>

<details>
<summary>Hint 2</summary>

Powers of two: /26 = 64, /25 = 128, /24 = 256. Prefix = 32 − log2(size).

</details>

<details>
<summary>Hint 3</summary>

Loopbacks are single-host routes.

</details>

<details>
<summary>Answer</summary>

(a) (40 + 40) × 2 + 2 = 162 addresses. 128 (/25) is too small, so you need 256, a **/24**. (b) 40 × 2 = 80, and the next power of two is 128, a **/25**. (c) One address each, advertised as a **/32**.

</details>

### Explain it

In your own words: Why can a /31 use both of its addresses when every other subnet (larger than /31) gives up its first and last addresses? What property of a point-to-point link makes that safe?

### Check

**1. How many addresses are in a /27?**

A. 27
B. 16
C. 32
D. 30

<details>
<summary>Answer</summary>

**C.** 32

2^(32−27) = 2^5 = 32. 27 confuses the prefix length with the size. 16 is a /28. 30 is the usable host count of a /27 after the network and broadcast addresses are removed. A /27 is what NICo's docs suggest as the typical control-plane service IP pool.

</details>

**2. How many usable host addresses does a /31 point-to-point subnet provide?**

A. 0, because the network and broadcast addresses take both
B. 1
C. 2
D. 4

<details>
<summary>Answer</summary>

**C.** 2

RFC 3021 lets /31s drop the network/broadcast convention because a point-to-point link has exactly two ends. Answering 0 applies the normal −2 rule where it doesn't apply. NICo relies on this, since its minimum prefix size is /31.

</details>

**3. What is a /32 typically used for in NICo's network design?**

<details>
<summary>Answer</summary>

A single host address, specifically each DPU's loopback, which it advertises as its VXLAN tunnel endpoint (VTEP).

A /32 matches exactly one address. Loopback interfaces never go down with a cable, which makes them stable endpoints to route to. A /32 isn't an empty or invalid subnet. It's the most specific route possible.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="firewall-rules"></a>
## 6. Firewall rules

*Builds on: IP networking fundamentals (ch. 3)*

### Before you read

- A firewall drops your connection attempt without replying. What will your `curl` command do: fail instantly with "connection refused", or hang until it times out?
- NICo's docs say "block everything else by default". Why might "deny unless allowed" be safer than "allow unless denied"?

<details>
<summary>Answers</summary>

- **A firewall drops your connection attempt without replying. What will your `curl` command do: fail instantly with "connection refused", or hang until it times out?** It hangs until it times out. Dropping means sending nothing back, so the client waits. "Connection refused" happens when the target actively rejects (sends a TCP reset or ICMP error), or when nothing is listening on that port.
- **NICo's docs say "block everything else by default". Why might "deny unless allowed" be safer than "allow unless denied"?** With default-deny, anything you forgot about stays blocked, so mistakes fail safe. With default-allow, every service you forget to block is exposed.

</details>

### Explanation

A **firewall** inspects packets and applies **rules**. Each rule has **match conditions** and an **action**.

Common match fields, all from earlier lessons:
- **source / destination IP or CIDR**, e.g. `ip saddr 10.10.0.0/24`
- **protocol**: TCP, UDP, ICMP
- **destination port**: the number that identifies a service on a host (22 SSH, 443 HTTPS, 6443 Kubernetes API, 8080 a dev API)
- **interface**, e.g. traffic arriving on `lo`
- **connection state**: `new`, `established`, `related`

Actions:
- **accept**: let the packet through
- **drop**: silently discard it. The client waits and times out.
- **reject**: discard it and send an error back. The client fails immediately.

Rules are checked **in order, and the first match wins**. If nothing matches, the chain's **default policy** applies. A **default-deny** policy (`policy drop`) plus a short list of `accept` rules is the standard pattern. NICo's network page recommends exactly this for site controllers: allow Kubernetes control-plane and node ports for your CNI, allow SSH from a secure management network, and block everything else.

Modern firewalls are **stateful**: they track connections. The rule `ct state established,related accept` means "let through anything that's part of a connection we already allowed". Without it, replies to your own outgoing requests (package downloads, DNS answers) would hit the default drop.

On Linux the current tool is **nftables** (`nft`). Rules live in **tables** and **chains**. A chain attaches to a **hook**: `input` for packets addressed to this host, `output` for packets it sends, `forward` for packets it routes for others. The first line inside a chain (`type filter hook input priority 0; policy drop;`) is the chain's header. It sets the hook and default policy and isn't a rule itself. The rules are the lines after it.

```
table inet lab {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif "lo" accept
    ip saddr 10.10.0.0/24 tcp dport 22 accept
  }
}
```

NICo also does address-based blocking itself. Its `siteConfig` has a `deny_prefixes` field listing CIDRs that instances must not reach, such as OOB, control plane and management networks.

**Analogy.** A firewall is like a door bouncer with a guest list who works down the list from the top. The first line that matches you decides whether you get in, and if you're on no line, the house rule applies ("no list, no entry"). Once you're inside, the bouncer remembers your face and lets you back in after a smoke break, which is the `established` rule. The analogy breaks down at "drop". A real bouncer at least shakes their head. A dropping firewall says nothing at all, so the client keeps waiting.

### Worked example: Read and apply a default-deny ruleset in a throwaway container

**Step 1: Start a container allowed to change firewall rules.**

```bash
docker run --rm -it --cap-add NET_ADMIN debian:stable-slim bash
apt-get update && apt-get install -y nftables
```
(With Podman, replace `docker` with `podman`.) `NET_ADMIN` lets the container manage *its own* network namespace. Your laptop's firewall isn't touched.

**Step 2: Write the ruleset.**

```bash
cat > /tmp/fw.nft <<'EOF'
table inet lab {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif "lo" accept
    ip saddr 10.10.0.0/24 tcp dport 22 accept
    tcp dport 6443 accept
  }
}
EOF
```
The header line sets the hook and `policy drop`. Below it are four rules: (1) `ct state established,related accept`, (2) `iif "lo" accept`, (3) SSH from 10.10.0.0/24, (4) port 6443 from anywhere.

**Step 3: Trace a few packets through it by hand.**

Go through the rules top to bottom, first match wins:
- New TCP from 10.10.0.7 to port 22: rule 3 matches, **accept**.
- New TCP from 192.168.5.5 to port 22: no rule matches, so **policy drop**.
- New TCP from anywhere to port 6443: rule 4, **accept**.
- A DNS reply to a query this host sent: rule 1 (`established`), **accept**.
- Ping (ICMP) from anyone: no match, **drop**.

**Step 4: Load and inspect it.**

```bash
nft -f /tmp/fw.nft
nft list table inet lab
```
`nft list table inet lab` shows only your table. If you run `nft list ruleset` instead, you may also see a `table ip nat` with warnings like `XT target DNAT not found`. Those belong to Docker and are harmless.

### Your turn: finish it

Fill in the blanks so this nftables file blocks everything by default and allows SSH only from the management network 10.10.0.0/24. Once filled, it must load with `nft -f`.

```text
table inet lab {
  chain input {
    type filter hook input priority 0; policy ___;
    ct state established,related accept
    iif "lo" accept
    ip saddr 10.10.0.0/24 tcp dport ___ accept
  }
}
```

<details>
<summary>Answer</summary>

The first blank is `drop`, for a default-deny policy. The second is `22`, the SSH port. The completed line reads `type filter hook input priority 0; policy drop;`.

</details>

### Your turn: on your own

Write an nftables `input` chain for a host running an API on TCP 8080. It should: allow replies to connections the host itself opened; allow loopback; allow TCP 8080 only from 172.30.0.20; allow SSH (22) only from 10.10.0.0/24; drop everything else silently. Then predict what `curl --max-time 5` from 172.30.0.30 to port 8080 will do, and give curl's exit code.

<details>
<summary>Hint 1</summary>

Start with the default-deny chain header from the lesson and add one `accept` line per allowed case.

</details>

<details>
<summary>Hint 2</summary>

Use `ip saddr <addr or CIDR> tcp dport <port> accept` for each allowed source/port pair.

</details>

<details>
<summary>Hint 3</summary>

Silent drop means no reply, so curl waits until `--max-time` runs out. curl's exit code for a timeout is 28.

</details>

<details>
<summary>Answer</summary>

```
table inet lab {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif "lo" accept
    ip saddr 172.30.0.20 tcp dport 8080 accept
    ip saddr 10.10.0.0/24 tcp dport 22 accept
  }
}
```
From 172.30.0.30, the SYN matches no accept rule and falls to `policy drop`. No reply comes back, curl hangs for 5 seconds and exits with **28** (operation timed out). If you used `reject` instead, curl would fail at once with exit code 7 (couldn't connect).

</details>

### Explain it

In your own words: Why does a default-deny firewall need the `ct state established,related accept` rule? What would break on the host if you left it out?

### Check

**1. A client tries to connect to a port that a firewall *drops*. What does the client see?**

A. "Connection refused" immediately
B. The connection hangs until a timeout
C. An HTTP 403 response
D. An HTTP 401 response

<details>
<summary>Answer</summary>

**B.** The connection hangs until a timeout

Drop sends nothing back, so the client keeps waiting. "Connection refused" comes from reject, or from a port with nothing listening. 401 and 403 are HTTP responses from a server that was reached, and a firewall drop means the server never saw the request.

</details>

**2. An nftables chain contains `tcp dport 22 drop` followed by `ip saddr 10.10.0.0/24 tcp dport 22 accept`. What happens to SSH from 10.10.0.5?**

A. Accepted, because the more specific rule wins
B. Dropped, because the first matching rule wins
C. Accepted, because accept beats drop
D. It depends on the default policy

<details>
<summary>Answer</summary>

**B.** Dropped, because the first matching rule wins

Rules are checked in order and the first match decides. Many people assume the more specific rule wins, but nftables doesn't work that way. The default policy only applies when *no* rule matches, and here the first rule already matched.

</details>

**3. Which approach matches the firewalling guidance on NICo's network prerequisites page?**

A. Allow everything and block known-bad ports
B. Allow Kubernetes control-plane and node ports for your CNI plus SSH from a secure management network, and block everything else by default
C. Disable the firewall on site controllers, because MetalLB handles security
D. Block only ICMP

<details>
<summary>Answer</summary>

**B.** Allow Kubernetes control-plane and node ports for your CNI plus SSH from a secure management network, and block everything else by default

The docs recommend default-deny with a short allow list. Default-allow leaves forgotten services exposed. MetalLB assigns and advertises IPs and isn't a firewall. Blocking ICMP alone protects nothing that matters.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="build-task"></a>
## Build task: Lock down a token-protected API with fixed IPs and an nftables firewall

**Goal:** Run a small JSON API in a container at 172.30.0.10:8080. It requires a bearer token and returns 401, 200 or 404. Call it from a client container at 172.30.0.20 and an "intruder" at 172.30.0.30, then add a default-deny nftables firewall so only the client can reach it.

**Why it matters for NICo:** This is a laptop-sized model of NICo's control plane: an HTTP API that checks `Authorization: Bearer` tokens (like `nico-rest-api`), services on fixed IPs in a known subnet (like MetalLB VIPs from a /28 pool), and a firewall that allows only the expected sources and ports and blocks everything else by default, as NICo's network page recommends. You'll use the same debugging moves on a real site: read status codes, check which source IP the server saw, and tell a firewall drop (timeout) apart from an application refusal (401/404).

**You need:**

- Docker (Engine or Desktop) or Podman. With Podman, replace `docker` with `podman` in every command.
- Internet access the first time, to pull `python:3.12-slim` and `curlimages/curl` and to install the `nftables` package inside the API container
- A terminal and a text editor
- An empty working directory, e.g. `mkdir ~/fwlab && cd ~/fwlab`
- Make sure the subnet 172.30.0.0/24 isn't already used by another Docker network (`docker network ls`, `docker network inspect <name>`)

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Create a network with a known subnet</summary>

```bash
docker network create --subnet 172.30.0.0/24 labnet
```
This gives you a /24 (256 addresses) on its own bridge, so you can pin containers to fixed IPs with `--ip`.

</details>

<details>
<summary>Step 2: Write the API</summary>

Save as `app.py` in your working directory:
```python
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

TOKEN = "lab-secret-token"
MACHINES = [{"id": "m1", "bmc_mac": "C4:5A:B1:C8:38:0D", "state": "ready"}]


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer " + TOKEN:
            self.send_json(401, {"error": "missing or bad token"})
            return
        if self.path == "/v1/machines":
            self.send_json(200, {"machines": MACHINES})
        else:
            self.send_json(404, {"error": "not found"})


print("listening on 8080", flush=True)
HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
```
The server checks the token first (401), then the path (200 or 404). It listens on `0.0.0.0`, meaning all of its interfaces.

</details>

<details>
<summary>Step 3: Start the API container with firewall capability</summary>

```bash
docker run -d --name api --network labnet --ip 172.30.0.10 \
  --cap-add NET_ADMIN -v "$PWD":/lab -w /lab python:3.12-slim \
  sh -c "apt-get update && apt-get install -y nftables && python3 -u app.py"
```
Wait until it's ready:
```bash
docker logs api 2>&1 | tail -n 3
```
Repeat until you see `listening on 8080`. (Python's server logs to stderr, hence `2>&1`.)

</details>

<details>
<summary>Step 4: Call it from the client and the intruder (no firewall yet)</summary>

```bash
C="docker run --rm --network labnet"
URL=http://172.30.0.10:8080

$C --ip 172.30.0.20 curlimages/curl -s -o /dev/null -w '%{http_code}\n' $URL/v1/machines
$C --ip 172.30.0.20 curlimages/curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Authorization: Bearer lab-secret-token' $URL/v1/machines
$C --ip 172.30.0.20 curlimages/curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Authorization: Bearer lab-secret-token' $URL/v1/nope
$C --ip 172.30.0.30 curlimages/curl -s -o /dev/null -w '%{http_code}\n' $URL/v1/machines
```
Expected: `401`, `200`, `404`, `401`. Right now the intruder reaches the app, and only the token check stops it. The API log now contains one request from `172.30.0.30`. That's expected, and you'll need to tell it apart from later requests.

</details>

<details>
<summary>Step 5: Write and apply a default-deny firewall</summary>

Save as `lab.nft`:
```
table inet lab {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif "lo" accept
    ip saddr 172.30.0.20 tcp dport 8080 accept
  }
}
```
Note the time (the container logs in UTC), then apply and inspect it:
```bash
date -u '+%d/%b/%Y %H:%M:%S'     # firewall applied at this time
docker exec api nft -f /lab/lab.nft
docker exec api nft list ruleset
```
Your `table inet lab` appears next to Docker's own `table ip nat`. Warnings such as `XT target DNAT not found` come from Docker's table and are harmless.

</details>

<details>
<summary>Step 6: Re-test and confirm who got through</summary>

Run the three client commands from step 4 again. You should get `401`, `200`, `404`. Then the intruder, with a timeout:
```bash
$C --ip 172.30.0.30 curlimages/curl -s --max-time 5 -o /dev/null \
  -w '%{http_code}\n' $URL/v1/machines; echo "exit=$?"
```
After about 5 seconds this prints `000` and `exit=28`, a timeout, because the firewall dropped the packets silently. Finally:
```bash
docker logs api 2>&1 | tail -n 8
```
Each line looks like `172.30.0.20 - - [20/Nov/2026 10:15:03] "GET /v1/machines HTTP/1.1" 200 -`. Compare the timestamps with the time you noted in step 5. You'll still see the `172.30.0.30` line from step 4, with an earlier timestamp. That one is expected. Every line timestamped after the firewall went up comes from `172.30.0.20`. The intruder's second request never reached Python.

</details>

<details>
<summary>Step 7: Clean up</summary>

```bash
docker rm -f api
docker network rm labnet
```

</details>

**Check it works:** After applying `lab.nft`, the client at 172.30.0.20 gets `401` (no token), `200` (token, /v1/machines) and `404` (token, /v1/nope). The intruder at 172.30.0.30 running `curl --max-time 5` prints `000` and exits with code 28. In `docker logs api 2>&1 | tail`, the only 172.30.0.30 line has a timestamp from before the firewall was applied (step 4). No 172.30.0.30 request appears after that time.

<details>
<summary>If you get stuck</summary>

- `nft: ... Operation not permitted`: the api container was started without `--cap-add NET_ADMIN`. Remove it and start it again with that flag.
- `nft: command not found`: the apt install hadn't finished. Wait for `listening on 8080` in `docker logs api 2>&1`.
- `Pool overlaps with other one on this address space` when creating the network: another network already uses 172.30.0.0/24. Use another private /24 (e.g. 172.31.50.0/24) and change every address to match.
- The intruder fails immediately with exit code 7 instead of timing out: something is rejecting rather than dropping. Check that your chain uses `policy drop` and has no `reject` rule.
- The client also times out after the firewall goes up: check the `ip saddr` address and port in `lab.nft` for typos, then reload with `docker exec api nft flush ruleset` followed by `docker exec api nft -f /lab/lab.nft`. Flushing also removes Docker's NAT rules inside the container, which serve Docker's embedded DNS at 127.0.0.11. That's fine here because the API never resolves names, but you can simply recreate the container instead.
- You see a 172.30.0.30 line in the API log and think the firewall failed: check its timestamp. The request from step 4 was made before the firewall existed and is expected. Only lines after the time you noted in step 5 matter.
- On SELinux hosts (Fedora/RHEL) where the container can't read `/lab/app.py`, mount the directory with `-v "$PWD":/lab:Z`.
- On Docker 28 and later, don't try to extend this lab by routing between two Docker networks through a 'router' container. Docker's own rules drop that traffic. Use the network-namespace stretch goal below instead.

</details>

**Stretch goal:** Rebuild the setup as a routed network of /31 point-to-point links, like NICo's DPU links, using network namespaces inside one privileged container:
```bash
docker run --rm -it --privileged debian:stable-slim bash
apt-get update && apt-get install -y iproute2 nftables python3 curl traceroute
for ns in client router server; do ip netns add $ns; ip -n $ns link set lo up; done
ip link add veth-c netns client type veth peer name veth-rc netns router
ip link add veth-s netns server type veth peer name veth-rs netns router
ip -n client addr add 10.0.0.1/31 dev veth-c
ip -n router addr add 10.0.0.0/31 dev veth-rc
ip -n router addr add 10.0.0.2/31 dev veth-rs
ip -n server addr add 10.0.0.3/31 dev veth-s
ip -n client link set veth-c up; ip -n router link set veth-rc up
ip -n router link set veth-rs up; ip -n server link set veth-s up
ip -n client route add default via 10.0.0.0
ip -n server route add default via 10.0.0.2
ip netns exec router sh -c 'echo 1 > /proc/sys/net/ipv4/ip_forward'
ip netns exec server python3 -m http.server 8080 &
ip netns exec client traceroute -n 10.0.0.3
ip netns exec client curl -s -o /dev/null -w '%{http_code}\n' http://10.0.0.3:8080/
```
(`debian:stable-slim` has no `sysctl`, so forwarding is enabled through `/proc`.) traceroute shows two hops: hop 1 is `10.0.0.0`, the router's address on the client's /31, and hop 2 is `10.0.0.3`, the server. You won't see `10.0.0.2` in the output, because by default a Linux router sends its "time exceeded" reply from the interface it uses to reach the sender, and that's the interface facing the client. curl prints `200`, and the server's log shows the client's real source IP `10.0.0.1`. Next, add a `forward` chain in the router namespace (`ip netns exec router nft -f <file>`) with `policy drop`, an `established,related` accept, and `ip saddr 10.0.0.1 ip daddr 10.0.0.3 tcp dport 8080 accept`. Confirm curl still returns 200, then add a second client namespace on another /31 (e.g. 10.0.0.4/31) and show that its curl times out.

## Review notes

The draft was rewritten twice using review issues; the notes below are from the last review.

This chapter was written with 8 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (CIDR prefixes and /31 point-to-point subnets): The explanation says the admin network's `reserve_first` field "reserves addresses at the start of the prefix so they aren't handed out." The quick start only lists `reserve_first` as a `[networks.admin]` field and never defines what it does, so the provided pages don't support this description of its meaning. *Fix:* Hedge it (e.g. "judging by its name, `reserve_first` likely keeps addresses at the start of the prefix from being handed out") or cite the Initial Network Configuration guide that defines it. Keep the supported point that the admin pool must allow for network and broadcast addresses.

---

[← 02-software-linux-basics.md](02-software-linux-basics.md) · [04-state-machine-framework.md →](04-state-machine-framework.md)
