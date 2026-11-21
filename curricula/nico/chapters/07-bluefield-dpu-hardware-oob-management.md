# Chapter 7: BlueField DPU · Hardware & OOB Management

*Part: Hardware & OOB Management · 5 concepts · [curriculum](../curriculum.md#chapter-7)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Chapter 6 showed how NICo talks to a server's BMC over Redfish. This chapter adds the second computer inside every NICo-managed server: the **NVIDIA BlueField DPU**. A DPU is a network card with its own Arm CPU, operating system and BMC. NICo uses it as the **trust anchor**. Tenant traffic passes through the DPU, so the DPU can enforce isolation no matter what runs on the host.

You'll cover five ideas in order:
1. **BlueField DPU**: what the device is and how NICo recognises it over Redfish.
2. **DPA (Data Path Accelerator)**: a subsystem inside the NIC with its own firmware rules. NICo keeps its firmware path separate from the generic NIC firmware engine.
3. **rshim**: the PCIe back door to the DPU's console and boot path. NICo turns it on with NVIDIA OEM Redfish actions before it installs the DPU OS.
4. **Out-of-band (OOB) management**: why NICo watches hardware only through BMCs and the DPU, and never through the host OS.
5. **OOB interface**: the physical and logical management ports that carry this traffic, and how NICo finds their MAC addresses.

These ideas come back later in zero-trust (ch. 23), HBN (ch. 29), BFB installs (ch. 13) and decommissioning (ch. 40). The build task at the end ties them together. You'll run a mock host BMC and a mock DPU BMC on an isolated Docker "management network", then write a small explorer that recognises the DPU, pairs it with its host, turns on rshim and finds the DPU's OOB MAC.

**By the end of this chapter you can:**

- Explain what a BlueField DPU is and why NICo treats it, not the host OS, as the enforcement boundary
- Identify a BlueField DPU and pair it with its host using the Redfish fields NICo relies on (Systems Id, Chassis Card1, PartNumber, SerialNumber)
- Describe why NICo keeps legacy DPA firmware policy and the generic NIC firmware engine from touching the same card
- Locate the NVIDIA OEM Redfish endpoints that read and enable rshim, and place the EnableRshim step in the DPU discovery state machine
- Distinguish in-band from out-of-band management and explain why NICo monitors hardware only out-of-band
- Find an OOB interface's MAC address from Redfish boot options and explain where NICo uses OOB and BMC MACs during decommissioning

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [BlueField DPU](#bluefield-dpu)
2. [DPA (Data Path Accelerator)](#dpa)
3. [rshim](#rshim)
4. [Out-of-band (OOB) management](#out-of-band-management)
5. [Out-of-Band (OOB) Interface](#out-of-band-interface)
6. [Build task: Mock DPU explorer on an isolated management network](#build-task)

<a id="bluefield-dpu"></a>
## 1. BlueField DPU

*Builds on: Baseboard Management Controller (BMC) (ch. 6)*

### Before you read

- A tenant gets root on a bare-metal server and rewrites its firewall rules. If isolation were enforced by software on that server's OS, what could the tenant do? Where would you put the enforcement instead?
- Guess: how many BMCs does a server with one BlueField DPU have?

<details>
<summary>Answers</summary>

- **A tenant gets root on a bare-metal server and rewrites its firewall rules. If isolation were enforced by software on that server's OS, what could the tenant do? Where would you put the enforcement instead?** They could switch off or bypass the isolation, because they control the OS that enforces it. Put enforcement on hardware the tenant can't reach but that all traffic must pass through. In NICo that is the BlueField DPU, a NIC with its own CPU and OS.
- **Guess: how many BMCs does a server with one BlueField DPU have?** Two. The host has its own BMC, and the BlueField has a separate BMC for the DPU. Each one shows up as its own Redfish endpoint.

</details>

### Explanation

A **SmartNIC** is a network interface card that can also run programs. NVIDIA's **BlueField DPU** (Data Processing Unit) goes further. On one PCIe card it combines:

- a ConnectX network controller (the NIC part, with data ports that connect to the top-of-rack switch),
- several **Arm** CPU cores with their own memory and storage, running their own Linux OS,
- its own **BMC**, which you can reach with Redfish like the host's BMC from chapter 6.

The host sees the card as a normal PCIe network device. Behind that device sits an independent computer, and every packet the host sends or receives goes through it. The DPU has its own CPU, OS and firmware, so a tenant who fully controls the host OS still can't log into the DPU or change it.

That is why NICo makes the DPU its **trust anchor**. The operational principles say NICo never relies on host software for security decisions: "The BlueField DPU is the enforcement boundary." Network isolation (VXLAN/EVPN, VRFs, security groups via HBN) runs on the DPU, so the physical switches never need reconfiguring.

NICo manages the DPU's whole lifecycle:
- It installs the DPU OS and provisions HBN.
- It manages all DPU firmware: BMC, NIC, UEFI and ATF.
- It runs a **DPU agent** on the DPU. The agent fetches its desired configuration from NICo over gRPC.

**How NICo recognises a DPU over Redfish:**
- On the DPU's BMC, `Systems/{id}` has an `Id` containing `bluefield`.
- The chassis with `Id` `Card1` is the DPU. Its `PartNumber` (for example `900-9D3B6-...`) and `Model` (BF2 vs BF3) confirm which device it is. The DPU can use the `Chassis/Card1` serial as a fallback for its system serial.
- **Pairing** links a DPU to the host it sits in. The primary path compares the `SerialNumber` of each host PCIe device, read through the host BMC, against the DPU's system serial numbers. A fallback path uses the `NetworkAdapters` serial, which must be visible to the host BMC.

The reference notes that some serial fields, such as Chassis and NetworkAdapters `SerialNumber`, are whitespace-trimmed. It doesn't say the same for the PCIe device serial. In this chapter's exercises we trim every serial before comparing. That's a sensible defensive normalisation, not a documented NICo behaviour for that particular field.

In the managed-host state machine, a host starts in `DpuDiscoveringState`, moves through `DPUInit` and then `HostInit`. A host with no DPU goes straight to host initialisation.

**Analogy.** A DPU is like a security guard posted inside an apartment's front door. The guard reports to building management, not to the tenant. The tenant can rearrange the furniture as they like, but every delivery passes the guard. The analogy breaks down because a real guard can be bribed or argued with. The DPU runs its own OS and firmware, which NICo controls, and the host has no login to it. It is a separate computer, not a person sharing the apartment.

### Worked example: Recognise a DPU and pair it with its host from Redfish JSON

**Step 1: Save what the DPU's BMC reports.**

Save responses shaped like the Chassis sample in the NICo Redfish reference:
```bash
mkdir -p ~/nico-ch7 && cd ~/nico-ch7
cat > card1.json <<'EOF'
{"Id": "Card1", "SerialNumber": "MBF2M516A-CECA_Ax_SN123456", "PartNumber": "900-9D3B6-00CV-AA0", "Model": "BlueField-2 DPU 25GbE", "Manufacturer": "NVIDIA"}
EOF
cat > dpu_system.json <<'EOF'
{"Id": "Bluefield", "SerialNumber": "MBF2M516A-CECA_Ax_SN123456", "PowerState": "On"}
EOF
```

**Step 2: Save what the host's BMC reports about its PCIe devices.**

The host BMC lists the card as one of its PCIe devices. Notice the trailing spaces in the serial number:
```bash
cat > host_pcie.json <<'EOF'
{"Id": "236-0", "SerialNumber": "MBF2M516A-CECA_Ax_SN123456  ", "PartNumber": "900-9D3B6-00CV-AA0"}
EOF
```

**Step 3: Apply the identification checks.**

```bash
python3 - <<'EOF'
import json
sysj = json.load(open("dpu_system.json"))
card = json.load(open("card1.json"))
print("Systems Id says DPU:  ", "bluefield" in sysj["Id"].lower())
print("Chassis Id says DPU:  ", card["Id"] == "Card1")
print("PartNumber BlueField: ", card["PartNumber"].lower().startswith("900-9d3b6"))
print("Generation hint:      ", "BF2" if "BlueField-2" in card["Model"] else "not BF2")
EOF
```
All three checks print `True`. NICo's real `is_bluefield_model()` matches a list of part numbers (BF2, BF3, BF3 SuperNIC). The one prefix used here is a simplification.

**Step 4: Pair DPU to host by serial number.**

```bash
python3 - <<'EOF'
import json
dpu = json.load(open("dpu_system.json"))["SerialNumber"].strip()
host_dev = json.load(open("host_pcie.json"))
print("raw equal:    ", host_dev["SerialNumber"] == dpu)
print("trimmed equal:", host_dev["SerialNumber"].strip() == dpu)
EOF
```
The raw comparison is `False` and the trimmed one is `True`. Stray whitespace in BMC data is real: the NICo reference calls out whitespace trimming for Chassis and NetworkAdapters serials. Trimming the PCIe serial too is a defensive choice in this exercise. Without it, a naive comparison would silently fail to pair.

**Step 5: Interpret the result.**

Two separate BMCs describe the same physical card. The DPU's BMC describes it as a system and a chassis; the host's BMC describes it as a PCIe device. Matching serial numbers is how NICo learns that this DPU guards that host. Only after pairing can NICo treat the DPU as the host's enforcement point.

### Your turn: finish it

Fill in the blanks so the function returns True only when both Redfish hints say "this is a BlueField DPU".

```text
def looks_like_dpu(system, chassis):
    id_hit = "bluefield" in system["Id"].___()
    card_hit = chassis["Id"] == "___"
    return id_hit and card_hit

print(looks_like_dpu({"Id": "Bluefield"}, {"Id": "Card1"}))
```

<details>
<summary>Answer</summary>

First blank: `lower`, giving `system["Id"].lower()`. The check looks for the substring `bluefield`, so lowercase first and `Bluefield` still matches. Second blank: `Card1`, the chassis Id NICo classifies as a DPU. The script prints `True`.

</details>

### Your turn: on your own

A host BMC reports three PCIe devices with serials `["J9X1", " MT2243X01234", "PCIE-NVME-7"]`. Two DPU BMCs report system serials `MT2243X01234` and `MT2243X09999`. Write a short Python snippet that prints which DPU serial pairs with this host, and explain what you'd suspect about the second DPU.

<details>
<summary>Hint 1</summary>

Pairing compares host PCIe device serials with DPU system serials.

</details>

<details>
<summary>Hint 2</summary>

Watch for the leading space. Normalise both sides with `.strip()` before comparing.

</details>

<details>
<summary>Hint 3</summary>

`{s.strip() for s in host} & {d.strip() for d in dpus}` gives you the matches.

</details>

<details>
<summary>Answer</summary>

```python
host = ["J9X1", " MT2243X01234", "PCIE-NVME-7"]
dpus = ["MT2243X01234", "MT2243X09999"]
print({s.strip() for s in host} & {d.strip() for d in dpus})  # {'MT2243X01234'}
```
`MT2243X01234` pairs with this host. `MT2243X09999` belongs to a different host, or its serial isn't visible through this host's BMC. The reference says the NetworkAdapters serial fallback "must be visible to Host BMC", so a missing serial blocks pairing.

</details>

### Explain it

In your own words: In your own words: why does putting the enforcement point on a separate Arm computer inside the server give stronger isolation than a hardened firewall on the host OS, even one that is very well configured?

### Check

**1. In NICo's model, where is tenant network isolation enforced?**

A. On the host OS, by an agent NICo installs
B. On the BlueField DPU
C. On the top-of-rack switches, reconfigured for each tenant
D. In the host BMC firmware

<details>
<summary>Answer</summary>

**B.** On the BlueField DPU

The DPU is the enforcement boundary (HBN on Ethernet). NICo installs no host agents, so a host agent is wrong. The fabric stays static during tenancy changes, so switches aren't reconfigured per tenant. The host BMC manages the host, but it isn't in the data path.

</details>

**2. Which Redfish data is NICo's primary path for pairing a DPU with its host?**

A. Matching the host's PCIe device SerialNumber to the DPU's system SerialNumber
B. Matching the DPU BMC's IP address to the host BMC's IP subnet
C. Matching the DPU Model string to the host Model string
D. Comparing BMC firmware versions

<details>
<summary>Answer</summary>

**A.** Matching the host's PCIe device SerialNumber to the DPU's system SerialNumber

The reference marks the PCIe device `SerialNumber` as Critical: the primary DPU-host pairing path. IP subnets and model strings are shared by many machines, so they can't identify one card. Firmware versions are tracked for compliance, not for pairing.

</details>

**3. Which of these does a BlueField DPU have that a plain NIC does not?**

A. A MAC address
B. A PCIe connection to the host
C. Its own Arm CPU, OS and BMC
D. Ethernet ports

<details>
<summary>Answer</summary>

**C.** Its own Arm CPU, OS and BMC

Every NIC has MAC addresses, a PCIe link and Ethernet ports. The DPU's own compute, OS and BMC let it act independently of the host.

</details>

**Sources:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/operational-principles.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/operational-principles.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

<a id="dpa"></a>
## 2. DPA (Data Path Accelerator)

*Builds on: BlueField DPU (ch. 7)*

### Before you read

- Two independent tools both decide to flash firmware onto the same network card at the same time. What could go wrong?
- Guess: is a DPA part of the host CPU, the DPU's Arm cores, or something else?

<details>
<summary>Answers</summary>

- **Two independent tools both decide to flash firmware onto the same network card at the same time. What could go wrong?** Their writes could interleave or clash. One tool might reset the card while the other is still writing, leaving a half-written or wrong image. Neither tool's record of what happened would be accurate. You need exactly one owner per card at a time.
- **Guess: is a DPA part of the host CPU, the DPU's Arm cores, or something else?** Something else. The DPA is a separate subsystem inside the NIC/DPU, with its own processing cores, agents and firmware policies.

</details>

### Explanation

The **Data Path Accelerator (DPA)** is a subsystem inside NVIDIA's network silicon, found on BlueField-3-class devices. It is a set of small, highly multi-threaded cores that sit close to the packet pipeline. They run code that has to react to traffic faster than the Arm cores or the host could. You program it through NVIDIA's DOCA toolkit (chapter 28). For this chapter, picture it as a third kind of compute on the card, next to the NIC hardware and the Arm cores.

The DPA has its own **agents** (software that drives it) and its own **firmware policies**. That matters to NICo because NICo has two ways to change NIC firmware:

1. A **legacy DPA firmware path**: a configured DPA firmware policy applied through an `ApplyFirmware` operation.
2. The newer **generic NIC firmware engine**, the `NicFirmwareUpdating` states in the managed-host machine. It resolves baselines per card, machine and site, then admits, executes and verifies updates.

If both paths could target the same card, you'd get the race from the prequestion. The managed-host docs make the rule explicit:

- A generic target that overlaps a configured legacy DPA firmware policy **stays in `NicFirmwareUpdating/Pending` with a diagnostic**. NICo doesn't quietly reinterpret the overlap as "nothing to do".
- On a tracked overlapping set of cards, the legacy DPA `ApplyFirmware` path returns `FAILED_PRECONDITION` until shared execution is implemented.
- If **DPA interface work is active**, a NIC check waits with "waiting for other host hardware work to settle".
- Once NIC work is admitted, it rejects overlapping DPA operations.
- Tracked native DPA requests count as settled only when completion matches the exact recorded request. Publishing a request alone settles nothing.

This is the single-owner idea from WorkLock and fencing (chapter 4), applied to firmware. Note that the generic engine's admission is **off by default** (`firmware_global.nic_firmware_admission_enabled = false`).

**Analogy.** Think of two maintenance crews with keys to the same server room. The building's rule is simple: if both work orders name the same rack, neither crew starts until a single crew is assigned. Unlike a building, NICo can't rely on the crews talking to each other. It enforces the rule in the controller, by keeping the work pending and by refusing the legacy call outright.

### Worked example: Model the overlap rule with a small Python check

**Step 1: Describe each engine's targets.**

This is a teaching model, not NICo configuration. Each card is identified by a part number/PSID pair, the identity NICo's allow-list uses.
```bash
cat > overlap.py <<'EOF'
generic_targets = {("900-9D3B6", "MT_0000000884"), ("MCX653106A", "MT_0000000222")}
legacy_dpa_policy = {("900-9D3B6", "MT_0000000884")}
active_dpa_work = False
EOF
```

**Step 2: Find the overlap.**

Append the decision logic:
```bash
cat >> overlap.py <<'EOF'
overlap = generic_targets & legacy_dpa_policy
if active_dpa_work:
    print("Pending: waiting for other host hardware work to settle")
elif overlap:
    print("Pending: overlaps legacy DPA policy:", sorted(overlap))
else:
    print("Eligible for admission checks")
EOF
python3 overlap.py
```
Output: `Pending: overlaps legacy DPA policy: [('900-9D3B6', 'MT_0000000884')]`.

**Step 3: Try the other branches.**

Change `active_dpa_work = True` and rerun. You get the "waiting for other host hardware work" message. Set it back to `False` and remove the shared tuple from `legacy_dpa_policy`. The output becomes `Eligible for admission checks`. Being eligible doesn't mean the update will run. Capacity, evidence and the admission flag still apply.

**Step 4: Relate it to NICo.**

In NICo, the overlap case keeps the host in `NicFirmwareUpdating/Pending` with a diagnostic. If someone calls the legacy `ApplyFirmware` path on that tracked cohort, it fails with `FAILED_PRECONDITION`. Neither engine wins by racing; the conflict is visible to an operator.

### Your turn: finish it

Complete the function so it returns the set of cards that both engines claim.

```text
def conflicting_cards(generic_targets, legacy_dpa_policy):
    return generic_targets ___ legacy_dpa_policy

print(conflicting_cards({"A", "B"}, {"B", "C"}))
```

<details>
<summary>Answer</summary>

`&` (set intersection), giving `return generic_targets & legacy_dpa_policy`. The script prints `{'B'}`. `|` (union) would wrongly flag every card that either engine targets.

</details>

### Your turn: on your own

A host has just finished deprovisioning and enters `WaitingForCleanup/Init`. A NIC baseline check is required, so it moves to `NicFirmwareUpdating/Pending`. Meanwhile an operator has started DPA interface work on the same host. What does the host do, and what message would you expect to see? What should the operator *not* do to "speed it up"?

<details>
<summary>Hint 1</summary>

Look for the NIC Preparation Results row that mentions DPA interface work.

</details>

<details>
<summary>Hint 2</summary>

The host doesn't fail. It keeps the same state and retries.

</details>

<details>
<summary>Hint 3</summary>

Remember the guidance about bypassing guards during uncertain active work.

</details>

<details>
<summary>Answer</summary>

The host stays in `NicFirmwareUpdating/Pending` with the diagnostic "waiting for other host hardware work to settle", and retries until the DPA work settles. The operator should not bypass the guard, for example by launching vendor flashing tools directly or trying to clear dispatch state by hand. The docs say to preserve the operation and its evidence, and not to run direct mutations alongside admitted NIC work.

</details>

### Explain it

In your own words: Why is it safer for NICo to leave a host visibly stuck in Pending with a diagnostic than to pick one firmware engine automatically and carry on?

### Check

**1. A generic NIC firmware target overlaps a configured legacy DPA firmware policy. What does NICo do?**

A. Treats it as an unmanaged skip and moves on
B. Keeps NicFirmwareUpdating/Pending with a diagnostic
C. Lets the generic engine run, because it is newer
D. Moves the host to Failed immediately

<details>
<summary>Answer</summary>

**B.** Keeps NicFirmwareUpdating/Pending with a diagnostic

The docs say not to reinterpret the error as an unmanaged skip. Neither engine silently wins. Failed is for recorded host or DPU failures, not for policy overlap.

</details>

**2. On a tracked overlapping cohort, what does the legacy DPA ApplyFirmware path return?**

A. OK, and it queues behind the generic engine
B. FAILED_PRECONDITION
C. NOT_FOUND
D. It silently does nothing

<details>
<summary>Answer</summary>

**B.** FAILED_PRECONDITION

It refuses with `FAILED_PRECONDITION` until shared execution is implemented. That makes the conflict explicit instead of quietly queuing or dropping the work.

</details>

**3. What counts as settlement for a tracked native DPA request?**

A. Successfully publishing the request
B. Completion that matches the exact recorded request
C. Any heartbeat from the DPA agent
D. A host reboot

<details>
<summary>Answer</summary>

**B.** Completion that matches the exact recorded request

Publication alone doesn't settle a request, and an unrelated heartbeat or a reboot doesn't prove the mutation finished. Completion must match the recorded request.

</details>

**Sources:** [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

<a id="rshim"></a>
## 3. rshim

*Builds on: BlueField DPU (ch. 7), PCIe device (ch. 1), Redfish vendor detection and OEM extensions (ch. 6)*

### Before you read

- A DPU has no OS installed yet, so there's nothing to SSH into. How might you push an OS image onto it, or watch its boot console?
- rshim is NVIDIA-specific. Based on chapter 6, where in the Redfish tree would you expect to find controls for it?

<details>
<summary>Answers</summary>

- **A DPU has no OS installed yet, so there's nothing to SSH into. How might you push an OS image onto it, or watch its boot console?** Use a low-level channel that works without the DPU's OS, over the PCIe link from the host or through the DPU's BMC. On BlueField that channel is rshim. It exposes a boot path and a console.
- **rshim is NVIDIA-specific. Based on chapter 6, where in the Redfish tree would you expect to find controls for it?** Under an OEM extension, at `Oem/Nvidia`, because it isn't part of the standard Redfish schema.

</details>

### Explanation

**rshim** is a BlueField management interface that reaches the DPU's boot path and console **without needing the DPU's OS to be running**. On the host it appears over **PCIe** as an extra function of the card. The DPU's BMC can also drive it. Some background from NVIDIA's open-source rshim driver (not NICo-specific): on Linux it creates a device directory such as `/dev/rshim0/` containing:

- `boot`: write a BlueField boot image (a **BFB**, covered in chapter 13) here to install an OS on the Arm cores,
- `console`: the Arm side's serial console,
- `misc`: status and control,

plus a small virtual network interface for talking to the DPU. Only one side, host or BMC, drives rshim at a time.

**Why NICo cares:** before NICo can install the DPU OS and HBN, it needs a reliable path to the DPU's boot process. NICo enables rshim with **NVIDIA OEM Redfish** calls on the DPU's BMC. All three appear in the reference:

| Endpoint | Method | Purpose |
|---|---|---|
| `Systems/{id}/Oem/Nvidia` | GET | Base MAC, rshim status, NIC mode |
| `Systems/{id}/Oem/Nvidia/Actions/HostRshim.Set` | POST | Set rshim (BF3) |
| `Managers/Bluefield_BMC/Oem/Nvidia` | PATCH | Enable rshim |

NICo only uses these paths after vendor detection (chapter 6) shows it's talking to an NVIDIA DPU BMC.

**Where it happens in the lifecycle:** in `DpuDiscoveringState`, the sequence is `Initializing` → `Configuring` → **`EnableRshim`**. After that:
- If DPF was selected during site exploration, the host goes to `RebootAllDPUS`.
- Otherwise NICo checks whether BFB install is supported. If it is, NICo enables Secure Boot and moves to `DPUInit/InstallingBFB`.

So rshim is a prerequisite step on the way to installing the DPU OS. The reference doesn't show the request bodies for these actions. Get them from the BMC itself (its action info) or from NVIDIA's BMC documentation.

**Analogy.** rshim is like the service hatch on a vending machine. You don't need the machine's touchscreen to be working: you open the hatch, load new stock (the boot image) and read the diagnostic display (the console). The analogy breaks down because the hatch is locked from software, not with a key. NICo has to unlock it remotely through the DPU's BMC before anything can use it.

### Worked example: Plan the Redfish calls to read and enable rshim on a DPU

**Step 1: Confirm the vendor first.**

OEM paths only make sense once you know who you're talking to. On a real DPU BMC (placeholders in caps):
```bash
curl -sk -u "$USER:$PASS" https://$DPU_BMC/redfish/v1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["Vendor"])'
```
NICo's `get_redfish_vendor()` makes this decision. Every later vendor-specific path depends on it.

**Step 2: Find the DPU's system Id.**

```bash
curl -sk -u "$USER:$PASS" https://$DPU_BMC/redfish/v1/Systems
```
Pick the member whose `Id` contains `bluefield`. That is the same check NICo uses to detect a DPU.

**Step 3: Read current rshim status.**

```bash
curl -sk -u "$USER:$PASS" https://$DPU_BMC/redfish/v1/Systems/$SYSTEM_ID/Oem/Nvidia
```
This OEM resource reports base MAC, rshim status and NIC mode.

**Step 4: Choose the enable call.**

There are two documented enable paths:
- `POST .../Systems/$SYSTEM_ID/Oem/Nvidia/Actions/HostRshim.Set` (labelled BF3)
- `PATCH .../Managers/Bluefield_BMC/Oem/Nvidia`

Get the exact body from the BMC's action info or NVIDIA's DPU BMC docs; it isn't in NICo's reference. Then re-read step 3 to confirm the change took effect. An HTTP 2xx alone doesn't prove it.

**Step 5: Place it in the state machine.**

If a host sits in `DpuDiscoveringState/EnableRshim`, NICo is doing exactly these steps. Next comes `RebootAllDPUS` (with DPF) or the BFB-supported check that leads to Secure Boot and `DPUInit/InstallingBFB`.

### Your turn: finish it

Complete this helper that builds the BF3 rshim action path for a given DPU system Id.

```text
def rshim_action_path(system_id):
    return f"/redfish/v1/Systems/{system_id}/Oem/___/Actions/___"

print(rshim_action_path("Bluefield"))
```

<details>
<summary>Answer</summary>

Blanks: `Nvidia` and `HostRshim.Set`. The script prints `/redfish/v1/Systems/Bluefield/Oem/Nvidia/Actions/HostRshim.Set`.

</details>

### Your turn: on your own

A managed host has been stuck in `DpuDiscoveringState/EnableRshim` for an hour. List the first two or three Redfish reads you'd make against the DPU's BMC, and say what each one tells you.

<details>
<summary>Hint 1</summary>

Start with whatever decides which code path NICo takes.

</details>

<details>
<summary>Hint 2</summary>

Then read the resource that reports rshim status.

</details>

<details>
<summary>Hint 3</summary>

Check that the manager the PATCH path targets actually exists.

</details>

<details>
<summary>Answer</summary>

(1) `GET /redfish/v1`: confirm `Vendor` identifies NVIDIA, because vendor detection decides whether NICo uses the NVIDIA OEM paths at all. (2) `GET /redfish/v1/Systems/{id}/Oem/Nvidia`: read the current rshim status (and NIC mode); is it still disabled? (3) `GET /redfish/v1/Managers` (or `Managers/Bluefield_BMC`): confirm the manager targeted by the PATCH enable path exists. A different manager Id, or a BMC firmware without these OEM resources, would explain the stall. Check that the BMC is reachable over the OOB network and that the credentials work too.

</details>

### Explain it

In your own words: Why does NICo need a channel like rshim at all, given the DPU will later run a full Linux OS that NICo's DPU agent can talk to over gRPC?

### Check

**1. Which endpoint reports a DPU's rshim status?**

A. GET /redfish/v1/Systems/{id}/Oem/Nvidia
B. GET /redfish/v1/Managers/{id}/NetworkProtocol
C. GET /redfish/v1/UpdateService/FirmwareInventory
D. GET /redfish/v1/Chassis/Card1/Thermal

<details>
<summary>Answer</summary>

**A.** GET /redfish/v1/Systems/{id}/Oem/Nvidia

The NVIDIA OEM system resource reports base MAC, rshim status and NIC mode. NetworkProtocol controls BMC services such as IPMI. Firmware inventory and Thermal are about versions and sensors.

</details>

**2. In DpuDiscoveringState, what comes immediately before EnableRshim?**

A. Configuring
B. InstallingBFB
C. EnableSecureBoot
D. RebootAllDPUS

<details>
<summary>Answer</summary>

**A.** Configuring

The order is Initializing → Configuring → EnableRshim. Secure Boot and BFB install come after it. RebootAllDPUS follows it on the DPF path.

</details>

**3. What is rshim's physical path from the host to the DPU?**

A. PCIe
B. The top-of-rack data network
C. The host's USB keyboard port
D. Wi-Fi

<details>
<summary>Answer</summary>

**A.** PCIe

rshim shows up to the host as part of the BlueField PCIe device, which is why it works before the DPU has a network OS. The data network needs the DPU's networking to be up.

</details>

**Sources:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

<a id="out-of-band-management"></a>
## 4. Out-of-band (OOB) management

*Builds on: Baseboard Management Controller (BMC) (ch. 6)*

### Before you read

- Your monitoring reads CPU temperature from an agent running inside the host OS. A tenant replaces that agent with one that always reports 40°C. What does your dashboard show while the CPU overheats?
- Guess: if a host's OS kernel panics, can you still power-cycle it remotely? Through what?

<details>
<summary>Answers</summary>

- **Your monitoring reads CPU temperature from an agent running inside the host OS. A tenant replaces that agent with one that always reports 40°C. What does your dashboard show while the CPU overheats?** A steady, healthy 40°C. In-band monitoring can be spoofed, or blocked entirely, by whoever controls the OS.
- **Guess: if a host's OS kernel panics, can you still power-cycle it remotely? Through what?** Yes, through the BMC. It has its own processor and network port and doesn't depend on the host OS.

</details>

### Explanation

**In-band** management goes *through* the host OS: SSH, an agent, a metrics exporter. **Out-of-band (OOB) management** goes around it. You talk to the BMC (or, in NICo, the DPU) over a separate management network. The BMC has its own processor, firmware and network port, so it keeps working whether the host OS is healthy, hung, powered off or hostile.

One of NICo's five operating principles is: **all monitoring of the machine must be done using out-of-band methods.** NICo monitors health, firmware state and machine status only via Redfish and the DPU agent, never via paths that "a compromised or unresponsive host OS could influence, block, or spoof." The DPU agent counts as out-of-band from the host's point of view, because it runs on the DPU's Arm cores, which the tenant can't reach.

What this looks like in practice:
- **Discovery**: NICo discovers BMCs over the OOB network with Redfish.
- **Health**: sensors (Thermal, Power, Sensors and so on) are polled at `sensor_fetch_interval`, 60 seconds by default.
- **Logs**: BMC and system event logs are collected every 5 minutes. Collection is incremental: the request asks only for entries with `Id` greater than the last one seen (`?$filter=Id gt '{last_id}'`).
- **Firmware**: inventory comes from `UpdateService/FirmwareInventory`.
- **Closing in-band doors**: NICo disables in-band BMC access from within the host. Otherwise a tenant could reach the BMC from the OS and tamper with the thing that watches them. The `Manager/NetworkProtocol` PATCH can enable or disable IPMI access. The `HostInterfaces` OS-to-BMC NIC toggle appears only in NICo's CI/CD tooling, not in core NICo.

This is also why NICo installs no agent in the host OS. Anything it learned from inside the host would be untrusted anyway.

**Analogy.** It's like a hotel reading the electricity meter in the corridor instead of asking guests how much power they used. The meter works even if the guest lies, is asleep or has locked the door. The analogy breaks down because the hotel's meter only reads. A BMC can also act: it can power-cycle, change boot order and flash firmware. That's exactly why the guest must have no route to it.

### Worked example: See in-band vs out-of-band with a container

**Step 1: Start a 'tenant host'.**

The container plays the host OS, and the Docker daemon plays the BMC: it sees the container from outside.
```bash
docker run -d --name tenant alpine sleep 3600
```

**Step 2: Read health in-band, and see how easily it's faked.**

```bash
docker exec tenant sh -c 'echo "status=healthy temp=40C" > /tmp/health'
docker exec tenant cat /tmp/health
```
The tenant controls this file completely, so it can write anything.

**Step 3: Make the host unresponsive.**

```bash
docker pause tenant
docker exec tenant cat /tmp/health
```
The in-band read now fails with an error saying the container is paused. Your in-band monitoring has gone blind.

**Step 4: Read state out-of-band.**

```bash
docker inspect -f '{{.State.Status}}' tenant   # prints: paused
docker unpause tenant && docker rm -f tenant
```
The outside observer still reports the true state, and it can still act (unpause, kill). This is the property NICo gets from BMCs and the DPU.

### Your turn: finish it

Complete the URL builder for NICo-style incremental log collection, so each poll asks only for entries newer than the last one seen.

```text
def next_log_url(base, system_id, last_id):
    return f"{base}/redfish/v1/Systems/{system_id}/LogServices/SEL/Entries?$filter=Id ___ '{___}'"

print(next_log_url("https://bmc.oob", "Bluefield", 41))
```

<details>
<summary>Answer</summary>

Blanks: `gt` and `last_id`. The script prints `https://bmc.oob/redfish/v1/Systems/Bluefield/LogServices/SEL/Entries?$filter=Id gt '41'`. A real HTTP client should URL-encode the spaces and quotes.

</details>

### Your turn: on your own

A tenant on a NICo-managed host (a) installs a fake metrics daemon that reports perfect health, and (b) later crashes the kernel. For each event, say what NICo's monitoring sees and why. Then name one in-band door NICo closes to keep its OOB path trustworthy.

<details>
<summary>Hint 1</summary>

NICo reads no data from inside the host OS.

</details>

<details>
<summary>Hint 2</summary>

Where do sensor readings and power state come from?

</details>

<details>
<summary>Hint 3</summary>

Think about whether the tenant could reach the BMC from inside the OS.

</details>

<details>
<summary>Answer</summary>

(a) Nothing changes. NICo never reads host-reported metrics; sensors come from Redfish on the BMC, every 60 seconds by default. (b) NICo still sees power state, sensors and event logs through the BMC, and the DPU agent keeps reporting from the DPU. It can still power-cycle the host through Redfish. The door it closes: in-band BMC access from within the host. NICo disables it so the tenant can't reach or tamper with the BMC (and, for example, IPMI access can be controlled through the Manager NetworkProtocol endpoint).

</details>

### Explain it

In your own words: Why is "the host could be hostile" a stronger reason for out-of-band monitoring than "the host could crash"? Which of the two is harder to detect?

### Check

**1. Which data source does NICo NOT use for security or health decisions?**

A. Redfish on the host BMC
B. The DPU agent
C. An agent running in the host OS
D. Redfish on the DPU BMC

<details>
<summary>Answer</summary>

**C.** An agent running in the host OS

NICo installs no host agents and treats the host as untrustworthy. The DPU agent runs on the DPU's Arm cores, which is out of the tenant's reach, so it counts as out-of-band from the host's point of view.

</details>

**2. Why does NICo disable in-band BMC access from within the host?**

A. To save bandwidth on the data network
B. So a tenant can't reach or tamper with the controller that monitors and manages their host
C. Because Redfish only works over IPv6 in-band
D. To speed up firmware updates

<details>
<summary>Answer</summary>

**B.** So a tenant can't reach or tamper with the controller that monitors and manages their host

Out-of-band monitoring is only trustworthy if the monitored party has no route to the monitor. Bandwidth and speed have nothing to do with it, and Redfish has no IPv6 restriction like that.

</details>

**Sources:** [overview/operational-principles.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/operational-principles.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

<a id="out-of-band-interface"></a>
## 5. Out-of-Band (OOB) Interface

*Builds on: Out-of-band (OOB) management (ch. 7)*

### Before you read

- A server shows four RJ45/SFP ports on the back. Two are 100GbE data ports to the top-of-rack switch. Guess what the other, slower ports might be for.
- How could software find the MAC address of a management port it has never seen, using only Redfish?

<details>
<summary>Answers</summary>

- **A server shows four RJ45/SFP ports on the back. Two are 100GbE data ports to the top-of-rack switch. Guess what the other, slower ports might be for.** Management. Typically one is the BMC's dedicated port, and on a BlueField there's also a 1GbE OOB port for the DPU's Arm OS. They connect to the separate management network, not the tenant data network.
- **How could software find the MAC address of a management port it has never seen, using only Redfish?** Read the system's boot options. A network boot option's UEFI device path contains `MAC(...)`, and its display name can say what kind of port it is (for example, it contains "OOB"). BMC MACs come from the Manager's EthernetInterfaces.

</details>

### Explanation

An **Out-of-Band (OOB) interface** is a network interface used for management and kept separate from the data network. Out-of-band management (the previous lesson) is the practice; OOB interfaces are the ports and links that carry it.

In a NICo server you'll typically find several:
- **Host BMC port**: the host BMC's own NIC. NICo reads its MAC from `Managers/{id}/EthernetInterfaces`, where `MACAddress` is **Critical** because NICo uses it for BMC identification and credential storage and lookup.
- **DPU BMC port**: the same idea, for the BlueField's BMC.
- **DPU OOB port**: from general BlueField background, the card has a dedicated 1GbE management port. Linux on the Arm cores sees it as an interface such as `oob_net0`, separate from the high-speed data ports.
- **Host OOB interface**: NICo also tracks an OOB interface MAC for the host.

**How NICo finds an OOB interface:** it reads `Systems/{id}/BootOptions`, checks `DisplayName` for the string `OOB`, and pulls the MAC out of `UefiDevicePath` with a regex on `MAC(...,`. For example, `MAC(B83FD2909582,0x1)` becomes `B8:3F:D2:90:95:82`. You saw UEFI device paths in chapter 5.

**Why it matters later:** these MACs are how NICo recognises hardware on the management network, for example when hosts and DPUs request addresses via DHCP. Decommissioning (chapter 40) relies on them:
1. `SuppressingOobDhcp` and `WaitingForOobDhcpAcknowledgement` check the **host and DPU OOB interface MACs**.
2. `SuppressingBmcDhcp` and `WaitingForBmcDhcpAcknowledgement` check the **host and DPU BMC MACs**.

Keeping the OOB interfaces physically and logically separate from the tenant data network means a tenant's traffic can never reach the management plane.

**Analogy.** OOB interfaces are like the staff-only service corridors in a hospital: separate doors and separate keycards, used only by staff to reach equipment rooms. The analogy breaks down because a corridor is just a space. Each OOB interface also has a fixed identity (its MAC) that NICo records, and that identity is how the system recognises each piece of equipment.

### Worked example: Find the OOB interface MAC from a Redfish boot option

**Step 1: Save the boot option.**

This is the sample from NICo's Redfish reference:
```bash
cd ~/nico-ch7
cat > bootopt.json <<'EOF'
{"Id": "NIC.Slot.3-1", "DisplayName": "PXE OOB NIC Slot 3 Port 1", "UefiDevicePath": "PciRoot(0x2)/Pci(0x1,0x0)/Pci(0x0,0x0)/MAC(B83FD2909582,0x1)", "BootOptionEnabled": true}
EOF
```

**Step 2: Check whether it's the OOB interface.**

```bash
python3 -c 'import json; o=json.load(open("bootopt.json")); print("OOB" in o["DisplayName"])'
```
This prints `True`. NICo's rule is the same plain substring check.

**Step 3: Extract and format the MAC.**

```bash
python3 - <<'EOF'
import json, re
o = json.load(open("bootopt.json"))
raw = re.search(r"MAC\(([0-9A-Fa-f]+),", o["UefiDevicePath"]).group(1)
print(raw, "->", ":".join(raw[i:i+2] for i in range(0, 12, 2)))
EOF
```
Output: `B83FD2909582 -> B8:3F:D2:90:95:82`.

**Step 4: Know where else management MACs come from.**

A BMC's own MAC isn't in boot options. It comes from `GET /redfish/v1/Managers/{id}/EthernetInterfaces/{id}` → `MACAddress`, for example `B8:3F:D2:90:95:82` in the reference sample. Keep the two sources apart: decommissioning waits on OOB MACs and BMC MACs in separate steps.

### Your turn: finish it

Fill in the regex and the slice step so this prints `B8:3F:D2:90:95:82`.

```text
import re
path = "PciRoot(0x2)/Pci(0x1,0x0)/Pci(0x0,0x0)/MAC(B83FD2909582,0x1)"
raw = re.search(r"___", path).group(1)
print(":".join(raw[i:i+2] for i in range(0, 12, ___)))
```

<details>
<summary>Answer</summary>

Regex: `MAC\(([0-9A-Fa-f]+),`. It captures the hex digits between `MAC(` and the comma. Step: `2`, so the string is cut into byte pairs. With those filled in, the line reads `raw = re.search(r"MAC\(([0-9A-Fa-f]+),", path).group(1)`.

</details>

### Your turn: on your own

A DPU's BMC returns these boot options. Write a Python snippet that picks the OOB one and prints its MAC in colon format. Then say which decommissioning wait step would later check this MAC.

```json
[{"Id": "Boot0001", "DisplayName": "UEFI HTTPv4 p0", "UefiDevicePath": "PciRoot(0x0)/Pci(0x0,0x0)/MAC(B83FD2909580,0x1)/IPv4(0.0.0.0)"},
 {"Id": "Boot0002", "DisplayName": "NET-OOB-IPV4", "UefiDevicePath": "MAC(B83FD2909582,0x1)/IPv4(0.0.0.0)"}]
```

<details>
<summary>Hint 1</summary>

Loop over the list and test `"OOB" in opt["DisplayName"]`.

</details>

<details>
<summary>Hint 2</summary>

Reuse the regex from the completion problem.

</details>

<details>
<summary>Hint 3</summary>

OOB MACs and BMC MACs are waited on in different decommissioning states. Which one has OOB in its name?

</details>

<details>
<summary>Answer</summary>

```python
import json, re
opts = json.loads('''[{"Id": "Boot0001", "DisplayName": "UEFI HTTPv4 p0", "UefiDevicePath": "PciRoot(0x0)/Pci(0x0,0x0)/MAC(B83FD2909580,0x1)/IPv4(0.0.0.0)"}, {"Id": "Boot0002", "DisplayName": "NET-OOB-IPV4", "UefiDevicePath": "MAC(B83FD2909582,0x1)/IPv4(0.0.0.0)"}]''')
for o in opts:
    if "OOB" in o["DisplayName"]:
        raw = re.search(r"MAC\(([0-9A-Fa-f]+),", o["UefiDevicePath"]).group(1)
        print(":".join(raw[i:i+2] for i in range(0, 12, 2)))
```
Prints `B8:3F:D2:90:95:82`. During decommissioning, `WaitingForOobDhcpAcknowledgement` checks the host and DPU OOB interface MACs (after `SuppressingOobDhcp`). The BMC MACs are checked separately in `WaitingForBmcDhcpAcknowledgement`.

</details>

### Explain it

In your own words: Why would NICo want the OOB interface to be a physically separate port on a separate network, instead of a VLAN on the same high-speed data ports the tenant uses?

### Check

**1. How does NICo detect which boot option belongs to the OOB interface?**

A. It checks DisplayName for the string "OOB"
B. It picks the boot option with the lowest PCI bus number
C. It asks the host OS which NIC is management
D. It picks the first enabled boot option

<details>
<summary>Answer</summary>

**A.** It checks DisplayName for the string "OOB"

The reference documents a plain `OOB` substring check on DisplayName, then extracts the MAC from UefiDevicePath. Asking the host OS would break the out-of-band principle. PCI ordering is used to find the primary data interface, not the OOB one.

</details>

**2. Where does NICo get a BMC's own MAC address, which is critical for credential lookup?**

A. Managers/{id}/EthernetInterfaces → MACAddress
B. Systems/{id}/BootOptions → UefiDevicePath
C. Chassis/Card1 → PartNumber
D. UpdateService/FirmwareInventory → Id

<details>
<summary>Answer</summary>

**A.** Managers/{id}/EthernetInterfaces → MACAddress

The BMC is a Manager, so its NIC is listed under the Manager's EthernetInterfaces. Boot options describe the system's boot NICs, not the BMC.

</details>

**3. During decommissioning, which MACs does the OOB DHCP acknowledgement wait check?**

A. Host and DPU OOB interface MACs
B. Host and DPU BMC MACs
C. Only the DPU data-port MACs
D. Tenant VM MACs

<details>
<summary>Answer</summary>

**A.** Host and DPU OOB interface MACs

BMC MACs are checked in a separate step, WaitingForBmcDhcpAcknowledgement. Data-port and tenant MACs aren't part of these DHCP suppression waits.

</details>

**Sources:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [architecture/state_machines/managedhost.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/managedhost.md)

<a id="build-task"></a>
## Build task: Mock DPU explorer on an isolated management network

**Goal:** Run a mock host BMC and a mock BlueField DPU BMC on an internal Docker network, then write an explorer that recognises the DPU, pairs it with its host by serial number, enables rshim through an NVIDIA-style OEM action, and extracts the DPU's OOB MAC. Show that a container on a separate data network can neither resolve the BMCs' names nor reach them by IP address.

**Why it matters for NICo:** NICo's Site Explorer does a real version of this when servers are racked. It finds BMCs over the OOB network, spots BlueField DPUs, pairs them with hosts by matching serial numbers, and enables rshim on the way to installing the DPU OS. Real BMC data can contain stray whitespace (the reference notes trimming for Chassis and NetworkAdapters serials), so the lab includes a padded serial to make you normalise it. Building a toy version teaches you what data NICo depends on and where it can break, which helps when a real host stalls in DpuDiscoveringState.

**You need:**

- Docker (or Podman with the `docker` alias), able to pull `python:3.12-slim`
- A working directory, e.g. `mkdir -p ~/nico-ch7-lab && cd ~/nico-ch7-lab`
- No Python packages needed: the standard library only
- Note: the mock's `Oem/Nvidia` field names (`HostRshim`, `Mode`) and the POST body are illustrative for this lab. The endpoint paths follow NICo's Redfish reference, but check real request bodies against NVIDIA's BMC documentation.

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Write the mock BMC</summary>

Save as `mock_bmc.py`. One script plays either role:
```python
#!/usr/bin/env python3
"""Mock BMC. Usage: python3 mock_bmc.py host|dpu PORT (lab only)."""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

ROLE, PORT = sys.argv[1], int(sys.argv[2])
DPU_SERIAL = "MT2301X00042"
S = "/redfish/v1/Systems"

HOST = {
    "/redfish/v1": {"Vendor": "Dell", "Systems": {"@odata.id": S}},
    S: {"Members": [{"@odata.id": S + "/System.Embedded.1"}]},
    S + "/System.Embedded.1": {
        "Id": "System.Embedded.1",
        "SerialNumber": "J1234XY",
        "PowerState": "On",
        "PCIeDevices": [{"@odata.id": S + "/System.Embedded.1/PCIeDevices/236-0"}],
    },
    S + "/System.Embedded.1/PCIeDevices/236-0": {
        "Id": "236-0",
        "SerialNumber": DPU_SERIAL + "  ",
        "PartNumber": "900-9D3B6-00CV-AA0",
    },
}

DPU = {
    "/redfish/v1": {"Vendor": "Nvidia", "Systems": {"@odata.id": S},
                    "Chassis": {"@odata.id": "/redfish/v1/Chassis"}},
    S: {"Members": [{"@odata.id": S + "/Bluefield"}]},
    S + "/Bluefield": {
        "Id": "Bluefield",
        "SerialNumber": DPU_SERIAL,
        "PowerState": "On",
        "Boot": {"BootOptions": {"@odata.id": S + "/Bluefield/BootOptions"}},
    },
    S + "/Bluefield/Oem/Nvidia": {"HostRshim": "Disabled", "Mode": "DpuMode"},
    S + "/Bluefield/BootOptions": {"Members": [
        {"@odata.id": S + "/Bluefield/BootOptions/Boot0001"},
        {"@odata.id": S + "/Bluefield/BootOptions/Boot0002"},
    ]},
    S + "/Bluefield/BootOptions/Boot0001": {
        "Id": "Boot0001", "DisplayName": "UEFI HTTPv4 p0",
        "UefiDevicePath": "PciRoot(0x0)/Pci(0x0,0x0)/MAC(B83FD2909580,0x1)/IPv4(0.0.0.0)",
    },
    S + "/Bluefield/BootOptions/Boot0002": {
        "Id": "Boot0002", "DisplayName": "NET-OOB-IPV4",
        "UefiDevicePath": "MAC(B83FD2909582,0x1)/IPv4(0.0.0.0)",
    },
    "/redfish/v1/Chassis/Card1": {
        "Id": "Card1", "SerialNumber": DPU_SERIAL,
        "PartNumber": "900-9D3B6-00CV-AA0", "Model": "BlueField-2 DPU 25GbE",
    },
}

TREE = HOST if ROLE == "host" else DPU
RSHIM_ACTION = S + "/Bluefield/Oem/Nvidia/Actions/HostRshim.Set"


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.rstrip("/")
        if path in TREE:
            self._send(200, TREE[path])
        else:
            self._send(404, {"error": "not found: " + path})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        if ROLE == "dpu" and self.path == RSHIM_ACTION:
            TREE[S + "/Bluefield/Oem/Nvidia"]["HostRshim"] = body.get("HostRshim", "Enabled")
            self._send(204)
        else:
            self._send(404, {"error": "no such action"})


HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
```
The host's PCIe serial has two trailing spaces on purpose, to imitate messy real-world BMC data.

</details>

<details>
<summary>Step 2: Create an isolated management network and start both BMCs</summary>

`--internal` gives the network no route out, a stand-in for a dedicated OOB network. No ports are published to your laptop.
```bash
docker network create --internal oob-mgmt
docker run -d --name host-bmc --network oob-mgmt -v "$PWD":/lab:ro python:3.12-slim python3 /lab/mock_bmc.py host 8000
docker run -d --name dpu-bmc  --network oob-mgmt -v "$PWD":/lab:ro python:3.12-slim python3 /lab/mock_bmc.py dpu 8000
docker ps --filter network=oob-mgmt
```
Both containers should show `Up`.

</details>

<details>
<summary>Step 3: Write the explorer (with one TODO)</summary>

Save as `explore.py`. Fill in the pairing TODO yourself; the hints have the answer if you get stuck.
```python
#!/usr/bin/env python3
import json
import re
import sys
import urllib.request

HOST_BMC, DPU_BMC = sys.argv[1], sys.argv[2]


def get(base, path):
    with urllib.request.urlopen(base + path, timeout=5) as r:
        return json.load(r)


def post(base, path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.status


# 1. Vendor detection and DPU identification
root = get(DPU_BMC, "/redfish/v1")
sys_ref = get(DPU_BMC, "/redfish/v1/Systems")["Members"][0]["@odata.id"]
dpu_sys = get(DPU_BMC, sys_ref)
card = get(DPU_BMC, "/redfish/v1/Chassis/Card1")
is_dpu = ("bluefield" in dpu_sys["Id"].lower()
          and card["PartNumber"].lower().startswith("900-9d3b6"))
print("vendor:", root["Vendor"], "| is BlueField:", is_dpu)

# 2. Pair the DPU with the host by serial number
host_ref = get(HOST_BMC, "/redfish/v1/Systems")["Members"][0]["@odata.id"]
host_sys = get(HOST_BMC, host_ref)
dpu_serial = dpu_sys["SerialNumber"].strip()
paired = False
# TODO: for each link in host_sys["PCIeDevices"], GET link["@odata.id"] from HOST_BMC
#       and set paired = True if its SerialNumber (stripped) equals dpu_serial
print("paired:", paired, "| host", host_sys["SerialNumber"], "<-> DPU", dpu_serial)

# 3. rshim via NVIDIA OEM action (only for an NVIDIA vendor)
oem_path = sys_ref + "/Oem/Nvidia"
if root["Vendor"].lower() == "nvidia" and get(DPU_BMC, oem_path)["HostRshim"] != "Enabled":
    post(DPU_BMC, oem_path + "/Actions/HostRshim.Set", {"HostRshim": "Enabled"})
rshim = get(DPU_BMC, oem_path)["HostRshim"]
print("rshim:", rshim)

# 4. OOB interface MAC from boot options
oob_mac = None
for m in get(DPU_BMC, dpu_sys["Boot"]["BootOptions"]["@odata.id"])["Members"]:
    opt = get(DPU_BMC, m["@odata.id"])
    if "OOB" in opt["DisplayName"]:
        raw = re.search(r"MAC\(([0-9A-Fa-f]+),", opt["UefiDevicePath"]).group(1)
        oob_mac = ":".join(raw[i:i + 2] for i in range(0, 12, 2))
print("DPU OOB MAC:", oob_mac)

ok = is_dpu and paired and rshim == "Enabled" and oob_mac is not None
print("RESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
```

</details>

<details>
<summary>Step 4: Run the explorer from inside the management network</summary>

```bash
docker run --rm --network oob-mgmt -v "$PWD":/lab:ro python:3.12-slim \
  python3 /lab/explore.py http://host-bmc:8000 http://dpu-bmc:8000
```
Run it once *before* filling in the TODO: you should see `paired: False` and `RESULT: FAIL`. Then complete the TODO and run it again.

</details>

<details>
<summary>Step 5: Confirm the rshim action reached the DPU BMC</summary>

```bash
docker logs dpu-bmc 2>&1 | tail
```
You should see a `POST /redfish/v1/Systems/Bluefield/Oem/Nvidia/Actions/HostRshim.Set` line with status 204. Run the explorer again: this time it skips the POST because rshim already reads `Enabled`. That makes the explorer idempotent, the property from chapter 4.

</details>

<details>
<summary>Step 6: Show the data network can't reach the management plane</summary>

Two probes from a 'tenant' container on a separate network. First, by name:
```bash
docker network create data-net
docker run --rm --network data-net python:3.12-slim python3 -c \
  "import urllib.request; urllib.request.urlopen('http://dpu-bmc:8000/redfish/v1', timeout=3)"
```
This fails with a name-resolution error (`Name or service not known` or similar). That only proves the tenant can't **resolve the BMC's name**, because Docker's DNS is scoped to each user-defined network. It doesn't yet prove packets can't get through.

Second, by IP. Get the BMC's address and run a positive control from inside the management network:
```bash
DPU_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' dpu-bmc)
echo "$DPU_IP"
docker run --rm --network oob-mgmt python:3.12-slim python3 -c \
  "import urllib.request; print(urllib.request.urlopen('http://$DPU_IP:8000/redfish/v1', timeout=3).status)"
```
This prints `200`, so the IP is correct. Now probe the same IP from the data network:
```bash
docker run --rm --network data-net python:3.12-slim python3 -c \
  "import urllib.request; urllib.request.urlopen('http://$DPU_IP:8000/redfish/v1', timeout=3)"
```
Expect a traceback ending in a timeout (`TimeoutError` / `timed out`) or a connection error (`URLError`, `No route to host`, `Connection refused`). Docker's isolation rules drop traffic between these bridge networks, so even a tenant who knows the address has no path to the BMC. That is the point of a separate OOB network.

</details>

**Check it works:** `docker run --rm --network oob-mgmt -v "$PWD":/lab:ro python:3.12-slim python3 /lab/explore.py http://host-bmc:8000 http://dpu-bmc:8000; echo exit=$?` prints `is BlueField: True`, `paired: True`, `rshim: Enabled`, `DPU OOB MAC: B8:3F:D2:90:95:82`, `RESULT: PASS` and `exit=0`. In the last step, the by-IP probe from `oob-mgmt` prints `200`, while the by-IP probe from `data-net` fails with a timeout or connection error (and the by-name probe fails at name resolution). Clean up with `docker rm -f host-bmc dpu-bmc && docker network rm oob-mgmt data-net`.

<details>
<summary>If you get stuck</summary>

- Pairing TODO answer (indent with 4 spaces inside the loop):
```python
for link in host_sys["PCIeDevices"]:
    dev = get(HOST_BMC, link["@odata.id"])
    if dev["SerialNumber"].strip() == dpu_serial:
        paired = True
```
- `paired: False` even after the TODO? You probably compared without `.strip()`. The host's serial has trailing spaces, as real BMC data sometimes does.
- `python3: can't open file '/lab/...'`: run the `docker run` commands from the directory that holds the scripts. On SELinux hosts (Fedora/RHEL), use `-v "$PWD":/lab:ro,Z`.
- `Name or service not known` from the explorer: it has to run with `--network oob-mgmt`. Container names only resolve on the same user-defined network.
- `HTTP Error 404` means a path typo. `docker logs dpu-bmc 2>&1 | tail` shows exactly which path was requested (http.server logs to stderr).
- `echo "$DPU_IP"` prints nothing? The `dpu-bmc` container isn't running; check `docker ps -a` and `docker logs dpu-bmc 2>&1`. Also make sure you run the probes in the same shell where you set `DPU_IP`.
- The data-net by-IP probe unexpectedly succeeds? Some Podman or rootless setups don't isolate networks the same way Docker does. Note the result and treat the by-name failure as your evidence; on standard Docker Engine the probe should fail.
- Network already exists? Run `docker network rm oob-mgmt data-net` and try again.

</details>

**Stretch goal:** Add OOB health polling. Give the DPU mock a `/redfish/v1/Systems/Bluefield/LogServices/SEL/Entries` endpoint that returns entries with increasing `Id`s and honours a `$filter=Id gt 'N'` query (parse it with `urllib.parse`). Then extend the explorer into a loop that collects only new entries every few seconds, like NICo's incremental log collection. Finally, add a second DPU mock whose serial is *not* in the host's PCIe list, and make the explorer report it as unpaired instead of crashing.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (BlueField DPU): The explanation says the Chassis Card1 `Model` (BF2 vs BF3) confirms which device it is. The reference gives 'DPU model detection (BF2 vs BF3)' to the Systems/{id} `Model` field; for Chassis `Model` it only says 'Model identification'. *Fix:* Attribute the BF2/BF3 generation hint to the Systems `Model` field, or say Card1's PartNumber/Model help identify the device without tying BF2/BF3 detection to the Chassis Model.
- **minor** (rshim): The worked-example curl commands use `$USER` as a 'placeholder in caps'. The shell already sets USER to the local login name, so a learner who forgets to set it will silently send their local username to the BMC. *Fix:* Rename the placeholders to `$BMC_USER`/`$BMC_PASS` (or similar) and show them being set.

---

[← 06-bmc-redfish.md](06-bmc-redfish.md) · [08-boot-network-services-uefi-firmware.md →](08-boot-network-services-uefi-firmware.md)
