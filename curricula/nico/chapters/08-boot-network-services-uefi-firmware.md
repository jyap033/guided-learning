# Chapter 8: Boot & Network Services · UEFI & Firmware

*Part: Networking & Isolation · 8 concepts · [curriculum](../curriculum.md#chapter-8)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Earlier chapters gave you the pieces: UEFI firmware and Secure Boot (ch. 5), BMCs and the Redfish API (ch. 6), and the BlueField DPU with its out-of-band interfaces (ch. 7). This chapter covers the services that turn those pieces into something a control plane can drive. That means configuring firmware remotely, choosing what a machine boots, and giving every management endpoint an address, a name and the correct time.

The chapter has two halves. The first half is about **firmware control through the BMC**: BIOS/UEFI settings that only take effect on the next reboot, locking those settings while a tenant has the host, and setting the boot order or a one-time boot override so a host boots from the network. The second half is about **site network services**: cloud-init user-data for first-boot OS setup, NTP for clocks, DNS (authoritative and recursive), DHCP with relays, and the out-of-band (OOB) management network that connects them all to the BMCs.

NICo needs all of this before it can manage a single host. It finds BMCs when their relayed DHCP requests reach `nico-dhcp`. It sets BMC clocks from enterprise NTP servers before ingestion. It runs its own authoritative DNS plus an `unbound` recursive resolver. Its PXE Service serves iPXE scripts and cloud-init user-data. Through Redfish it sets the boot order and enforces UEFI lockdown. If one of these is misconfigured, hosts never appear, TLS to BMCs fails, or machines boot the wrong thing.

Every lesson has a small exercise you can run on a laptop. The build task at the end puts them together into a miniature OOB site inside one Docker container. A mock BMC gets its address through a DHCP relay, resolves names, syncs its clock, and is then told over Redfish to change a BIOS setting and network-boot once.

**By the end of this chapter you can:**

- Stage a BIOS attribute change through a Redfish settings object and explain why it only applies after a reboot
- Choose between a permanent boot order change and a one-time or continuous boot source override, and apply each through Redfish
- Explain how UEFI lockdown, per-device UEFI passwords and disabled in-band BMC access together stop a tenant from changing firmware configuration
- Write and validate cloud-init user-data, and describe where NICo's PXE Service fits in first boot
- Tell authoritative and recursive DNS apart with dig, and describe how nico-dns, unbound and NTP (enterprise servers and nico-ntp) serve a NICo site
- Configure a DHCP relay that forwards BMC requests from an OOB segment to a central DHCP server, and troubleshoot a BMC that is never discovered

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [UEFI/BIOS settings](#uefi-bios-settings)
2. [UEFI lockdown](#uefi-lockdown)
3. [Boot order and boot source override](#boot-order-and-boot-source-override)
4. [cloud-init](#cloud-init)
5. [NTP time synchronization](#ntp-time-synchronization)
6. [DNS (authoritative and recursive)](#dns)
7. [DHCP](#dhcp)
8. [Out-of-band (OOB) management network](#out-of-band-management-network)
9. [Build task: A miniature OOB site: discover, name, time-sync and network-boot a mock BMC](#build-task)

<a id="uefi-bios-settings"></a>
## 1. UEFI/BIOS settings

*Builds on: Redfish API (ch. 6)*

### Before you read

- You send a Redfish PATCH that changes a BIOS setting, and it returns success. You immediately GET the BIOS resource. Do you expect to see the new value? Guess before reading.
- Why would a bare-metal control plane care about BIOS settings at all, rather than leaving them at factory defaults?

<details>
<summary>Answers</summary>

- **You send a Redfish PATCH that changes a BIOS setting, and it returns success. You immediately GET the BIOS resource. Do you expect to see the new value? Guess before reading.** Usually not. On most BMCs the write goes to a separate *pending settings* object. The live BIOS resource keeps showing the old value until the next reboot, when the firmware applies the pending change.
- **Why would a bare-metal control plane care about BIOS settings at all, rather than leaving them at factory defaults?** Features that workloads depend on, such as SR-IOV, virtualization extensions and UEFI boot mode, are switched on or off in firmware. Across a fleet these settings have to be consistent and correct, or the same OS image behaves differently on different hosts.

</details>

### Explanation

**BIOS/UEFI settings** are the firmware's configuration: the options you would otherwise change in the setup menu during boot. Examples are boot mode, virtualization support, SR-IOV, power profiles and boot devices. Firmware stores them as a set of named **attributes**, each with a value such as `"SriovGlobalEnable": "Disabled"`.

Redfish (ch. 6) exposes these attributes under the system resource:

- `GET /redfish/v1/Systems/{id}/Bios` returns `Attributes`, the **current** values the firmware is using now.
- The same response usually includes `@Redfish.Settings.SettingsObject.@odata.id`. This points at a second resource, often `.../Bios/Settings`, that holds **pending** values.
- You change settings by sending a `PATCH` with `{"Attributes": {...}}` to the pending object, not to the live one.
- Pending values are applied when the server next reboots. The firmware reads them early in POST, writes them into its configuration store, and the live `Bios` resource then shows them.

There are two reasons for this split. Many settings can only change safely while the OS is not running, and keeping the change separate lets you stage several changes and apply them with one reboot. A reset type from ch. 6 (for example `ForceRestart`) is what makes them take effect.

Attribute **names and allowed values are vendor-specific**. Most BMCs publish an attribute registry that describes them. Code that manages a mixed fleet needs per-vendor mappings, which is one reason fleet tooling detects the vendor (ch. 6).

Where NICo fits: the docs say NICo manages host firmware (UEFI and BMC) out-of-band, enforces security lockdown, and requires BMCs to support boot order configuration and the Secure Boot toggle through Redfish. Site Explorer records configuration data from each BMC, including boot order and lockdown mode. The debug web UI at `/admin` lets operators make BMC changes through HTTP POST in a peer-reviewed, auditable way. The docs do **not** list which BIOS attributes, if any, NICo writes. `SriovGlobalEnable` in this lesson is a generic illustration of the Redfish mechanism, not a documented NICo setting. Whatever a controller changes this way only lands after a reboot, so it has to be tracked as a state: *staged → rebooted → verified*. That fits the state-machine and idempotency ideas from ch. 4.

**Analogy.** It is like editing the config file of a daemon that only reads its config at startup. Your edit is saved, but nothing changes until you restart. The analogy breaks down in two places. You cannot just restart the daemon here; the whole machine has to reboot. And firmware can reject or adjust a value while applying it, so you always need to read the live resource back afterwards.

### Worked example: Stage and apply a BIOS change on a mock Redfish BMC

**Step 1: Save a mock BMC.**

Real BMCs are expensive, so this is a ~100-line in-memory imitation of the relevant Redfish resources (Python 3.8+, standard library only). It is **not** a real BMC and **not** part of NICo. The build task reuses it, so save it as `mock_bmc.py`:

```python
#!/usr/bin/env python3
"""Tiny in-memory imitation of a few Redfish resources, for labs only."""
import json
import socketserver
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SYS = "/redfish/v1/Systems/1"
BOOT_OPTIONS = {"Boot0001": "Hdd", "Boot0002": "Pxe"}
BOOT_KEYS = {"BootSourceOverrideEnabled", "BootSourceOverrideTarget", "BootOrder"}
ENABLED = {"Disabled", "Once", "Continuous"}
TARGETS = {"None", "Pxe", "Hdd", "Cd", "Usb", "BiosSetup"}

state = {
    "bios": {"SriovGlobalEnable": "Disabled", "BootMode": "Uefi"},
    "pending": {},
    "boot": {
        "BootSourceOverrideEnabled": "Disabled",
        "BootSourceOverrideTarget": "None",
        "BootOrder": ["Boot0001", "Boot0002"],
    },
    "last_boot": "Hdd",
}


def reset():
    """Simulate a reboot: apply pending BIOS changes, then pick a boot device."""
    state["bios"].update(state["pending"])
    state["pending"].clear()
    boot = state["boot"]
    if boot["BootSourceOverrideEnabled"] in ("Once", "Continuous"):
        state["last_boot"] = boot["BootSourceOverrideTarget"]
        if boot["BootSourceOverrideEnabled"] == "Once":
            boot["BootSourceOverrideEnabled"] = "Disabled"
    else:
        state["last_boot"] = BOOT_OPTIONS[boot["BootOrder"][0]]


class Handler(BaseHTTPRequestHandler):
    def send_json(self, code, body):
        data = json.dumps(body, indent=2).encode() + b"\n"
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path == SYS:
            self.send_json(200, {"Id": "1", "Boot": state["boot"],
                                 "Oem": {"Lab": {"LastBootSource": state["last_boot"]}}})
        elif self.path == SYS + "/Bios":
            self.send_json(200, {"Attributes": state["bios"],
                                 "@Redfish.Settings": {"SettingsObject": {"@odata.id": SYS + "/Bios/Settings"}}})
        elif self.path == SYS + "/Bios/Settings":
            self.send_json(200, {"Attributes": state["pending"]})
        else:
            self.send_json(404, {"error": "not found"})

    def do_PATCH(self):
        body = self.read_json()
        if self.path == SYS + "/Bios/Settings":
            attrs = body.get("Attributes", {})
            unknown = sorted(set(attrs) - set(state["bios"]))
            if unknown:
                return self.send_json(400, {"error": f"unknown attributes: {unknown}"})
            state["pending"].update(attrs)
            self.send_json(200, {"Attributes": state["pending"]})
        elif self.path == SYS:
            boot = body.get("Boot", {})
            bad = sorted(set(boot) - BOOT_KEYS)
            if bad:
                return self.send_json(400, {"error": f"unsupported Boot properties: {bad}"})
            if boot.get("BootSourceOverrideEnabled", "Disabled") not in ENABLED:
                return self.send_json(400, {"error": "bad BootSourceOverrideEnabled"})
            if boot.get("BootSourceOverrideTarget", "None") not in TARGETS:
                return self.send_json(400, {"error": "bad BootSourceOverrideTarget"})
            if not set(boot.get("BootOrder", [])) <= set(BOOT_OPTIONS):
                return self.send_json(400, {"error": "unknown boot option in BootOrder"})
            state["boot"].update(boot)
            self.send_json(200, {"Boot": state["boot"]})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == SYS + "/Actions/ComputerSystem.Reset":
            self.read_json()
            reset()
            self.send_response(204)
            self.end_headers()
        else:
            self.send_json(404, {"error": "not found"})


class Server(ThreadingHTTPServer):
    def server_bind(self):
        # Skip HTTPServer's reverse-DNS lookup of the bind address,
        # which can hang for seconds when no resolver is reachable.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


if __name__ == "__main__":
    host = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    print(f"mock BMC on http://{host}:8000{SYS}", flush=True)
    Server((host, 8000), Handler).serve_forever()
```

`Oem.Lab.LastBootSource` is a field invented for this mock. It shows which device the pretend reboot used.

**Step 2: Start it and wait until it answers.**

```bash
python3 mock_bmc.py 127.0.0.1 2>/tmp/mock_bmc.log &
MOCK=$!
SYS=http://127.0.0.1:8000/redfish/v1/Systems/1
for i in $(seq 1 20); do curl -sf $SYS >/dev/null && break; sleep 0.5; done
```
`MOCK=$!` saves the process ID so you can stop exactly this process later.

**Step 3: Read current values and find the settings object.**

```bash
curl -s $SYS/Bios
```
You see `"SriovGlobalEnable": "Disabled"` and `@Redfish.Settings.SettingsObject.@odata.id` pointing at `/redfish/v1/Systems/1/Bios/Settings`. On a real BMC, take this URL from the response rather than hard-coding it, because vendors use different paths.

**Step 4: Stage the change.**

```bash
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"Attributes": {"SriovGlobalEnable": "Enabled"}}' $SYS/Bios/Settings
curl -s $SYS/Bios | grep Sriov      # still "Disabled"
curl -s $SYS/Bios/Settings          # the pending change is here
```
The write succeeded, but the live value has not changed.

**Step 5: Reboot and verify.**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
  -d '{"ResetType": "ForceRestart"}' $SYS/Actions/ComputerSystem.Reset   # 204
curl -s $SYS/Bios | grep Sriov      # now "Enabled"
curl -s $SYS/Bios/Settings          # pending is empty again
```
Reading the value back after the reboot is the step that proves the change took effect. Keep the mock running for the two problems below, then stop it with `kill $MOCK`. Lesson 3 starts a fresh copy.

### Your turn: finish it

With the mock running, fill in the blanks so the command stages `BootMode` = `Uefi` as a pending change (and does not touch the live resource).

```text
curl -s -X ___ -H 'Content-Type: application/json' \
  -d '{"Attributes": {"BootMode": "Uefi"}}' \
  http://127.0.0.1:8000/redfish/v1/Systems/1/___
```

<details>
<summary>Answer</summary>

The method is `PATCH` and the path is `Bios/Settings`:

```bash
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"Attributes": {"BootMode": "Uefi"}}' \
  http://127.0.0.1:8000/redfish/v1/Systems/1/Bios/Settings
```

</details>

### Your turn: on your own

Write a small Python script (standard library only) that brings the mock BMC to a desired BIOS state `{"SriovGlobalEnable": "Enabled"}` **idempotently**. Running it twice must cause at most one reboot, and when the host already complies it must not stage anything or reboot.

<details>
<summary>Hint 1</summary>

Before writing anything, read both `/Bios` (current) and `/Bios/Settings` (pending).

</details>

<details>
<summary>Hint 2</summary>

Only stage attributes where the current value differs from the desired value and the pending value doesn't already contain the desired value.

</details>

<details>
<summary>Hint 3</summary>

Reboot only if some current value still differs from the desired value. Use `urllib.request.Request(url, data=..., method=...)` for PATCH and POST.

</details>

<details>
<summary>Answer</summary>

```python
import json, urllib.request

SYS = "http://127.0.0.1:8000/redfish/v1/Systems/1"
DESIRED = {"SriovGlobalEnable": "Enabled"}

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(SYS + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        raw = r.read()
        return json.loads(raw) if raw else None

current = call("GET", "/Bios")["Attributes"]
pending = call("GET", "/Bios/Settings")["Attributes"]
to_stage = {k: v for k, v in DESIRED.items()
            if current.get(k) != v and pending.get(k) != v}
if to_stage:
    call("PATCH", "/Bios/Settings", {"Attributes": to_stage})
if any(current.get(k) != v for k, v in DESIRED.items()):
    call("POST", "/Actions/ComputerSystem.Reset", {"ResetType": "ForceRestart"})
    print("staged and rebooted")
else:
    print("already compliant")
```
On a fresh mock, the first run prints `staged and rebooted` and the second prints `already compliant`. (If you already applied the change in the worked example, both runs print `already compliant`; restart the mock to see the first case.) A real controller would also re-read `/Bios` after the reboot and record the result, rather than assuming the change worked.

</details>

### Explain it

In your own words: Why does Redfish separate pending settings from current settings instead of writing straight into the live BIOS resource? What would a controller get wrong if it treated a successful PATCH as "done"?

### Check

**1. You PATCH `{"Attributes": {"SriovGlobalEnable": "Enabled"}}` to `/Bios/Settings` and get HTTP 200. Before any reboot, what does `GET /Bios` show for that attribute?**

A. Enabled, because the PATCH succeeded
B. Disabled, the old value, until a reboot applies the pending change
C. An error, because the BIOS is locked until reboot
D. Both values in a list

<details>
<summary>Answer</summary>

**B.** Disabled, the old value, until a reboot applies the pending change

The 200 only means the pending object accepted the change. Firmware applies pending settings during the next boot, so the live resource shows the old value until then. Locking (next lesson) is a separate mechanism.

</details>

**2. On an unfamiliar vendor's BMC, how should code find the URL where pending BIOS changes go?**

A. Always use /redfish/v1/Systems/1/Bios/Settings
B. Read @Redfish.Settings.SettingsObject.@odata.id from the Bios resource
C. Derive it from the UEFI device path of the boot disk
D. Look it up in the DMI platform identity

<details>
<summary>Answer</summary>

**B.** Read @Redfish.Settings.SettingsObject.@odata.id from the Bios resource

Paths differ between vendors. The Bios resource tells you where its settings object lives. Device paths and DMI identify hardware; they do not locate Redfish resources.

</details>

**3. True or false: BIOS attribute names such as `SriovGlobalEnable` are fixed by the Redfish standard and are the same on every vendor's BMC.**

A. True
B. False

<details>
<summary>Answer</summary>

**B.** False

Redfish standardises the container (the `Attributes` object, the settings object, the registry). The attribute names and allowed values come from each vendor's firmware, so fleet tooling needs per-vendor mappings.

</details>

**Sources:** [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md)

<a id="uefi-lockdown"></a>
## 2. UEFI lockdown

*Builds on: UEFI firmware and Secure Boot (ch. 5), UEFI/BIOS settings (ch. 8)*

### Before you read

- A tenant has root on a bare-metal server but no access to the BMC network. List two ways they might still try to change its firmware settings.
- Why not let tenants change BIOS settings and simply reset them when the host is released?

<details>
<summary>Answers</summary>

- **A tenant has root on a bare-metal server but no access to the BMC network. List two ways they might still try to change its firmware settings.** (1) Reboot and open the firmware setup menu through the console. (2) From the running OS, use an in-band path to the BMC, such as IPMI over the local driver (`/dev/ipmi0`), a Redfish Host Interface (a USB network link from host to BMC) or vendor tools, to change BIOS or BMC settings. Writing UEFI variables from the OS is a related path.
- **Why not let tenants change BIOS settings and simply reset them when the host is released?** Some changes persist or are hard to detect. A tampered firmware configuration could affect the next tenant or undermine the measured-boot trust that NICo re-establishes. Prevention is stronger than cleaning up afterwards.

</details>

### Explanation

NICo treats every host as untrustworthy by default. Once a tenant has root on a machine, the main firmware risk is that they change its configuration: disabling security features, changing boot behaviour, or leaving something behind for the next tenant. **UEFI lockdown** is how NICo prevents this. It is not one switch. Several controls each close a different path:

1. **Lock the settings.** Many BMCs offer a lockdown mode that freezes BIOS/BMC configuration so it cannot be changed. NICo enables UEFI lockdown *during active use*, which prevents unauthorized BIOS changes while a tenant has the host. Site Explorer records each host's lockdown mode along with its boot order.
2. **Password-protect the setup menu.** NICo manages **per-device UEFI passwords**. Before ingestion, operators set site-wide UEFI defaults for hosts and DPUs with `nico-admin-cli` (for example `credential add-uefi --kind=host` and `--kind=dpu`), and Site Explorer refuses to run until they exist. A tenant watching the serial console during boot therefore cannot open setup without the password.
3. **Remove the in-band back door.** A host OS can often talk to its own BMC without using the network. NICo disables in-band BMC access from within the host, so management is out-of-band only, through the OOB network that NICo controls.

Lockdown is different from **Secure Boot** (ch. 5). Secure Boot checks that boot code is signed. Lockdown stops configuration from changing. You need both, because a tenant who could change settings might simply turn Secure Boot off.

Lockdown also has a lifecycle. The docs say two things: NICo enables lockdown during active use, and it schedules UEFI and BMC firmware updates on healthy, unoccupied hosts. They do not spell out the exact sequence. A reasonable model of how the pieces fit, and **not** a documented NICo workflow, is: while no tenant holds the host, unlock, make the change, re-lock before the host is assigned again, and let measured-boot attestation check that the host is in the expected state. What the docs do state is that NICo never relies on in-band host reporting for security decisions, so any such checks happen out-of-band.

**Analogy.** A hotel room: the guest has the key and full use of the room, but the thermostat's service panel is locked, the maintenance phone line in the wall is disconnected, and only staff with a master key can reconfigure anything between guests. The analogy breaks down in one way: hotel staff walk in physically, while NICo does its management remotely over the OOB network, and it checks hosts with cryptographic measurements instead of a visual inspection.

### Worked example: Audit the in-band firmware paths on a Linux machine

**Step 1: Check whether the machine boots with UEFI.**

```bash
[ -d /sys/firmware/efi ] && echo UEFI || echo "legacy BIOS (or not Linux)"
```
On UEFI systems, the OS can see firmware variables. That is one way into firmware state.

**Step 2: Look at the UEFI variables the OS can see.**

```bash
ls /sys/firmware/efi/efivars 2>/dev/null | head
mokutil --sb-state 2>/dev/null || echo "mokutil not installed"
```
You see entries like `BootOrder-8be4df61-...`. The OS can read, and with root sometimes write, these variables. Secure Boot and firmware lockdown limit what such writes can achieve.

**Step 3: Look for an in-band IPMI channel to a BMC.**

```bash
ls -l /dev/ipmi* 2>/dev/null || echo "no IPMI device"
lsmod 2>/dev/null | grep -i ipmi || true
```
A laptop has none. On a server with a BMC, `/dev/ipmi0` lets root run tools like `ipmitool` against the local BMC without any network access.

**Step 4: Look for a Redfish Host Interface.**

```bash
sudo dmidecode -t 42 2>/dev/null || echo "dmidecode not available"
```
SMBIOS type 42 ("Management Controller Host Interface") advertises a host-to-BMC link, typically a USB network interface that carries Redfish. dmidecode always prints a header first: its version and a line like `SMBIOS 3.3.0 present.` If nothing follows that header, meaning no `Handle ...` entry titled `Management Controller Host Interface`, the machine has no Host Interface.

**Step 5: Map each path to its control.**

| Path you found | Control that closes it |
|---|---|
| Firmware setup menu via console | Per-device UEFI password |
| `/dev/ipmi0`, Redfish Host Interface | Disable in-band host-to-BMC access |
| Changing BIOS settings at all while assigned | UEFI lockdown during active use |
| Booting unsigned code | Secure Boot (ch. 5) |
| Anything that slipped through | Out-of-band checks and measured-boot attestation |

### Your turn: finish it

This toy policy function decides whether a BIOS write is allowed. Fill in the blanks so that in-band writes are never allowed, and out-of-band writes are only allowed when no tenant has the host.

```text
def bios_write_allowed(source, host_assigned):
    """source is 'oob' (site controller over the OOB network) or 'inband' (from the host OS)."""
    if source == "inband":
        return ___
    return not ___


assert bios_write_allowed("inband", False) is False
assert bios_write_allowed("oob", True) is False
assert bios_write_allowed("oob", False) is True
```

<details>
<summary>Answer</summary>

```python
def bios_write_allowed(source, host_assigned):
    """source is 'oob' (site controller over the OOB network) or 'inband' (from the host OS)."""
    if source == "inband":
        return False
    return not host_assigned
```
In-band writes are refused (that path is disabled), and out-of-band writes wait until the host is unassigned (lockdown during active use). This is a teaching model, not NICo code.

</details>

### Your turn: on your own

A BIOS setting on 200 hosts needs fixing. 150 of them are currently assigned to tenants. Using the model from this lesson (it is built from documented pieces, not a documented NICo procedure), describe how the fix could be rolled out so that lockdown is respected and every host ends up both fixed and locked. Name each step and say what is checked out-of-band.

<details>
<summary>Hint 1</summary>

Lockdown stays on while a tenant has the host, so ask when each host becomes eligible.

</details>

<details>
<summary>Hint 2</summary>

The docs say NICo schedules firmware work on healthy, unoccupied hosts. Think about what happens between release and the next assignment.

</details>

<details>
<summary>Hint 3</summary>

One reasonable order is: unlock → stage → reboot → verify → re-lock → attest, with every check going through the BMC rather than the host OS.

</details>

<details>
<summary>Answer</summary>

Fix the 50 unassigned hosts first. Leave the 150 assigned hosts alone until each is released, because lockdown stays on during active use and must not be bypassed. For each eligible (healthy, unoccupied) host: (1) unlock out-of-band; (2) stage the BIOS change in the Redfish settings object; (3) reboot so it applies; (4) read the live Bios resource back over Redfish to confirm the value; (5) re-enable lockdown and confirm the lockdown mode; (6) run measured-boot attestation before the host can be assigned again. Every check goes through the BMC, never through software inside the host. Assigned hosts receive the fix after release, before their next assignment. This sequence is a reasonable model; the docs confirm the ingredients (lockdown during active use, firmware work on unoccupied hosts, out-of-band monitoring, measured-boot attestation) but not this exact order.

</details>

### Explain it

In your own words: Explain in your own words why NICo needs both lockdown and disabled in-band BMC access, and why either one alone would leave a gap.

### Check

**1. A tenant runs `ipmitool` on the host OS to change a BMC setting through `/dev/ipmi0`. Which control is aimed at exactly this path?**

A. Secure Boot
B. Disabling in-band host-to-BMC access
C. The per-device UEFI password
D. DHCP relay on the OOB switch

<details>
<summary>Answer</summary>

**B.** Disabling in-band host-to-BMC access

`/dev/ipmi0` is an in-band channel from the host to its BMC. Secure Boot checks boot-code signatures, and the UEFI password protects the setup menu. Neither covers an OS-level BMC channel. DHCP relay has nothing to do with it.

</details>

**2. "Secure Boot is enabled, so UEFI lockdown adds nothing." Why is this wrong?**

A. It is correct; Secure Boot already blocks all BIOS changes
B. Secure Boot verifies signed boot code; lockdown stops configuration changes, including someone turning Secure Boot off
C. Lockdown is just a different name for Secure Boot
D. Secure Boot only works on DPUs

<details>
<summary>Answer</summary>

**B.** Secure Boot verifies signed boot code; lockdown stops configuration changes, including someone turning Secure Boot off

They protect different things. Without lockdown, the Secure Boot toggle itself is a setting a tenant could change.

</details>

**3. When does NICo keep UEFI lockdown enabled?**

A. Only during initial discovery
B. While a tenant has the host (active use)
C. Never; it relies on attestation instead
D. Only while firmware updates run

<details>
<summary>Answer</summary>

**B.** While a tenant has the host (active use)

The docs describe UEFI lockdown during active use, which prevents unauthorized BIOS changes while a tenant has the host. Firmware updates are scheduled on unoccupied hosts, and attestation is an additional check, not a replacement.

</details>

**Sources:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md)

<a id="boot-order-and-boot-source-override"></a>
## 3. Boot order and boot source override

*Builds on: UEFI/BIOS settings (ch. 8), UEFI firmware and Secure Boot (ch. 5)*

### Before you read

- A server's boot order is Disk, then Network. You want it to boot from the network exactly once to reinstall, then go back to normal on its own. What do you change?
- Why might a control plane want every managed host to try the network before the local disk on every boot?

<details>
<summary>Answers</summary>

- **A server's boot order is Disk, then Network. You want it to boot from the network exactly once to reinstall, then go back to normal on its own. What do you change?** Leave the boot order alone and set a **one-time boot override** to the network (in Redfish: `BootSourceOverrideEnabled: Once`, `BootSourceOverrideTarget: Pxe`), then reboot. The next boot uses the override and later boots follow the normal order.
- **Why might a control plane want every managed host to try the network before the local disk on every boot?** The network boot server then decides on each boot what the host should run: an installer, a discovery agent, or simply "continue to local disk". Control stays on the server side and does not depend on whatever happens to be on the disk.

</details>

### Explanation

UEFI's boot manager (ch. 5) keeps a list of **boot options**, the `Boot0000`, `Boot0001`, … variables. Each one names a device path, such as a disk partition or a network interface's PXE/HTTP boot. A separate `BootOrder` variable lists which options to try, in order. UEFI also has `BootNext`, which is used for one boot and then cleared.

Redfish exposes this on the ComputerSystem resource under `Boot`:

- `BootOrder`: the **persistent** order, as references like `["Boot0001", "Boot0002"]`. Changing it affects every future boot.
- `BootSourceOverrideTarget`: a device *class* to boot instead, such as `Pxe`, `Hdd`, `Cd`, `Usb`, `BiosSetup` or `None`. Many BMCs list the allowed values in `BootSourceOverrideTarget@Redfish.AllowableValues`.
- `BootSourceOverrideEnabled`: `Disabled`, `Once` (the next boot only; the BMC sets it back to `Disabled` afterwards) or `Continuous` (every boot until you change it).
- `BootSourceOverrideMode`: `UEFI` or `Legacy` on BMCs that support it.

You set these with `PATCH /redfish/v1/Systems/{id}` and a `{"Boot": {...}}` body. Nothing happens until the machine resets, so a controller usually sends the PATCH and then a reset action.

**Which one to use:** use an override for one-off actions like "reinstall now", and change the boot order when you want a permanent policy.

In NICo: BMCs must support boot order configuration through Redfish, which NICo uses to set the UEFI boot order with the DPU first, so the host boots from the network through its DPU. Managed hosts are configured to always boot from PXE. NICo's PXE Service fetches the correct artifact for each host from NICo Core, and if a local bootable device is found the host boots it. Site Explorer records boot order, and operators can change boot orders from the debug web UI.

**Analogy.** A GPS has a saved route preference ("avoid tolls"), which is the boot order, and a "detour for this trip only", which is a `Once` override. The analogy breaks down because you have to arm the detour before starting the car, and it is the BMC, not the driver, that clears it after one trip. Some firmware also reorders or ignores entries it cannot use.

### Worked example: One-time PXE boot vs. continuous override on the mock BMC

**Step 1: Start a fresh copy of the mock from Lesson 1.**

```bash
pkill -f mock_bmc.py 2>/dev/null; sleep 0.5   # stop any copy left over from Lesson 1
python3 mock_bmc.py 127.0.0.1 2>/tmp/mock_bmc.log &
MOCK=$!
SYS=http://127.0.0.1:8000/redfish/v1/Systems/1
for i in $(seq 1 20); do curl -sf $SYS >/dev/null && break; sleep 0.5; done
curl -s $SYS
```
Stopping the old copy first matters: a second copy cannot bind port 8000, and its `Address already in use` error would only appear in `/tmp/mock_bmc.log`. `BootOrder` is `["Boot0001", "Boot0002"]` (Hdd, then Pxe) and the override is `Disabled`.

**Step 2: Arm a one-time PXE override.**

```bash
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"Boot": {"BootSourceOverrideEnabled": "Once", "BootSourceOverrideTarget": "Pxe"}}' $SYS
```

**Step 3: Reboot and see the override used up.**

```bash
RESET='{"ResetType": "ForceRestart"}'
curl -s -X POST -H 'Content-Type: application/json' -d "$RESET" $SYS/Actions/ComputerSystem.Reset
curl -s $SYS | grep -E 'LastBootSource|OverrideEnabled'
```
`LastBootSource` is `Pxe` and `BootSourceOverrideEnabled` has gone back to `Disabled`.

**Step 4: Reboot again: back to the normal order.**

```bash
curl -s -X POST -H 'Content-Type: application/json' -d "$RESET" $SYS/Actions/ComputerSystem.Reset
curl -s $SYS | grep LastBootSource      # Hdd
```

**Step 5: Compare with Continuous.**

```bash
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"Boot": {"BootSourceOverrideEnabled": "Continuous", "BootSourceOverrideTarget": "Pxe"}}' $SYS
for n in 1 2; do curl -s -X POST -H 'Content-Type: application/json' -d "$RESET" $SYS/Actions/ComputerSystem.Reset; done
curl -s $SYS | grep -E 'LastBootSource|OverrideEnabled'   # Pxe, Continuous
```
On a real Linux UEFI machine, `sudo efibootmgr` shows the in-band equivalents (`BootCurrent`, `BootOrder`), and `sudo efibootmgr -n 0002` sets a one-time `BootNext`. NICo uses the out-of-band Redfish route instead, because it does not trust the host OS. Keep the mock running for the problems below, then stop it with `kill $MOCK`.

### Your turn: finish it

Make PXE the **permanent** first boot choice on the mock (Boot0002 is Pxe, Boot0001 is Hdd) by changing the boot order, not the override. Fill in the blank.

```text
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"Boot": {"BootOrder": [___]}}' \
  http://127.0.0.1:8000/redfish/v1/Systems/1
```

<details>
<summary>Answer</summary>

`"Boot0002", "Boot0001"`, giving:

```bash
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"Boot": {"BootOrder": ["Boot0002", "Boot0001"]}}' \
  http://127.0.0.1:8000/redfish/v1/Systems/1
```
First set the override back to `Disabled` (for example, PATCH `{"Boot": {"BootSourceOverrideEnabled": "Disabled"}}`) if you left `Continuous` on. After any reset, `LastBootSource` is `Pxe`, and it stays that way.

</details>

### Your turn: on your own

Write `netboot_once.sh`. It should arm a one-time PXE boot on the mock, reset the system, and then *verify*, exiting non-zero on failure, that the host booted from PXE and that the override was used up. The BMC URL should come from a `SYS` environment variable with a sensible default.

<details>
<summary>Hint 1</summary>

Three HTTP calls: a PATCH on the system, a POST to the reset action, a GET to verify.

</details>

<details>
<summary>Hint 2</summary>

Use `curl -sf` so HTTP errors fail the script, and `set -e`.

</details>

<details>
<summary>Hint 3</summary>

Parse the GET with `python3 -c` and `json.load(sys.stdin)`, then assert on `Oem.Lab.LastBootSource` and `Boot.BootSourceOverrideEnabled`.

</details>

<details>
<summary>Answer</summary>

```sh
#!/bin/sh
set -e
SYS=${SYS:-http://127.0.0.1:8000/redfish/v1/Systems/1}
H='Content-Type: application/json'
curl -sf -H "$H" -X PATCH \
  -d '{"Boot":{"BootSourceOverrideEnabled":"Once","BootSourceOverrideTarget":"Pxe"}}' "$SYS" >/dev/null
curl -sf -H "$H" -X POST -d '{"ResetType":"ForceRestart"}' \
  "$SYS/Actions/ComputerSystem.Reset" >/dev/null
curl -sf "$SYS" | python3 -c '
import json, sys
s = json.load(sys.stdin)
assert s["Oem"]["Lab"]["LastBootSource"] == "Pxe", "did not boot from PXE"
assert s["Boot"]["BootSourceOverrideEnabled"] == "Disabled", "override not consumed"
print("one-time PXE boot OK")'
```
On real hardware you would read the boot result from logs or from what the PXE server saw, not from a mock-only OEM field.

</details>

### Explain it

In your own words: Why does NICo set hosts to try the network first on every boot, rather than arming a one-time PXE override each time it wants to reinstall? Which approach depends more on the host's disk contents?

### Check

**1. You set `BootSourceOverrideEnabled: Once` with target `Pxe`, then reboot twice. Which devices do the two boots use?**

A. Pxe, then Pxe
B. Pxe, then whatever BootOrder says
C. BootOrder both times, since Once needs a BIOS settings change
D. Nothing changes until you also edit BootOrder

<details>
<summary>Answer</summary>

**B.** Pxe, then whatever BootOrder says

`Once` applies to the next boot only, and then the BMC sets it back to `Disabled`. `Continuous` would give Pxe both times. Overrides are separate from BIOS attributes and from BootOrder.

</details>

**2. You PATCH a boot override but never reset the server. What has happened?**

A. The server rebooted automatically into PXE
B. Nothing visible yet; the override waits for the next boot
C. The BootOrder was rewritten permanently
D. The BMC rejected it because no reset was included

<details>
<summary>Answer</summary>

**B.** Nothing visible yet; the override waits for the next boot

Overrides, like pending BIOS settings, are acted on when the system boots. Making that happen is a separate reset action.

</details>

**3. Which in-band UEFI feature is closest to a Redfish `Once` override?**

A. BootOrder
B. BootNext
C. Secure Boot db
D. The DMI system UUID

<details>
<summary>Answer</summary>

**B.** BootNext

`BootNext` is used for one boot and then cleared, just like `Once`. `BootOrder` is persistent. The other two are unrelated to boot device choice.

</details>

**Sources:** [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md)

<a id="cloud-init"></a>
## 4. cloud-init

### Before you read

- Every customer gets the same OS image. How does each machine end up with its own hostname, users and SSH keys on its first boot?
- If cloud-init's `runcmd` installs a package, does that command run again on every reboot?

<details>
<summary>Answers</summary>

- **Every customer gets the same OS image. How does each machine end up with its own hostname, users and SSH keys on its first boot?** An agent inside the image, cloud-init, runs early in boot. It finds per-machine data (meta-data and user-data) from a *datasource*, such as a local seed disk or an HTTP endpoint, and applies it.
- **If cloud-init's `runcmd` installs a package, does that command run again on every reboot?** No. `runcmd` runs once per instance (tracked by the instance-id). Commands that must run on every boot go in `bootcmd`.

</details>

### Explanation

**cloud-init** is the standard tool, across many Linux distributions, for configuring an OS the first time it boots. The image is generic. What makes a machine unique is data handed to it at boot:

- **meta-data**: facts about the instance, most importantly an `instance-id` (and often a hostname).
- **user-data**: what the owner wants done. Usually it is a YAML file whose **first line must be `#cloud-config`**. It can also be a shell script starting with `#!`.
- **vendor-data** (optional): defaults from the platform operator.

cloud-init gets this data from a **datasource**. **NoCloud** reads it from a local disk labelled `cidata` or from an HTTP URL given on the kernel command line (`ds=nocloud;s=http://server/path/`). Cloud providers use their own metadata services.

The run is split into stages (local, network, config, final). Each module, such as `users`, `ntp`, `write_files`, `packages` or `runcmd`, has a frequency. Most run **once per instance**: cloud-init records the instance-id and skips them on later boots unless the id changes. `bootcmd` runs on every boot. Logs are in `/var/log/cloud-init.log` and `/var/log/cloud-init-output.log`, and `cloud-init status --wait` blocks until it finishes. `cloud-init schema --config-file FILE` validates a cloud-config before you rely on it.

In NICo, the **PXE Service** serves boot artifacts to managed hosts and DPUs over HTTP: iPXE scripts, **cloud-init user-data** and OS images. It fetches the right artifact for each host from the API Service, so the user-data a host receives depends on what NICo knows about that host. NICo uses cloud-init in two ways. DPUs get a NICo-provided cloud-init file that installs NICo components on top of the base DPU image. Tenants can supply their own cloud-init configuration to set up the OS they chose for the host. NICo works with any OS installable through iPXE.

**Analogy.** cloud-init is like a new employee's onboarding packet. Everyone gets the same laptop image, and the packet tells this particular laptop whose it is and what to install. Like a real packet, it is mostly read once: re-reading it on every login would be wasteful or harmful. The analogy breaks down because cloud-init remembers "already onboarded" through the instance-id. Give the same machine a new instance-id and it onboards from scratch, which no employee would do.

### Worked example: Write, validate and serve cloud-init user-data

**Step 1: Write user-data and meta-data.**

```bash
mkdir -p ~/ci-demo && cd ~/ci-demo
cat > user-data <<'EOF'
#cloud-config
hostname: lab-host-01
users:
  - name: ops
    groups: [sudo]
    shell: /bin/bash
    ssh_authorized_keys:
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnlyForTheLab ops@laptop
ntp:
  enabled: true
  servers: [ntp.oob.lab]
runcmd:
  - [sh, -c, 'echo "provisioned at $(date -u)" > /etc/motd']
EOF
printf 'instance-id: lab-host-01-v1\nlocal-hostname: lab-host-01\n' > meta-data
```

**Step 2: Validate it with the real cloud-init.**

```bash
docker run --rm -v "$PWD:/w" ubuntu:24.04 sh -c \
  'apt-get update -qq && apt-get install -y -qq cloud-init >/dev/null 2>&1 && cloud-init schema --config-file /w/user-data'
```
Expect a line beginning `Valid schema`. (Podman works the same way with `podman run`.)

**Step 3: Break it on purpose.**

Change `hostname: lab-host-01` to `hostname: [lab, host]` and rerun. The schema check reports that `hostname` is not of type string. Change it back. Validating before serving catches typos that would otherwise fail silently on a remote machine.

**Step 4: Serve it over HTTP, like a PXE service would.**

```bash
python3 -m http.server 8080 --bind 127.0.0.1 2>/tmp/ci-http.log &
HTTP_PID=$!
for i in $(seq 1 20); do curl -sf http://127.0.0.1:8080/user-data >/dev/null && break; sleep 0.5; done
curl -s http://127.0.0.1:8080/user-data | head -3
kill $HTTP_PID
```
Saving `$!` right after the start means `kill` stops exactly this server, even if other background jobs (such as a mock BMC) are still running. A NoCloud client booted with `ds=nocloud;s=http://<server>:8080/` on its kernel command line would fetch `meta-data` and `user-data` from this URL. Optional: `cloud-localds seed.img user-data meta-data` (package `cloud-image-utils`) builds a seed disk you can attach to an Ubuntu cloud image in QEMU to watch the whole first boot.

### Your turn: finish it

Fill in the two blanks so this is valid cloud-config that installs nginx and then enables it once on first boot.

```text
___
hostname: web-01
package_update: true
packages:
  - nginx
___:
  - [systemctl, enable, --now, nginx]
```

<details>
<summary>Answer</summary>

```yaml
#cloud-config
hostname: web-01
package_update: true
packages:
  - nginx
runcmd:
  - [systemctl, enable, --now, nginx]
```
Without the `#cloud-config` header, cloud-init does not treat the file as cloud-config at all. `runcmd` runs once per instance, after packages are installed.

</details>

### Your turn: on your own

Write user-data for a host in this chapter's lab. It should create a user `ops` with passwordless sudo and your SSH key, use `ntp.oob.lab` as its NTP server, and write `/etc/motd` with a fixed message using a file-writing module (not `runcmd`). Validate it with `cloud-init schema`. Then answer: if the host reboots with the same instance-id, which of these steps run again?

<details>
<summary>Hint 1</summary>

The modules you need are `users`, `ntp` and `write_files`.

</details>

<details>
<summary>Hint 2</summary>

In `users`, `sudo: "ALL=(ALL) NOPASSWD:ALL"` gives passwordless sudo. `write_files` entries take `path` and `content`.

</details>

<details>
<summary>Hint 3</summary>

Think about module frequency: these are per-instance modules.

</details>

<details>
<summary>Answer</summary>

```yaml
#cloud-config
users:
  - name: ops
    groups: [sudo]
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnlyForTheLab ops@laptop
ntp:
  enabled: true
  servers: [ntp.oob.lab]
write_files:
  - path: /etc/motd
    content: |
      Provisioned by cloud-init. Firmware changes go through the site controller.
```
On a reboot with the same instance-id, none of these run again, because they are per-instance. If you need something on every boot, put it in `bootcmd`. Note that listing `users:` without `default` also skips creating the image's default user.

</details>

### Explain it

In your own words: Why does cloud-init key its "already done" record on the instance-id instead of simply running everything on every boot? What would go wrong for a bare-metal host that is released and handed to a new tenant if the instance-id did not change?

### Check

**1. A user-data file starts with `hostname: web-01` and has no `#cloud-config` line. What happens?**

A. cloud-init parses it as YAML anyway
B. It is not recognised as cloud-config, so the settings are not applied
C. cloud-init runs it as a shell script
D. The machine refuses to boot

<details>
<summary>Answer</summary>

**B.** It is not recognised as cloud-config, so the settings are not applied

cloud-init uses the first line to decide what kind of user-data it has. Shell scripts need `#!`. Cloud-config needs `#cloud-config`. Without either, the content is not treated as configuration.

</details>

**2. Which cloud-init key is meant for commands that run on *every* boot?**

A. runcmd
B. bootcmd
C. write_files
D. packages

<details>
<summary>Answer</summary>

**B.** bootcmd

`runcmd`, `write_files` and `packages` run once per instance by default. `bootcmd` runs early on every boot.

</details>

**3. In NICo, which component serves cloud-init user-data to managed hosts?**

A. nico-dhcp
B. The PXE Service, over HTTP
C. The host's BMC through Redfish
D. The DPU Agent's metadata service

<details>
<summary>Answer</summary>

**B.** The PXE Service, over HTTP

The PXE Service serves iPXE scripts, cloud-init user-data and OS images over HTTP, fetching the right artifact for each host from the API Service. DHCP hands out addresses and options. FMDS gives running instances metadata, but the docs name the PXE Service for user-data.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md)

<a id="ntp-time-synchronization"></a>
## 5. NTP time synchronization

### Before you read

- A BMC's clock says 2019-01-01, but it is actually 2026. A controller connects to it over HTTPS. What could go wrong?
- Why can't you set every clock correctly once at install and leave it?

<details>
<summary>Answers</summary>

- **A BMC's clock says 2019-01-01, but it is actually 2026. A controller connects to it over HTTPS. What could go wrong?** TLS certificate validity checks compare dates against the clock. A certificate issued in 2025 looks "not yet valid" to a machine that thinks it is 2019, so connections or certificate installation can fail. Log timestamps are also wrong, which makes incidents hard to piece together.
- **Why can't you set every clock correctly once at install and leave it?** Hardware clocks drift (seconds per day is common). Some devices also lose time when powered off or reset. Clocks need continuous correction against a reference.

</details>

### Explanation

**NTP (Network Time Protocol)** keeps clocks in agreement over the network. A client sends a small UDP packet to port **123**. The server replies with timestamps recording when it received the request and when it sent the reply. From these and its own send and receive times, the client works out the **offset** (how far its clock is off) and the **delay** (the network round trip), then gradually corrects its clock.

Key terms:

- **Stratum**: the distance from a reference clock. Stratum 1 servers are attached directly to GPS or atomic references; a server syncing from stratum 1 is stratum 2, and so on. Stratum 0 in a reply means "unsynchronised" or a special message.
- **Leap indicator**: two bits in the reply. A value of 3 means the server's clock is not synchronised.
- **SNTP**: a simplified one-shot query, enough to read a server's time.
- **chrony**, **ntpd** and **systemd-timesyncd** are common implementations. chrony is the usual choice for servers.
- Clients can learn NTP servers from DHCP: option **42** for IPv4, option **56** for DHCPv6.

NTP timestamps count seconds from 1900, not from 1970 like Unix time, so code subtracts 2208988800 to convert.

How NICo uses time:

- `siteConfig.ntp_servers` lists **enterprise NTP server IPs** used for **BMC time setup before ingestion** and for **DHCP option 42**. Leaving it `[]` falls back to a legacy DHCP/DNS method.
- NICo can also run **`nico-ntp`**, a **3-replica chrony StatefulSet** in which each replica gets its own MetalLB VIP. You enable it with `nico-ntp.externalService.enabled: true` and assign three VIPs via `nico-ntp.externalService.perPodAnnotations`. You then list those same VIPs, comma-separated, in `nico-dhcp.config.kea.hookParameters.ntpServer` so **DPUs receive them over DHCP**. The enterprise servers in `ntp_servers` are still used for BMC pre-ingestion sync, independently of `nico-ntp`.
- For IPv6, providing AAAA records under `unbound.localData` for the agent's NTP hostname (`carbide-ntp.forge` by default) lets the DPU-local server advertise NTP through DHCPv6 option 56.

**Analogy.** Like synchronising watches before an operation by calling a speaking clock. You also account for how long the call took to connect, which is the role of the delay calculation. The analogy breaks down because NTP does not jump your watch to the new time. It speeds up or slows down the clock until it matches, so software never sees time run backwards in normal operation.

### Worked example: Query an NTP server by hand

**Step 1: Write a one-shot SNTP client.**

Save as `sntp.py` (the build task reuses it):

```python
import socket
import struct
import sys
import time

NTP_EPOCH_OFFSET = 2208988800  # seconds from 1900-01-01 to 1970-01-01
server = sys.argv[1] if len(sys.argv) > 1 else "pool.ntp.org"
request = b"\x1b" + 47 * b"\0"  # LI=0, version 3, mode 3 (client)
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
    s.settimeout(3)
    s.sendto(request, (server, 123))
    data, _ = s.recvfrom(48)
leap, stratum = data[0] >> 6, data[1]
secs, frac = struct.unpack("!II", data[40:48])  # transmit timestamp
server_time = secs - NTP_EPOCH_OFFSET + frac / 2**32
print(f"server={server} stratum={stratum} leap={leap} "
      f"offset={server_time - time.time():+.3f}s "
      f"time={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(server_time))}")
```

**Step 2: Ask a public server.**

```bash
python3 sntp.py pool.ntp.org
# or: python3 sntp.py time.cloudflare.com
```
Expect stratum 1–3, leap 0, and a small offset (tens of milliseconds) if your laptop is synced. If it times out, your network probably blocks outbound UDP 123.

**Step 3: Compare with your OS's own client.**

```bash
timedatectl 2>/dev/null | grep -i synchron   # systemd Linux
chronyc tracking 2>/dev/null | head -5       # if chrony is installed
sntp time.apple.com 2>/dev/null              # macOS built-in
```
The OS clients keep correcting continuously. Your script only takes one reading.

**Step 4: Relate it to a BMC.**

A BMC fresh from the factory may have a clock that is way off. Before NICo starts trusting TLS sessions and logs from it, it sets the BMC's time from the enterprise NTP servers in `ntp_servers`. Your script shows the same exchange those servers answer.

### Your turn: finish it

Fill in the two blanks in this stripped-down client: the NTP port, and the constant that converts NTP seconds (from 1900) into Unix seconds (from 1970).

```text
import socket, struct, time

with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
    s.settimeout(3)
    s.sendto(b"\x1b" + 47 * b"\0", ("pool.ntp.org", ___))
    data, _ = s.recvfrom(48)
secs = struct.unpack("!I", data[40:44])[0]
print(time.ctime(secs - ___))
```

<details>
<summary>Answer</summary>

The port is `123` and the constant is `2208988800`:

```python
s.sendto(b"\x1b" + 47 * b"\0", ("pool.ntp.org", 123))
...
print(time.ctime(secs - 2208988800))
```

</details>

### Your turn: on your own

A site sets `ntp_servers = ["10.0.0.5", "10.0.0.6"]` (enterprise servers) and enables `nico-ntp` with VIPs 10.180.126.170–172, which are also put in `nico-dhcp.config.kea.hookParameters.ntpServer`. (a) Which servers are used to set a new host BMC's clock before ingestion? (b) Which NTP servers do DPUs learn over DHCP? (c) Why give each chrony replica its own VIP instead of putting one VIP in front of all three?

<details>
<summary>Hint 1</summary>

Read the two NICo facts separately: one is about BMC pre-ingestion time, the other about what the Kea hook hands to DPUs.

</details>

<details>
<summary>Hint 2</summary>

The docs say the enterprise servers continue to be used for BMC pre-ingestion sync *independently* of nico-ntp.

</details>

<details>
<summary>Hint 3</summary>

For (c), think about how an NTP client spots one bad server: it needs several distinct sources to compare. What would a load-balanced single address look like to it?

</details>

<details>
<summary>Answer</summary>

(a) The enterprise servers 10.0.0.5 and 10.0.0.6 from `ntp_servers`. (b) The three nico-ntp VIPs, 10.180.126.170, .171 and .172, via the Kea hook's `ntpServer` list. (c) NTP clients compare several independent sources and discard ones that disagree. Three separate addresses give them three distinct servers. A single load-balanced VIP would look like one server whose clock and delay jump around as packets land on different replicas, so the client could neither compare sources nor stay stable if one replica failed. (General NTP reasoning; the docs state the per-replica VIP design but not the reason.)

</details>

### Explain it

In your own words: Explain why accurate time on a BMC matters to a control plane that talks to it only over HTTPS and Redfish, even though the BMC does not run any tenant workload.

### Check

**1. An NTP reply has stratum 2. What does that tell you?**

A. The server is two network hops away
B. The server syncs from a stratum 1 server, which is attached to a reference clock
C. The clock is off by 2 seconds
D. It is the second reply in a burst

<details>
<summary>Answer</summary>

**B.** The server syncs from a stratum 1 server, which is attached to a reference clock

Stratum counts the distance from a reference clock in the sync hierarchy, not network hops or error size.

</details>

**2. Which DHCPv4 option carries NTP server addresses, and is listed next to `ntp_servers` in NICo's site config?**

A. Option 3
B. Option 6
C. Option 42
D. Option 67

<details>
<summary>Answer</summary>

**C.** Option 42

Option 3 is the router, 6 is DNS servers, and 67 is the boot file name. NICo's docs say `ntp_servers` is used for BMC time setup and DHCP option 42.

</details>

**3. What is `nico-ntp`?**

A. A wrapper that forwards to the enterprise servers in ntp_servers
B. A 3-replica chrony StatefulSet, each replica with its own MetalLB VIP
C. An NTP client that runs on every BMC
D. A Kea hook that rewrites DHCP option 42

<details>
<summary>Answer</summary>

**B.** A 3-replica chrony StatefulSet, each replica with its own MetalLB VIP

nico-ntp is NICo's built-in NTP service. Its VIPs are handed to DPUs over DHCP through the Kea hook parameter, while the enterprise servers continue to handle BMC pre-ingestion sync.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="dns"></a>
## 6. DNS (authoritative and recursive)

*Builds on: IP networking fundamentals (ch. 3)*

### Before you read

- When your laptop looks up `www.example.com`, does the DNS server in your `/etc/resolv.conf` own that name?
- Why would a datacenter control plane run its own DNS server instead of putting records in the company DNS?

<details>
<summary>Answers</summary>

- **When your laptop looks up `www.example.com`, does the DNS server in your `/etc/resolv.conf` own that name?** Almost certainly not. It is a *recursive resolver*. It asks the servers that do own the name (the authoritative servers) for you, then caches the answer.
- **Why would a datacenter control plane run its own DNS server instead of putting records in the company DNS?** It creates and changes machines and addresses all the time, so it is the natural source of truth for their names. Delegating a zone to it lets those names stay accurate automatically.

</details>

### Explanation

DNS turns names into data such as IP addresses. Servers play two very different roles:

- An **authoritative server** owns one or more **zones**, a zone being a part of the name tree such as `mysite.example.com`. It answers only for those zones and marks its answers **authoritative** (the `aa` flag in `dig`). It does not look up anything else.
- A **recursive resolver** answers *any* name for its clients. It starts at the root, follows **NS** (name server) records down through **delegations** (`com` → `example.com` → …) to the authoritative server, then caches the result for its **TTL**. Its replies have the `ra` (recursion available) flag and usually not `aa`.

A **delegation** is an NS record in a parent zone saying "this child zone is served by these servers". That is how a company DNS can hand `mysite.example.com` to a different server. Common record types are **A** (IPv4), **AAAA** (IPv6), **PTR** (reverse lookups, address → name), **CNAME** (alias), **NS** and **SOA**.

NICo runs both kinds:

- **`nico-dns`** is **authoritative for NICo-delegated zones**. The site's base domain is set with `initial_domain_name`. Each `nico-dns` replica gets its own VIP (`perPodAnnotations`), so the parent zone can delegate to several stable addresses.
- **Unbound** is the **recursive resolver** that handles all DNS queries from managed machines and tenant instances over the OOB network. In the docs' words, it **forwards queries for NICo-managed zones to `nico-dns`** and resolves everything else recursively. ("Forwards" is used loosely there; the docs don't show the Unbound config. In Unbound terms, sending a zone to an authoritative server is usually a `stub-zone`, while `forward-zone` is meant for upstream recursive resolvers.) Extra records can be added with `unbound.localData`, for example AAAA records for the NTP hostname.

Separately, your *external* DNS must resolve the `nico-api` hostname to its VIP. Getting names right here also matters later: TLS certificates (ch. 19) list the names they are valid for.

**Analogy.** An authoritative server is a company's own reception desk: it knows exactly who works there and won't answer questions about other companies. A recursive resolver is a concierge who phones the right reception desks for you and remembers the answers for a while. The analogy breaks down because the concierge finds the right desk by asking a chain of directories (root, then TLD, then the domain), and because remembered answers expire after a TTL the desk chooses.

### Worked example: Tell authoritative and recursive answers apart with dig

**Step 1: Ask your normal (recursive) resolver.**

```bash
dig example.com A
```
(`dig` is built into macOS. On Debian/Ubuntu install `bind9-dnsutils`.) In the `flags:` line, look for `rd ra` (recursion desired, recursion available) and usually **no** `aa`. The `SERVER:` line shows which resolver answered.

**Step 2: Find who is authoritative.**

```bash
dig +short NS example.com
```
These are the servers the `.com` zone delegates `example.com` to.

**Step 3: Ask the authoritative server directly, without recursion.**

```bash
NS=$(dig +short NS example.com | head -1)
dig @"$NS" example.com A +norecurse
```
Now the flags include `aa`: this server owns the zone. Its answer comes from zone data, not from a cache.

**Step 4: Ask an authoritative server about a name it doesn't own.**

```bash
dig @"$NS" www.wikipedia.org A +norecurse
```
You get no answer: typically `status: REFUSED`, or an empty answer section with no `aa`. Authoritative servers do not look up other people's names.

**Step 5: Watch the whole recursion.**

```bash
dig +trace example.com
```
This shows root → `com` → `example.com`, which is the path Unbound follows for any non-NICo name a managed machine asks about.

### Your turn: finish it

This is generic Unbound configuration for a resolver that sends one zone, `mysite.example.com`, to an authoritative server at 10.180.126.165 and resolves everything else recursively. It uses `stub-zone`, Unbound's construct for pointing a zone at an authoritative server (`forward-zone` is for upstream recursive resolvers). It illustrates the idea; it is not NICo's chart. Fill in the blanks.

```text
server:
    interface: 0.0.0.0
    access-control: 10.0.0.0/8 allow

stub-zone:
    name: "___"
    stub-addr: ___
```

<details>
<summary>Answer</summary>

```text
stub-zone:
    name: "mysite.example.com"
    stub-addr: 10.180.126.165
```
Queries under that zone go straight to the authoritative server, sent without the recursion-desired flag. Everything else follows normal recursion from the root.

</details>

### Your turn: on your own

Two complaints arrive at a NICo site. (1) A managed host resolves `github.com` fine but gets no answer for `bmc-07.mysite.example.com`. (2) An operator's laptop on the corporate network cannot resolve `nico.mysite.example.com`, the nico-api hostname. For each, say which DNS component is most likely at fault and how you would confirm it with `dig`.

<details>
<summary>Hint 1</summary>

Work out which resolver each client uses: managed machines use Unbound, and the laptop uses corporate DNS.

</details>

<details>
<summary>Hint 2</summary>

For (1), recursion works, so the problem is specific to the NICo zone. What does Unbound do with that zone?

</details>

<details>
<summary>Hint 3</summary>

For (2), the nico-api hostname must resolve in *external* DNS to the nico-api VIP. Check the delegation or record there, and query nico-dns directly to separate the two.

</details>

<details>
<summary>Answer</summary>

(1) Unbound can recurse, so the general resolver works. The NICo-zone path is broken: either Unbound's routing of that zone to `nico-dns` or `nico-dns` itself (missing record, unreachable VIP). Confirm with `dig @<nico-dns-VIP> bmc-07.mysite.example.com +norecurse`. If that gives an `aa` answer, the fault is between Unbound and nico-dns. If it doesn't, the fault is in nico-dns or its data. (2) The laptop uses corporate DNS, which must resolve the nico-api hostname to the nico-api VIP, either as a record or through a delegation to nico-dns. Run `dig nico.mysite.example.com` on the laptop and `dig +short NS mysite.example.com` to see whether a delegation exists. Then query nico-dns directly to see whether it knows the name.

</details>

### Explain it

In your own words: Why does NICo split DNS into an authoritative server for its own zones and a separate recursive resolver for managed machines, instead of one server doing both?

### Check

**1. A `dig` reply has the `aa` flag set. What does that mean?**

A. The answer came from a cache
B. The responding server is authoritative for the zone
C. Authentication succeeded
D. The name has an AAAA record

<details>
<summary>Answer</summary>

**B.** The responding server is authoritative for the zone

`aa` means authoritative answer. Answers from a cache usually lack it. DNSSEC validation shows up as a different flag (`ad`), and `aa` has nothing to do with record types.

</details>

**2. A managed host looks up `pypi.org`. Which NICo component handles the query?**

A. nico-dns, authoritatively
B. Unbound, recursively
C. nico-dhcp
D. The PXE Service

<details>
<summary>Answer</summary>

**B.** Unbound, recursively

Unbound handles all DNS queries from managed machines. It only sends NICo-managed zones to nico-dns and resolves other names recursively.

</details>

**3. Why does each `nico-dns` replica get its own VIP?**

A. So a parent zone can delegate to several stable server addresses
B. Because DNS cannot use load balancers at all
C. To give each tenant its own zone
D. Because DHCP requires it

<details>
<summary>Answer</summary>

**A.** So a parent zone can delegate to several stable server addresses

Delegations list multiple name servers, and resolvers try them individually. Stable per-replica addresses fit that model. The quick start assigns them through `perPodAnnotations`.

</details>

**Sources:** [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="dhcp"></a>
## 7. DHCP

*Builds on: CIDR prefixes and /31 point-to-point subnets (ch. 3)*

### Before you read

- A brand-new BMC has no IP address. How can it send a packet asking for one?
- Broadcasts do not cross routers. How does a DHCP server in a different subnet ever hear that request?

<details>
<summary>Answers</summary>

- **A brand-new BMC has no IP address. How can it send a packet asking for one?** It sends a broadcast from source address 0.0.0.0 to 255.255.255.255, UDP port 68 → 67, identifying itself by its MAC address. Every device on the local segment receives it.
- **Broadcasts do not cross routers. How does a DHCP server in a different subnet ever hear that request?** A DHCP relay agent on the router or switch interface for that segment picks up the broadcast and unicasts it to the server. It records which segment the request came from so the server can choose the right subnet.

</details>

### Explanation

**DHCP (Dynamic Host Configuration Protocol)** gives devices an IP address and network settings automatically. The basic exchange is **DORA**:

1. **Discover**: the client broadcasts "I need an address", including its MAC (client port 68 → server port 67).
2. **Offer**: a server proposes an address.
3. **Request**: the client asks for that offer.
4. **Ack**: the server confirms. The client now holds a **lease** for a set time and renews it before it expires.

The reply also carries **options**: 1 subnet mask, 3 router, 6 DNS servers, 15 domain name, 42 NTP servers, and boot options used by PXE (ch. 12).

**Relays.** Broadcasts stay inside one L2 segment, but you want one central server. A **DHCP relay agent** runs on the router interface (often a switch's VLAN interface) for each segment. It receives the broadcast, writes its own interface address on that segment into the **`giaddr`** field, and unicasts the packet to the configured server. The server uses `giaddr` to choose which subnet to allocate from. Relays can also add option 82, which identifies the switch port. The server replies to the relay, and the relay passes the reply to the client.

In NICo:

- The central **`nico-dhcp`** service answers relayed requests from physical networks: host BMCs, DPU BMCs and DPU OOB interfaces on `Underlay` segments (plus zero-DPU host interfaces on `HostInband`). It is **stateless**. It converts each DHCP request into gRPC and forwards it to **NICo Core**, which does the IP address management.
- **BMC discovery happens through DHCP.** When a BMC asks for an address, NICo allocates one and looks up the MAC in the expected-machines table to find its initial credentials.
- Because switches are configured to relay to it, `nico-dhcp` needs a **stable VIP**. The quick start says to set `externalService.enabled: true` explicitly and pin its MetalLB address, so the relay targets do not change on redeploy.
- A host whose DPU runs in DPU mode gets its own DHCP from a server *on the DPU*. Those requests never reach the underlay.
- The DPU's RJ45 port gets two addresses from NICo: the DPU OOB address and the DPU BMC address.

**Analogy.** A DHCP relay is like an office mailroom. A new employee with no desk drops a note in the local tray saying "I need a desk". The mailroom stamps it "from 3rd floor" (giaddr) and sends it to central facilities, which assigns a desk on the 3rd floor and sends the answer back through the same mailroom. The analogy breaks down because the mailroom forwards only these requests and keeps no record of who sits where: allocation lives entirely with the central server, just as NICo's switches only relay.

### Worked example: Watch DORA between a dnsmasq server and a busybox client

**Step 1: Start a throwaway privileged container.**

```bash
docker run --rm -it --privileged python:3.12-slim bash
# inside:
apt-get update -qq && apt-get install -y -qq iproute2 dnsmasq-base busybox >/dev/null
```
Everything runs inside this one container, using Linux network namespaces. That avoids Docker's routing rules between containers.

**Step 2: Build a two-namespace segment.**

```bash
ip netns add srv; ip netns add cli
ip link add s0 type veth peer name c0 netns cli
ip link set s0 netns srv
ip -n srv addr add 192.168.50.1/24 dev s0
ip -n srv link set s0 up; ip -n cli link set c0 up
```
`cli` has no address yet, like a fresh BMC.

**Step 3: Run a DHCP server.**

```bash
ip netns exec srv dnsmasq --no-daemon --port=0 --interface=s0 --bind-interfaces \
  --dhcp-range=192.168.50.100,192.168.50.150,1h --dhcp-leasefile=/tmp/leases \
  --pid-file=/tmp/dnsmasq.pid --user=root --log-dhcp > /tmp/dnsmasq.log 2>&1 &
sleep 1
```
`--port=0` turns off dnsmasq's DNS so only DHCP runs.

**Step 4: Request a lease.**

```bash
ip netns exec cli busybox udhcpc -i c0 -f -q -n -s /bin/true
```
udhcpc prints `Sending discover...`, `Sending select...` and `Lease of 192.168.50.1xx obtained`. `-s /bin/true` skips applying the address; we only want to see the exchange.

**Step 5: Read DORA from the server's side.**

```bash
grep -E 'DHCP(DISCOVER|OFFER|REQUEST|ACK)' /tmp/dnsmasq.log
cat /tmp/leases
```
You see four lines carrying the client's MAC, and a lease entry tying MAC → IP. NICo's version of the lease entry lives in NICo Core's database, and the MAC is what gets matched against `expected_machines.json`. Type `exit` to discard the container.

### Your turn: finish it

In the build task, the OOB "switch" namespace has address 10.30.0.1 on the BMC segment, and the central DHCP server (standing in for the nico-dhcp VIP) is 10.20.0.10. dnsmasq's relay syntax is `--dhcp-relay=<local address on the client segment>,<server address>`. Fill in the blanks.

```text
ip netns exec oob dnsmasq --keep-in-foreground --port=0 \
  --dhcp-relay=___,___ --pid-file=/tmp/relay.pid --user=root &
```

<details>
<summary>Answer</summary>

```bash
ip netns exec oob dnsmasq --keep-in-foreground --port=0 \
  --dhcp-relay=10.30.0.1,10.20.0.10 --pid-file=/tmp/relay.pid --user=root &
```
10.30.0.1 becomes the `giaddr` on relayed requests, which tells the server to allocate from 10.30.0.0/24. 10.20.0.10 is where requests are sent.

</details>

### Your turn: on your own

The lab's DHCP server config (in the build task) serves one relayed OOB segment, 10.30.0.0/24. Add a second rack segment, 10.31.0.0/24, whose relay address is 10.31.0.1. BMC `02:00:00:00:00:51` should get 10.31.0.50 with the name `bmc-02`, and each segment's clients must get *their own* router. Write the dnsmasq lines for the server, and the relay line for the new switch.

<details>
<summary>Hint 1</summary>

The server picks the range from the giaddr. You need a second `dhcp-range` covering 10.31.0.0/24.

</details>

<details>
<summary>Hint 2</summary>

Options that differ by segment need tags: `dhcp-range=set:NAME,...` and `dhcp-option=tag:NAME,...`.

</details>

<details>
<summary>Hint 3</summary>

The relay for the new switch is `dhcp-relay=10.31.0.1,10.20.0.10`.

</details>

<details>
<summary>Answer</summary>

Server:
```text
dhcp-range=set:oob1,10.30.0.100,10.30.0.200,255.255.255.0,1h
dhcp-range=set:oob2,10.31.0.100,10.31.0.200,255.255.255.0,1h
dhcp-option=tag:oob1,option:router,10.30.0.1
dhcp-option=tag:oob2,option:router,10.31.0.1
dhcp-host=02:00:00:00:00:51,bmc-02,10.31.0.50
```
These replace the single untagged `dhcp-range` and router option. New switch:
```text
dhcp-relay=10.31.0.1,10.20.0.10
```
The server also needs a route back to 10.31.0.0/24 through that switch. NICo's equivalent is defining the segment's prefix and gateway in the site's network configuration and pointing that switch's relay at the nico-dhcp VIP.

</details>

### Explain it

In your own words: Explain why the relay's `giaddr` is enough for one central server to hand out correct addresses on dozens of separate segments, and why that lets NICo's OOB switches stay "dumb" (relay only).

### Check

**1. What does a DHCP relay put in `giaddr`?**

A. The client's MAC address
B. Its own interface address on the client's segment
C. The DHCP server's address
D. The address being offered

<details>
<summary>Answer</summary>

**B.** Its own interface address on the client's segment

giaddr tells the server which segment the request came from, so it can choose the right subnet, and where to send the reply. The MAC is in a separate field (chaddr), and the offered address goes in yiaddr.

</details>

**2. In a NICo site, who decides which IP a newly seen BMC gets?**

A. The OOB switch's DHCP relay
B. nico-dhcp, which stores leases itself
C. NICo Core's IP address management, reached by nico-dhcp over gRPC
D. The BMC chooses and announces it

<details>
<summary>Answer</summary>

**C.** NICo Core's IP address management, reached by nico-dhcp over gRPC

nico-dhcp is stateless and forwards to NICo Core, which performs IPAM. Switches only relay.

</details>

**3. A host's DPU is managed in DPU mode. Do the host OS's DHCP requests reach nico-dhcp?**

A. Yes, through the OOB relay
B. No, a DHCP server on the DPU answers them locally
C. Only if option 82 is set
D. Only during discovery

<details>
<summary>Answer</summary>

**B.** No, a DHCP server on the DPU answers them locally

For DPU-mode hosts, NICo runs a per-host DHCP server on the DPU, configured by dpu-agent, so those requests never reach the underlay. nico-dhcp serves underlay endpoints such as BMCs and DPU OOB interfaces.

</details>

**Sources:** [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="out-of-band-management-network"></a>
## 8. Out-of-band (OOB) management network

*Builds on: Baseboard Management Controller (BMC) (ch. 6), DHCP (ch. 8)*

### Before you read

- A tenant's OS has crashed and its data network is down. How can an operator still power-cycle the machine and watch its console?
- What is the minimum the OOB switches must do so NICo can find a newly cabled BMC?

<details>
<summary>Answers</summary>

- **A tenant's OS has crashed and its data network is down. How can an operator still power-cycle the machine and watch its console?** Through the BMC, which runs independently of the host OS and is reached over a separate management (out-of-band) network.
- **What is the minimum the OOB switches must do so NICo can find a newly cabled BMC?** Relay the BMC's DHCP requests to the nico-dhcp VIP. NICo does the addressing and discovery; the switches do not assign addresses themselves.

</details>

### Explanation

The **out-of-band (OOB) management network** is a separate network that connects the management ports: host BMCs, DPU BMCs and DPU OOB interfaces (ch. 6–7). It does not depend on the host OS or the tenant data network, which is why NICo can discover, power-cycle and repair machines even when the tenant OS is down. Because it reaches every BMC, it is also the most sensitive network on the site.

NICo's requirements for it:

- **Connectivity** from every BMC to the site controller, normally over a dedicated OOB network.
- **A DHCP relay on every BMC-facing network**, pointing at the NICo DHCP service IP (`NICo_DHCP_EXTERNAL`, the nico-dhcp VIP).
- **`Underlay` connectivity** for DPU BMC and DPU OOB interfaces.
- **The switches only relay.** NICo manages IP allocation for the management network.

How discovery works, using the earlier lessons: a BMC powers on and broadcasts DHCP. The switch relays it to nico-dhcp. NICo Core allocates an address and checks the MAC against `expected_machines.json`; only listed hosts are discovered and ingested. Site Explorer then crawls the BMC's address over Redfish, collecting serials, power state, boot order, lockdown mode and firmware versions, and pairs hosts with their DPUs. Unbound provides recursive DNS to managed machines over this same OOB network.

The quick start's step 6 is "Connect the OOB network": configure the relay to the nico-dhcp VIP, then check that requests arrive with
`kubectl logs -n nico-system -l app.kubernetes.io/name=nico-dhcp --tail=20`.

Two more details. The OOB and management ranges belong in `deny_prefixes`, the CIDRs that tenant instances must not reach. And there is one exception to the dedicated topology: a **zero-DPU host's BMC** (including hosts with DPU policy `nic`) may share a `HostInband` subnet/VLAN with the host OS NIC. The BMC is then still operationally out of band, but it has no dedicated network isolation. The exception never applies to DPU BMCs or DPU OOB interfaces.

**Analogy.** The OOB network is a building's service corridor: maintenance staff reach every room's electrical panel without walking through the guests' rooms, and it keeps working when the main hallway is blocked. The analogy breaks down in one important way: anyone in that corridor can reach every panel at once. That is why tenants must be kept out of it (deny_prefixes, disabled in-band BMC access), not just politely discouraged.

### Worked example: Find which expected BMCs never reached DHCP

**Step 1: Write the expected-machines manifest.**

Use the documented format:

```bash
mkdir -p ~/oob-check && cd ~/oob-check
cat > expected_machines.json <<'EOF'
{
  "expected_machines": [
    {"bmc_mac_address": "C4:5A:B1:C8:38:0D", "bmc_username": "root",
     "bmc_password": "default-password1", "chassis_serial_number": "SERIAL-1"},
    {"bmc_mac_address": "C4:5A:FF:FF:FF:FF", "bmc_username": "root",
     "bmc_password": "default-password2", "chassis_serial_number": "SERIAL-2"}
  ]
}
EOF
```

**Step 2: Record the MACs actually seen on DHCP.**

On a real site you would collect these from the nico-dhcp logs or switch tables. Here, simulate the list:

```bash
printf 'c4:5a:b1:c8:38:0d\n7c:c2:55:00:11:22\n' > observed.txt
```

**Step 3: Normalise case and sort both lists.**

```bash
jq -r '.expected_machines[].bmc_mac_address' expected_machines.json \
  | tr '[:upper:]' '[:lower:]' | sort > expected.txt
tr '[:upper:]' '[:lower:]' < observed.txt | sort > seen.txt
```
MACs are case-insensitive, and comparing without normalising produces false mismatches.

**Step 4: Compare.**

```bash
echo "expected but never seen:"; comm -23 expected.txt seen.txt
echo "seen but not expected:";   comm -13 expected.txt seen.txt
```
Output: `c4:5a:ff:ff:ff:ff` never seen; `7c:c2:55:00:11:22` unexpected.

**Step 5: Interpret.**

- **Never seen**: the request never reached DHCP. Check power and cabling, whether that VLAN has a relay, the relay's target (the nico-dhcp VIP), and the routing between them.
- **Seen but not expected**: the network works, but the host is not in the manifest, so NICo will not ingest it. Either add it to `expected_machines.json` (with its chassis serial) or find out why an unknown BMC is on the OOB network.

### Your turn: finish it

Here is the same comparison in Python. Fill in the JSON key and the set operator so the first line prints expected MACs that were never seen.

```text
import json

machines = json.load(open("expected_machines.json"))["expected_machines"]
expected = {m["___"].lower() for m in machines}
seen = {line.strip().lower() for line in open("observed.txt") if line.strip()}
print("never seen (check relay/cabling):", sorted(expected ___ seen))
print("seen but not expected (will not be ingested):", sorted(seen - expected))
```

<details>
<summary>Answer</summary>

The key is `bmc_mac_address` and the operator is `-` (set difference):

```python
expected = {m["bmc_mac_address"].lower() for m in machines}
...
print("never seen (check relay/cabling):", sorted(expected - seen))
```

</details>

### Your turn: on your own

A new rack is cabled to a new OOB switch. Its 16 host BMCs are all in `expected_machines.json`, but none of them are discovered, and `kubectl logs -n nico-system -l app.kubernetes.io/name=nico-dhcp` shows nothing from their MACs. BMCs in other racks work fine. Write an ordered checklist, from most to least likely, of what to check, and say what each check would prove.

<details>
<summary>Hint 1</summary>

The logs show nothing at all, so the problem is before nico-dhcp. Follow the packet from the BMC.

</details>

<details>
<summary>Hint 2</summary>

A relay needs two things: to be enabled on the BMC-facing VLAN interface, and to point at the right target.

</details>

<details>
<summary>Hint 3</summary>

Other racks work, so nico-dhcp and its VIP are fine globally. Focus on what is new: the switch, its VLAN/SVI, its relay config and its routing to the VIP.

</details>

<details>
<summary>Answer</summary>

1. **Relay configured on the new switch's BMC-facing VLAN interface.** Without it, the broadcasts never leave the rack. Check the switch config, or capture on the uplink for UDP 67 traffic.
2. **Relay target is the nico-dhcp VIP** (`NICo_DHCP_EXTERNAL`), not an old or typo'd address. A wrong target sends packets elsewhere.
3. **Routing between the switch and the VIP in both directions.** Replies go back to the relay's giaddr, so the site must route the new segment's prefix back to this switch. Ping or trace from the switch's SVI to the VIP.
4. **Physical: BMC ports cabled to the right ports and VLAN, and link up.** Compare the switch's MAC table with the manifest MACs.
5. **The segment is defined in NICo.** Once requests arrive, NICo needs this prefix in its network configuration to allocate from it. This becomes the next issue after the logs start showing the MACs.

When nico-dhcp logs show the MACs, the network side is done, and you move on to Site Explorer, credentials and the manifest.

</details>

### Explain it

In your own words: Explain why NICo puts address allocation and discovery in the central nico-dhcp/Core path and asks the OOB switches only to relay. What does this buy you when you add a rack or redeploy the site controller?

### Check

**1. What must the OOB switches do for NICo to discover BMCs?**

A. Run their own DHCP pools for the BMC subnets
B. Relay BMC DHCP requests to the nico-dhcp VIP
C. Run Redfish against each BMC
D. Forward all BMC traffic to the DPU

<details>
<summary>Answer</summary>

**B.** Relay BMC DHCP requests to the nico-dhcp VIP

NICo manages IP allocation. The switches only need to relay DHCP to the NICo DHCP service IP. Running local pools would bypass NICo's discovery. Site Explorer, not the switches, is what talks Redfish.

</details>

**2. Which endpoint may share a `HostInband` subnet with the host OS instead of sitting on a dedicated OOB network?**

A. A DPU BMC
B. A DPU OOB interface
C. The host BMC of a zero-DPU host
D. Any BMC, if the operator chooses

<details>
<summary>Answer</summary>

**C.** The host BMC of a zero-DPU host

The documented exception covers only a zero-DPU host's BMC (including DPU policy `nic`). It does not apply to DPU BMCs or DPU OOB interfaces, and that topology lacks dedicated network isolation.

</details>

**3. Why should the OOB network's prefixes be included in `deny_prefixes`?**

A. So DHCP relays can find them
B. To stop tenant instances from reaching BMCs and other management endpoints
C. Because MetalLB requires it
D. To speed up DNS

<details>
<summary>Answer</summary>

**B.** To stop tenant instances from reaching BMCs and other management endpoints

`deny_prefixes` lists CIDRs that instances must not reach, such as OOB, control plane and management. The OOB network reaches every BMC, so tenant access to it would undermine isolation.

</details>

**Sources:** [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md)

<a id="build-task"></a>
## Build task: A miniature OOB site: discover, name, time-sync and network-boot a mock BMC

**Goal:** Inside one privileged container, build three network namespaces: `bmc` (a mock BMC), `oob` (an OOB switch acting as router and DHCP relay) and `svc` (the site controller, with a DHCP server standing in for the nico-dhcp VIP, DNS, NTP and a PXE-style HTTP server for user-data). Have the BMC get its address through the relay. Confirm that it can resolve names and read the time. Then, acting as the controller over the OOB network, stage a BIOS change and a one-time PXE boot through Redfish, reboot it, and check the result.

**Why it matters for NICo:** This is a scaled-down version of NICo's Day 0 path. In a real site, OOB switches relay BMC DHCP to the nico-dhcp VIP, NICo Core allocates the address and matches the MAC against `expected_machines.json`, BMC time is set from enterprise NTP, nico-dns and Unbound provide names, the PXE Service serves cloud-init user-data, and NICo sets the boot order through Redfish and records configuration data such as lockdown mode. The BIOS attribute change in this lab exercises the general Redfish pending-settings mechanism; it is not a documented NICo setting. When discovery or provisioning fails on a real site, you debug the same chain: relay → DHCP → routing → DNS/NTP → Redfish.

**You need:**

- Docker (Engine or Desktop) on Linux or macOS. Podman also works but needs rootful mode (`sudo podman run --privileged ...`), because rootless containers usually cannot create network namespaces.
- About 300 MB of disk for the `python:3.12-slim` image and packages.
- `mock_bmc.py` from Lesson 1 and `sntp.py` from Lesson 5.
- A host directory for the lab, e.g. `mkdir -p ~/nico-ch8-lab/pxe && cd ~/nico-ch8-lab`. All files below go there and are mounted into the container at `/lab`.

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Write the site service configs</summary>

Copy `mock_bmc.py` and `sntp.py` into `~/nico-ch8-lab`, then create:

`dnsmasq-server.conf` (DHCP server, standing in for the nico-dhcp VIP, plus the DNS zone `oob.lab`):
```text
# --- DNS: answer only for our own zone, no recursion ---
interface=svc0
bind-interfaces
no-resolv
no-hosts
domain=oob.lab
local=/oob.lab/
host-record=dhcp.oob.lab,10.20.0.10
host-record=ntp.oob.lab,10.20.0.10
host-record=pxe.oob.lab,10.20.0.10
# --- DHCP: relayed requests from the OOB segment 10.30.0.0/24 ---
dhcp-range=10.30.0.100,10.30.0.200,255.255.255.0,1h
# Like expected_machines.json: only known MACs get an address
dhcp-host=02:00:00:00:00:50,bmc-01,10.30.0.50
dhcp-ignore=tag:!known
dhcp-option=option:router,10.30.0.1
dhcp-option=option:dns-server,10.20.0.10
dhcp-option=option:ntp-server,10.20.0.10
dhcp-leasefile=/lab/run/leases
pid-file=/lab/run/dnsmasq.pid
log-facility=/lab/run/dnsmasq.log
log-dhcp
log-queries
user=root
```

`dnsmasq-relay.conf` (the OOB switch's relay; DNS is turned off):
```text
port=0
dhcp-relay=10.30.0.1,10.20.0.10
pid-file=/lab/run/relay.pid
log-facility=/lab/run/relay.log
log-dhcp
user=root
```

`chrony.conf` (an NTP server that serves its own clock; `-x` at startup stops it from touching the clock):
```text
local stratum 8
allow 10.0.0.0/8
bindaddress 10.20.0.10
cmdport 0
pidfile /lab/run/chronyd.pid
```

`pxe/user-data` (served like NICo's PXE Service would):
```yaml
#cloud-config
hostname: lab-host-01
ntp:
  enabled: true
  servers: [ntp.oob.lab]
runcmd:
  - [sh, -c, 'echo "provisioned at $(date -u)" > /etc/motd']
```

</details>

<details>
<summary>Step 2: Write the DHCP client hook, topology script and verifier</summary>

`udhcpc.sh` (busybox udhcpc runs this to apply the lease; it also writes the BMC namespace's resolv.conf from the DNS option):
```sh
#!/bin/sh
case "$1" in
  deconfig)
    ip addr flush dev "$interface"
    ip link set "$interface" up
    ;;
  bound|renew)
    ip addr flush dev "$interface"
    ip addr add "$ip/$mask" dev "$interface"
    ip route replace default via "$router" dev "$interface"
    mkdir -p /etc/netns/bmc
    : > /etc/netns/bmc/resolv.conf
    for d in $dns; do echo "nameserver $d" >> /etc/netns/bmc/resolv.conf; done
    echo "ip=$ip mask=$mask router=$router dns=$dns domain=$domain ntp=$ntpsrv server=$serverid" > /lab/run/lease.txt
    ;;
esac
```

`setup-net.sh`:
```sh
#!/bin/sh
set -e
for ns in bmc oob svc; do ip netns add $ns; done
# BMC <-> OOB switch
ip link add bmc0 type veth peer name oob-bmc netns oob
ip link set bmc0 netns bmc
# OOB switch <-> site controller
ip link add svc0 type veth peer name oob-svc netns oob
ip link set svc0 netns svc
ip -n bmc link set bmc0 address 02:00:00:00:00:50
ip -n oob addr add 10.30.0.1/24 dev oob-bmc
ip -n oob addr add 10.20.0.1/24 dev oob-svc
ip -n svc addr add 10.20.0.10/24 dev svc0
for ns in bmc oob svc; do ip -n $ns link set lo up; done
ip -n bmc link set bmc0 up
ip -n oob link set oob-bmc up
ip -n oob link set oob-svc up
ip -n svc link set svc0 up
ip -n svc route add default via 10.20.0.1
ip netns exec oob sh -c 'echo 1 > /proc/sys/net/ipv4/ip_forward'
# Give oob and svc a reachable resolver, so tools don't hang on reverse lookups
for ns in oob svc; do mkdir -p /etc/netns/$ns; echo "nameserver 10.20.0.10" > /etc/netns/$ns/resolv.conf; done
mkdir -p /lab/run
echo "topology ready"
```
The BMC namespace deliberately has no address: it has to get one through the relay.

`verify.sh`:
```sh
#!/bin/sh
B="ip netns exec bmc"
S="ip netns exec svc"
SYS=http://10.30.0.50:8000/redfish/v1/Systems/1
pass=0; fail=0
check() {
  name=$1; shift
  if sh -c "$*" >/dev/null 2>&1; then echo "PASS  $name"; pass=$((pass+1))
  else echo "FAIL  $name"; fail=$((fail+1)); fi
}
check "DHCP: BMC leased 10.30.0.50 from 10.20.0.10 via relay" \
  "grep -q 'ip=10.30.0.50 .*server=10.20.0.10' /lab/run/lease.txt"
check "DNS: bmc-01.oob.lab resolves to 10.30.0.50" \
  "$B dig +short bmc-01.oob.lab | grep -qx 10.30.0.50"
check "NTP: time server answers the BMC" \
  "$B python3 /lab/sntp.py 10.20.0.10"
check "PXE: user-data served by name, starts with #cloud-config" \
  "$B curl -sf http://pxe.oob.lab:8080/user-data | head -n 1 | grep -qx '#cloud-config'"
check "BIOS: staged SriovGlobalEnable applied after reset" \
  "$S curl -sf $SYS/Bios | grep -q '\"SriovGlobalEnable\": \"Enabled\"'"
check "Boot: one-time PXE override used and consumed" \
  "$S curl -sf $SYS | grep -q '\"LastBootSource\": \"Pxe\"' && $S curl -sf $SYS | grep -q '\"BootSourceOverrideEnabled\": \"Disabled\"'"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
```

Make the scripts executable on the host: `chmod +x udhcpc.sh setup-net.sh verify.sh`.

</details>

<details>
<summary>Step 3: Start the lab container and build the topology</summary>

```bash
cd ~/nico-ch8-lab
docker run --rm -it --privileged --name nico-ch8 -v "$PWD:/lab" python:3.12-slim bash
```
Inside the container:
```bash
# Stop package install scripts from auto-starting daemons
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d
apt-get update && apt-get install -y --no-install-recommends \
  iproute2 dnsmasq-base chrony busybox curl bind9-dnsutils procps
sh /lab/setup-net.sh
ip -n oob -br addr          # oob-bmc 10.30.0.1/24, oob-svc 10.20.0.1/24
ip -n bmc -br addr          # bmc0 UP, no IPv4 yet
```
`procps` provides `pkill`, which the slim image lacks and later steps use. Everything stays in one container on purpose. Routing between separate Docker networks through a router container is blocked on Docker 28+.

</details>

<details>
<summary>Step 4: Start the site controller services</summary>

```bash
ip netns exec svc dnsmasq --conf-file=/lab/dnsmasq-server.conf --keep-in-foreground &
sleep 1
ip netns exec svc chronyd -d -x -u root -f /lab/chrony.conf > /lab/run/chrony.log 2>&1 &
ip netns exec svc python3 -m http.server 8080 --bind 10.20.0.10 --directory /lab/pxe \
  > /lab/run/pxe.log 2>&1 &
for i in $(seq 1 20); do ip netns exec svc curl -sf http://10.20.0.10:8080/user-data >/dev/null && break; sleep 0.5; done
ip netns exec svc dig +short @10.20.0.10 pxe.oob.lab     # 10.20.0.10
```
dnsmasq starts first, so the HTTP server's reverse lookup of its own address gets a fast answer.

</details>

<details>
<summary>Step 5: Turn on the relay and let the BMC request an address</summary>

```bash
ip netns exec oob dnsmasq --conf-file=/lab/dnsmasq-relay.conf --keep-in-foreground &
sleep 1
ip netns exec bmc busybox udhcpc -i bmc0 -f -q -n -t 5 -O ntpsrv -s /lab/udhcpc.sh
cat /lab/run/lease.txt
cat /etc/netns/bmc/resolv.conf
grep -E 'DHCP(DISCOVER|OFFER|REQUEST|ACK)' /lab/run/dnsmasq.log
```
Expected: `Lease of 10.30.0.50 obtained from 10.20.0.10`. The server log shows DORA for `02:00:00:00:00:50` arriving on `svc0`. The server has no interface on the BMC's segment, so these requests can only have come through the relay.

**Optional: watch an unexpected BMC get refused.** This mimics a BMC missing from `expected_machines.json`. dnsmasq only reads its config at startup, and rerunning udhcpc first flushes bmc0's address, so follow the whole sequence, including the restore:
```bash
# 1. Stop only the server dnsmasq (the relay keeps running) and change the known MAC
pkill -f dnsmasq-server.conf; sleep 1
sed -i 's/^dhcp-host=02:00:00:00:00:50/dhcp-host=02:00:00:00:00:99/' /lab/dnsmasq-server.conf
ip netns exec svc dnsmasq --conf-file=/lab/dnsmasq-server.conf --keep-in-foreground &
sleep 1
# 2. Ask again: no lease this time, and bmc0 is left with no address
ip netns exec bmc busybox udhcpc -i bmc0 -f -q -n -t 3 -O ntpsrv -s /lab/udhcpc.sh || echo "no lease (expected)"
grep ignored /lab/run/dnsmasq.log | tail -2
ip -n bmc -br addr          # no IPv4
# 3. Restore the MAC, restart the server, and get 10.30.0.50 back
pkill -f dnsmasq-server.conf; sleep 1
sed -i 's/^dhcp-host=02:00:00:00:00:99/dhcp-host=02:00:00:00:00:50/' /lab/dnsmasq-server.conf
ip netns exec svc dnsmasq --conf-file=/lab/dnsmasq-server.conf --keep-in-foreground &
sleep 1
ip netns exec bmc busybox udhcpc -i bmc0 -f -q -n -t 5 -O ntpsrv -s /lab/udhcpc.sh
ip -n bmc -br addr          # bmc0 10.30.0.50/24 again
```
Do not continue until bmc0 has 10.30.0.50 again: the mock BMC in the next step binds that address.

</details>

<details>
<summary>Step 6: Check DNS and time from the BMC, then start its Redfish service</summary>

```bash
ip netns exec bmc dig +short bmc-01.oob.lab          # 10.30.0.50 (name registered from DHCP)
ip netns exec bmc dig example.com | grep status       # REFUSED or SERVFAIL: authoritative-only, no recursion
sleep 5; ip netns exec bmc python3 /lab/sntp.py 10.20.0.10   # stratum 8 (leap=3 for the first few seconds is OK)
ip netns exec bmc curl -s http://pxe.oob.lab:8080/user-data | head -3

ip netns exec bmc python3 /lab/mock_bmc.py 10.30.0.50 > /lab/run/bmc.log 2>&1 &
for i in $(seq 1 20); do ip netns exec svc curl -sf http://10.30.0.50:8000/redfish/v1/Systems/1 >/dev/null && break; sleep 0.5; done
```
The last loop runs from `svc`: the controller reaches the BMC by routing across the OOB switch.

</details>

<details>
<summary>Step 7: Act as the controller: stage BIOS, arm one-time PXE, reboot</summary>

```bash
RF="ip netns exec svc curl -s -H Content-Type:application/json"
SYS=http://10.30.0.50:8000/redfish/v1/Systems/1
$RF -X PATCH -d '{"Attributes":{"SriovGlobalEnable":"Enabled"}}' $SYS/Bios/Settings
$RF -X PATCH -d '{"Boot":{"BootSourceOverrideEnabled":"Once","BootSourceOverrideTarget":"Pxe"}}' $SYS
$RF $SYS/Bios | grep Sriov                    # still Disabled: pending only
$RF -X POST -d '{"ResetType":"ForceRestart"}' -w '%{http_code}\n' $SYS/Actions/ComputerSystem.Reset   # 204
$RF $SYS/Bios | grep Sriov                    # Enabled
$RF $SYS | grep -E 'LastBootSource|OverrideEnabled'   # Pxe, Disabled
```
Then run `sh /lab/verify.sh`.

</details>

**Check it works:** Inside the container, run `sh /lab/verify.sh`. It must print six `PASS` lines (DHCP via relay, DNS, NTP, PXE user-data, BIOS applied, one-time PXE consumed) and end with `6 passed, 0 failed`, with exit status 0 (`echo $?` prints `0`).

<details>
<summary>If you get stuck</summary>

- `File exists` or `Cannot find device` when re-running setup-net.sh: the namespaces are left over. Run `pkill dnsmasq; pkill chronyd; pkill -f mock_bmc; pkill -f http.server; ip -all netns delete; rm -rf /etc/netns /lab/run`, then run it again, or just exit and start a fresh container.
- udhcpc keeps sending discovers with no lease: check `/lab/run/relay.log` and `/lab/run/dnsmasq.log`. Nothing in the server log means the relay isn't forwarding (is the relay dnsmasq running in `oob`? is `ip_forward` 1?). `no address range available for DHCP request via 10.30.0.1` means the server's `dhcp-range` doesn't cover the relay's subnet. A log line saying the MAC was `ignored` means it doesn't match `dhcp-host` (check you restored it after the optional refusal exercise, and restarted the server dnsmasq).
- `dnsmasq: failed to create listening socket ... Address in use`: an earlier dnsmasq is still running in that namespace. `pkill dnsmasq` and start again (server first, then relay).
- curl to the mock BMC gives `connection refused`: give the server time to start; the wait loops exist for this reason. Check the mock's output with `cat /lab/run/bmc.log`. The mock must start *after* DHCP, because 10.30.0.50 doesn't exist before the lease; `ip -n bmc -br addr` should show it.
- NTP check fails: make sure `cat /lab/run/chrony.log` shows no fatal error, and wait a few seconds after starting chronyd. Any reply passes the check; `leap=3` just means chrony hasn't picked its local reference yet.
- `udhcpc.sh: Permission denied`: the executable bit was lost. Run `chmod +x /lab/udhcpc.sh` (Windows-style line endings cause similar errors).

</details>

**Stretch goal:** Add a lab-only lockdown to the mock and a controller script that respects it. Give `mock_bmc.py` a `state["locked"]` flag, exposed and toggled through a mock-only `PATCH /redfish/v1/Systems/1` body `{"Oem": {"Lab": {"Locked": true}}}`. While it is locked, `PATCH .../Bios/Settings` should return 403. Then write `apply_bios.sh`, run from `svc`. It should refuse to run if a marker file `/lab/run/assigned` exists (standing in for "a tenant has the host"); otherwise unlock, stage, reset, verify the live value, and re-lock, exiting non-zero if any step fails. This follows the lockdown model from Lesson 2, not a documented NICo procedure. Add two checks to `verify.sh`: a PATCH while locked returns 403, and the host is locked again at the end.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 6 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (DNS (authoritative and recursive)): The explanation and the third check question give 'so the parent zone can delegate to several stable server addresses' as the reason each nico-dns replica has its own VIP. The quick start only says that each replica gets its own VIP (use perPodAnnotations); it gives no reason. The NTP lesson labels its equivalent per-replica-VIP reasoning as general reasoning, but this lesson does not. *Fix:* Add a short qualifier in the explanation and in the check's explanation, e.g. '(general DNS reasoning; the docs state the per-replica VIP design but not the reason)', matching how the NTP lesson handles it.

---

[← 07-bluefield-dpu-hardware-oob-management.md](07-bluefield-dpu-hardware-oob-management.md) · [09-underlay-bgp.md →](09-underlay-bgp.md)
