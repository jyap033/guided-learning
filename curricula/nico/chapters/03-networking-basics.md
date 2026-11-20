# Chapter 3: Networking Basics

*Part: Foundations · 6 concepts · [curriculum](../curriculum.md#chapter-3)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

NICo is a network-heavy system. Before it can provision a single bare-metal machine, it has to hand out IP addresses to BMCs and DPUs, run DHCP, DNS and PXE services that machines reach over the network, route traffic between tenant networks, and expose REST and gRPC APIs that you call with an access token. Every page of the NICo deployment docs assumes you can read lines like "a `/31` point-to-point subnet", "a `/27` pool", "advertise `/32` loopbacks" or "`Authorization: Bearer $TOKEN`" without stopping.

This chapter builds that vocabulary from the bottom up. It starts with HTTP, the protocol you'll use to talk to NICo's REST API. Then it covers how machines are addressed (IP addresses), how frames move inside one local network (Layer 2 Ethernet and switches), and how packets move between networks (subnets, gateways and routers). It ends with how to size address blocks with CIDR notation, including the `/31` and `/32` blocks NICo uses everywhere, and how firewall rules decide which traffic is allowed.

You already know what a NIC and a MAC address are (Chapter 1) and how to work in a Linux shell and run containers (Chapter 2). This chapter puts those to work. Each lesson has commands you can run on your own laptop. The closing build task wires everything together in a small Docker lab: a token-protected API on a subnet you design, with a firewall in front of it.

**By the end of this chapter you can:**

- Make authenticated HTTP API calls with curl and read the status codes and headers that come back
- Read an IPv4 address, tell private addresses from public ones, and inspect your own machine's addresses and routes
- Explain how a switch learns MAC addresses, and predict where it will forward a frame
- Work out whether a packet is delivered directly or through a gateway, and which route a router picks
- Size and split IP blocks in CIDR notation, including /31 point-to-point links and /32 host addresses, as NICo's address pools require
- Write and order default-deny firewall rules by address, protocol and port, then test them

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [HTTP and web APIs](#http-and-web-apis)
2. [IP addressing basics](#ip-addressing-basics)
3. [Layer 2 Ethernet networking](#layer-2-ethernet-networking)
4. [IP networking fundamentals](#ip-networking-fundamentals)
5. [CIDR prefixes and /31 point-to-point subnets](#cidr-prefixes-and-31-point-to-point-subnets)
6. [Firewall rules](#firewall-rules)
7. [Build task: Mini site-controller network lab: a token-protected API on a subnet you design, behind a firewall](#build-task)

<a id="http-and-web-apis"></a>
## 1. HTTP and web APIs

### Before you read

- An API returns either 401 or 403. Which one means "I don't know who you are", and which means "I know who you are, but you're not allowed"?
- Guess: where in an HTTP request does an access token usually go: in the URL, in a header, or in the response?

<details>
<summary>Answers</summary>

- **An API returns either 401 or 403. Which one means "I don't know who you are", and which means "I know who you are, but you're not allowed"?** 401 Unauthorized means the server couldn't authenticate you: the credentials are missing, expired or invalid. 403 Forbidden means it knows who you are but won't let you do this.
- **Guess: where in an HTTP request does an access token usually go: in the URL, in a header, or in the response?** In a request header, usually `Authorization: Bearer <token>`. Putting tokens in URLs is discouraged because URLs end up in logs.

</details>

### Explanation

**HTTP** (HyperText Transfer Protocol) is a request/response protocol. A **client** (curl, a browser, `nicocli`) sends a **request**, and a **server** sends back a **response**. A **web API** is a set of HTTP endpoints built for programs to call rather than for people to read.

**Anatomy of a URL**: `http://localhost:8388/v2/org/ncx/nico/user/current`
- `http` is the **scheme**. `https` means HTTP wrapped in TLS encryption.
- `localhost` is the **host**, meaning which machine to talk to.
- `8388` is the **port**. One machine runs many programs, and the port number picks which one gets the request. The defaults are 80 for HTTP and 443 for HTTPS.
- `/v2/org/...` is the **path**, meaning which resource you want. An optional `?key=value` **query string** can follow it.

**A request** contains:
1. A **method** saying what you want to do: `GET` (read), `POST` (create or act), `PUT`/`PATCH` (update), `DELETE`.
2. **Headers**, which are `Name: value` metadata lines such as `Content-Type: application/json` (the format of the body), `Accept` (the format you want back) and `Authorization` (who you are).
3. An optional **body**, usually JSON.

**A response** contains a **status code**, headers and an optional body. The first digit of the code tells you the category:
- `2xx` success (`200 OK`, `201 Created`, `204 No Content`)
- `3xx` redirect (go somewhere else)
- `4xx` your request was wrong (`400 Bad Request`, `401 Unauthorized`, `403 Forbidden`, `404 Not Found`)
- `5xx` the server failed (`500`, `502`, `503`)

**Tokens.** HTTP is *stateless*: the server doesn't remember you between requests, so every request has to prove who you are. A common way is a **bearer token**, a string you get from an identity provider and send as `Authorization: Bearer <token>`. Whoever *bears* (holds) it gets in, so treat it like a password. Many tokens are **JWTs** (JSON Web Tokens), signed JSON documents that contain claims such as the issuer (`iss`). Chapter 19 covers them in depth.

This is exactly how you talk to NICo REST. You get a token from Keycloak's token endpoint using the `client_credentials` grant, then send it in the `Authorization` header. The docs warn that a token fetched through a port-forward to `localhost` carries the wrong `iss` claim and "will be rejected". The docs also note that until you make the one-time org bootstrap call, site operations return **404**.

**Analogy.** An HTTP request is like a form you hand in at a government office counter. The method is the box you tick ("request a copy" or "file a new application"), the path is which department's file you mean, the headers are the details on the envelope, and the token is the ID badge you show every single time, because the clerk has no memory of you. The reply comes back with a stamp: approved (2xx), you filled it in wrong (4xx), or our system is down (5xx). Where it breaks down: a real clerk might recognise your face. An HTTP server only trusts the badge, and anyone holding a copy of the badge gets the same service as you.

### Worked example: Inspect real HTTP requests and responses on your laptop

**Step 1: Start a throwaway HTTP server.**

Python ships with a basic file server. In one terminal, run:
```bash
mkdir -p ~/httplab && cd ~/httplab
echo '{"hello": "world"}' > data.json
python3 -m http.server 8000
```
It now listens on port 8000 and serves files from this directory.

**Step 2: Send a GET and read the response.**

In a second terminal:
```bash
curl -i http://localhost:8000/data.json
```
`-i` prints the response headers. You'll see something like:
```
HTTP/1.0 200 OK
Server: SimpleHTTP/0.6 Python/3.12.3
Content-type: application/json
Content-Length: 19

{"hello": "world"}
```
The first line is the status code, then come the headers, then a blank line, then the body.

**Step 3: Trigger a 4xx error.**

```bash
curl -i http://localhost:8000/does-not-exist
```
You get `404 File not found`. The request reached the server fine. The resource just doesn't exist. A 4xx code is an answer from the server, not a network failure.

**Step 4: See the request you sent, including a custom header.**

```bash
curl -v -H 'Authorization: Bearer demo-token' http://localhost:8000/data.json
```
`-v` (verbose) shows lines starting with `>`. These are your request: `> GET /data.json HTTP/1.1`, `> Host: localhost:8000`, `> Authorization: Bearer demo-token`. This file server ignores the header, but a real API like NICo REST checks it on every request.

**Step 5: Pull out just the status code (handy in scripts).**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/data.json
```
This prints `200`. `-o /dev/null` throws away the body and `-w` prints the code. You'll use this pattern in the build task.

### Your turn: finish it

The NICo Quick Start bootstraps the org with one authenticated GET to the port-forwarded REST API, then pretty-prints the JSON. Fill in the blanks.

TOKEN=$(helm-prereqs/keycloak/get-token.sh)

curl -sS -H "___: ___ $TOKEN" \
    http://localhost:8388/v2/org/ncx/nico/service-account/current \
    | python3 -m json.tool

<details>
<summary>Answer</summary>

The header is `Authorization: Bearer $TOKEN`:
```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
    http://localhost:8388/v2/org/ncx/nico/service-account/current \
    | python3 -m json.tool
```
The header name is `Authorization` and the scheme is `Bearer`. Without this header the server can't authenticate you and you'd expect a 401.

</details>

### Your turn: on your own

With `python3 -m http.server 8000` still running, write one curl command that sends a **POST** with the JSON body `{"name":"node1"}` and a correct `Content-Type` header to `http://localhost:8000/data.json`, and prints only the status code. Predict the code first, then run it and explain what it means.

<details>
<summary>Hint 1</summary>

You need `-X POST` (or just `--data`, which implies POST), a `-H` for the content type, and the `-w '%{http_code}'` trick from the worked example.

</details>

<details>
<summary>Hint 2</summary>

The content type for JSON is `application/json`. The body goes in `--data '{"name":"node1"}'`.

</details>

<details>
<summary>Hint 3</summary>

Python's simple file server only implements GET and HEAD. Look up the 5xx code that means "the server doesn't support this method at all".

</details>

<details>
<summary>Answer</summary>

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' \
  --data '{"name":"node1"}' http://localhost:8000/data.json
```
It prints `501` (Not Implemented). Your request was well-formed and reached the server, but this server has no handler for POST. Compare that with 404 (the path doesn't exist) and 405 (some APIs use it to mean the method isn't allowed on this particular resource). The server log in the first terminal also shows `Unsupported method ('POST')`.

</details>

### Explain it

In your own words: HTTP is stateless. Explain in your own words why that forces every NICo REST request to carry the token, and why that makes a leaked token dangerous.

### Check

**1. You call a NICo REST endpoint with a token you fetched through `kubectl port-forward` to Keycloak on localhost, and you get a 401. What is the most likely cause?**

A. The token's issuer (`iss`) claim doesn't match what nico-rest-api expects, so the token is rejected
B. Your user is authenticated but lacks permission for that resource
C. The endpoint path doesn't exist
D. The NICo REST pod has crashed

<details>
<summary>Answer</summary>

**A.** The token's issuer (`iss`) claim doesn't match what nico-rest-api expects, so the token is rejected

The Quick Start warns that tokens requested against a port-forwarded localhost Keycloak carry an `iss` claim that nico-rest-api doesn't expect, so they're rejected. A rejected credential gives 401. A permission problem would be 403, a missing path 404, and a crashed server a 5xx code or a connection error, not a clean 401.

</details>

**2. Which part of an HTTP request carries a bearer token?**

A. The Authorization request header
B. The status code
C. The URL's port number
D. The Content-Type header

<details>
<summary>Answer</summary>

**A.** The Authorization request header

Tokens go in `Authorization: Bearer <token>`. Status codes only appear in responses. The port picks which program receives the request. Content-Type describes the format of the body, not who you are.

</details>

**3. Before the one-time org bootstrap call, NICo REST site operations return 404. Is that a network problem, an authentication problem, or something else? Answer briefly.**

<details>
<summary>Answer</summary>

Something else. The server received the request and answered it, and as far as it knows the resource doesn't exist yet. Calling `GET .../service-account/current` lazily creates the org's provider, tenant and account.

Any status code proves the request got through the network. 404 is not about authentication either: that would be 401 or 403. The resource simply hasn't been created yet.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="ip-addressing-basics"></a>
## 2. IP addressing basics

### Before you read

- How many bits long is an IPv4 address?
- Can a machine on the public internet send packets straight to 10.1.2.3?

<details>
<summary>Answers</summary>

- **How many bits long is an IPv4 address?** 32 bits, written as four 8-bit numbers (octets) from 0 to 255, such as 10.180.126.160.
- **Can a machine on the public internet send packets straight to 10.1.2.3?** No. 10.0.0.0/8 is a private range (RFC 1918). It's only meaningful inside a private network, and internet routers don't carry routes to it.

</details>

### Explanation

An **IP address** is a logical address given to a network interface so that packets can find it, even across many networks. It's different from the **MAC address** you met in Chapter 1:

| | MAC address | IP address |
|---|---|---|
| Set by | Manufacturer (burned in) | Configuration or DHCP |
| Scope | One local network | Across networks |
| Structure | Flat | Hierarchical (network part + host part) |

**IPv4** addresses are 32 bits, written in **dotted decimal**: four **octets** (bytes) separated by dots. `10.180.126.160` in binary is `00001010.10110100.01111110.10100000`.

An IP address belongs to an *interface*, not to a machine. One server can have several. The NICo docs count 3 management IPs for a node with a DPU: one for the host BMC, one for the DPU's ARM OS and one for the DPU BMC. A machine without a DPU needs only the host BMC's IP.

**Network part and host part.** The leading bits of an address name the network and the rest name a host on that network. The split is written as a **prefix length**. `10.180.126.160/28` means "the first 28 bits are the network". Lesson 5 covers this in depth.

**Special ranges worth knowing:**
- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`: **private** addresses for internal networks. Datacenter fabrics, including the NICo docs' examples, use them heavily.
- `127.0.0.0/8`: **loopback**, meaning "this machine itself" (`127.0.0.1` is `localhost`).
- `169.254.0.0/16`: **link-local**, which a machine gives itself when DHCP fails.
- `0.0.0.0`: "any address" or "unspecified". `255.255.255.255`: broadcast to the local network.

**How addresses get assigned.** Either **statically** (typed into config) or dynamically by **DHCP**, where a server hands out addresses (Chapter 8). NICo uses both. The docs say control-plane node IPs are "allocated statically at OS install time", while BMCs on the management network get theirs via DHCP.

**IPv6** addresses are 128 bits, written in hex groups separated by colons (`2001:db8::1`). `::1` is loopback. The ideas are the same, there are just far more addresses. NICo supports IPv6 in places, but this course focuses on IPv4.

**Analogy.** A MAC address is like a person's passport number: fixed, unique, and useless for finding where they live. An IP address is like a postal address: it has a hierarchy (country, city, street, house) that lets mail be routed step by step, and it changes when the person moves. Where it breaks down: one network interface can have several IP addresses at once, and private addresses like 10.x.x.x are reused in thousands of separate networks, as if every city had its own "1 Main Street".

### Worked example: Find and dissect your own IP addresses

**Step 1: List your interfaces and their IPv4 addresses.**

Linux:
```bash
ip -4 addr show
```
macOS:
```bash
ifconfig | grep 'inet '
```
You'll see `127.0.0.1` on the loopback interface (`lo` / `lo0`) and probably a private address such as `192.168.1.23/24` on your Wi-Fi or Ethernet interface. The `/24` is the prefix length.

**Step 2: Classify addresses with Python's ipaddress module.**

```bash
python3 - <<'EOF'
import ipaddress
for a in ["127.0.0.1", "10.180.126.160", "192.168.1.23", "169.254.10.5", "8.8.8.8"]:
    ip = ipaddress.ip_address(a)
    print(f"{a:16} private={ip.is_private!s:5} loopback={ip.is_loopback!s:5} link_local={ip.is_link_local}")
EOF
```
`8.8.8.8` is the only public one.

**Step 3: See the 32 bits behind the dots.**

```bash
python3 -c "import ipaddress; ip=ipaddress.ip_address('10.180.126.160'); print(f'{int(ip):032b}', int(ip))"
```
Output: `00001010101101000111111010100000 179601056`. An IPv4 address is really just a 32-bit integer: 10×16777216 + 180×65536 + 126×256 + 160 = 179601056. The dots are only there to help humans read it.

**Step 4: Split the address into network and host parts.**

```bash
python3 -c "import ipaddress; i=ipaddress.ip_interface('10.180.126.160/28'); print(i.network, i.ip)"
```
This prints `10.180.126.160/28 10.180.126.160`. With `/28`, the first 28 bits name the network and the last 4 bits number the hosts inside it.

### Your turn: finish it

Finish this script so it reports, for each address, whether it is private and whether it is loopback.

import ipaddress

for a in ["10.0.0.5", "127.0.0.1", "1.1.1.1"]:
    ip = ipaddress.___(a)
    print(a, "private:", ip.___, "loopback:", ip.is_loopback)

<details>
<summary>Answer</summary>

```python
import ipaddress

for a in ["10.0.0.5", "127.0.0.1", "1.1.1.1"]:
    ip = ipaddress.ip_address(a)
    print(a, "private:", ip.is_private, "loopback:", ip.is_loopback)
```
Output: `10.0.0.5` is private, `127.0.0.1` is loopback (Python also reports it as private), and `1.1.1.1` is neither.

</details>

### Your turn: on your own

The NICo Quick Start's example MetalLB config uses `10.180.126.160` as the start of the internal VIP pool and `10.180.126.176` as the start of the external one. Write both addresses in binary and find exactly which bit differs between them. What is that bit worth in decimal?

<details>
<summary>Hint 1</summary>

Only the last octet differs (160 vs 176), so you only need to convert those two bytes.

</details>

<details>
<summary>Hint 2</summary>

160 = 128 + 32 and 176 = 128 + 32 + 16. Write each as 8 bits.

</details>

<details>
<summary>Hint 3</summary>

Compare `10100000` with `10110000`. From the left, the bits are worth 128, 64, 32, 16, 8, 4, 2, 1.

</details>

<details>
<summary>Answer</summary>

160 = `10100000` and 176 = `10110000`. They differ in one bit: the **4th bit from the left** of the last octet (the 16s bit), which is worth **16**. That's why each pool is a /28 (16 addresses). The two blocks sit right next to each other: .160–.175 and .176–.191.

</details>

### Explain it

In your own words: Why does a network need IP addresses at all when every NIC already has a globally unique MAC address? Explain using the idea of hierarchy.

### Check

**1. According to the NICo network prerequisites, how many management-network IPs does a managed host with one DPU need?**

A. 3
B. 1
C. 2
D. 4

<details>
<summary>Answer</summary>

**A.** 3

The rule is 1 for the host BMC plus 2 per DPU (the DPU ARM OS and the DPU BMC), so 1 + 2 = 3. Answering 1 forgets the DPU. Answering 2 counts the DPU as a single device, but it has its own BMC and its own OS.

</details>

**2. You move a server's NIC from one office network to another. What changes?**

A. Its IP address, typically; the MAC address stays the same
B. Its MAC address; the IP stays the same
C. Both always change
D. Neither changes

<details>
<summary>Answer</summary>

**A.** Its IP address, typically; the MAC address stays the same

The MAC is burned into the hardware. The IP is logical and belongs to the network it's attached to, so a new network (usually via DHCP) gives the interface a new IP.

</details>

**3. Which of these is a private (RFC 1918) address: 172.20.1.1, 172.40.1.1, or 11.0.0.1?**

<details>
<summary>Answer</summary>

172.20.1.1. The private 172 range is 172.16.0.0/12, which covers 172.16.0.0–172.31.255.255.

172.40.1.1 is outside 172.16–172.31, and 11.0.0.1 is outside 10.0.0.0/8, so both are public addresses. Mistaking "any 172.x" for private is a common error.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md)

<a id="layer-2-ethernet-networking"></a>
## 3. Layer 2 Ethernet networking

*Builds on: Network interface card (NIC) (ch. 2)*

### Before you read

- A switch receives a frame addressed to a MAC address it has never seen. What do you think it does with it?
- Does a basic Ethernet switch read the IP addresses inside the traffic it forwards?

<details>
<summary>Answers</summary>

- **A switch receives a frame addressed to a MAC address it has never seen. What do you think it does with it?** It floods the frame out of every port except the one it came in on, and hopes the destination answers.
- **Does a basic Ethernet switch read the IP addresses inside the traffic it forwards?** No. A Layer 2 switch only looks at the Ethernet header, mainly the destination and source MAC addresses.

</details>

### Explanation

Networking is usually described in **layers**. Each layer solves one problem and relies on the layer below it:
- **Layer 1, physical**: cables, light and voltage.
- **Layer 2, data link**: delivery between NICs on the *same* local network, using **MAC addresses**. Ethernet lives here.
- **Layer 3, network**: delivery across networks, using **IP addresses** (next lesson).

**Ethernet frames.** At Layer 2 data travels in **frames**. A frame has a header (destination MAC, source MAC, and an **EtherType** saying what the payload is, such as IPv4), a payload, and a checksum. The largest payload a link allows is its **MTU** (maximum transmission unit). The default is 1500 bytes. "Jumbo frames" use 9000. The NICo docs advise 9000 "only if underlay supports it end-to-end", because a single 1500-byte hop in the path breaks the larger frames.

**How a switch works.** A **switch** is a box with many ports that forwards frames between them. It keeps a **MAC address table** (also called a CAM table or FDB) that maps each MAC to a port:
1. **Learn**: when a frame arrives, the switch records *source MAC → incoming port*.
2. **Forward**: if the destination MAC is in the table, the frame goes out of that one port.
3. **Flood**: if the destination is unknown, or is the **broadcast** address `ff:ff:ff:ff:ff:ff`, the frame goes out of every port except the one it came in on.
4. **Age out**: entries are forgotten after a while (often around 5 minutes) so that moved devices get relearned.

All the ports a broadcast can reach make up one **broadcast domain**, also called a **Layer 2 segment**. Hosts on the same segment are **L2-adjacent**: they can reach each other directly by MAC. Wiring switches in a loop makes floods circulate forever (a *broadcast storm*), so real networks run loop-prevention protocols. VLANs, which split one switch into several segments, come in Chapter 10.

A **Linux bridge** is a switch in software. Docker's `docker0` is one.

**Why NICo cares.** MAC addresses are flat, with no hierarchy, and flooding doesn't scale. So large fabrics keep Layer 2 segments small and route between them instead. NICo's FNN tenant model goes all the way: the docs say interfaces in the same VPC are *not* L2-adjacent, and cluster software "must not depend on broadcast discovery, ARP between nodes, or an L2-advertised service VIP". The BMC MAC address you'll put in `expected_machines.json` is a Layer 2 identity, and NICo uses it to recognise each machine.

**Analogy.** A switch is like a new mailroom clerk who doesn't know where anyone sits. Every time a letter arrives, the clerk notes which desk the *sender* handed it in from. If the clerk knows where the recipient sits, the letter goes straight there. If not, the clerk walks to every desk and shouts the name. Where it breaks down: names (MACs) give no clue about location, so this only works for one floor. You can't run a city's mail by shouting at every desk, which is why routing by IP (Layer 3) exists.

### Worked example: Trace a switch learning MAC addresses

**Step 1: Set the scene.**

A 4-port switch with an empty MAC table. Port 1: host A (`aa:aa:aa:aa:aa:01`), port 2: host B (`...:02`), port 3: host C (`...:03`), port 4: host D (`...:04`).

**Step 2: Frame 1: A sends to B.**

The switch learns `A → port 1`. B is unknown, so it **floods** the frame out of ports 2, 3 and 4. C and D see that the destination MAC isn't theirs and discard it.

Table: `{A: 1}`

**Step 3: Frame 2: B replies to A.**

The switch learns `B → port 2`. A is known, so the frame goes **only out of port 1**.

Table: `{A: 1, B: 2}`

**Step 4: Frame 3: C broadcasts to ff:ff:ff:ff:ff:ff.**

The switch learns `C → port 3`. Broadcasts are always flooded, so the frame goes out of ports 1, 2 and 4.

Table: `{A: 1, B: 2, C: 3}`. D still isn't in the table because D hasn't sent anything yet.

**Step 5: Look at the real thing on your machine.**

Your NIC's MAC address:
```bash
ip link show        # Linux: look for 'link/ether xx:xx:...'
ifconfig en0 | grep ether   # macOS
```
MACs your machine has recently talked to on the local segment:
```bash
ip neigh            # Linux
arp -a              # macOS
```
On Linux with Docker running, `bridge fdb show br docker0` shows the software switch's own MAC table.

### Your turn: finish it

Continuing the worked example (table `{A: 1, B: 2, C: 3}`), D now sends a frame to C. Fill in what the switch does.

Learn:    D → port ___
Forward:  destination C is ___ (known/unknown), so send out port(s) ___
Table:    {A: 1, B: 2, C: 3, ___}

<details>
<summary>Answer</summary>

Learn: `D → port 4`. Forward: C is **known**, so the frame goes out of **port 3 only**. Table: `{A: 1, B: 2, C: 3, D: 4}`.

</details>

### Your turn: on your own

Write a small Python function `switch(frames)` that simulates a learning switch. `frames` is a list of `(in_port, src_mac, dst_mac)` tuples. The switch has ports 1–4. For each frame, print the list of ports it goes out of. Test it with the worked example's frames.

<details>
<summary>Hint 1</summary>

Keep a dict `table = {}` that maps MAC to port. Update it with the source MAC *before* you decide where the frame goes.

</details>

<details>
<summary>Hint 2</summary>

If `dst` is the broadcast address or isn't in `table`, the output is every port except `in_port`. Otherwise it's `[table[dst]]`.

</details>

<details>
<summary>Hint 3</summary>

Edge case: if the known port for `dst` equals `in_port`, a real switch drops the frame (filtering). Return an empty list.

</details>

<details>
<summary>Answer</summary>

```python
BCAST = "ff:ff:ff:ff:ff:ff"
PORTS = [1, 2, 3, 4]

def switch(frames):
    table = {}
    for in_port, src, dst in frames:
        table[src] = in_port                      # learn
        if dst == BCAST or dst not in table:
            out = [p for p in PORTS if p != in_port]  # flood
        elif table[dst] == in_port:
            out = []                              # filter
        else:
            out = [table[dst]]                    # forward
        print(f"{src} -> {dst}: out {out}")
    return table

A, B, C, D = (f"aa:aa:aa:aa:aa:0{i}" for i in range(1, 5))
print(switch([(1, A, B), (2, B, A), (3, C, BCAST), (4, D, C)]))
```
Outputs: `[2, 3, 4]`, `[1]`, `[1, 2, 4]`, `[3]`, then the final table `{A: 1, B: 2, C: 3, D: 4}`.

</details>

### Explain it

In your own words: Explain why a switch learns from the *source* MAC of each frame rather than the destination, and what would go wrong if it learned from the destination instead.

### Check

**1. Host A sends a broadcast frame on an 8-port switch where every host is already in the MAC table. Where does the frame go?**

A. Out of all 7 other ports
B. Only to the port of the host that will answer
C. Nowhere, because broadcasts are dropped
D. Back out of A's port only

<details>
<summary>Answer</summary>

**A.** Out of all 7 other ports

Broadcasts are always flooded within the segment, however full the table is. The table only helps with unicast frames to known MACs. The switch can't know which host will answer.

</details>

**2. What does a Layer 2 switch use to decide where to send a frame?**

A. The destination MAC address
B. The destination IP address
C. The TCP port number
D. The source IP address

<details>
<summary>Answer</summary>

**A.** The destination MAC address

A Layer 2 switch reads only the Ethernet header. IP addresses are Layer 3 and are used by routers, and ports are Layer 4. A common misconception is that switches route by IP. Plain switches don't.

</details>

**3. The NICo docs say two instance interfaces allocated from the same VPC prefix are *not* L2-adjacent. In one sentence, what can't they do as a result?**

<details>
<summary>Answer</summary>

They can't reach each other directly by MAC on a shared segment. Broadcasts and ARP from one never reach the other, so all their traffic has to be routed.

L2-adjacent means "in the same broadcast domain". If they aren't, MAC-based discovery (ARP, broadcast service discovery) fails, which is why the docs tell you to choose cluster software that works over routed connectivity.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="ip-networking-fundamentals"></a>
## 4. IP networking fundamentals

*Builds on: Layer 2 Ethernet networking (ch. 3), IP addressing basics (ch. 3)*

### Before you read

- Your laptop is 192.168.1.20/24. It sends a packet to 192.168.1.50 and another to 8.8.8.8. Which of the two goes through your router?
- When a packet passes through a router, which addresses change: the IP addresses, the MAC addresses, or both?

<details>
<summary>Answers</summary>

- **Your laptop is 192.168.1.20/24. It sends a packet to 192.168.1.50 and another to 8.8.8.8. Which of the two goes through your router?** Only the one to 8.8.8.8. 192.168.1.50 is in the same subnet, so it's delivered directly over Layer 2. 8.8.8.8 is outside it, so the packet goes to the default gateway.
- **When a packet passes through a router, which addresses change: the IP addresses, the MAC addresses, or both?** The MAC addresses. The router builds a new Ethernet frame for the next hop. The source and destination IPs stay the same end to end (unless NAT is involved).

</details>

### Explanation

Lesson 2 gave machines IP addresses and Lesson 3 moved frames within one segment. This lesson joins them.

**Packets inside frames.** An IP **packet** (Layer 3) holds the source and destination IPs and the data. To cross a cable it's wrapped in an Ethernet **frame** (Layer 2). The frame gets the packet to the next device. The IP header gets it to the final destination.

**A subnet** is a group of addresses that share a network prefix, such as `192.168.1.0/24`. They usually sit on one L2 segment, so hosts in the subnet reach each other directly.

**The sending host's decision**, made for every packet:
1. Is the destination inside my subnet? (Apply my prefix length and compare.)
2. **Yes**: find the destination's MAC with **ARP** (Address Resolution Protocol: a broadcast asking "who has 192.168.1.50?", answered by the owner's unicast reply), then send the frame straight to it.
3. **No**: send it to my **default gateway**, the router's IP on my subnet. ARP finds the *gateway's* MAC. The frame is addressed to the gateway, but the packet's destination IP is still the far host.

**Routers** have interfaces on several subnets and a **routing table** of `prefix → next hop or interface` entries. For each packet a router:
- picks the matching route with the **longest prefix** (the most specific one wins; `0.0.0.0/0`, the **default route**, matches everything),
- decrements the packet's **TTL** (time to live), discarding it at 0 so that loops can't run forever,
- builds a fresh frame for the next hop.

Routes are configured statically or learned from routing protocols such as BGP (Chapter 9). Any Linux box can act as a router once `net.ipv4.ip_forward=1` is set. NICo's Quick Start requires that setting on every Kubernetes node, because pod traffic gets routed through the node.

**Tools:** `ping` (sends ICMP echo to test reachability), `traceroute` (lists every router hop), `ip route` (shows the routing table).

**In NICo:** the admin network config needs a `gateway` whenever an IPv4 prefix is present. In FNN VPCs each instance interface sits on its own tiny subnet with its DPU acting as the gateway, so instance-to-instance traffic is **routed** even within one VPC. The docs warn not to depend on ARP between nodes.

**Analogy.** Sending a packet is like posting a letter. If it's for a neighbour on your street (your subnet), you walk it over yourself. Otherwise you drop it at the local post office (the gateway), which looks only at the destination city, passes it to the next sorting office, and so on. Where it breaks down: at each post office the letter (IP packet) is put into a brand-new outer envelope (Ethernet frame) addressed only to the next office. Real mail keeps one envelope all the way.

### Worked example: Read your machine's routing decisions

**Step 1: Show the routing table.**

Linux:
```bash
ip route
```
Typical output:
```
default via 192.168.1.1 dev wlp2s0 proto dhcp metric 600
192.168.1.0/24 dev wlp2s0 proto kernel scope link src 192.168.1.23
```
Line 2 says "my own subnet is directly attached, no gateway needed". Line 1 is the default route: "everything else goes via the router at 192.168.1.1".

macOS: `netstat -rn -f inet`.

**Step 2: Ask the kernel how it would reach a remote IP.**

```bash
ip route get 1.1.1.1
# 1.1.1.1 via 192.168.1.1 dev wlp2s0 src 192.168.1.23
```
The word `via` means it goes through a gateway. On macOS: `route -n get 1.1.1.1` and look at the `gateway:` line.

**Step 3: Compare with a local IP.**

```bash
ip route get 192.168.1.1
# 192.168.1.1 dev wlp2s0 src 192.168.1.23
```
There's no `via`, so this address is reached directly on the segment. (Use your own gateway's address.)

**Step 4: See the ARP result for the gateway.**

```bash
ping -c 1 192.168.1.1 >/dev/null; ip neigh     # macOS: arp -a
```
You'll see `192.168.1.1 lladdr xx:xx:... REACHABLE`. That's the MAC your laptop puts on *every* frame bound for the internet.

**Step 5: Count the routers on the way out.**

```bash
traceroute -n 1.1.1.1      # Linux may need: sudo apt install traceroute
```
Each line is one router hop. The first is your gateway.

### Your turn: finish it

Finish this Python function that decides whether a host delivers a packet directly or sends it to its gateway.

import ipaddress

def next_hop(my_iface: str, gateway: str, dst: str) -> str:
    iface = ipaddress.ip_interface(my_iface)       # e.g. "192.168.1.20/24"
    if ipaddress.ip_address(dst) ___ iface.___:
        return f"direct: ARP for {dst}"
    return f"via gateway: ARP for {gateway}"

print(next_hop("192.168.1.20/24", "192.168.1.1", "192.168.1.50"))
print(next_hop("192.168.1.20/24", "192.168.1.1", "8.8.8.8"))

<details>
<summary>Answer</summary>

```python
    if ipaddress.ip_address(dst) in iface.network:
```
The blanks are `in` and `network`. The first call prints `direct: ARP for 192.168.1.50` and the second prints `via gateway: ARP for 192.168.1.1`.

</details>

### Your turn: on your own

A router has this table:
```
10.0.0.0/8       via 172.16.0.1  (A)
10.180.0.0/16    via 172.16.0.2  (B)
10.180.126.0/24  via 172.16.0.3  (C)
0.0.0.0/0        via 172.16.0.254 (D)
```
Which next hop does it pick for (1) 10.180.126.170, (2) 10.180.9.9, (3) 10.9.9.9, (4) 192.0.2.10? Then check your answers with Python.

<details>
<summary>Hint 1</summary>

Find every route whose prefix contains the address, then pick the one with the largest /number.

</details>

<details>
<summary>Hint 2</summary>

10.180.126.170 is inside all four prefixes. The /24 is the most specific.

</details>

<details>
<summary>Hint 3</summary>

In Python: `[n for n in nets if ip in n]`, then `max(..., key=lambda n: n.prefixlen)`.

</details>

<details>
<summary>Answer</summary>

(1) C, (2) B, (3) A, (4) D.
```python
import ipaddress as ia
routes = {"10.0.0.0/8": "A", "10.180.0.0/16": "B", "10.180.126.0/24": "C", "0.0.0.0/0": "D"}
for d in ["10.180.126.170", "10.180.9.9", "10.9.9.9", "192.0.2.10"]:
    ip = ia.ip_address(d)
    best = max((ia.ip_network(p) for p in routes if ip in ia.ip_network(p)), key=lambda n: n.prefixlen)
    print(d, "->", routes[str(best)])
```

</details>

### Explain it

In your own words: When your laptop sends a packet to 8.8.8.8, the Ethernet frame is addressed to your router's MAC, but the IP header says 8.8.8.8. Explain why both addresses are needed and what each one is for.

### Check

**1. A packet crosses three routers from host X to host Y. Which statement is true?**

A. Source and destination IPs stay the same; the frame's MAC addresses are rewritten at each hop
B. Source and destination MACs stay the same; the IPs are rewritten at each hop
C. Both are rewritten at each hop
D. Neither changes

<details>
<summary>Answer</summary>

**A.** Source and destination IPs stay the same; the frame's MAC addresses are rewritten at each hop

MAC addresses only mean something on one segment, so every router builds a new frame for the next link. IPs identify the endpoints end to end. NAT is the exception, and it isn't happening here.

</details>

**2. Why does NICo's Quick Start require `net.ipv4.ip_forward=1` on every Kubernetes node?**

A. So the node can route packets between interfaces, for example to and from pods, instead of dropping packets not addressed to itself
B. So the node can get an IP address by DHCP
C. So the node's MAC address becomes forwardable
D. So the node can resolve DNS names

<details>
<summary>Answer</summary>

**A.** So the node can route packets between interfaces, for example to and from pods, instead of dropping packets not addressed to itself

`ip_forward` turns a Linux host into a router. Without it, packets that arrive for some other IP (such as a pod's) are discarded. DHCP, MACs and DNS are unrelated to this setting.

</details>

**3. In a NICo FNN VPC, two instance interfaces got addresses from the same VPC prefix. Will one instance ARP for the other's MAC directly?**

A. No. Each interface is on its own point-to-point subnet with the DPU as gateway, so traffic is routed through the DPU
B. Yes, because sharing a prefix means sharing a segment
C. Yes, but only for broadcast traffic
D. Only if the MTU is 9000

<details>
<summary>Answer</summary>

**A.** No. Each interface is on its own point-to-point subnet with the DPU as gateway, so traffic is routed through the DPU

The docs say allocating from the same VPC prefix "does not make them L2-adjacent". Each interface's /31 links it to its DPU gateway, and the host ARPs only for that gateway. Thinking "same prefix means same segment" is exactly the misconception the docs warn about.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="cidr-prefixes-and-31-point-to-point-subnets"></a>
## 5. CIDR prefixes and /31 point-to-point subnets

*Builds on: IP networking fundamentals (ch. 3)*

### Before you read

- How many IPv4 addresses are in a /24? And in a /31?
- Guess: why would a network engineer ever want a subnet with only two addresses?

<details>
<summary>Answers</summary>

- **How many IPv4 addresses are in a /24? And in a /31?** A /24 has 2^(32−24) = 256 addresses. A /31 has 2^1 = 2.
- **Guess: why would a network engineer ever want a subnet with only two addresses?** For a point-to-point link between exactly two devices, such as a host and its DPU or a server and a switch. Two ends need only two addresses, so nothing is wasted.

</details>

### Explanation

**CIDR** (Classless Inter-Domain Routing) notation writes a block of addresses as `address/prefix-length`. The prefix length `n` is the number of fixed network bits. The remaining `32 − n` bits number the hosts, so the block holds **2^(32−n) addresses**.

| Prefix | Addresses | | Prefix | Addresses |
|---|---|---|---|---|
| /24 | 256 | | /28 | 16 |
| /25 | 128 | | /29 | 8 |
| /26 | 64 | | /30 | 4 |
| /27 | 32 | | /31 | 2 |
| | | | /32 | 1 |

Each step of one bit halves or doubles the size. The same idea is sometimes written as a **netmask**: /24 is `255.255.255.0`.

**Alignment.** A block has to start at a multiple of its size. `10.0.0.16/28` is valid (16 is a multiple of 16), but `10.0.0.20/28` isn't a proper network: it has "host bits set".

**Reserved addresses.** In a normal subnet the first address is the **network address** and the last is the **broadcast address**, so usable hosts = 2^(32−n) − 2. A /24 has 254 usable hosts, a /30 has 2. One usable address normally goes to the gateway too. The NICo admin network pool must cover "one usable IP per managed server, plus any required network and broadcast addresses".

**/31, point-to-point.** A link with exactly two ends has no need for broadcast, so RFC 3021 lets *both* addresses in a /31 be used. That halves the cost of every link compared with a /30. NICo leans on this heavily: each control-plane node gets a /31 between its host OS and DPU, each tenant interface gets its own /31 to its DPU gateway, and the docs state "the minimum individual prefix size is /31".

**/32, a single host.** A /32 names exactly one address. It's used for **loopback addresses**: a stable identity on a router or DPU that isn't tied to any physical port. Routes to a /32 are host routes. In NICo, "DPUs advertise /32 loopbacks for VXLAN tunnel endpoints", and there's one per DPU from the DPU loopback pool.

**Sizing.** To size a pool, count the addresses you need and round up to the next power of two. The NICo docs give one formula, `(servers + DPUs) * 2 + 2`. With 10 servers and 10 DPUs that's 42 addresses, which needs a /26 (64), because a /27 (32) is too small.

**Analogy.** CIDR is like selling land along a numbered street in lots whose size must be a power of two and which must start on a matching boundary: 16-plot lots start at plot 0, 16, 32 and so on. A /31 is a semi-detached pair with no shared driveway to set aside, and a /32 is one plot. Where it breaks down: real land can be sold in any size at any boundary. IP blocks can't, because routers match them using fixed bit masks.

### Worked example: Size and carve a NICo-style address plan

**Step 1: Count what you need.**

Say you have 8 servers, each with 1 DPU (8 DPUs). The first prefix in the NICo network prerequisites is sized with `(servers + DPUs) * 2 + 2` = (8 + 8) × 2 + 2 = **34 addresses**.

**Step 2: Round up to a power of two.**

A /27 gives 32, which is too small. A /26 gives 64, which fits. Check with Python:
```bash
python3 -c "import math; n=34; print('/%d' % (32 - math.ceil(math.log2(n))))"
# /26
```

**Step 3: Pick an aligned block and check its range.**

```bash
python3 - <<'EOF'
import ipaddress
net = ipaddress.ip_network("10.50.0.64/26")
print(net.network_address, "-", net.broadcast_address, net.num_addresses)
EOF
# 10.50.0.64 - 10.50.0.127 64
```
64 is a multiple of 64, so the block is aligned. Try `ip_network("10.50.0.70/26")` and you'll get `ValueError: ... has host bits set`.

**Step 4: Carve it into /31 point-to-point links.**

```bash
python3 - <<'EOF'
import ipaddress
links = list(ipaddress.ip_network("10.50.0.64/26").subnets(new_prefix=31))
print(len(links), "links")
for l in links[:3]:
    a, b = list(l)          # both addresses are usable in a /31
    print(l, "host side:", a, " DPU side:", b)
EOF
```
The output starts with `32 links`, then `10.50.0.64/31 host side: 10.50.0.64  DPU side: 10.50.0.65`, and so on.

**Step 5: Give each DPU a /32 loopback.**

```bash
python3 -c "import ipaddress as i; print([str(n) for n in list(i.ip_network('10.60.0.0/29').subnets(new_prefix=32))])"
```
That's 8 single-host /32s, `10.60.0.0/32` to `10.60.0.7/32`, one per DPU, like NICo's DPU loopback pool.

### Your turn: finish it

Split `192.168.100.0/29` into point-to-point links and print each link's two addresses.

import ipaddress

block = ipaddress.ip_network("192.168.100.0/29")
for link in block.subnets(new_prefix=___):
    a, b = list(link)
    print(link, a, b)
# How many lines will this print? ___

<details>
<summary>Answer</summary>

`new_prefix=31`. A /29 has 8 addresses, so it holds 8 / 2 = **4** /31 links: `.0/31` (.0, .1), `.2/31` (.2, .3), `.4/31` (.4, .5), `.6/31` (.6, .7).

</details>

### Your turn: on your own

The NICo docs say a host with one DPU, using the PF and one VF, uses two /31 subnets per tenant network (one per interface). You have 20 such hosts and one tenant network. What is the smallest single CIDR block that holds the whole tenant pool? Prove it with Python by carving the block into /31s and counting them.

<details>
<summary>Hint 1</summary>

Start with the number of /31s: hosts × interfaces per host.

</details>

<details>
<summary>Hint 2</summary>

Every /31 is 2 addresses. Multiply, then round up to the next power of two.

</details>

<details>
<summary>Hint 3</summary>

40 links × 2 = 80 addresses. A /26 (64) is too small.

</details>

<details>
<summary>Answer</summary>

20 hosts × 2 interfaces = 40 /31s = 80 addresses, which rounds up to 128, a **/25**.
```python
import ipaddress
print(len(list(ipaddress.ip_network("10.70.0.0/25").subnets(new_prefix=31))))  # 64 >= 40
print(len(list(ipaddress.ip_network("10.70.0.0/26").subnets(new_prefix=31))))  # 32 < 40, too small
```
A second tenant network needs its own pool of the same size, as the docs say: "provide separate pools, each sized for all servers".

</details>

### Explain it

In your own words: A normal /30 point-to-point link wastes half its addresses. Explain why a /31 can safely use both of its addresses, and why that matters when NICo hands out a link for every tenant interface on every host.

### Check

**1. Which addresses are usable in `10.0.0.8/31`?**

A. 10.0.0.8 and 10.0.0.9
B. Only 10.0.0.9
C. None; network and broadcast use both
D. 10.0.0.8, 10.0.0.9 and 10.0.0.10

<details>
<summary>Answer</summary>

**A.** 10.0.0.8 and 10.0.0.9

RFC 3021 treats both /31 addresses as usable because a point-to-point link needs no network or broadcast address. Applying the usual "minus 2" rule to a /31 is the classic mistake, and a /31 can't contain a third address.

</details>

**2. NICo's docs say DPUs advertise `/32` loopbacks. What does a /32 represent?**

A. A single host address, a stable identity not tied to one physical link
B. A 32-address pool
C. A point-to-point link
D. The whole IPv4 address space

<details>
<summary>Answer</summary>

**A.** A single host address, a stable identity not tied to one physical link

/32 means all 32 bits are fixed, which leaves exactly one address. "32 addresses" mixes up the prefix length with the size: that would be a /27. A point-to-point link is a /31, and the whole space is /0.

</details>

**3. The docs suggest a /27 for the control-plane service IP pool. How many addresses is that, and is `10.1.1.40/27` a correctly aligned network?**

<details>
<summary>Answer</summary>

32 addresses. 10.1.1.40/27 is not aligned, because 40 isn't a multiple of 32. The aligned /27 containing .40 is 10.1.1.32/27 (.32–.63).

Size is 2^(32−27) = 32. A /27 must start at 0, 32, 64 and so on in the last octet. Python's `ip_network('10.1.1.40/27')` raises "has host bits set".

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md)

<a id="firewall-rules"></a>
## 6. Firewall rules

*Builds on: IP networking fundamentals (ch. 3)*

### Before you read

- A packet arrives and none of the firewall's rules match it. What happens?
- Guess: if a firewall allows outbound connections from your server but blocks all inbound traffic, can the server still get replies to its own requests?

<details>
<summary>Answers</summary>

- **A packet arrives and none of the firewall's rules match it. What happens?** The chain's default policy decides. A secure firewall's default is to drop (default deny), so anything not explicitly allowed is blocked.
- **Guess: if a firewall allows outbound connections from your server but blocks all inbound traffic, can the server still get replies to its own requests?** Yes, with a stateful firewall. It tracks connections and lets reply packets of established connections back in.

</details>

### Explanation

A **firewall** inspects packets and applies **rules** that allow or deny them. It can run on the host itself (Linux's **nftables** or the older **iptables**) or as a device in the network.

**Ports and protocols.** On top of IP, most traffic uses **TCP** (reliable connections) or **UDP** (single datagrams). Both carry a 16-bit **port** number that says which program should receive the data. You met ports in the HTTP lesson. Common ones:

| Port | Service |
|---|---|
| TCP 22 | SSH |
| UDP/TCP 53 | DNS |
| UDP 67/68 | DHCP server/client |
| TCP 80 / 443 | HTTP / HTTPS |
| TCP 6443 | Kubernetes API server (default) |
| TCP 10250 | kubelet |

**ICMP** (used by ping) has no ports.

**A rule** matches on some combination of these fields and gives an **action**:
- direction or hook: inbound (`input`), outbound (`output`), or passing through (`forward`)
- source and/or destination address, often written as a CIDR
- protocol and destination port
- action: **accept**, **drop** (silently discard, so the sender waits until it times out), or **reject** (discard and send back an error, so the sender fails at once)

**Order and defaults.** In nftables and iptables, rules in a chain are checked top to bottom, and the **first match wins**. Packets that match nothing get the chain's **policy**. Good practice is **default deny**: set the policy to drop and add narrow accept rules. Watch out: cloud security groups (Chapter 38) often work differently, as an unordered set of allow rules.

**Stateful filtering.** **Connection tracking** remembers flows, so one rule (`ct state established,related accept`) lets in the replies to connections you started. Without it you'd need a matching rule for every return path.

**In NICo.** The network prerequisites recommend exactly this posture for site controllers: "Allow K8s control-plane and node ports per chosen CNI, plus SSH from a secure management network. Block everything else by default." NICo also applies the idea on tenants' behalf. The `deny_prefixes` setting in `siteConfig` lists "CIDRs instances must not reach (OOB, control plane, management)", so tenant machines can't touch the BMCs or the control plane.

**Analogy.** A firewall is like a building's security desk with a printed list of rules: "Couriers to the loading dock: allowed. Visitors from Acme to floor 3: allowed. Everyone else: turned away." The guard reads the list top to bottom and acts on the first line that fits. A stateful guard also remembers who left to fetch lunch and lets them back in. Where it breaks down: the guard only checks the label on the outside (addresses, ports, protocol). A firewall rule doesn't judge whether the content is malicious, so a permitted port can still carry an attack.

### Worked example: Write and test a default-deny ruleset for a site-controller-like host

**Step 1: State the policy in plain words.**

Management network: `10.10.0.0/24`. Cluster nodes: `10.20.0.0/24`.
1. Allow replies to connections we started.
2. Allow loopback traffic.
3. Allow SSH (TCP 22) **only** from the management network.
4. Allow the Kubernetes API (TCP 6443) from cluster nodes.
5. Drop everything else.

**Step 2: Translate it to nftables.**

Save as `fw.nft`:
```
table inet demo {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif "lo" accept
    ip saddr 10.10.0.0/24 tcp dport 22 accept
    ip saddr 10.20.0.0/24 tcp dport 6443 accept
  }
}
```
`policy drop` is the default deny. Each line is one rule, checked in order.

**Step 3: Load it safely in a container (not on your laptop).**

Experimenting on your own host's firewall can cut off your network, so use a throwaway container:
```bash
docker run --rm -it --cap-add NET_ADMIN -v "$PWD/fw.nft:/fw.nft" alpine:3.20 sh -c \
  'apk add -q nftables && nft -f /fw.nft && nft list ruleset'
```
`--cap-add NET_ADMIN` lets the container change its *own* network namespace only. Your host is untouched.

**Step 4: Predict the verdict for sample packets.**

| Packet | Verdict | Why |
|---|---|---|
| TCP 10.10.0.5 → port 22 | accept | rule 3 |
| TCP 10.99.0.5 → port 22 | drop | wrong source, falls to the policy |
| TCP 10.20.0.7 → port 6443 | accept | rule 4 |
| UDP 10.20.0.7 → port 53 | drop | no rule for it |
| Reply to our own `apt` download | accept | rule 1 (established) |

### Your turn: finish it

Add an nftables rule that allows HTTPS to the NICo REST ingress only from the client network `10.30.0.0/23`.

ip saddr ___ tcp dport ___ accept

<details>
<summary>Answer</summary>

```
    ip saddr 10.30.0.0/23 tcp dport 443 accept
```
A /23 covers 512 addresses, 10.30.0.0–10.30.1.255. HTTPS is TCP 443.

</details>

### Your turn: on your own

A colleague wrote this chain, and nobody can reach the web server on port 443. Explain why, then rewrite it so that HTTPS from anywhere and SSH from 10.10.0.0/24 work and everything else is dropped.
```
chain input {
  type filter hook input priority 0; policy accept;
  ip saddr 0.0.0.0/0 drop
  tcp dport 443 accept
  ip saddr 10.10.0.0/24 tcp dport 22 accept
}
```

<details>
<summary>Hint 1</summary>

Rules are evaluated top to bottom, and the first match wins. Which rule does a port-443 packet match first?

</details>

<details>
<summary>Hint 2</summary>

`0.0.0.0/0` matches every IPv4 source. Putting a drop-everything rule as an explicit line also hides the fact that the policy is `accept`.

</details>

<details>
<summary>Hint 3</summary>

Move the deny into `policy drop`, put the accepts in the body, and remember the established/related rule for return traffic.

</details>

<details>
<summary>Answer</summary>

The first rule, `ip saddr 0.0.0.0/0 drop`, matches every IPv4 packet, so the accept rules below it are never reached. (IPv6 packets would fall through to `policy accept`, which is a second bug.) Fixed version:
```
chain input {
  type filter hook input priority 0; policy drop;
  ct state established,related accept
  iif "lo" accept
  tcp dport 443 accept
  ip saddr 10.10.0.0/24 tcp dport 22 accept
}
```

</details>

### Explain it

In your own words: Explain why "default deny plus specific allows" is safer than "default allow plus specific denies", especially on a NICo control-plane host that serves DHCP, DNS, PXE and APIs to many networks.

### Check

**1. Your curl to a server hangs for 30 seconds and then times out, rather than failing at once with "connection refused". What is the most likely firewall action?**

A. A drop rule (or drop policy) is discarding the packets silently
B. A reject rule is sending back an error
C. An accept rule matched
D. The server returned HTTP 403

<details>
<summary>Answer</summary>

**A.** A drop rule (or drop policy) is discarding the packets silently

Drop gives the client no answer, so it waits until it times out. Reject sends back an error (TCP reset or ICMP), which fails at once with "connection refused". An HTTP 403 means you did reach the server.

</details>

**2. Why do default-deny rulesets usually start with `ct state established,related accept`?**

A. So replies to connections the host started (and to allowed inbound connections) get back in without a rule for every return path
B. So that every new inbound connection is allowed
C. To speed up DNS lookups
D. Because nftables requires it syntactically

<details>
<summary>Answer</summary>

**A.** So replies to connections the host started (and to allowed inbound connections) get back in without a rule for every return path

Connection tracking recognises packets that belong to existing flows. It doesn't allow *new* inbound connections, which is the tempting misreading, and nftables doesn't require it syntactically.

</details>

**3. What does NICo's `deny_prefixes` site setting describe, in terms of this lesson?**

<details>
<summary>Answer</summary>

A list of destination CIDRs that tenant instances must not reach, such as the OOB/BMC, control-plane and management networks. In effect, deny rules keyed on destination address.

The Quick Start describes `deny_prefixes` as "CIDRs instances must not reach (OOB, control plane, management)". It's the same allow/deny idea, applied to tenant traffic by destination prefix.

</details>

**Sources:** [getting-started/prerequisites/network.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/network.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="build-task"></a>
## Build task: Mini site-controller network lab: a token-protected API on a subnet you design, behind a firewall

**Goal:** Build a small Docker network on a subnet you choose with static IPs. On it, run a Python HTTP API that needs a bearer token, plus two client containers. Explore the Layer 2 and Layer 3 behaviour between them, then add a default-deny firewall so that only the "management" client can reach the API port.

**Why it matters for NICo:** This is NICo's control-plane pattern in miniature. NICo services such as nico-api, DHCP and PXE sit on planned IP addresses, clients call REST APIs with `Authorization: Bearer` tokens, and the docs recommend allowing only the needed ports from trusted networks and blocking everything else. Doing it once by hand makes the address pools, VIPs, status codes and firewall guidance in the NICo deployment docs concrete.

**You need:**

- Docker (Docker Desktop on macOS, or Docker Engine on Linux). Podman 4+ also works: replace `docker` with `podman`
- Python 3 on your laptop, for the address-planning script
- About 100 MB of disk for an Alpine-based image
- A free private subnet. The steps use 172.28.5.0/24; pick another if it clashes with your LAN or VPN

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Plan the addresses</summary>

Create a working directory and a planning script:
```bash
mkdir -p ~/nicolab && cd ~/nicolab
cat > plan.py <<'EOF'
import ipaddress as ia
lab = ia.ip_network("172.28.5.0/24")
print("lab:", lab, "size", lab.num_addresses, "usable", lab.num_addresses - 2)
plan = {"gateway": "172.28.5.1", "api": "172.28.5.10", "mgmt": "172.28.5.20", "other": "172.28.5.30"}
for name, ip in plan.items():
    assert ia.ip_address(ip) in lab, name
    print(f"{name:8} {ip}")
# Paper exercise: carve point-to-point links and loopbacks like NICo does
links = list(ia.ip_network("10.99.0.0/29").subnets(new_prefix=31))
print("p2p links:", [f"{l} ({l[0]} <-> {l[1]})" for l in links])
print("loopbacks:", [str(n) for n in ia.ip_network("10.99.1.0/30").subnets(new_prefix=32)])
EOF
python3 plan.py
```
You should see 4 /31 links and 4 /32 loopbacks.

</details>

<details>
<summary>Step 2: Write the token-protected API</summary>

```bash
cat > api.py <<'EOF'
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

TOKEN = "lab-token"
MACHINES = [{"id": "m1", "bmc_mac": "C4:5A:B1:C8:38:0D", "state": "Ready"}]

class Handler(BaseHTTPRequestHandler):
    def send_json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/v1/health":
            return self.send_json(200, {"status": "ok"})
        if self.path == "/v1/machines":
            if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                return self.send_json(401, {"error": "missing or invalid token"})
            return self.send_json(200, {"machines": MACHINES})
        self.send_json(404, {"error": "not found"})

HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
EOF

cat > Dockerfile <<'EOF'
FROM alpine:3.20
RUN apk add --no-cache python3 curl nftables iproute2 iputils
WORKDIR /app
COPY api.py /app/api.py
EOF
docker build -t nicolab .
```

</details>

<details>
<summary>Step 3: Create the subnet and start the containers on static IPs</summary>

```bash
docker network create --subnet 172.28.5.0/24 --gateway 172.28.5.1 nicolab
docker run -d --name api   --network nicolab --ip 172.28.5.10 --cap-add NET_ADMIN nicolab python3 -u /app/api.py
docker run -d --name mgmt  --network nicolab --ip 172.28.5.20 nicolab sleep infinity
docker run -d --name other --network nicolab --ip 172.28.5.30 nicolab sleep infinity
docker ps --format '{{.Names}}\t{{.Status}}'
```
The Docker network is a Linux bridge, which is a software Layer 2 switch, and the `--gateway` is the router address for this subnet.

</details>

<details>
<summary>Step 4: Observe Layer 2 and Layer 3 from inside a client</summary>

```bash
docker exec mgmt ip -4 addr show eth0      # 172.28.5.20/24
docker exec mgmt ip route                  # default via 172.28.5.1; 172.28.5.0/24 is directly attached
docker exec mgmt ip route get 172.28.5.10  # no 'via': same subnet, delivered directly
docker exec mgmt ip route get 1.1.1.1      # 'via 172.28.5.1': goes to the gateway
docker exec mgmt ping -c 2 172.28.5.10
docker exec mgmt ip neigh                  # api's MAC, learned via ARP
docker exec api ip link show eth0          # compare: the same MAC on the api side
```
Write down which addresses are Layer 2 (MAC) and which are Layer 3 (IP).

</details>

<details>
<summary>Step 5: Exercise the HTTP API and its status codes</summary>

```bash
API=http://172.28.5.10:8080
docker exec mgmt curl -s -i $API/v1/health
docker exec mgmt curl -s -o /dev/null -w '%{http_code}\n' $API/v1/machines                                    # 401
docker exec mgmt curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer lab-token' $API/v1/machines  # 200
docker exec mgmt curl -s -o /dev/null -w '%{http_code}\n' $API/v1/nope                                         # 404
docker exec other curl -s -o /dev/null -w '%{http_code}\n' $API/v1/health                                      # 200 (no firewall yet)
docker logs api | tail -5
```

</details>

<details>
<summary>Step 6: Add a default-deny firewall on the API container</summary>

Allow ICMP from anyone (so ping still works) and TCP 8080 only from the mgmt client. Drop the rest.
```bash
cat > fw.nft <<'EOF'
table inet lab {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif "lo" accept
    ip protocol icmp accept
    ip saddr 172.28.5.20 tcp dport 8080 accept
  }
}
EOF
docker exec -i api nft -f - < fw.nft
docker exec api nft list ruleset
```
The container's ruleset now matches your file, and your laptop's own firewall is untouched.

</details>

**Check it works:** Run:
```bash
API=http://172.28.5.10:8080
docker exec mgmt  curl -s -o /dev/null -w 'mgmt+token: %{http_code}\n' -H 'Authorization: Bearer lab-token' $API/v1/machines
docker exec mgmt  curl -s -o /dev/null -w 'mgmt no token: %{http_code}\n' $API/v1/machines
docker exec other ping -c 1 -W 2 172.28.5.10 >/dev/null && echo 'other ping: ok'
docker exec other curl -s -m 3 -o /dev/null -w 'other http: %{http_code}\n' $API/v1/health; echo "other curl exit=$?"
```
You're done when you see `mgmt+token: 200`, `mgmt no token: 401`, `other ping: ok`, `other http: 000` and `other curl exit=28`. Exit code 28 is a timeout, which shows the packets were silently dropped by the firewall rather than refused. ICMP still gets through, so the block is specific to TCP port 8080.

<details>
<summary>If you get stuck</summary>

- `Error response from daemon: Pool overlaps with other one on this address space`: another Docker network or your LAN/VPN already uses 172.28.5.0/24. Pick another private /24 (such as 172.29.77.0/24) and update every IP in the steps and in plan.py.
- `nft: Operation not permitted`: the api container was started without `--cap-add NET_ADMIN`. Run `docker rm -f api` and start it again with the flag.
- `Could not process rule: No such file or directory` from nft: your kernel or VM lacks nf_tables. Add `iptables` to the Dockerfile and use `iptables -P INPUT DROP; iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT; iptables -A INPUT -i lo -j ACCEPT; iptables -A INPUT -p icmp -j ACCEPT; iptables -A INPUT -s 172.28.5.20 -p tcp --dport 8080 -j ACCEPT`.
- curl exit code 7 (connection refused) instead of 28: something sent back a reset. Either the API isn't running (`docker logs api`) or your rule uses reject instead of drop.
- mgmt is also blocked after you add the firewall: check the source address in the accept rule matches `docker exec mgmt ip -4 addr` exactly. Rules match on the packet's real source IP.
- Podman rootless: static `--ip` needs a user-defined network (`podman network create --subnet ...`). Netavark, the default in Podman 4+, supports it.

</details>

**Stretch goal:** Add routing between two subnets. (1) Create a second network and a router container attached to both, on fixed addresses:
```bash
docker network create --subnet 172.28.6.0/24 --gateway 172.28.6.1 nicolab2
docker run -d --name router --network nicolab --ip 172.28.5.254 --cap-add NET_ADMIN --sysctl net.ipv4.ip_forward=1 nicolab sleep infinity
docker network connect --ip 172.28.6.254 nicolab2 router
docker run -d --name far --network nicolab2 --ip 172.28.6.10 --cap-add NET_ADMIN nicolab sleep infinity
```
(2) Add routes in **both** directions. `far` needs a route to the api subnet, and `api` (the container that sends the replies, already started with NET_ADMIN) needs a route back to far's subnet. Without the return route, api's replies go to the Docker gateway 172.28.5.1, where Docker's inter-network isolation drops them.
```bash
docker exec far ip route add 172.28.5.0/24 via 172.28.6.254
docker exec api ip route add 172.28.6.0/24 via 172.28.5.254
```
(3) Extend the api firewall **before** testing, because the current ruleset drops far's TCP 8080 traffic: `docker exec api nft add rule inet lab input ip saddr 172.28.6.0/24 tcp dport 8080 accept` (a CIDR rule for the whole subnet). (4) Now check: `docker exec far traceroute -n -I 172.28.5.10` shows one router hop (172.28.6.254) before api. Use `-I` (ICMP probes), because the firewall drops the default UDP probes. `docker exec far ip neigh` lists only the router's MAC, never api's. `docker exec far curl -s $API/v1/health` returns `{"status": "ok"}`, and `docker logs api | tail -1` shows far's real source IP, 172.28.6.10, because routing rewrote the MACs but not the IPs. Finally, explain why a host firewall like this one can't allow `/v1/health` while blocking `/v1/machines`: the URL path is inside the HTTP payload, which nftables rules on addresses, protocols and ports never look at.

## Review notes

The first draft had major issues and was rewritten using the review; the notes below are from reviewing the rewrite.

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (build task): `docker logs api | tail -5` (step 'Exercise the HTTP API') and `docker logs api | tail -1` (stretch) won't work as intended: Python's http.server writes its request log to stderr, and `docker logs` passes the container's stderr to the terminal's stderr, so the pipe to `tail` never sees those lines. The learner gets the whole log unfiltered, and `tail -1` won't isolate far's request line. *Fix:* Merge stderr into the pipe: `docker logs api 2>&1 | tail -5` and `docker logs api 2>&1 | tail -1`.

---

[← 02-software-linux-basics.md](02-software-linux-basics.md) · [04-state-machine-framework.md →](04-state-machine-framework.md)
