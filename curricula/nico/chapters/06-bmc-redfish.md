# Chapter 6: BMC & Redfish

*Part: Hardware & OOB Management · 6 concepts · [curriculum](../curriculum.md#chapter-6)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Chapter 5 covered what runs when a server powers on (UEFI) and how NICo's services fit together. This chapter goes down one level, to how NICo reaches a machine at all. NICo never logs in to a host OS to manage it. It talks to a small separate computer on every server and DPU, the **Baseboard Management Controller (BMC)**, and it uses one protocol for that: **Redfish**, a REST/JSON API over HTTPS.

You'll go from the hardware idea (what a BMC is and why it keeps working when the host is dead) to the protocol (Redfish requests, the resource tree, reset actions). Then come the messy parts: vendors don't implement Redfish the same way, so NICo detects the vendor and adjusts. Last, you'll meet the two Rust libraries NICo uses to talk Redfish: libredfish and nv-redfish.

This matters because almost everything NICo does to hardware starts with a Redfish call. Site Explorer discovers machines that way, DPU-host pairing compares serial numbers read from Redfish, provisioning uses Redfish resets and boot-order changes, and the Hardware Health service polls Redfish sensors. When ingestion gets stuck later in the course, the first thing to check is usually what the BMC's Redfish tree actually says.

You don't need a server. The lessons use a fake Redfish tree served by Python's built-in web server, and the build task has you write a small mock BMC plus a client that does what Site Explorer does, in miniature.

**By the end of this chapter you can:**

- Explain what a BMC is, why it works when the host OS is down, and how many BMCs a NICo managed host has
- Query a Redfish service with curl and jq, starting from the anonymous service root and following @odata.id links through Systems, Chassis and Managers
- Choose the right Redfish reset type for a situation and check the result by reading PowerState back
- Explain how NICo uses the service root's Vendor field and Oem sections to choose vendor-specific endpoints
- Describe what libredfish and nv-redfish each do in NICo and why typed code generation is replacing hand-written clients
- Build a mock BMC and a Redfish client that walks the tree, detects the vendor and power-cycles the fake host

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [Baseboard Management Controller (BMC)](#baseboard-management-controller)
2. [Redfish API](#redfish-api)
3. [Power control reset types](#power-control-reset-types)
4. [Redfish resource tree (Systems, Chassis, Managers)](#redfish-resource-tree)
5. [Redfish vendor detection and OEM extensions](#redfish-vendor-detection-and-oem-extensions)
6. [libredfish and nv-redfish](#libredfish-and-nv-redfish)
7. [Build task: Mini Site Explorer: a mock BMC and a Redfish client](#build-task)

<a id="baseboard-management-controller"></a>
## 1. Baseboard Management Controller (BMC)

*Builds on: IP networking fundamentals (ch. 3)*

### Before you read

- A server's OS has kernel-panicked and hung. Nobody is in the datacenter. How could someone still reboot that machine remotely?
- Guess: does a BlueField DPU plugged into a server use the server's BMC, or does it have its own?

<details>
<summary>Answers</summary>

- **A server's OS has kernel-panicked and hung. Nobody is in the datacenter. How could someone still reboot that machine remotely?** Through its BMC. The BMC is a separate small computer on the motherboard with its own network connection and power. It can press the virtual power and reset buttons even when the host OS is dead.
- **Guess: does a BlueField DPU plugged into a server use the server's BMC, or does it have its own?** It has its own. NICo treats a managed host as a host BMC plus one BMC per DPU, and talks to each one separately.

</details>

### Explanation

A **Baseboard Management Controller (BMC)** is a small, independent computer built into a server's motherboard (and into each BlueField DPU). It has its own processor, memory, firmware and network interface. It also runs on **standby power**, the trickle of power a plugged-in server gets even while it is "off". So the BMC is up whenever the power cord is connected, whatever the main CPU and OS are doing.

With that independence, a BMC can:
- power the host on, off or reset it
- read sensors (temperatures, fan speeds, power draw)
- report inventory (serial numbers, PCIe devices, firmware versions)
- change boot order and BIOS/UEFI settings
- update firmware
- provide a remote serial console (Serial-over-LAN)

This is called **out-of-band (OOB)** management: control traffic travels on a separate path from the host's normal data traffic. Vendors brand their BMCs: Dell iDRAC, HPE iLO, Lenovo XClarity.

**How NICo uses BMCs.** A NICo *managed host* has a BMC for the x86 or ARM host and another BMC for each DPU. When a BMC boots it sends a DHCP request on the OOB network. A DHCP relay forwards it to NICo's DHCP service, which hands the address information to NICo Core. Site Explorer then contacts the BMC at that address. It logs in with the factory default username and password you listed in `expected_machines.json` (keyed by BMC MAC address and chassis serial number), then changes those credentials to site-managed ones. Only machines listed in that manifest are ingested.

NICo also turns off in-band BMC access from inside the host, so a tenant's OS can't reconfigure its own BMC. It manages BMCs only over the OOB network, and only with Redfish (next lesson).

**Analogy.** A BMC is like a building's caretaker who lives in a small flat in the basement, with their own phone line and their own electricity meter. If the main office floor loses power or everyone has gone home, you can still phone the caretaker to flip breakers, read the thermostat or let a contractor in. Where it breaks down: a real caretaker can fix anything with their hands. A BMC can only do what its firmware exposes, and if the building's mains (AC power) is cut completely, the caretaker's flat goes dark too.

### Worked example: Read a BMC's identity the way NICo receives it

**Step 1: Create the expected machines manifest.**

NICo learns which BMCs to trust from `expected_machines.json`. Make a copy of the documented example:
```bash
mkdir -p ~/redfish-lab && cd ~/redfish-lab
cat > expected_machines.json <<'EOF'
{
  "expected_machines": [
    {
      "bmc_mac_address": "C4:5A:B1:C8:38:0D",
      "bmc_username": "root",
      "bmc_password": "default-password1",
      "chassis_serial_number": "SERIAL-1"
    },
    {
      "bmc_mac_address": "C4:5A:FF:FF:FF:FF",
      "bmc_username": "root",
      "bmc_password": "default-password2",
      "chassis_serial_number": "SERIAL-2"
    }
  ]
}
EOF
```

**Step 2: Pick out the fields that identify the BMC.**

```bash
jq -r '.expected_machines[] | "\(.bmc_mac_address)  serial=\(.chassis_serial_number)"' expected_machines.json
```
Output:
```
C4:5A:B1:C8:38:0D  serial=SERIAL-1
C4:5A:FF:FF:FF:FF  serial=SERIAL-2
```
The MAC belongs to the **BMC's** network interface, not to the host's data NICs. DHCP requests on the OOB network come from that MAC.

**Step 3: Trace what happens when that BMC powers up.**

1. The power cord goes in, and the BMC boots on standby power. The host can stay off.
2. The BMC sends DHCP from `C4:5A:B1:C8:38:0D`. The OOB switch relays it to NICo DHCP.
3. NICo Core records the address, and Site Explorer starts probing it over Redfish.
4. Site Explorer logs in as `root` / `default-password1`, checks that the chassis serial matches `SERIAL-1`, and later rotates the credentials.

**Step 4: Count the BMCs.**

If that chassis holds one host and one BlueField DPU, NICo talks to **two** BMCs: the host BMC and the DPU BMC. Each gets its own DHCP lease, its own Redfish sessions and its own health collectors.

### Your turn: finish it

Fill in the blank so the command prints only the BMC MAC addresses NICo will accept, one per line.

```text
jq -r '.expected_machines[].___' expected_machines.json
```

<details>
<summary>Answer</summary>

bmc_mac_address. The full command is `jq -r '.expected_machines[].bmc_mac_address' expected_machines.json` and it prints `C4:5A:B1:C8:38:0D` and `C4:5A:FF:FF:FF:FF`.

</details>

### Your turn: on your own

A managed host has one x86 host and two BlueField-3 DPUs. (a) How many BMCs does NICo's Hardware Health service collect from for this host? (b) The host OS is shut down but the power cords are plugged in. Which of those BMCs can NICo still reach?

<details>
<summary>Hint 1</summary>

Each DPU is managed like a small computer of its own.

</details>

<details>
<summary>Hint 2</summary>

The Redfish workflow docs say every BMC gets its own set of collectors: health, firmware and logs.

</details>

<details>
<summary>Hint 3</summary>

Count 1 host BMC + 2 DPU BMCs, then remember what powers a BMC.

</details>

<details>
<summary>Answer</summary>

(a) Three: one host BMC and one BMC per DPU, so three sets of collectors. (b) All three. BMCs run on standby power and don't depend on the host OS, so a shut-down host still has reachable BMCs as long as AC power is present.

</details>

### Explain it

In your own words: Why does NICo make security decisions from data it reads out-of-band through the BMC, instead of asking an agent running in the host OS?

### Check

**1. Why can a BMC still answer requests after the host OS has crashed?**

A. It runs on its own processor and firmware, powered by standby power
B. It is a high-priority process inside the host OS kernel
C. It caches the last host state and replays it until the OS recovers
D. It shares the host CPU but runs in a protected CPU mode

<details>
<summary>Answer</summary>

**A.** It runs on its own processor and firmware, powered by standby power

A BMC is a separate computer. Running it as a kernel process or in a protected CPU mode would still tie it to the host CPU and OS, which defeats the purpose of out-of-band management. It isn't a cache either: it reads live state.

</details>

**2. Which identifier in expected_machines.json does NICo use to recognize a BMC when it first appears on the network?**

A. The BMC MAC address
B. The host's data-NIC MAC address
C. The BMC's IP address
D. The DPU serial number

<details>
<summary>Answer</summary>

**A.** The BMC MAC address

The BMC's DHCP request comes from the BMC MAC, and the manifest is keyed by it. The BMC has no IP until NICo assigns one, so the manifest can't list one. The chassis serial is used to cross-check the match. DPU serials come into play later, during pairing.

</details>

**3. Short answer: what does NICo do to the factory default BMC password after discovery?**

<details>
<summary>Answer</summary>

It rotates it to a site-managed credential.

The factory defaults in expected_machines.json are only for the first login. After that NICo sets the site-wide host or DPU BMC credential that you configured beforehand.

</details>

**Sources:** [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md)

<a id="redfish-api"></a>
## 2. Redfish API

*Builds on: Baseboard Management Controller (BMC) (ch. 6), HTTP and web APIs (ch. 3)*

### Before you read

- If a BMC exposes a REST API, what URL path would you guess is the entry point that lists everything else?
- Should a client be able to read the service root without logging in? Why might that be useful?

<details>
<summary>Answers</summary>

- **If a BMC exposes a REST API, what URL path would you guess is the entry point that lists everything else?** `/redfish/v1`, the Redfish service root. Every other resource is reached by following links from it.
- **Should a client be able to read the service root without logging in? Why might that be useful?** Usually yes. Redfish lets the service root be read anonymously, so a client can find out what kind of BMC it's talking to (vendor, Redfish version) before choosing how to authenticate. NICo's Site Explorer does exactly this.

</details>

### Explanation

**Redfish** is a standard from the DMTF (an industry standards body) for managing hardware over HTTPS. It replaces older binary protocols with something you already know from Chapter 3: HTTP verbs, URLs and JSON bodies.

| Verb | Redfish use | Example |
|---|---|---|
| GET | read a resource | `GET /redfish/v1/Systems/{id}` gives serial number and power state |
| PATCH | change properties | `PATCH /redfish/v1/Systems/{id}/Bios/Settings` sets BIOS attributes for the next boot |
| POST | run an action or create something | `POST .../Actions/ComputerSystem.Reset` reboots the host |
| DELETE | remove | delete a BMC user account |

Everything starts at the **service root**, `/redfish/v1`. Its JSON contains links to the main collections (`Systems`, `Chassis`, `Managers`, `UpdateService`) and a `Vendor` field.

**Authentication.** Most resources need credentials. That can be HTTP Basic auth on each request, or a session created with `POST /redfish/v1/SessionService/Sessions`, which returns a token. NICo's Site Explorer works in this order:
1. **Anonymous** GET of `/redfish/v1`, to detect the vendor.
2. **Direct** login with the username and password from the Expected Machines manifest (factory defaults).
3. **Key** login after rotation: the credential is looked up by BMC MAC address.

**Why it matters for NICo.** NICo talks to host and DPU BMCs *only* through Redfish. A BMC must support these Redfish operations or the host can't be managed: power control, boot order, Secure Boot toggle, firmware inventory, firmware update, Serial-over-LAN, and IPv6. Site Explorer, the Hardware Health service and power and boot actions all come down to Redfish HTTP calls.

Two practical notes. Real BMCs often ship with self-signed TLS certificates, which is why lab commands often use `curl -k`. And a Redfish response is ordinary JSON, so `jq` is the most useful tool you'll have.

**Analogy.** Redfish is like a restaurant menu written to an industry standard. Every restaurant lists Starters, Mains and Drinks in the same places, so you can order without learning each kitchen. Where it breaks down: the standard only fixes the layout. Each restaurant still adds house specials (OEM extensions) and sometimes files a dish under a different heading. That's why NICo needs vendor-specific handling.

### Worked example: Serve and query a fake Redfish service root

**Step 1: Write a service root document.**

Python's built-in web server returns `index.html` for a directory, so a directory tree can stand in for read-only Redfish:
```bash
mkdir -p ~/redfish-lab/redfish/v1 && cd ~/redfish-lab
cat > redfish/v1/index.html <<'EOF'
{
  "@odata.id": "/redfish/v1",
  "Id": "RootService",
  "RedfishVersion": "1.15.0",
  "Vendor": "Dell",
  "Systems":  {"@odata.id": "/redfish/v1/Systems"},
  "Chassis":  {"@odata.id": "/redfish/v1/Chassis"},
  "Managers": {"@odata.id": "/redfish/v1/Managers"},
  "UpdateService": {"@odata.id": "/redfish/v1/UpdateService"}
}
EOF
```

**Step 2: Start the server.**

In the `~/redfish-lab` directory, in its own terminal:
```bash
python3 -m http.server 8000
```
Leave it running. Request logs appear in this terminal.

**Step 3: GET the service root.**

In a second terminal:
```bash
curl -sL http://127.0.0.1:8000/redfish/v1 | jq .
curl -sL http://127.0.0.1:8000/redfish/v1 | jq -r .Vendor
```
`-L` follows the server's redirect from `/redfish/v1` to `/redfish/v1/`. The second command prints `Dell`, the same field Site Explorer reads first.

**Step 4: Compare with a real BMC (reference only).**

Against real hardware the same steps look like this. Don't run them unless you have a BMC:
```bash
curl -sk https://BMC_IP/redfish/v1 | jq -r .Vendor          # anonymous probe
curl -sk -u root:PASSWORD https://BMC_IP/redfish/v1/Systems | jq .   # authenticated
```
Without `-u`, the second request normally returns HTTP 401.

### Your turn: finish it

Complete the command so it prints the path of the Managers collection from the fake service root.

```text
curl -sL http://127.0.0.1:8000/redfish/v1 | jq -r '.Managers."___"'
```

<details>
<summary>Answer</summary>

@odata.id. The full command is `curl -sL http://127.0.0.1:8000/redfish/v1 | jq -r '.Managers."@odata.id"'` and it prints `/redfish/v1/Managers`. The quotes are needed because `@` and `.` aren't allowed in a bare jq key.

</details>

### Your turn: on your own

Using only HTTP verbs and Redfish paths, write the request (method + path + body, if any) that would (1) read a system's serial number and power state, and (2) stage a BIOS change for the next reboot. Use `{id}` for the system ID.

<details>
<summary>Hint 1</summary>

Reading never needs a body. Which verb is that?

</details>

<details>
<summary>Hint 2</summary>

BIOS changes go to a settings sub-resource, not to the live Bios resource.

</details>

<details>
<summary>Hint 3</summary>

Look at the Bios rows in the lesson's verb table.

</details>

<details>
<summary>Answer</summary>

(1) `GET /redfish/v1/Systems/{id}`, which returns `SerialNumber` and `PowerState`. (2) `PATCH /redfish/v1/Systems/{id}/Bios/Settings` with a body like `{"Attributes": {...}}`. The change stays pending until the next reboot. (Some vendors use a different path for the settings resource, as you'll see in the vendor lesson.)

</details>

### Explain it

In your own words: Why does Site Explorer make an anonymous request before it tries any credentials, instead of logging in straight away?

### Check

**1. What is the Redfish service root path?**

A. /redfish/v1
B. /api/v1/redfish
C. /redfish/v1/Systems
D. /.well-known/redfish

<details>
<summary>Answer</summary>

**A.** /redfish/v1

`/redfish/v1` is the fixed entry point. `/redfish/v1/Systems` is one collection linked from it, not the root. The other paths aren't part of Redfish.

</details>

**2. Which list matches the order of authentication methods NICo's Site Explorer uses over a BMC's life?**

A. Anonymous, then Direct (factory defaults), then Key (lookup by BMC MAC after rotation)
B. Key first, then Direct if the key fails, never anonymous
C. Direct only; NICo stores the factory password permanently
D. Anonymous for all calls, because BMCs on the OOB network are trusted

<details>
<summary>Answer</summary>

**A.** Anonymous, then Direct (factory defaults), then Key (lookup by BMC MAC after rotation)

Anonymous access is only for the initial vendor probe. Factory defaults are used until rotation, then site-managed credentials are looked up by BMC MAC. NICo rotates credentials rather than keeping the defaults, and it doesn't treat the OOB network as trusted.

</details>

**3. Short answer: name three Redfish operations a chassis BMC must support for NICo to manage the host.**

<details>
<summary>Answer</summary>

Any three of: power control, boot order configuration, UEFI Secure Boot toggle, firmware inventory, firmware update, Serial-over-LAN, IPv6.

These are the BMC Redfish requirements in the hardware and OOB setup prerequisites.

</details>

**Sources:** [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md)

<a id="power-control-reset-types"></a>
## 3. Power control reset types

*Builds on: Redfish API (ch. 6)*

### Before you read

- What's the difference between asking an OS to restart and pressing the reset button?
- Is there anything a normal reboot doesn't reset, but unplugging the power cord does?

<details>
<summary>Answers</summary>

- **What's the difference between asking an OS to restart and pressing the reset button?** Asking lets the OS stop services and flush disks before rebooting (graceful). The button restarts immediately, with no cooperation from the OS (forced). A hung OS can only be fixed the forced way.
- **Is there anything a normal reboot doesn't reset, but unplugging the power cord does?** Yes. Anything running on standby power, including the BMC itself and some NIC and DPU state, keeps running through a normal reboot. Only an AC power cycle (cutting mains power) resets it.

</details>

### Explanation

Redfish power control is an **action**: you POST a JSON body to the system's reset target.
```http
POST /redfish/v1/Systems/{system_id}/Actions/ComputerSystem.Reset
Content-Type: application/json

{"ResetType": "GracefulRestart"}
```
NICo's power control supports these reset types, from gentlest to most drastic:

| ResetType | What happens |
|---|---|
| `On` | Power on a host that is off |
| `GracefulShutdown` | Ask the OS to shut down cleanly (via ACPI); stays off |
| `GracefulRestart` | Ask the OS to reboot cleanly |
| `ForceOff` | Cut host power immediately, like holding the power button |
| `ForceRestart` | Immediate reset, no OS cooperation |
| `PowerCycle` | Power off, then on again |
| `ACPowercycle` | Remove even standby power, which resets the BMC and devices that a normal reset leaves untouched |

**Graceful** types need a working OS to cooperate. If the OS is hung, the request may be accepted and then nothing happens. **Force** types always work, but they can lose unflushed data. An **AC power cycle** often isn't done through `ComputerSystem.Reset` at all. Some platforms use `POST /redfish/v1/Chassis/{id}/Actions/Chassis.Reset`, and NVIDIA GBx00 uses an OEM action (`NvidiaChassis.AuxPowerReset`). Not every BMC offers every type. A system resource usually lists what it accepts under `ResetType@Redfish.AllowableValues` in its `Actions` block.

**How NICo uses them.** During provisioning NICo power-cycles the DPU (`GracefulRestart`) so it network-boots `nico.efi`. Later it does the same to the host after changing BIOS and boot order. These power cycles are rate-limited (`reset_rate_limit`) so a host doesn't get rebooted over and over.

**Resets are external effects** (Chapter 4). A database rollback can't undo a reboot, and a timed-out POST is *ambiguous*: the BMC may have acted even though you got no response. The safe pattern is to record a recovery point, then confirm the outcome by reading `PowerState` back (`On`, `Off`, `PoweringOn`, `PoweringOff`, …) before deciding whether to retry.

**Analogy.** Think of ending a meeting. GracefulShutdown is asking everyone to wrap up and leave. ForceOff is switching off the lights. ForceRestart is switching them off and straight back on. An AC power cycle is cutting power to the whole building, including the receptionist's desk (the BMC). Where it breaks down: people in a meeting adapt, but a hung OS simply ignores the polite request. With the forced options nothing is negotiated, and the only clue to what happened is what you observe afterwards.

### Worked example: Pick a valid reset type and build the request

**Step 1: Save a system resource with its Actions block.**

```bash
cd ~/redfish-lab
cat > system.json <<'EOF'
{
  "Id": "System.Embedded.1",
  "PowerState": "On",
  "Actions": {
    "#ComputerSystem.Reset": {
      "target": "/redfish/v1/Systems/System.Embedded.1/Actions/ComputerSystem.Reset",
      "ResetType@Redfish.AllowableValues": ["On", "ForceOff", "GracefulShutdown", "GracefulRestart", "ForceRestart", "PowerCycle"]
    }
  }
}
EOF
```

**Step 2: List what this BMC accepts.**

```bash
jq -r '.Actions["#ComputerSystem.Reset"]["ResetType@Redfish.AllowableValues"][]' system.json
```
Note that `ACPowercycle` isn't in the list. On this BMC an AC cycle would have to go through a chassis-level or OEM action.

**Step 3: Decide on a type.**

Scenario: the host OS is healthy, and you've just staged BIOS changes that need a reboot. Choose `GracefulRestart`. The OS can shut down cleanly, and the reboot applies the pending settings.

**Step 4: Build the body and the target.**

```bash
jq -n --arg t GracefulRestart '{ResetType: $t}'
jq -r '.Actions["#ComputerSystem.Reset"].target' system.json
```
Against real hardware (reference only):
```bash
curl -sk -u root:PASSWORD -X POST -H 'Content-Type: application/json' \
  -d '{"ResetType":"GracefulRestart"}' \
  https://BMC_IP/redfish/v1/Systems/System.Embedded.1/Actions/ComputerSystem.Reset
```

**Step 5: Verify, don't assume.**

After the POST, poll `GET /redfish/v1/Systems/System.Embedded.1` and watch `PowerState`. A success status on the POST means the BMC *accepted* the command, not that the host has finished rebooting.

### Your turn: finish it

Complete the jq filter so it prints `true` if the reset type in `$t` is allowed by this BMC and `false` otherwise. With `ACPowercycle` it should print `false`.

```text
jq --arg t ACPowercycle '.Actions["#ComputerSystem.Reset"]["ResetType@Redfish.AllowableValues"] | ___' system.json
```

<details>
<summary>Answer</summary>

any(. == $t). The full command is `jq --arg t ACPowercycle '.Actions["#ComputerSystem.Reset"]["ResetType@Redfish.AllowableValues"] | any(. == $t)' system.json`. It prints `false`, and with `--arg t ForceRestart` it prints `true`.

</details>

### Your turn: on your own

A NICo state handler POSTs `ForceRestart` to a host BMC, and the HTTP call times out with no response. Using what you learned about external effects in Chapter 4, write the steps the next handler run should take. Say which reset type you would retry with, if any, and why.

<details>
<summary>Hint 1</summary>

Did the reboot happen? You can't tell from a timeout.

</details>

<details>
<summary>Hint 2</summary>

Which Redfish field shows what the host is doing right now?

</details>

<details>
<summary>Hint 3</summary>

Read PowerState first. Only retry if you can show the reset didn't happen, and remember that power cycles are rate-limited.

</details>

<details>
<summary>Answer</summary>

1) Treat the outcome as unknown: the BMC may have rebooted the host and lost the response. 2) Start from the durable recovery point (the handler recorded that a reset was intended). 3) `GET /redfish/v1/Systems/{id}` and read `PowerState`, along with other evidence such as boot progress or the host contacting NICo after the reboot. 4) If the host clearly went through a reset, adopt it as complete and move on. If it's `PoweringOn`/`PoweringOff`, keep observing. 5) Retry only when the evidence shows no reset happened, the retry is safe, and the reset rate limit allows it. Use `ForceRestart` again if the host is hung, because a graceful type needs a responsive OS. Never assume the first call did nothing.

</details>

### Explain it

In your own words: Why would NICo ever need an AC power cycle when ForceRestart already resets the host immediately?

### Check

**1. The host OS is completely hung. Which reset type is most likely to actually reboot it?**

A. ForceRestart
B. GracefulRestart
C. GracefulShutdown followed by On
D. On

<details>
<summary>Answer</summary>

**A.** ForceRestart

Graceful types depend on the OS responding to the shutdown request, which a hung OS won't do. `On` does nothing to a host that is already on. ForceRestart doesn't need any OS cooperation.

</details>

**2. A reset POST returns success. What has been proven?**

A. The BMC accepted the command; you still need to observe PowerState to confirm the result
B. The host has finished rebooting and the OS is up
C. The host's BMC has also been reset
D. Nothing; Redfish POSTs always succeed

<details>
<summary>Answer</summary>

**A.** The BMC accepted the command; you still need to observe PowerState to confirm the result

Accepting a command isn't the same as completing it. A normal ComputerSystem.Reset doesn't reset the BMC; that takes an AC cycle or Manager.Reset. And POSTs do fail, for example when the ResetType isn't supported.

</details>

**3. Short answer: what JSON body tells a BMC to restart the host cleanly?**

<details>
<summary>Answer</summary>

{"ResetType": "GracefulRestart"}

It's POSTed to /redfish/v1/Systems/{id}/Actions/ComputerSystem.Reset. This is what NICo uses to power-cycle DPUs and hosts during provisioning.

</details>

**Sources:** [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/backends/rms.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/backends/rms.md), [architecture/state_handling.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_handling.md)

<a id="redfish-resource-tree"></a>
## 4. Redfish resource tree (Systems, Chassis, Managers)

*Builds on: Redfish API (ch. 6)*

### Before you read

- One physical server box. Guess how Redfish might separate "the computer that runs an OS", "the metal box with fans and sensors" and "the BMC itself".
- If the service root only contains links, how does a client find a particular system's serial number?

<details>
<summary>Answers</summary>

- **One physical server box. Guess how Redfish might separate "the computer that runs an OS", "the metal box with fans and sensors" and "the BMC itself".** As three resource types: Systems (the computer: CPUs, memory, boot, power state), Chassis (the physical enclosure or card: serials, sensors, network adapters) and Managers (the BMC: firmware version, network interfaces, logs).
- **If the service root only contains links, how does a client find a particular system's serial number?** It follows links. Root → `Systems` collection → a member's `@odata.id` → the system resource, which has `SerialNumber`.

</details>

### Explanation

Redfish arranges resources in a tree under `/redfish/v1`. The three main branches:

- **Systems** (`/redfish/v1/Systems/{id}`): the *computer*, the thing that boots an OS. It has `SerialNumber`, `PowerState`, `Boot.BootOrder`, links to `PCIeDevices`, `EthernetInterfaces`, `Bios`, `SecureBoot`, and the reset action.
- **Chassis** (`/redfish/v1/Chassis/{id}`): *physical* things, such as an enclosure, tray or card. It has `SerialNumber`, `PartNumber`, `NetworkAdapters`, `Sensors`, `Thermal`, `Power`.
- **Managers** (`/redfish/v1/Managers/{id}`): the *BMC* itself. It has `FirmwareVersion`, `EthernetInterfaces` (where the BMC's own `MACAddress` lives), `LogServices`, and `Manager.Reset`.

**Collections and links.** `/redfish/v1/Systems` is a *collection*. Its `Members` array lists links, not the full objects. Every link is an object with one key, `@odata.id`, whose value is the resource's path. A client never constructs paths itself. It reads `@odata.id` and follows it, because IDs vary by vendor (`System.Embedded.1` on Dell, `1` on others, `Card1` for a DPU chassis).

**How NICo reads the tree.** Site Explorer collects:

| Data | From |
|---|---|
| System serial, power state | `Systems/{id}` |
| Chassis serial (fallback if system serial is missing) | `Chassis/{id}` |
| Network adapters and serials | `Chassis/{id}/NetworkAdapters` |
| PCIe devices and serials | `Systems/{id}` → `PCIeDevices` |
| BMC firmware version | `Managers/{id}` |
| BMC MAC | `Managers/{id}/EthernetInterfaces` |
| Firmware versions | `UpdateService/FirmwareInventory` |

IDs and part numbers carry meaning too. A chassis with `Id` `"Card1"` is classified as a DPU, and BlueField devices are recognized by `PartNumber`. The `SerialNumber` of PCIe devices is the main key for **DPU-host pairing**: a host's PCIe device serial must match a DPU BMC's own serial.

**Analogy.** The resource tree is like a library catalogue. The front page (service root) points to sections (collections), each section lists shelf numbers (`@odata.id` links), and you walk to the shelf to read the book (the resource). Where it breaks down: a library numbers its shelves the same way everywhere, but Redfish IDs are chosen by each vendor. You must follow the links you're given rather than guess a shelf number.

### Worked example: Walk Systems, Chassis and Managers by following links

**Step 1: Add collections and resources to the fake tree.**

In `~/redfish-lab` (the server from the Redfish API lesson should still be running there):
```bash
cd ~/redfish-lab
mk() { mkdir -p "redfish/v1$1"; cat > "redfish/v1$1/index.html"; }
mk /Systems <<'EOF'
{"@odata.id": "/redfish/v1/Systems",
 "Members": [{"@odata.id": "/redfish/v1/Systems/System.Embedded.1"}],
 "Members@odata.count": 1}
EOF
mk /Systems/System.Embedded.1 <<'EOF'
{"@odata.id": "/redfish/v1/Systems/System.Embedded.1",
 "Id": "System.Embedded.1", "SerialNumber": "J1234XY", "PowerState": "On",
 "Manufacturer": "Dell Inc.", "Model": "PowerEdge R750",
 "PCIeDevices": [{"@odata.id": "/redfish/v1/Systems/System.Embedded.1/PCIeDevices/236-0"}]}
EOF
mk /Chassis <<'EOF'
{"@odata.id": "/redfish/v1/Chassis",
 "Members": [{"@odata.id": "/redfish/v1/Chassis/System.Embedded.1"}],
 "Members@odata.count": 1}
EOF
mk /Chassis/System.Embedded.1 <<'EOF'
{"@odata.id": "/redfish/v1/Chassis/System.Embedded.1",
 "Id": "System.Embedded.1", "SerialNumber": "J1234XY"}
EOF
mk /Managers <<'EOF'
{"@odata.id": "/redfish/v1/Managers",
 "Members": [{"@odata.id": "/redfish/v1/Managers/iDRAC.Embedded.1"}],
 "Members@odata.count": 1}
EOF
mk /Managers/iDRAC.Embedded.1 <<'EOF'
{"@odata.id": "/redfish/v1/Managers/iDRAC.Embedded.1",
 "Id": "iDRAC.Embedded.1", "FirmwareVersion": "7.00.00.171"}
EOF
```

**Step 2: Define a tiny GET helper.**

```bash
BASE=http://127.0.0.1:8000
get() { curl -sL "$BASE$1"; }
```

**Step 3: Follow root → collection → member.**

```bash
sys_coll=$(get /redfish/v1 | jq -r '.Systems."@odata.id"')
sys=$(get "$sys_coll" | jq -r '.Members[0]."@odata.id"')
echo "$sys"
get "$sys" | jq '{Id, SerialNumber, PowerState}'
```
You never typed `System.Embedded.1`. The links gave it to you.

**Step 4: Do the same for Chassis.**

```bash
ch=$(get "$(get /redfish/v1 | jq -r '.Chassis."@odata.id"')" | jq -r '.Members[0]."@odata.id"')
get "$ch" | jq -r .SerialNumber
```
On this host the chassis serial matches the system serial. NICo uses it as a fallback when `Systems/{id}.SerialNumber` is missing.

### Your turn: finish it

Fill in the two blanks so the commands print the BMC firmware version (`7.00.00.171`) by following links from the Managers collection.

```text
mgr=$(get /redfish/v1/Managers | jq -r '.___')
get "$mgr" | jq -r '.___'
```

<details>
<summary>Answer</summary>

First blank: `Members[0]."@odata.id"`. Second blank: `FirmwareVersion`. Filled in:
```bash
mgr=$(get /redfish/v1/Managers | jq -r '.Members[0]."@odata.id"')
get "$mgr" | jq -r '.FirmwareVersion'
```

</details>

### Your turn: on your own

NICo must decide which DPU belongs to which host. You can query the host BMC and the DPU BMC. Describe which resources you would read on each and which field you would compare. Assume the host isn't a Supermicro.

<details>
<summary>Hint 1</summary>

The DPU is a PCIe card inside the host, so the host BMC can see it as a device.

</details>

<details>
<summary>Hint 2</summary>

On the host BMC, look at the links in `Systems/{id}`. On the DPU BMC, look at the chassis that represents the card.

</details>

<details>
<summary>Hint 3</summary>

Compare the host's `PCIeDevices/{id}.SerialNumber` (with `PartNumber` to recognize BlueField) against the DPU's serial, for example `Chassis/Card1.SerialNumber`.

</details>

<details>
<summary>Answer</summary>

On the host BMC: read `Systems/{id}`, follow each `PCIeDevices` `@odata.id`, and record `SerialNumber` and `PartNumber`. Network adapters under `Chassis/{id}/NetworkAdapters` are the fallback path. On the DPU BMC: read its system and chassis. The DPU chassis has `Id` `Card1`, and its `SerialNumber` gives the DPU's pairing serial. Then match host-side device serials (whitespace trimmed) against DPU serials. A match pairs that DPU with that host.

</details>

### Explain it

In your own words: Why does a Redfish client follow `@odata.id` links instead of building paths like `/redfish/v1/Systems/1` itself?

### Check

**1. Where would you find the MAC address of the BMC's own network port?**

A. /redfish/v1/Managers/{id}/EthernetInterfaces
B. /redfish/v1/Systems/{id}/EthernetInterfaces
C. /redfish/v1/Chassis/{id}/NetworkAdapters
D. /redfish/v1 (service root)

<details>
<summary>Answer</summary>

**A.** /redfish/v1/Managers/{id}/EthernetInterfaces

Managers represent the BMC. `Systems/{id}/EthernetInterfaces` lists the host's NICs, and NetworkAdapters lists add-in cards like DPUs. Mixing those up is a common mistake. The service root only contains links.

</details>

**2. What does a collection such as /redfish/v1/Systems contain?**

A. A Members array of links, each with an @odata.id
B. The full JSON of every system, inline
C. Only a count of systems
D. A list of system serial numbers

<details>
<summary>Answer</summary>

**A.** A Members array of links, each with an @odata.id

Collections hold references. To read details you GET each member's `@odata.id`. `Members@odata.count` gives the count, but the links are what you follow.

</details>

**3. Short answer: which Redfish field does NICo treat as critical for DPU-host pairing on PCIe devices?**

<details>
<summary>Answer</summary>

SerialNumber (with PartNumber to identify BlueField devices).

PCIe device SerialNumber is the primary pairing key. PartNumber identifies BF2, BF3 and SuperNIC devices.

</details>

**Sources:** [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

<a id="redfish-vendor-detection-and-oem-extensions"></a>
## 5. Redfish vendor detection and OEM extensions

*Builds on: Redfish resource tree (Systems, Chassis, Managers) (ch. 6)*

### Before you read

- If Redfish is a standard, why would a client need to know which vendor made the BMC?
- Where in a Redfish JSON document would you expect a vendor to put fields the standard doesn't define?

<details>
<summary>Answers</summary>

- **If Redfish is a standard, why would a client need to know which vendor made the BMC?** Vendors implement the standard differently: different paths for the same thing, different IDs, and extra non-standard fields and actions. The client needs the vendor to know which variant to use.
- **Where in a Redfish JSON document would you expect a vendor to put fields the standard doesn't define?** In an `Oem` object, usually keyed by vendor name, for example `Oem.Nvidia` or `Oem.Dell`. Vendor-only actions appear under `Actions/Oem` or similar paths.

</details>

### Explanation

The Redfish standard leaves room for vendors to differ, and they do. NICo deals with this in two ways.

**1. Vendor detection.** Site Explorer's first request is an anonymous `GET /redfish/v1`. It reads the `Vendor` field and maps it to a `RedfishVendor` value. The docs call this field *Required*: it "determines all vendor-specific behavior". The vendors NICo has specific handling for include Dell, HPE, Lenovo, Supermicro, Viking and NVIDIA (DPU, GH200, GB200). Detection doesn't rely only on `Vendor`. For example, Viking is also recognized by a manager with `Id == "BMC"`.

**2. Vendor-specific paths and behaviour.** Examples from NICo's endpoint reference:

| Task | Differences |
|---|---|
| Pending BIOS settings | Standard `Bios/Settings`; HPE `Bios/settings` (lowercase); Lenovo `Bios/Pending`; Viking `Bios/SD` |
| BMC event log | Dell `Managers/{id}/LogServices/Sel/Entries`; HPE `.../IEL/Entries`; Viking `.../SEL/Entries`; Lenovo `Systems/{id}/LogServices/AuditLog/Entries` |
| PCIe devices | Supermicro under `Chassis/{id}/PCIeDevices`; others linked from `Systems/{id}` |
| Lockdown | Dell `Managers/{id}/Attributes`; Supermicro `Oem/Supermicro/SysLockdown` |
| Admin account Id | Lenovo `"1"`, AMI/Viking `"2"` |

**OEM extensions.** For features the standard doesn't cover, vendors add an **`Oem`** section with their own fields and actions. NVIDIA's examples matter most for NICo:
- `Systems/{id}/Oem/Nvidia` on a DPU: base MAC, rshim status, NIC mode
- `Systems/{id}/Oem/Nvidia/Actions/Mode.Set`: switch a BlueField between NIC and DPU mode
- `Chassis/BMC_0/Actions/Oem/NvidiaChassis.AuxPowerReset`: AC power cycle on GBx00
- `Oem.Nvidia.chassis_physical_slot_number` and `compute_tray_index` on chassis

A client can safely ignore `Oem` data it doesn't understand. To *use* it, the client needs vendor-specific code, and that is the main reason NICo's Redfish libraries have per-vendor implementations.

**Analogy.** Vendor detection is like checking which country's power socket a hotel room has before you plug in. The electricity is standard, but the plug shape isn't. `Oem` sections are like the extra USB-C port some hotels add: useful if your device knows about it, harmless if it doesn't. Where it breaks down: you can see a socket's shape, but a BMC can claim one vendor while behaving like another (OEM rebrands of the same BMC firmware), so NICo also checks other clues such as the manager's Id.

### Worked example: Choose an endpoint from the detected vendor

**Step 1: Write a vendor-to-path table.**

Save as `~/redfish-lab/vendor_paths.py`. This is an illustration of the idea, not NICo's code:
```python
BIOS_PENDING = {
    "HPE": "Bios/settings",
    "Lenovo": "Bios/Pending",
    "Viking": "Bios/SD",
}
DEFAULT = "Bios/Settings"


def bios_pending_path(vendor, system_path):
    return f"{system_path}/{BIOS_PENDING.get(vendor, DEFAULT)}"


for vendor in ["Dell", "HPE", "Lenovo", "Viking"]:
    print(vendor, bios_pending_path(vendor, "/redfish/v1/Systems/1"))
```

**Step 2: Run it.**

```bash
python3 ~/redfish-lab/vendor_paths.py
```
Output:
```
Dell /redfish/v1/Systems/1/Bios/Settings
HPE /redfish/v1/Systems/1/Bios/settings
Lenovo /redfish/v1/Systems/1/Bios/Pending
Viking /redfish/v1/Systems/1/Bios/SD
```

**Step 3: Feed it a detected vendor.**

Read `Vendor` from the fake service root and pass it in:
```bash
v=$(curl -sL http://127.0.0.1:8000/redfish/v1 | jq -r .Vendor)
python3 -c "import sys; sys.path.insert(0, '$HOME/redfish-lab'); from vendor_paths import bios_pending_path as p; print(p('$v', '/redfish/v1/Systems/System.Embedded.1'))"
```
(The import also re-runs the demo loop at the bottom of the file, so you'll see its four lines first.) Edit `redfish/v1/index.html` to say `"Vendor": "Lenovo"` and run it again. The last line changes.

**Step 4: Spot an OEM section.**

A DPU system resource might contain:
```json
"Oem": { "Nvidia": { "Mode": "DpuMode" } }
```
(The field names inside `Oem.Nvidia` here are illustrative.) A generic client skips this. NICo's NVIDIA DPU code reads `Oem/Nvidia` and can call `Oem/Nvidia/Actions/Mode.Set`.

### Your turn: finish it

Extend the table pattern to BMC event-log entries. Fill in the blank for HPE so the function returns the right path from NICo's endpoint reference.

```text
BMC_EVENT_LOG = {
    "Dell": "LogServices/Sel/Entries",
    "HPE": "LogServices/___/Entries",
    "Viking": "LogServices/SEL/Entries",
}


def bmc_event_log(vendor, manager_path):
    return f"{manager_path}/{BMC_EVENT_LOG[vendor]}"
```

<details>
<summary>Answer</summary>

IEL. HPE's BMC event log is at `Managers/{id}/LogServices/IEL/Entries`. (Lenovo is left out of this table on purpose: its log lives under `Systems/{id}/LogServices/AuditLog/Entries`, which isn't under the manager at all.)

</details>

### Your turn: on your own

Write a Python function `pcie_collection(vendor, system, chassis_path)` that returns a list of PCIe device paths to GET. `system` is the parsed JSON of `Systems/{id}`. Handle Supermicro differently from everyone else, following NICo's endpoint reference.

<details>
<summary>Hint 1</summary>

For most vendors the device links are already inside the system JSON.

</details>

<details>
<summary>Hint 2</summary>

Supermicro keeps them under a chassis collection, so you return the collection path and let the caller list its Members.

</details>

<details>
<summary>Hint 3</summary>

Non-Supermicro: `[d["@odata.id"] for d in system.get("PCIeDevices", [])]`.

</details>

<details>
<summary>Answer</summary>

```python
def pcie_collection(vendor, system, chassis_path):
    if vendor == "Supermicro":
        # Supermicro lists PCIe devices under the chassis
        return [f"{chassis_path}/PCIeDevices"]
    return [d["@odata.id"] for d in system.get("PCIeDevices", [])]
```
For Supermicro the caller GETs the collection and follows each `Members[].@odata.id`. For everyone else the links come straight from `Systems/{id}`.

</details>

### Explain it

In your own words: Why does NICo detect the vendor once at the start, from the anonymous service root, instead of trying each vendor's path until one works?

### Check

**1. Which field does NICo read to decide vendor-specific behaviour?**

A. Vendor in the /redfish/v1 service root
B. Manufacturer in /redfish/v1/Systems/{id}
C. The HTTP Server response header
D. The BMC's DHCP hostname

<details>
<summary>Answer</summary>

**A.** Vendor in the /redfish/v1 service root

The service root's Vendor field drives vendor-specific behaviour. System Manufacturer describes the server maker and is used for Machine ID generation, and it needs authentication to read. HTTP headers and hostnames aren't what NICo uses.

</details>

**2. A BlueField DPU needs to switch from NIC mode to DPU mode. Where is that action?**

A. Systems/{id}/Oem/Nvidia/Actions/Mode.Set
B. Systems/{id}/Actions/ComputerSystem.Reset with ResetType DpuMode
C. Systems/{id}/Bios/Settings
D. Managers/{id}/Actions/Manager.ResetToDefaults

<details>
<summary>Answer</summary>

**A.** Systems/{id}/Oem/Nvidia/Actions/Mode.Set

DPU mode isn't part of standard Redfish, so NVIDIA exposes it as an OEM action. There's no DpuMode reset type. BIOS settings and manager factory reset are different features.

</details>

**3. Short answer: why is it safe for a generic Redfish client to receive a resource with an Oem section it doesn't understand?**

<details>
<summary>Answer</summary>

Because Oem data adds to the standard fields rather than replacing them. A client that ignores it still sees the standard properties.

Vendors put non-standard content under Oem so it doesn't conflict with schema-defined fields. You only need vendor code when you want to use that content.

</details>

**Sources:** [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

<a id="libredfish-and-nv-redfish"></a>
## 6. libredfish and nv-redfish

*Builds on: Redfish vendor detection and OEM extensions (ch. 6)*

### Before you read

- If you were writing a Redfish client for six vendors, would you hand-write a struct for every Redfish resource, or generate them from the official schema? What's the trade-off?
- Guess: is it better to compile support for the whole Redfish schema into a binary, or only the parts you use?

<details>
<summary>Answers</summary>

- **If you were writing a Redfish client for six vendors, would you hand-write a struct for every Redfish resource, or generate them from the official schema? What's the trade-off?** Generating them from the schema gives correct, typed code for every standard resource and is easy to update. Hand-written code makes vendor quirks easier to model but drifts and lets field-name typos through. NICo uses both approaches, in two libraries.
- **Guess: is it better to compile support for the whole Redfish schema into a binary, or only the parts you use?** Only the parts you use. Less code means faster builds and smaller binaries. nv-redfish is feature-gated for exactly this reason.

</details>

### Explanation

NICo is written in Rust and talks Redfish through two client libraries. Both are used at the same time, with versions pinned in the workspace `Cargo.toml`.

**libredfish** (v0.43.11) is the older, broader library. It defines a `Redfish` trait, a Rust interface with methods such as `bios()`, `set_bios()`, `machine_setup()`, `get_secure_boot()`, `get_accounts()` and power control. It has **vendor-specific implementations** of that trait: Dell, HPE, Lenovo, Supermicro, and NVIDIA DPU, GB200, GH200 and Viking. All the quirks from the previous lesson (HPE's lowercase `Bios/settings`, Dell's lockdown attributes, NVIDIA's `Oem` actions) live in those implementations. Site Explorer uses it for vendor detection, boot configuration, power control, BIOS and account management.

**nv-redfish** (0.7.1) works differently: **code generation**. The DMTF publishes the Redfish schema as CSDL (XML). At build time nv-redfish compiles that CSDL into **strongly typed** Rust structs and methods. A misspelled field becomes a compile error instead of a silent `None` at runtime. It is **feature-gated**, so only the Redfish services you enable get compiled. NICo enables `std-redfish`, `update-service` and `resource-status`. It is used for Site Explorer exploration and for the Hardware Health service's firmware inventory collection:
```rust
let service_root = ServiceRoot::new(bmc.clone()).await?;
let update_service = service_root.update_service().await?;
let firmware_inventories = update_service.firmware_inventories().await?;
```
Each `.await` is an async HTTP GET (Chapter 2's async/await): `/redfish/v1`, then `/redfish/v1/UpdateService`, then `/FirmwareInventory` and each item in it.

**The direction of travel.** nv-redfish is gradually **replacing** libredfish. When you read NICo code you'll find both. Rule of thumb: the newer, inventory-style read paths (exploration, health) use nv-redfish, and many vendor-specific *write* operations (BIOS, boot order, accounts) still go through libredfish's `Redfish` trait.

**Analogy.** libredfish is like a set of hand-drawn maps, one per city, with every local shortcut and roadworks noted. nv-redfish is like a GPS map generated from the official survey data: always consistent and quick to update, but local quirks have to be added on top. Where it breaks down: a GPS map is loaded at runtime, while nv-redfish's types are fixed at compile time, so a field the schema doesn't describe isn't reachable through the generated types.

### Worked example: See why typed resources catch mistakes

**Step 1: Parse a firmware item the untyped way.**

Save as `~/redfish-lab/typed.py`:
```python
from dataclasses import dataclass

raw = {"Id": "BMC_Firmware", "Name": "BMC Firmware", "Version": "7.00.00.171"}

# Untyped: a typo silently gives None
print("untyped:", raw.get("version"))


@dataclass
class SoftwareInventory:
    Id: str
    Name: str
    Version: str


inv = SoftwareInventory(**raw)
print("typed:", inv.Version)
try:
    print(inv.version)
except AttributeError as err:
    print("typed typo caught:", err)
```

**Step 2: Run it.**

```bash
python3 ~/redfish-lab/typed.py
```
The untyped lookup prints `None`, a bug that would quietly export an empty firmware version. The typed version raises an error straight away. In Rust with nv-redfish, that mistake wouldn't even compile.

**Step 3: Map the nv-redfish chain to HTTP.**

| Rust call | HTTP |
|---|---|
| `ServiceRoot::new(bmc)` | `GET /redfish/v1` |
| `.update_service()` | `GET /redfish/v1/UpdateService` |
| `.firmware_inventories()` | `GET /redfish/v1/UpdateService/FirmwareInventory`, then `GET .../FirmwareInventory/{id}` per item |

Each item's `Name` and `Version` become the Prometheus labels `firmware_name` and `version`.

**Step 4: Decide which library owns a task.**

Setting the host boot order to DPU-first (`set_boot_order_dpu_first`) and writing BIOS attributes are vendor-sensitive writes, handled by libredfish's `Redfish` trait. Polling firmware inventory in nico-hw-health is a schema-standard read, handled by nv-redfish.

### Your turn: finish it

Fill in the HTTP request that the nv-redfish `update_service()` call produces in the firmware collector chain.

```text
ServiceRoot::new(bmc)       -> GET /redfish/v1
.update_service()           -> GET ___
.firmware_inventories()     -> GET /redfish/v1/UpdateService/FirmwareInventory
```

<details>
<summary>Answer</summary>

/redfish/v1/UpdateService

</details>

### Your turn: on your own

For each task, say whether NICo's docs put it in libredfish or nv-redfish, and give one reason: (a) applying BIOS settings with `machine_setup()`, (b) polling firmware inventory in the Hardware Health service, (c) Site Explorer's vendor detection, (d) creating or changing BMC user accounts.

<details>
<summary>Hint 1</summary>

Recall which library has a `Redfish` trait with per-vendor implementations.

</details>

<details>
<summary>Hint 2</summary>

The firmware collector code in the lesson uses `ServiceRoot::new(...)`.

</details>

<details>
<summary>Hint 3</summary>

Vendor-sensitive writes and detection belong to the library with per-vendor implementations. Standard inventory reads belong to the generated one.

</details>

<details>
<summary>Answer</summary>

(a) libredfish: BIOS paths and attributes vary by vendor (HPE `Bios/settings`, Lenovo `Bios/Pending`, …), and the `Redfish` trait has vendor-specific implementations. (b) nv-redfish: the `FirmwareCollector` uses typed `ServiceRoot` → `update_service()` → `firmware_inventories()`, which is standard schema data. (c) libredfish: the docs list vendor detection under libredfish in Site Explorer. (d) libredfish: account management is listed there, and admin account IDs vary by vendor (Lenovo "1", AMI/Viking "2").

</details>

### Explain it

In your own words: Why does it make sense to replace libredfish gradually rather than all at once, given what you know about vendor quirks and the risk of rebooting or misconfiguring production hosts?

### Check

**1. What is the core technique that sets nv-redfish apart from libredfish?**

A. It generates strongly typed Rust from the Redfish CSDL schema at build time
B. It is written in Go and runs as a separate microservice
C. It talks IPMI instead of Redfish for faster polling
D. It downloads vendor schemas from each BMC at runtime

<details>
<summary>Answer</summary>

**A.** It generates strongly typed Rust from the Redfish CSDL schema at build time

Both libraries are Rust and both speak Redfish. nv-redfish compiles CSDL into types at build time. It doesn't fetch schemas at runtime, and it isn't a separate service.

</details>

**2. Where do vendor-specific behaviours such as HPE's lowercase Bios/settings path live in NICo's Redfish code?**

A. In libredfish's vendor-specific implementations of the Redfish trait
B. In nv-redfish's generated code, one module per vendor
C. In the BMC firmware, so NICo doesn't need to handle them
D. In the expected_machines.json manifest

<details>
<summary>Answer</summary>

**A.** In libredfish's vendor-specific implementations of the Redfish trait

libredfish has per-vendor implementations (Dell, HPE, Lenovo, Supermicro, NVIDIA variants). nv-redfish is generated from the standard schema, not organized per vendor. The manifest only holds BMC MACs, credentials and serials.

</details>

**3. Short answer: which nv-redfish features does NICo currently enable?**

<details>
<summary>Answer</summary>

std-redfish, update-service and resource-status.

Feature gating compiles in only the Redfish services NICo needs, which keeps builds smaller and faster.

</details>

**Sources:** [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

<a id="build-task"></a>
## Build task: Mini Site Explorer: a mock BMC and a Redfish client

**Goal:** Run a small mock BMC that speaks a slice of Redfish (anonymous service root, authenticated Systems/Chassis/Managers, a working ComputerSystem.Reset action, and an Oem section). Then run a client that probes it anonymously, detects the vendor, walks the tree through @odata.id links, picks a vendor-specific path, and power-cycles the fake host, checking the result by reading PowerState back.

**Why it matters for NICo:** This is NICo's Site Explorer and Host Power Manager in miniature: an anonymous vendor probe, then an authenticated inventory walk, then vendor-specific behaviour, then a reset action treated as an ambiguous external effect and confirmed by reading state back. When you later debug a host stuck in ingestion, you'll be asking the same questions this client asks.

**You need:**

- Linux or macOS with Python 3.8+ (`python3 --version`); only the standard library is used
- curl, plus jq (optional, for poking at the mock by hand)
- Two terminal windows
- A working directory, e.g. `mkdir -p ~/redfish-build && cd ~/redfish-build`

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Write the mock BMC</summary>

Save as `~/redfish-build/mock_bmc.py`:
```python
#!/usr/bin/env python3
"""mock_bmc.py - a tiny fake BMC speaking a slice of Redfish over plain HTTP.

Usage: python3 mock_bmc.py [VENDOR] [PORT]
"""
import base64
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VENDOR = sys.argv[1] if len(sys.argv) > 1 else "Dell"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
USER, PASSWORD = "root", "factory-default"
SYS = "/redfish/v1/Systems/1"
STATE = {"PowerState": "On", "resets": 0}
ALLOWED = ["On", "ForceOff", "GracefulShutdown", "GracefulRestart",
           "ForceRestart", "PowerCycle"]


def tree():
    return {
        "/redfish/v1": {
            "@odata.id": "/redfish/v1",
            "Id": "RootService",
            "RedfishVersion": "1.15.0",
            "Vendor": VENDOR,
            "Systems": {"@odata.id": "/redfish/v1/Systems"},
            "Chassis": {"@odata.id": "/redfish/v1/Chassis"},
            "Managers": {"@odata.id": "/redfish/v1/Managers"},
        },
        "/redfish/v1/Systems": {
            "@odata.id": "/redfish/v1/Systems",
            "Members": [{"@odata.id": SYS}],
            "Members@odata.count": 1,
        },
        SYS: {
            "@odata.id": SYS,
            "Id": "1",
            "SerialNumber": "SERIAL-1",
            "PowerState": STATE["PowerState"],
            "Links": {
                "Chassis": [{"@odata.id": "/redfish/v1/Chassis/1"}],
                "ManagedBy": [{"@odata.id": "/redfish/v1/Managers/1"}],
            },
            "Actions": {
                "#ComputerSystem.Reset": {
                    "target": SYS + "/Actions/ComputerSystem.Reset",
                    "ResetType@Redfish.AllowableValues": ALLOWED,
                }
            },
            "Oem": {VENDOR: {"ResetCount": STATE["resets"]}},
        },
        "/redfish/v1/Chassis": {
            "@odata.id": "/redfish/v1/Chassis",
            "Members": [{"@odata.id": "/redfish/v1/Chassis/1"}],
            "Members@odata.count": 1,
        },
        "/redfish/v1/Chassis/1": {
            "@odata.id": "/redfish/v1/Chassis/1",
            "Id": "1",
            "SerialNumber": "SERIAL-1",
            "PartNumber": "MOCK-0001",
        },
        "/redfish/v1/Managers": {
            "@odata.id": "/redfish/v1/Managers",
            "Members": [{"@odata.id": "/redfish/v1/Managers/1"}],
            "Members@odata.count": 1,
        },
        "/redfish/v1/Managers/1": {
            "@odata.id": "/redfish/v1/Managers/1",
            "Id": "1",
            "FirmwareVersion": "7.00.00.171",
            "Links": {"ManagerForServers": [{"@odata.id": SYS}]},
        },
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body=None):
        data = b"" if body is None else json.dumps(body, indent=2).encode()
        self.send_response(code)
        if code == 401:
            self.send_header("WWW-Authenticate", 'Basic realm="mock-bmc"')
        if data:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _path(self):
        return self.path.split("?")[0].rstrip("/") or "/"

    def _authorized(self):
        token = base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()
        return self.headers.get("Authorization") == "Basic " + token

    def do_GET(self):
        path = self._path()
        if path != "/redfish/v1" and not self._authorized():
            return self._send(401, {"error": "authentication required"})
        resource = tree().get(path)
        if resource is None:
            return self._send(404, {"error": f"no resource at {path}"})
        self._send(200, resource)

    def do_POST(self):
        path = self._path()
        if not self._authorized():
            return self._send(401, {"error": "authentication required"})
        if path != SYS + "/Actions/ComputerSystem.Reset":
            return self._send(404, {"error": f"no action at {path}"})
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "body is not JSON"})
        reset_type = body.get("ResetType")
        if reset_type not in ALLOWED:
            return self._send(400, {"error": f"unsupported ResetType {reset_type!r}",
                                    "allowed": ALLOWED})
        if reset_type.startswith("Graceful") and STATE["PowerState"] == "Off":
            return self._send(409, {"error": f"{reset_type} needs a running OS; host is Off"})
        if reset_type in ("ForceOff", "GracefulShutdown"):
            STATE["PowerState"] = "Off"
        else:
            STATE["PowerState"] = "On"
        STATE["resets"] += 1
        self._send(204)


if __name__ == "__main__":
    print(f"mock BMC Vendor={VENDOR} on http://127.0.0.1:{PORT}/redfish/v1 "
          f"(user {USER})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
```
In terminal 1, start it as a Lenovo BMC:
```bash
cd ~/redfish-build && python3 mock_bmc.py Lenovo 8000
```

</details>

<details>
<summary>Step 2: Poke at it by hand</summary>

In terminal 2:
```bash
curl -s http://127.0.0.1:8000/redfish/v1 | jq -r .Vendor          # Lenovo (anonymous works)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/redfish/v1/Systems   # 401
curl -s -u root:factory-default http://127.0.0.1:8000/redfish/v1/Systems/1 | jq '{SerialNumber, PowerState, Oem}'
```
This is the same split you saw in the Redfish API lesson: the service root is anonymous and everything else needs credentials.

</details>

<details>
<summary>Step 3: Write the client helpers</summary>

Save the first half of `~/redfish-build/redfish_client.py`:
```python
#!/usr/bin/env python3
"""redfish_client.py - probe, walk, detect vendor and reset a Redfish BMC.

Usage: python3 redfish_client.py [BASE_URL] [RESET_TYPE]
"""
import base64
import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
USER, PASSWORD = "root", "factory-default"
AUTH = "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()

# Illustrative vendor table (paths from NICo's Redfish Endpoints Reference)
BIOS_PENDING = {
    "HPE": "/Bios/settings",
    "Lenovo": "/Bios/Pending",
    "Viking": "/Bios/SD",
}
DEFAULT_BIOS_PENDING = "/Bios/Settings"


def request(method, path, body=None, auth=True):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if auth:
        req.add_header("Authorization", AUTH)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read()
        return err.code, (json.loads(raw) if raw else None)


def get(path, auth=True):
    status, body = request("GET", path, auth=auth)
    if status != 200:
        sys.exit(f"GET {path} -> {status}: {body}")
    return body


def first_member(collection_path):
    return get(collection_path)["Members"][0]["@odata.id"]
```

</details>

<details>
<summary>Step 4: Write the walk, vendor logic and reset</summary>

Append this to the same file:
```python


def main():
    root = get("/redfish/v1", auth=False)  # anonymous probe, like Site Explorer
    vendor = root.get("Vendor", "unknown")
    print(f"Vendor: {vendor}")

    system_path = first_member(root["Systems"]["@odata.id"])
    chassis_path = first_member(root["Chassis"]["@odata.id"])
    manager_path = first_member(root["Managers"]["@odata.id"])
    system = get(system_path)
    chassis = get(chassis_path)
    manager = get(manager_path)
    print(f"System {system_path}: serial={system['SerialNumber']} power={system['PowerState']}")
    print(f"Chassis {chassis_path}: serial={chassis['SerialNumber']}")
    print(f"Manager {manager_path}: firmware={manager['FirmwareVersion']}")
    bios = BIOS_PENDING.get(vendor, DEFAULT_BIOS_PENDING)
    print(f"Pending BIOS path would be: {system_path}{bios}")
    print(f"OEM data: {json.dumps(system.get('Oem', {}))}")

    reset_type = sys.argv[2] if len(sys.argv) > 2 else "ForceRestart"
    action = system["Actions"]["#ComputerSystem.Reset"]
    allowed = action["ResetType@Redfish.AllowableValues"]
    if reset_type not in allowed:
        sys.exit(f"{reset_type} not offered by this BMC; allowed: {allowed}")
    status, body = request("POST", action["target"], {"ResetType": reset_type})
    print(f"POST {reset_type} -> {status}" + ("" if body is None else f" {json.dumps(body)}"))
    # A POST result is only acceptance; confirm by reading state back.
    print(f"PowerState now: {get(system_path)['PowerState']}")


if __name__ == "__main__":
    main()
```
Notice it never hard-codes `/Systems/1`. Every path comes from `@odata.id` or the action's `target`.

</details>

<details>
<summary>Step 5: Run a sequence of resets</summary>

```bash
cd ~/redfish-build
python3 redfish_client.py http://127.0.0.1:8000 ForceOff
python3 redfish_client.py http://127.0.0.1:8000 GracefulRestart
python3 redfish_client.py http://127.0.0.1:8000 On
python3 redfish_client.py http://127.0.0.1:8000 ACPowercycle
```
Expected, in order: `PowerState now: Off`; a `409` with "needs a running OS" and state still `Off`; `PowerState now: On`; then an exit with "ACPowercycle not offered by this BMC". Watch the `ResetCount` in the OEM data go up. Terminal 1 shows each request (http.server logs to stderr).

</details>

<details>
<summary>Step 6: Switch vendor and confirm the behaviour changes</summary>

Stop the mock (Ctrl-C) and restart it as HPE: `python3 mock_bmc.py HPE 8000`. Run the client again. The pending BIOS path should now end in `/Bios/settings` (lowercase), and the OEM data should be keyed `HPE`. Try `Dell` as well: it falls back to the standard `/Bios/Settings`.

</details>

**Check it works:** With `python3 mock_bmc.py Lenovo 8000` running, start with the host On (restart the mock if you've already powered it off) and run `python3 redfish_client.py http://127.0.0.1:8000 ForceOff`. The output must include `Vendor: Lenovo`, `System /redfish/v1/Systems/1: serial=SERIAL-1 power=On`, `Pending BIOS path would be: /redfish/v1/Systems/1/Bios/Pending`, `POST ForceOff -> 204` and `PowerState now: Off`. Also, `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/redfish/v1/Systems` must print `401`.

<details>
<summary>If you get stuck</summary>

- `Address already in use`: another server (perhaps the lesson's `python3 -m http.server`) is on port 8000. Stop it, or run the mock on 8001 and pass `http://127.0.0.1:8001` to the client.
- Every request returns 401: check the client's USER/PASSWORD match the mock's (`root` / `factory-default`). Only `/redfish/v1` is anonymous.
- `IndentationError` after pasting: the second half of the client must be appended at column 0. `def main():` has no leading spaces.
- State seems stuck: the mock keeps power state in memory. Restarting it resets the host to `On` with ResetCount 0.
- GracefulRestart returning 409 is the intended behaviour: the mock models a graceful action that can't run without a live OS. Use `On` or `ForceRestart` instead.

</details>

**Stretch goal:** Make it more like Site Explorer. (1) Run two mocks at once (`python3 mock_bmc.py HPE 8001` and `python3 mock_bmc.py Supermicro 8002`) and change the client to loop over a list of BMC URLs, printing one inventory line per BMC. (2) Add a Supermicro branch that would look for PCIe devices under `Chassis/{id}/PCIeDevices`, and add that collection to the mock. (3) Add a `Chassis.Reset` action to the mock's chassis that accepts `PowerCycle`, and have the client use it when asked for an AC-style cycle that the system action doesn't offer. (4) If you have Docker, run the DMTF Redfish Mockup Server image (`dmtf/redfish-mockup-server`; check its README for the port and options) and point the read-only part of your client at it to see a much fuller, standard tree.

## Review notes

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **ok**, no issues found.

---

[← 05-uefi-firmware-nico-architecture.md](05-uefi-firmware-nico-architecture.md) · [07-bluefield-dpu-hardware-oob-management.md →](07-bluefield-dpu-hardware-oob-management.md)
