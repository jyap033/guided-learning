# Chapter 8: Boot & Network Services · UEFI & Firmware

*Part: Networking & Isolation · 8 concepts · [curriculum](../curriculum.md#chapter-8)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

This chapter covers the services a bare-metal host needs between power-on and a running OS. In Chapter 5 you saw what UEFI firmware is. In Chapter 6 you drove a BMC over Redfish. In Chapter 7 you met the out-of-band (OOB) management path. Here those pieces come together. You will read and stage firmware (BIOS) settings, lock them while a tenant has the machine, and steer the boot device so the host boots from the network. You will also look at the network services every managed machine depends on: DHCP for addresses, DNS for names, NTP for time, and cloud-init for first-boot configuration.

This matters for NICo because its discovery chain starts with one of these protocols. A BMC powers on and sends a DHCP request. A switch on the OOB network relays that request to `nico-dhcp`. NICo Core allocates an address. Site Explorer then reaches the BMC over Redfish using the credentials in `expected_machines.json`. From there NICo manages the boot order, the UEFI firmware and lockdown. Hosts boot from the network and fetch iPXE scripts and cloud-init user-data from the PXE Service. If one link in that chain is misconfigured, a host never appears or never provisions.

Each lesson starts with a question to try before reading. Then come an explanation, a worked example you can run on a laptop, and practice problems that give you less help each time. The chapter ends with a build task. Inside one Docker container you will set up a small OOB network: a fake BMC, a DHCP relay, and a controller running DHCP, DNS and NTP. Then you discover the BMC through a relayed DHCP request and provision it over Redfish.

**By the end of this chapter you can:**

- Read BIOS attributes over Redfish, stage a change as a pending setting, and apply it with a reset
- Explain how UEFI lockdown combined with disabled in-band host-to-BMC access protects firmware while a tenant has a host
- Set a one-time or persistent boot source override and predict which device a host boots from on each reboot
- Write, validate and serve cloud-init user-data over HTTP the way a PXE service does
- Tell an authoritative DNS server from a recursive resolver, and name the NTP and DNS components NICo runs
- Trace a BMC's DHCP request through an OOB relay to nico-dhcp, and build a working relay in a lab

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
9. [Build task: Mini OOB network: discover a BMC by relayed DHCP, then provision it over Redfish](#build-task)

<a id="uefi-bios-settings"></a>
## 1. UEFI/BIOS settings

*Builds on: Redfish API (ch. 6)*

### Before you read

- You PATCH a BIOS attribute through Redfish and get 200 OK. You immediately GET that attribute again. What value do you expect to see, and why?
- Why can't the firmware simply apply a setting like 'enable SR-IOV' while the OS is running?

<details>
<summary>Answers</summary>

- **You PATCH a BIOS attribute through Redfish and get 200 OK. You immediately GET that attribute again. What value do you expect to see, and why?** Usually the old value. The change has been accepted as a pending setting. Firmware reads BIOS settings during POST, so the new value only takes effect after the next reboot.
- **Why can't the firmware simply apply a setting like 'enable SR-IOV' while the OS is running?** Settings like this decide how PCIe devices are enumerated and how resources are allocated during POST. The running OS has already discovered the hardware based on the old values. Changing them underneath it would make that picture wrong, so they are applied at the next boot.

</details>

### Explanation

**BIOS settings** (vendors still say "BIOS" even on UEFI machines) are the firmware's configuration: name/value pairs such as `BootMode = Uefi`, `SecureBoot = Enabled` or `SriovGlobalEnable = Disabled`. They live in the firmware's non-volatile storage and are read during **POST**, the self-test and hardware-setup phase that runs before the boot loader.

Redfish (Chapter 6) exposes them in two places:

- **Current settings**: `GET /redfish/v1/Systems/<id>/Bios` returns an `Attributes` object. Treat it as read-only.
- **Pending settings**: the same response has an `@Redfish.Settings` annotation that points to a *settings object*, often `/Bios/Settings`. You `PATCH` the attributes you want to change there. The BMC stores them as pending.

The pending values are applied at the **next reboot**, for example the `ComputerSystem.Reset` action you used in Chapter 6. After the reboot, `/Bios` shows the new values and the pending list is empty. Some vendors add an extra step, such as creating a configuration job, or let you choose when changes apply with an `@Redfish.SettingsApplyTime` annotation. Differences like these are why a controller needs vendor detection and OEM handling (Chapter 6).

**Attribute names are vendor-specific.** Redfish standardises where attributes live, not what they are called. Each BMC publishes an **attribute registry** that lists the valid names, types and allowed values. `SriovGlobalEnable` exists on one vendor's servers. Another vendor calls it something else.

This lesson uses **SR-IOV** (Single Root I/O Virtualization) as a typical example of a firmware setting. SR-IOV lets one PCIe device, such as a NIC, present many lightweight *virtual functions* to the OS, and firmware often has to enable it before the OS can use it.

**What the NICo docs say about firmware configuration:** NICo manages host UEFI firmware and enforces a firmware baseline. Its BMC Redfish requirements include a **UEFI Secure Boot toggle** (enable/disable Secure Boot) and **boot order configuration**. Site Explorer records configuration data such as **boot order and lockdown mode** from each BMC. The docs don't list which individual BIOS attributes NICo sets, so don't assume any particular attribute from this lesson.

Two habits from earlier chapters apply. Be **idempotent**: compare current, pending and desired values before you stage anything, so running the same step twice does not cause an extra reboot. And remember that **200 OK means "accepted as pending", not "applied"**. Check the result after the reboot.

**Analogy.** It's like asking a building manager to change the thermostat schedule. They write your request on tonight's work order (the pending settings), and the schedule actually changes when the system restarts overnight (the reboot). The analogy breaks down in one place: a real BMC can reject the request, or some firmware drops a staged change without telling you. The manager would at least tell you. So always re-read `/Bios` after the reboot.

### Worked example: Stage and apply an SR-IOV change on a mock BMC

**Step 1: Save the mock BMC.**

Save this as `mockbmc.py`. It is a toy that models a small part of Redfish. Lessons 2 and 3 and the build task reuse it.

```python
#!/usr/bin/env python3
"""mockbmc.py: a toy Redfish-style BMC for learning.

Models a tiny slice of Redfish (Bios, Bios/Settings, Boot, Reset) plus a
made-up OEM Lockdown flag. Real BMCs differ by vendor; this is not a spec.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

SYS = "/redfish/v1/Systems/1"
BOOT_OPTIONS = {
    "Boot0001": {"DisplayName": "UEFI NVMe: local disk", "Target": "Hdd",
                 "UefiDevicePath": "PciRoot(0x0)/Pci(0x1,0x1)/Pci(0x0,0x0)/NVMe(0x1,00-00-00-00-00-00-00-00)"},
    "Boot0002": {"DisplayName": "UEFI PXE IPv4: NIC1", "Target": "Pxe",
                 "UefiDevicePath": "PciRoot(0x0)/Pci(0x3,0x0)/Pci(0x0,0x0)/MAC(C45AB1C8380E,0x1)/IPv4(0.0.0.0)"},
    "Boot0003": {"DisplayName": "UEFI HTTP IPv4: NIC1", "Target": "UefiHttp",
                 "UefiDevicePath": "PciRoot(0x0)/Pci(0x3,0x0)/Pci(0x0,0x0)/MAC(C45AB1C8380E,0x1)/IPv4(0.0.0.0)/Uri()"},
}
STATE = {
    "bios": {"SriovGlobalEnable": "Disabled", "BootMode": "Uefi", "SecureBoot": "Enabled"},
    "pending": {},
    "boot": {"BootSourceOverrideEnabled": "Disabled", "BootSourceOverrideTarget": "None",
             "BootOrder": ["Boot0001", "Boot0002", "Boot0003"]},
    "lockdown": False,
    "last_boot": None,
}


def first_option_for(target):
    for opt_id in STATE["boot"]["BootOrder"]:
        if BOOT_OPTIONS[opt_id]["Target"] == target:
            return opt_id
    return None


class Handler(BaseHTTPRequestHandler):
    def send_json(self, code, body):
        data = json.dumps(body, indent=2).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"{}")

    def blocked_inband(self):
        if STATE["lockdown"] and self.headers.get("X-Mock-Inband") == "1":
            self.send_json(403, {"error": "in-band host-to-BMC access disabled (lockdown)"})
            return True
        return False

    def do_GET(self):
        if self.blocked_inband():
            return
        if self.path == SYS:
            self.send_json(200, {"Id": "1", "Boot": STATE["boot"],
                                 "Bios": {"@odata.id": SYS + "/Bios"},
                                 "Oem": {"Mock": {"Lockdown": STATE["lockdown"],
                                                  "LastBootedFrom": STATE["last_boot"]}}})
        elif self.path == SYS + "/Bios":
            self.send_json(200, {"Attributes": STATE["bios"],
                                 "@Redfish.Settings": {"SettingsObject": {"@odata.id": SYS + "/Bios/Settings"}}})
        elif self.path == SYS + "/Bios/Settings":
            self.send_json(200, {"Attributes": STATE["pending"]})
        elif self.path.startswith(SYS + "/BootOptions/"):
            opt_id = self.path.rsplit("/", 1)[1]
            if opt_id in BOOT_OPTIONS:
                self.send_json(200, {"Id": opt_id, **BOOT_OPTIONS[opt_id]})
            else:
                self.send_json(404, {"error": "no such boot option"})
        else:
            self.send_json(404, {"error": "not found"})

    def do_PATCH(self):
        if self.blocked_inband():
            return
        body = self.read_json()
        if self.path == SYS + "/Bios/Settings":
            if STATE["lockdown"]:
                self.send_json(403, {"error": "BIOS settings locked"})
                return
            attrs = body.get("Attributes", {})
            unknown = [k for k in attrs if k not in STATE["bios"]]
            if unknown:
                self.send_json(400, {"error": "unknown attributes", "names": unknown})
                return
            STATE["pending"].update(attrs)
            self.send_json(200, {"Attributes": STATE["pending"]})
        elif self.path == SYS:
            if STATE["lockdown"] and "Boot" in body:
                self.send_json(403, {"error": "boot settings locked"})
                return
            if "Boot" in body:
                STATE["boot"].update(body["Boot"])
            lock = body.get("Oem", {}).get("Mock", {}).get("Lockdown")
            if lock is not None:
                STATE["lockdown"] = bool(lock)
            self.send_json(200, {"Boot": STATE["boot"], "Lockdown": STATE["lockdown"]})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.blocked_inband():
            return
        if self.path != SYS + "/Actions/ComputerSystem.Reset":
            self.send_json(404, {"error": "not found"})
            return
        self.read_json()
        STATE["bios"].update(STATE["pending"])
        STATE["pending"] = {}
        boot = STATE["boot"]
        if boot["BootSourceOverrideEnabled"] in ("Once", "Continuous"):
            chosen = first_option_for(boot["BootSourceOverrideTarget"]) or boot["BootOrder"][0]
            if boot["BootSourceOverrideEnabled"] == "Once":
                boot["BootSourceOverrideEnabled"] = "Disabled"
                boot["BootSourceOverrideTarget"] = "None"
        else:
            chosen = boot["BootOrder"][0]
        STATE["last_boot"] = chosen
        self.send_json(200, {"BootedFrom": chosen,
                             "DisplayName": BOOT_OPTIONS[chosen]["DisplayName"]})


if __name__ == "__main__":
    host = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
    print(f"mock BMC on http://{host}:{port}{SYS}", flush=True)
    HTTPServer((host, port), Handler).serve_forever()
```

**Step 2: Start it.**

In terminal 1:

```bash
python3 mockbmc.py
# mock BMC on http://127.0.0.1:8000/redfish/v1/Systems/1
```

In terminal 2, set a shortcut:

```bash
B=http://127.0.0.1:8000/redfish/v1/Systems/1
```

**Step 3: Read the current settings.**

```bash
curl -s $B/Bios
```

You get `"SriovGlobalEnable": "Disabled"` in `Attributes`, plus `@Redfish.Settings.SettingsObject` pointing to `.../Bios/Settings`. That link tells you where to write changes.

**Step 4: Stage the change.**

```bash
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"Attributes": {"SriovGlobalEnable": "Enabled"}}' \
  $B/Bios/Settings
```

The response lists the pending attributes.

**Step 5: Observe that it is pending, not applied.**

```bash
curl -s $B/Bios | grep Sriov           # still "Disabled"
curl -s $B/Bios/Settings | grep Sriov  # "Enabled" (pending)
```

**Step 6: Reboot and confirm.**

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"ResetType": "ForceRestart"}' $B/Actions/ComputerSystem.Reset
curl -s $B/Bios | grep Sriov           # now "Enabled"
curl -s $B/Bios/Settings               # Attributes is empty again
```

### Your turn: finish it

With the mock BMC running, turn SR-IOV back off and apply the change. Fill in the two blanks.

```text
B=http://127.0.0.1:8000/redfish/v1/Systems/1
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"Attributes": {"SriovGlobalEnable": "Disabled"}}' \
  $B/Bios/___
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"ResetType": "ForceRestart"}' \
  $B/Actions/___
```

<details>
<summary>Answer</summary>

The first blank is `Settings`, because changes go to the settings object `/Bios/Settings`, not to `/Bios`. The second blank is `ComputerSystem.Reset`, the Redfish reset action that reboots the system and applies pending settings. Afterwards, `curl -s $B/Bios | grep Sriov` shows `"Disabled"`.

</details>

### Your turn: on your own

Write a small script in Python or bash that makes sure `SriovGlobalEnable` is `Enabled` on the mock BMC, idempotently. It should stage the change and reboot only when the current value is wrong. Run it twice. The second run must not stage anything or reboot.

<details>
<summary>Hint 1</summary>

Read both `/Bios` (current) and `/Bios/Settings` (pending) before deciding what to do.

</details>

<details>
<summary>Hint 2</summary>

If the current value already matches, print 'already compliant' and exit without any PATCH or POST.

</details>

<details>
<summary>Hint 3</summary>

Python's `urllib.request.Request(url, data=..., method='PATCH', headers={'Content-Type': 'application/json'})` lets you send PATCH requests without installing anything. Stage the change only if it isn't already pending, then POST the reset.

</details>

<details>
<summary>Answer</summary>

```python
import json, urllib.request

BASE = "http://127.0.0.1:8000/redfish/v1/Systems/1"
WANT = {"SriovGlobalEnable": "Enabled"}

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)

current = call("GET", "/Bios")["Attributes"]
todo = {k: v for k, v in WANT.items() if current.get(k) != v}
if not todo:
    print("already compliant")
else:
    pending = call("GET", "/Bios/Settings")["Attributes"]
    if any(pending.get(k) != v for k, v in todo.items()):
        call("PATCH", "/Bios/Settings", {"Attributes": todo})
    print(call("POST", "/Actions/ComputerSystem.Reset", {"ResetType": "ForceRestart"}))
```
The first run stages the change and reboots. The second run prints `already compliant`. Comparing current, pending and desired values is what makes the step safe to repeat.

</details>

### Explain it

In your own words: Why does Redfish keep current BIOS values (`/Bios`) separate from pending ones (`/Bios/Settings`) instead of letting you PATCH `/Bios` directly? What would a controller lose if the two were merged?

### Check

**1. After `PATCH /Bios/Settings` returns 200, where does the new value show up first?**

A. In /Bios Attributes, immediately
B. In /Bios/Settings Attributes, until the next reboot applies it
C. Only in the BMC's event log
D. Nowhere: the PATCH is only remembered if you rebooted beforehand

<details>
<summary>Answer</summary>

**B.** In /Bios/Settings Attributes, until the next reboot applies it

The settings object holds pending values, and the firmware applies them during the next POST. Seeing the change in /Bios immediately is the most common wrong assumption; it leads people to think a PATCH failed. No reboot is needed before the PATCH.

</details>

**2. Your script sets `SriovGlobalEnable` on one vendor's servers but gets 'unknown attribute' on another vendor's. What is the most likely reason?**

A. Redfish forbids SR-IOV changes on some servers
B. BIOS attribute names are vendor- and platform-specific and are listed in each BMC's attribute registry
C. SR-IOV only exists on DPUs
D. The BMC hides attributes until lockdown is enabled

<details>
<summary>Answer</summary>

**B.** BIOS attribute names are vendor- and platform-specific and are listed in each BMC's attribute registry

Redfish standardises where attributes live, not what they are called. Look up the platform's attribute registry. SR-IOV is a general PCIe feature, not something specific to DPUs, and lockdown does not hide attributes.

</details>

**3. Which firmware-configuration operation appears in NICo's BMC Redfish requirements table?**

A. UEFI Secure Boot toggle (enable/disable Secure Boot)
B. Hyper-threading toggle
C. Memory overclocking profiles
D. Fan curve configuration

<details>
<summary>Answer</summary>

**A.** UEFI Secure Boot toggle (enable/disable Secure Boot)

The requirements table lists power control, boot order configuration, the UEFI Secure Boot toggle, firmware inventory and update, Serial-over-LAN and IPv6. The other options are real BIOS settings on many servers, but the NICo docs don't list them as requirements.

</details>

**Sources:** [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md)

<a id="uefi-lockdown"></a>
## 2. UEFI lockdown

*Builds on: UEFI firmware and Secure Boot (ch. 5), UEFI/BIOS settings (ch. 8)*

### Before you read

- A tenant has root access and a serial console on a bare-metal host, but not NICo's BMC password. Name two ways they might still try to change firmware settings.
- Why would NICo ever need to turn lockdown off again?

<details>
<summary>Answers</summary>

- **A tenant has root access and a serial console on a bare-metal host, but not NICo's BMC password. Name two ways they might still try to change firmware settings.** (1) Reboot and enter the UEFI setup menu from the console. A UEFI setup password blocks this. (2) From the running OS, talk to the host's own BMC over an internal channel such as IPMI over KCS or the Redfish Host Interface (a virtual USB NIC), or use vendor tools that write firmware settings. Lockdown and disabling in-band access block these.
- **Why would NICo ever need to turn lockdown off again?** Between tenants NICo has to change things itself: apply firmware updates, re-apply the firmware baseline, sanitize the machine, and adjust settings. Lockdown is enabled for the tenancy and lifted while the host is back in NICo's hands.

</details>

### Explanation

NICo treats every host as untrustworthy. A tenant gets full root, and possibly console access, on real hardware. If they could change firmware configuration, they could, for example, disable Secure Boot (Chapter 5), reorder boot devices, or leave settings behind that affect the next tenant.

**UEFI lockdown** closes this gap. While a tenant has the host, NICo locks UEFI/BIOS settings so they cannot be changed. NICo's capabilities list this as "UEFI lockdown during active use, which prevents unauthorized BIOS changes while a tenant has the host". How lockdown works is vendor-specific. It is usually a BMC or firmware feature exposed through OEM Redfish extensions (Chapter 6). While it is on, configuration writes are refused until it is switched off again from the management side.

Lockdown alone is not enough, because of **in-band access**. *In-band* means the host OS talking to its own BMC over an internal path: IPMI over the KCS interface, or the Redfish Host Interface, which appears to the OS as a USB network adapter. If that path is open, root on the host can send BMC commands without ever touching the OOB network. NICo therefore **disables in-band host-to-BMC access**, so management happens only out-of-band, from NICo, over the OOB network.

Supporting layers:

- **Per-device UEFI passwords.** NICo sets a site-managed UEFI password on each host and DPU. Site Explorer will not start ingesting until those credentials are configured.
- **Observation.** Site Explorer records each BMC's lockdown mode, so drift is visible.
- **Attestation.** Measured Boot and TPM checks detect changes that slipped past the other layers.

The lifecycle is: apply the firmware baseline while unlocked → enable lockdown → tenant uses the host → NICo disables lockdown → sanitize and re-baseline → lock again for the next tenant.

**Analogy.** In a hotel the thermostat and fuse box are behind a panel only staff can open. Guests use the room but can't rewire it, and housekeeping opens the panel between stays. The analogy breaks down because a hotel panel is a single physical lock. Firmware lockdown depends on vendor implementation quality, and a guest who could phone the front desk from inside the room (in-band access) might get around the panel. That's why NICo also closes the in-band path and verifies with attestation.

### Worked example: Lock a mock BMC and watch tenant attempts fail

**Step 1: Start a fresh mock BMC.**

Restart `mockbmc.py` from Lesson 1 so its state is clean:

```bash
python3 mockbmc.py
```

In another terminal: `B=http://127.0.0.1:8000/redfish/v1/Systems/1`. In this mock, the header `X-Mock-Inband: 1` stands for "this request comes from the host OS over an internal channel". It is a made-up convention for the lab, not real Redfish.

**Step 2: Show in-band access works while unlocked.**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Mock-Inband: 1' $B
# 200
```

**Step 3: Controller enables lockdown out-of-band.**

The mock exposes lockdown as an OEM field, which is how real vendors tend to do it:

```bash
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"Oem": {"Mock": {"Lockdown": true}}}' $B
```

**Step 4: Tenant attempts fail.**

```bash
# in-band from the host: refused entirely
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Mock-Inband: 1' $B           # 403
# BIOS change, even without the in-band header: refused while locked
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"Attributes": {"SecureBoot": "Disabled"}}' $B/Bios/Settings           # BIOS settings locked
```

**Step 5: Release: unlock, then changes work again.**

```bash
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"Oem": {"Mock": {"Lockdown": false}}}' $B
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"Attributes": {"SriovGlobalEnable": "Enabled"}}' $B/Bios/Settings      # accepted
```

### Your turn: finish it

Fill in the blanks so the host is locked before the tenant gets it, and so the last command proves in-band access is refused (it should print 403).

```text
B=http://127.0.0.1:8000/redfish/v1/Systems/1
# 1. finish firmware changes while unlocked
curl -s -X PATCH -H 'Content-Type: application/json' -d '{"Attributes":{"SriovGlobalEnable":"Enabled"}}' $B/Bios/Settings
curl -s -X POST -H 'Content-Type: application/json' -d '{"ResetType":"ForceRestart"}' $B/Actions/ComputerSystem.Reset
# 2. lock before the tenant gets the host
curl -s -X PATCH -H 'Content-Type: application/json' -d '{"Oem":{"Mock":{"Lockdown":___}}}' $B
# 3. prove in-band access is refused (expect 403)
curl -s -o /dev/null -w '%{http_code}\n' -H '___: 1' $B
```

<details>
<summary>Answer</summary>

The first blank is `true`, a JSON boolean without quotes. The second blank is `X-Mock-Inband`, the lab's stand-in for a request from the host OS. The order matters: all firmware changes happen before lockdown, because the mock refuses BIOS writes once it is locked.

</details>

### Your turn: on your own

Put these actions in the right order for one tenant's stay and the handover to the next tenant. Say which steps happen with lockdown ON. Actions: (a) tenant runs workload, (b) disable lockdown, (c) enable lockdown, (d) apply BIOS/firmware baseline and reboot, (e) sanitize: erase drives and clean up, (f) hand the host to the next tenant. Some actions appear more than once.

<details>
<summary>Hint 1</summary>

Lockdown has to be on before the tenant ever touches the host.

</details>

<details>
<summary>Hint 2</summary>

NICo can't re-baseline or change settings while the host is locked, so lockdown comes off before any NICo maintenance.

</details>

<details>
<summary>Hint 3</summary>

The pattern repeats: baseline → lock → use → unlock → clean → baseline → lock → hand over.

</details>

<details>
<summary>Answer</summary>

d → c → (lockdown ON) a → b → e → d → c → (lockdown ON) f. Lockdown is on whenever a tenant has the host, and off only while NICo is working on it between tenants.

</details>

### Explain it

In your own words: Explain in your own words why UEFI lockdown on its own doesn't protect firmware if a tenant can still reach the BMC from inside the host. What does disabling in-band access add?

### Check

**1. What does 'in-band host-to-BMC access' mean?**

A. The tenant OS talking to its own BMC over an internal channel such as IPMI KCS or the Redfish Host Interface
B. NICo talking to the BMC over the OOB network
C. The DPU agent polling NICo Core for configuration
D. A switch relaying DHCP from the BMC

<details>
<summary>Answer</summary>

**A.** The tenant OS talking to its own BMC over an internal channel such as IPMI KCS or the Redfish Host Interface

In-band means the path goes through the host itself. NICo's own Redfish traffic over the OOB network is the out-of-band path that NICo keeps. DPU agent polling and DHCP relay are unrelated.

</details>

**2. When does NICo keep UEFI lockdown enabled?**

A. Only during discovery
B. While a tenant has the host
C. Permanently; it is never disabled
D. Only while firmware updates are running

<details>
<summary>Answer</summary>

**B.** While a tenant has the host

Lockdown protects the host during active use. It can't be permanent, because NICo has to change settings and update firmware between tenants, and firmware updates need the host unlocked.

</details>

**3. Besides lockdown and disabling in-band access, name one other NICo measure that stops a tenant from changing or hiding firmware changes.**

<details>
<summary>Answer</summary>

Any one of: per-device UEFI passwords managed by NICo; Site Explorer recording lockdown mode; Measured Boot/TPM attestation, which detects changes.

UEFI passwords block the setup menu. Site Explorer's records make drift visible. Attestation catches anything the other layers missed.

</details>

**Sources:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md)

<a id="boot-order-and-boot-source-override"></a>
## 3. Boot order and boot source override

*Builds on: UEFI/BIOS settings (ch. 8), UEFI firmware and Secure Boot (ch. 5)*

### Before you read

- A server's boot order is [local disk, network], and the disk holds a working OS. How could you make it boot from the network exactly once without editing the boot order?
- After a 'Once' override has been used, what happens on the following reboot?

<details>
<summary>Answers</summary>

- **A server's boot order is [local disk, network], and the disk holds a working OS. How could you make it boot from the network exactly once without editing the boot order?** Set a one-time boot source override through Redfish: `BootSourceOverrideEnabled: Once` and `BootSourceOverrideTarget: Pxe`. The next boot goes to the network. After that the override clears and the normal order applies again.
- **After a 'Once' override has been used, what happens on the following reboot?** The host falls back to its normal boot order. The override resets to Disabled/None.

</details>

### Explanation

In Chapter 5 you saw that UEFI keeps **boot options** (`Boot0001`, `Boot0002`, …), each with a device path, plus a **BootOrder** list. On every boot the firmware tries the options in order until one works.

Redfish exposes this under `/redfish/v1/Systems/<id>` in the `Boot` object:

- `BootOrder`: an array of references such as `"Boot0001"`. Each has a matching resource under `BootOptions/` with a `DisplayName` and a `UefiDevicePath`. Changing it is **persistent**. On some BMCs it is staged like a BIOS setting and applied at the next reboot.
- `BootSourceOverrideTarget`: a device *class* to boot instead, for example `Pxe`, `Hdd`, `Cd`, `Usb`, `UefiHttp` or `BiosSetup`. `None` means no override.
- `BootSourceOverrideEnabled`: `Disabled`, `Once` (used on the next boot, then cleared) or `Continuous` (used on every boot until changed).

The override sits on top of the boot order without changing it. If the target isn't available, for example network boot is disabled on the NIC, many firmwares fall back to the normal order without reporting anything. So check where the host actually booted.

**Why NICo cares:** NICo provisions machines by network-booting them (PXE/iPXE, covered in Chapter 12). Its BMC requirements include *boot order configuration*, described as "Set UEFI boot order (DPU first)": the DPU's network path comes first in the UEFI order. Managed hosts are configured to always boot from PXE. NICo's PXE Service then decides what the host gets, and if a local bootable device is found, the host boots it. A persistent network-first order means every boot, including one the tenant starts from inside the OS, passes through NICo instead of depending on someone remembering to set an override. Site Explorer records each host's boot order, and the Debug Web UI lets operators change boot orders.

**Analogy.** The boot order is like the saved route preferences in your GPS. A one-time override is "take the detour for this trip only", and Continuous is "always use the detour until I say stop". The analogy breaks down because a GPS tells you when a road is closed. Firmware whose override target doesn't exist often falls back to the normal route without telling you.

### Worked example: PXE once, then back to disk

**Step 1: Inspect the current boot settings.**

Start `mockbmc.py` from Lesson 1, then:

```bash
B=http://127.0.0.1:8000/redfish/v1/Systems/1
curl -s $B | python3 -c 'import json,sys; print(json.load(sys.stdin)["Boot"])'
# {'BootSourceOverrideEnabled': 'Disabled', 'BootSourceOverrideTarget': 'None', 'BootOrder': ['Boot0001', 'Boot0002', 'Boot0003']}
```

**Step 2: Decode the boot options.**

```bash
for o in Boot0001 Boot0002 Boot0003; do curl -s $B/BootOptions/$o | grep DisplayName; done
# Boot0001 = local NVMe, Boot0002 = PXE IPv4, Boot0003 = UEFI HTTP
```

So the persistent order is disk first.

**Step 3: Set a one-time PXE override.**

```bash
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"Boot": {"BootSourceOverrideEnabled": "Once", "BootSourceOverrideTarget": "Pxe"}}' $B
```

**Step 4: Reboot and check.**

```bash
curl -s -X POST -H 'Content-Type: application/json' -d '{"ResetType":"ForceRestart"}' \
  $B/Actions/ComputerSystem.Reset
# "BootedFrom": "Boot0002"  (PXE)
curl -s $B | grep Override
# Enabled is back to "Disabled", Target to "None": the override was used up
```

**Step 5: Reboot again.**

```bash
curl -s -X POST -H 'Content-Type: application/json' -d '{"ResetType":"ForceRestart"}' \
  $B/Actions/ComputerSystem.Reset
# "BootedFrom": "Boot0001"  (back to disk)
```

### Your turn: finish it

Fill in the body so the next boot (only) goes to the network.

```text
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"Boot": {"BootSourceOverrideEnabled": "___", "BootSourceOverrideTarget": "___"}}' \
  http://127.0.0.1:8000/redfish/v1/Systems/1
```

<details>
<summary>Answer</summary>

The first blank is `Once`. The second blank is `Pxe`. `Continuous` would also give you PXE on the next boot, but it would keep doing so on every boot after that.

</details>

### Your turn: on your own

Make the mock host boot from the network on every reboot without using any override, so the setup matches NICo's persistent network-first order. Prove it with two resets in a row.

<details>
<summary>Hint 1</summary>

A persistent change means editing `BootOrder`, not the override fields.

</details>

<details>
<summary>Hint 2</summary>

PATCH `/redfish/v1/Systems/1` with a `Boot` object that contains only a new `BootOrder` array.

</details>

<details>
<summary>Hint 3</summary>

Put `Boot0002` first: `{"Boot": {"BootOrder": ["Boot0002", "Boot0001", "Boot0003"]}}`.

</details>

<details>
<summary>Answer</summary>

```bash
B=http://127.0.0.1:8000/redfish/v1/Systems/1
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"Boot": {"BootOrder": ["Boot0002", "Boot0001", "Boot0003"]}}' $B
for i in 1 2; do
  curl -s -X POST -H 'Content-Type: application/json' -d '{"ResetType":"ForceRestart"}' \
    $B/Actions/ComputerSystem.Reset | grep BootedFrom
done
# both print "Boot0002"
```
On real hardware, some BMCs stage `BootOrder` changes until the next reboot. Read the order back after the first reset to confirm it took.

</details>

### Explain it

In your own words: Why would an operator want a persistent network-first boot order instead of setting a one-time PXE override before each provisioning step? Think about reboots NICo didn't start.

### Check

**1. You set `BootSourceOverrideEnabled: Once` and `BootSourceOverrideTarget: Pxe`, then the host reboots twice. What happens?**

A. Both boots use PXE
B. The first boot uses PXE; the second follows the normal boot order
C. The first boot follows the normal order; the second uses PXE
D. Neither boot changes until BootOrder is edited too

<details>
<summary>Answer</summary>

**B.** The first boot uses PXE; the second follows the normal boot order

Once is used up by the next boot and then resets to Disabled. 'Both' describes Continuous. An override doesn't require editing BootOrder.

</details>

**2. What are entries like `Boot0001` in a Redfish `BootOrder`?**

A. References to UEFI Boot#### load options, each with a device path
B. DHCP option numbers for boot files
C. MAC addresses of NICs
D. Redfish session IDs

<details>
<summary>Answer</summary>

**A.** References to UEFI Boot#### load options, each with a device path

They map directly to UEFI boot variables (Chapter 5). DHCP boot-file options are a separate mechanism used later in PXE.

</details>

**3. Which Redfish capability does NICo require for boot devices, and what does it say?**

<details>
<summary>Answer</summary>

Boot order configuration: "Set UEFI boot order (DPU first)".

It is listed in the BMC Redfish requirements table. It is how managed hosts are set up to always boot from the network.

</details>

**Sources:** [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md)

<a id="cloud-init"></a>
## 4. cloud-init

### Before you read

- You boot 50 machines from the same OS image. How does each one end up with its own hostname and SSH key without anyone logging in to it?
- You edit the user-data and reboot a machine, but the new users and packages don't appear. Guess why.

<details>
<summary>Answers</summary>

- **You boot 50 machines from the same OS image. How does each one end up with its own hostname and SSH key without anyone logging in to it?** A first-boot agent in the image (cloud-init) fetches per-machine data from a datasource (meta-data such as instance-id and hostname, plus user-data with instructions) and applies it.
- **You edit the user-data and reboot a machine, but the new users and packages don't appear. Guess why.** cloud-init runs its per-instance steps once per instance-id. The instance-id didn't change, so it treated this as the same instance and skipped them.

</details>

### Explanation

**cloud-init** is the standard tool, across many Linux distributions, for configuring an OS on first boot. It ships inside the OS image. Early in boot it detects a **datasource**, which is where its configuration comes from: a cloud metadata service, a small disk or ISO, or an HTTP URL (the *NoCloud* datasource supports all three). It fetches:

- **meta-data**: facts about this instance, mainly `instance-id` and `local-hostname`.
- **user-data**: what to do. The most common format is YAML that starts with the exact line `#cloud-config`. A plain shell script starting with `#!` also works.
- Optionally **vendor-data** and **network-config**.

Common `#cloud-config` keys are `users` (with `ssh_authorized_keys`), `packages`, `write_files` and `runcmd`. cloud-init runs in stages through boot (local, network, config, final) and logs to `/var/log/cloud-init.log` and `/var/log/cloud-init-output.log`. `cloud-init status --wait` blocks until it has finished.

**instance-id matters.** Per-instance modules run once for each instance-id. If you reboot with the same id, they are skipped. A new id makes cloud-init treat the machine as a new instance.

**In NICo:** the PXE Service serves boot artifacts, including iPXE scripts, **cloud-init user-data** and OS images, to managed hosts and DPUs over HTTP. It asks the API Service which artifact is correct for each host. cloud-init is used in two ways. DPUs get a NICo-provided cloud-init file that installs NICo components on top of the base DPU image. Tenants can supply their own cloud-init to configure the OS they install on the host. Because NICo supports any OS that iPXE can install, cloud-init is the common way to hand that OS its first-boot instructions.

One caution: user-data often contains secrets or keys, and anything that can reach the datasource can read it. Treat it as sensitive.

**Analogy.** cloud-init is like the setup card taped inside a flat-pack furniture box: same kit everywhere, but the card says which colour handles to fit and whose name goes on the label. The analogy breaks down because cloud-init remembers it has already followed the card for this instance-id. Swap the card without changing the id and nothing happens.

### Worked example: Write, validate and serve user-data like a PXE service

**Step 1: Write the seed files.**

```bash
mkdir -p seed && cd seed
cat > meta-data <<'EOF'
instance-id: node-01-2026a
local-hostname: node-01
EOF
cat > user-data <<'EOF'
#cloud-config
hostname: node-01
users:
  - name: ops
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMP ops@laptop
packages:
  - chrony
runcmd:
  - echo "provisioned by cloud-init" > /etc/motd
EOF
cd ..
```
If you plan to boot a VM in step 4, replace the example key with the contents of your own `~/.ssh/id_ed25519.pub` (create one with `ssh-keygen -t ed25519` if needed). The user `ops` has no password, so SSH with that key is the only way in.

**Step 2: Validate the schema.**

Use a throwaway Ubuntu container so you don't install cloud-init on your laptop:

```bash
docker run --rm -v "$PWD/seed":/seed ubuntu:24.04 bash -c \
  'apt-get update -qq && apt-get install -y -qq cloud-init >/dev/null && cloud-init schema --config-file /seed/user-data'
```
You should see a line saying the schema is valid. Remove the `#cloud-config` line and run it again to see it fail.

**Step 3: Serve it over HTTP.**

This is what a PXE service does for user-data. Use port 8080 so it doesn't clash with the mock BMC from Lessons 1–3 on port 8000 (or stop `mockbmc.py` with Ctrl-C first):

```bash
python3 -m http.server 8080 --directory seed
# in another terminal:
curl -s http://127.0.0.1:8080/meta-data
curl -s http://127.0.0.1:8080/user-data | head -3
```

**Step 4: (Optional) Boot a real VM against it.**

With QEMU and an Ubuntu cloud image (`https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img`), point the NoCloud datasource at your server through SMBIOS. Inside QEMU's user network, your laptop is `10.0.2.2`, and the URL must end with `/`. The `hostfwd` option forwards your laptop's port 2222 to the VM's SSH port:

```bash
qemu-img create -f qcow2 -b noble-server-cloudimg-amd64.img -F qcow2 node01.qcow2
qemu-system-x86_64 -m 1024 -nographic -accel kvm \
  -drive file=node01.qcow2,if=virtio \
  -nic user,model=virtio-net-pci,hostfwd=tcp::2222-:22 \
  -smbios 'type=1,serial=ds=nocloud;s=http://10.0.2.2:8080/'
```
On macOS, use `-accel hvf` (and the arm64 image with `qemu-system-aarch64` on Apple silicon). Your http.server log shows `GET /meta-data` and `GET /user-data`. A 404 for `/vendor-data` is normal. The serial console shows the boot but you can't log in there, because `ops` has no password. To quit QEMU later, press Ctrl-a then x.

**Step 5: Check the result.**

From a second terminal on your laptop, once the VM has booted (allow a minute or two):

```bash
ssh -p 2222 -i ~/.ssh/id_ed25519 ops@127.0.0.1
# inside the VM:
cloud-init status --wait
cat /etc/motd
id ops
```
If SSH is refused, wait a little longer; sshd starts late on first boot. If something is missing after login, read `/var/log/cloud-init-output.log`.

### Your turn: finish it

Fill in the two blanks so this is valid cloud-config that creates user `ops` with an SSH key.

```text
___
hostname: node-01
users:
  - name: ops
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ___:
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMP ops@laptop
runcmd:
  - echo "provisioned by cloud-init" > /etc/motd
```

<details>
<summary>Answer</summary>

The first line is `#cloud-config`, exactly that and on line 1. The key is `ssh_authorized_keys`; the blank already sits at four spaces of indentation, lined up with `shell:`. Check it with `cloud-init schema --config-file user-data`.

</details>

### Your turn: on your own

Extend the worked example's user-data so it also creates the file `/etc/nico-lab/role` containing `gpu-worker` with mode `0644`. Validate it with the schema check. Then decide what you must change in meta-data so an already-booted VM applies the new user-data on its next boot.

<details>
<summary>Hint 1</summary>

Look up the `write_files` module.

</details>

<details>
<summary>Hint 2</summary>

Each `write_files` entry takes `path`, `content` and `permissions`. Quote the permissions as a string.

</details>

<details>
<summary>Hint 3</summary>

For the rerun, think about the field cloud-init uses to decide whether this is a new instance.

</details>

<details>
<summary>Answer</summary>

Add:
```yaml
write_files:
  - path: /etc/nico-lab/role
    content: |
      gpu-worker
    permissions: '0644'
```
Then change `instance-id` in meta-data, for example to `node-01-2026b`. With the old id, cloud-init's per-instance modules are skipped on reboot.

</details>

### Explain it

In your own words: When a bare-metal host passes from one tenant to the next and is reprovisioned, why does it matter that cloud-init keys its first-boot work on instance-id?

### Check

**1. For YAML user-data to be treated as cloud-config, what must the first line be?**

A. #cloud-config
B. ---
C. #!/bin/bash
D. cloud-config:

<details>
<summary>Answer</summary>

**A.** #cloud-config

cloud-init chooses the user-data format from that header. `---` is just a YAML document marker. `#!/bin/bash` makes the user-data a shell script, which is valid but a different format.

</details>

**2. Which NICo component serves cloud-init user-data to managed hosts?**

A. PXE Service
B. DHCP Server
C. Hardware Health
D. Site Explorer

<details>
<summary>Answer</summary>

**A.** PXE Service

The PXE Service serves iPXE scripts, cloud-init user-data and OS images over HTTP, and gets the right artifact from the API Service. DHCP hands out addresses, Hardware Health scrapes sensors, and Site Explorer crawls BMCs.

</details>

**3. Name the two ways NICo uses cloud-init.**

<details>
<summary>Answer</summary>

DPUs use a NICo-provided cloud-init file to install NICo components on the base DPU image, and tenants can supply custom cloud-init to configure the OS on their host.

Both are described in the glossary entry for cloud-init in NICo.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md)

<a id="ntp-time-synchronization"></a>
## 5. NTP time synchronization

### Before you read

- A BMC's clock says it is 2019. NICo connects to its Redfish API over HTTPS. What could go wrong?
- What do you think 'stratum 2' means for an NTP server?

<details>
<summary>Answers</summary>

- **A BMC's clock says it is 2019. NICo connects to its Redfish API over HTTPS. What could go wrong?** TLS certificate checks can fail, because certificates look not-yet-valid or expired against the wrong clock. Log and telemetry timestamps can't be lined up with other systems. Anything time-limited, such as tokens or sessions, can behave strangely.
- **What do you think 'stratum 2' means for an NTP server?** It is two steps from a reference clock. A stratum 1 server is attached directly to a reference such as GPS or an atomic clock, and a stratum 2 server syncs from stratum 1.

</details>

### Explanation

**NTP** (Network Time Protocol, UDP port 123) keeps clocks in step. A client sends a request and the server returns timestamps. Using the time it sent the request, the time the server received it, the time the server replied, and the time the reply arrived, the client estimates two things: its **offset** (how far off its clock is) and the network **delay**, which it compensates for. Servers advertise a **stratum**: 1 means directly attached to a reference clock, and each step further away adds one. Clients usually use several servers, so one wrong server (a *falseticker*) can be outvoted. **chrony** (`chronyd` daemon, `chronyc` CLI) is a common NTP implementation. **SNTP** is a simpler one-shot form of the same packet exchange.

Why infrastructure cares: TLS (which mTLS and Redfish over HTTPS rely on) checks certificate validity windows against the local clock. Logs from BMCs, DPUs and the control plane are only useful together if their timestamps agree.

**How NICo handles time:**

- `siteConfig.ntp_servers` lists **enterprise NTP server IPs** used for **BMC time setup** and **DHCP option 42** (option 42 is the IPv4 DHCP option that carries NTP servers). Leave it as `[]` to use the legacy DHCP/DNS fallback. NICo sets BMC time from these servers before ingestion.
- **nico-ntp** is an optional built-in service: a **3-replica chrony StatefulSet** in which each replica gets its own MetalLB VIP. To use it, set `nico-ntp.externalService.enabled: true`, assign three VIPs through `nico-ntp.externalService.perPodAnnotations`, and set `nico-dhcp.config.kea.hookParameters.ntpServer` to a comma-separated list of the same VIPs, **so DPUs receive them over DHCP**. The enterprise servers in `ntp_servers` are still used for BMC pre-ingestion sync, independently of nico-ntp.
- For IPv6 NTP advertised through DHCPv6 option 56, add AAAA records under `unbound.localData` for the agent's NTP hostname (`carbide-ntp.forge` by default).

**Analogy.** Imagine setting your watch by asking someone who set theirs from the station clock (stratum 2). NTP goes further: it times how long the answer took to reach you and corrects for that delay. Here the analogy breaks down, because a person passing on the time can't correct for the minute they spent walking over to you.

### Worked example: Ask an NTP server for the time with 20 lines of Python

**Step 1: Write an SNTP client.**

Save as `sntp.py` (you'll reuse it in the build task):

```python
#!/usr/bin/env python3
"""sntp.py: send one SNTP request and print what the server says."""
import socket
import struct
import sys
import time

NTP_EPOCH_OFFSET = 2208988800  # seconds from 1900-01-01 to 1970-01-01

server = sys.argv[1] if len(sys.argv) > 1 else "pool.ntp.org"
request = b"\x1b" + 47 * b"\0"  # LI=0, version 3, mode 3 (client)
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(3)
t_send = time.time()
sock.sendto(request, (server, 123))
data, _ = sock.recvfrom(512)
t_recv = time.time()
leap = data[0] >> 6
stratum = data[1]
secs, frac = struct.unpack("!II", data[40:48])
server_time = secs - NTP_EPOCH_OFFSET + frac / 2**32
local_mid = (t_send + t_recv) / 2
print(f"server={server} stratum={stratum} leap={leap}")
print("server time:", time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(server_time)))
print(f"approx offset (server - local): {server_time - local_mid:+.3f} s, round trip {t_recv - t_send:.3f} s")
```

**Step 2: Query a public server.**

```bash
python3 sntp.py pool.ntp.org
# server=pool.ntp.org stratum=2 leap=0
# server time: 2026-11-21 10:15:02 UTC
# approx offset (server - local): +0.004 s, round trip 0.031 s
```
If it times out, your network may block outbound UDP 123. Try `time.google.com`, or a server your organisation provides.

**Step 3: Compare with your OS's own sync.**

Linux with chrony: `chronyc tracking` (look at *Stratum* and *System time*). systemd: `timedatectl`. macOS: `sntp time.apple.com`.

**Step 4: Interpret.**

Stratum 1–3 and an offset in milliseconds mean a healthy clock. `leap=3` or `stratum=0` means the server itself is not synchronised, so don't trust it. Our offset ignores how the delay splits between the two directions, which full NTP handles properly. That's fine for a sanity check.

### Your turn: finish it

Two numbers are missing from the SNTP client. Fill them in.

```text
NTP_EPOCH_OFFSET = ___  # seconds from 1900-01-01 to 1970-01-01
...
sock.sendto(request, (server, ___))
```

<details>
<summary>Answer</summary>

`NTP_EPOCH_OFFSET = 2208988800`, because NTP counts seconds from 1900 and Unix time counts from 1970. The port is `123`, the NTP UDP port.

</details>

### Your turn: on your own

A site has `ntp_servers = ["10.1.1.10", "10.1.1.11"]` in siteConfig. nico-ntp is enabled with VIPs 10.180.126.170–172, and `nico-dhcp.config.kea.hookParameters.ntpServer` is set to those three. (a) Which servers set a host BMC's clock before ingestion? (b) How do DPUs learn about the nico-ntp VIPs? (c) You also want DPUs to get IPv6 NTP through DHCPv6 option 56. What do you add?

<details>
<summary>Hint 1</summary>

The docs keep enterprise NTP for BMCs separate from nico-ntp.

</details>

<details>
<summary>Hint 2</summary>

Look at what the DHCP hook parameter is for.

</details>

<details>
<summary>Hint 3</summary>

IPv6 discovery goes through a DNS name that the agent has built in.

</details>

<details>
<summary>Answer</summary>

(a) The enterprise servers in `ntp_servers` (10.1.1.10 and 10.1.1.11). They are used for BMC pre-ingestion time sync whether or not nico-ntp is enabled. (b) Over DHCP: the `ntpServer` hook parameter on nico-dhcp hands out the comma-separated VIPs. (c) AAAA records with reachable IPv6 NTP addresses under `unbound.localData` for the agent's NTP hostname, `carbide-ntp.forge` by default. Without them only the IPv4 path is available.

</details>

### Explain it

In your own words: Why does it make sense for NICo to set a BMC's time before ingestion, rather than after it starts managing the host? Think about what ingestion does over HTTPS.

### Check

**1. What is nico-ntp?**

A. A 3-replica chrony StatefulSet where each replica has its own MetalLB VIP
B. A single NTP pod behind one shared VIP
C. An NTP client installed on every BMC
D. Another name for DHCP option 42

<details>
<summary>Answer</summary>

**A.** A 3-replica chrony StatefulSet where each replica has its own MetalLB VIP

Each replica gets its own VIP, so clients see three independent servers. That gives redundancy and lets clients outvote a bad server. A single shared VIP would hide which replica answered.

</details>

**2. Which setting delivers the nico-ntp VIPs to DPUs over DHCP?**

A. nico-dhcp.config.kea.hookParameters.ntpServer
B. siteConfig.dhcp_servers
C. nico-ntp.externalService.enabled on its own
D. deny_prefixes

<details>
<summary>Answer</summary>

**A.** nico-dhcp.config.kea.hookParameters.ntpServer

Enabling the external service only exposes the VIPs; DHCP has to advertise them as well. `dhcp_servers` lists DHCP servers, not NTP servers, and `deny_prefixes` is an isolation setting.

</details>

**3. What is the IPv4 DHCP option number for NTP servers?**

<details>
<summary>Answer</summary>

42

`ntp_servers` feeds DHCP option 42. The IPv6 equivalent mentioned in the docs is DHCPv6 option 56.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="dns"></a>
## 6. DNS (authoritative and recursive)

*Builds on: IP networking fundamentals (ch. 3)*

### Before you read

- When your laptop looks up www.example.com, does the DNS server in your network settings usually own that name? If not, how does it find the answer?
- What do you think it means for a zone to be 'delegated' to someone?

<details>
<summary>Answers</summary>

- **When your laptop looks up www.example.com, does the DNS server in your network settings usually own that name? If not, how does it find the answer?** No. It is a recursive resolver. It asks the root servers, then the .com servers, then example.com's authoritative servers, and caches the result.
- **What do you think it means for a zone to be 'delegated' to someone?** The parent zone publishes NS records saying "for this subdomain, ask these servers". Those servers then become authoritative for the subdomain.

</details>

### Explanation

DNS (Domain Name System) turns names into addresses. It is split into **zones**, which are parts of the name tree that one party manages, such as `example.com` or `mysite.example.com`.

Servers play one of two roles:

- An **authoritative server** answers only for zones it owns, from its own data. Its answers carry the **`aa`** (authoritative answer) flag. Ask it about a name outside its zones and it refers you elsewhere or refuses. It does not look the name up for you.
- A **recursive resolver** answers *any* name for its clients. It starts at the root, follows **NS referrals** (".com is served by these servers", then "example.com by these"), gets the answer from the authoritative server, and **caches** it for the record's TTL. Its replies carry **`ra`** (recursion available) but usually not `aa`.

**Delegation** joins the two. A parent zone delegates a child zone by publishing NS records for it, plus **glue** A/AAAA records when the name servers sit inside the child zone. Recursive resolvers follow that delegation to the child's authoritative servers.

**In NICo** both roles run:

- **nico-dns** (the Authoritative DNS Service) is authoritative for **NICo-delegated zones**. It answers queries from the site controller and managed nodes, and gets its data from the API Service over mTLS/gRPC. It runs as replicas with their own VIPs, which are set through `perPodAnnotations`.
- **Unbound** is the recursive resolver for **managed machines and tenant instances**, reached over the OOB network. It forwards queries for NICo-managed zones to nico-dns and resolves everything else recursively.

The site's base domain is `initial_domain_name` in siteConfig. Separately, your *external* DNS must resolve the `nico-api` hostname to the nico-api VIP.

**Analogy.** A recursive resolver is a reference librarian: ask about any book and they track it down, keeping popular ones on a nearby shelf (the cache). An authoritative server is the author, who can only speak about their own books. The analogy breaks down because a librarian's shelf copy of a DNS record expires after its TTL, and until then the librarian may hand you an outdated copy even though the author has updated it.

### Worked example: Watch authoritative and recursive answers differ

**Step 1: Get dig.**

macOS already has `dig`. On Debian/Ubuntu run `sudo apt install bind9-dnsutils`. Or use a container: `docker run --rm -it debian:stable-slim bash -c 'apt-get update -qq && apt-get install -y -qq bind9-dnsutils >/dev/null && bash'`.

**Step 2: Find who is authoritative.**

```bash
dig +short NS example.com
```
Pick one of the names it returns. The steps below call it `$NS`, for example `NS=$(dig +short NS example.com | head -1)`.

**Step 3: Ask the authoritative server.**

```bash
dig @$NS example.com A +norecurse | grep -E 'flags|^example'
```
The header flags include **`aa`**: this server owns the zone.

**Step 4: Ask a recursive resolver.**

```bash
dig @1.1.1.1 example.com A | grep flags
```
The flags show `rd ra` and no `aa`: the resolver fetched the answer, or served it from cache, on your behalf.

**Step 5: Ask the authoritative server about someone else's name.**

```bash
dig @$NS www.wikipedia.org A +norecurse | grep -E 'status|flags'
```
You get no answer, often `status: REFUSED`, and no `ra`. Authoritative servers don't recurse.

**Step 6: See the delegation chain.**

```bash
dig +trace example.com
```
Root → `com.` NS referral → `example.com.` NS referral → the final authoritative answer. This is the walk a recursive resolver does for you.

### Your turn: finish it

In unbound's config syntax, make the resolver send queries for the site's delegated zone to two authoritative servers (illustrative VIPs) and resolve everything else recursively. This shows the idea; it is not NICo's shipped Unbound configuration. You can check your answer with `unbound-checkconf <file>` after `apt install unbound` in a Debian container.

```text
server:
    interface: 0.0.0.0
    access-control: 10.0.0.0/8 allow

___:
    name: "mysite.example.com."
    ___: 10.180.126.165
    stub-addr: 10.180.126.166
```

<details>
<summary>Answer</summary>

The first blank is `stub-zone`, so the line reads `stub-zone:` at column 0. The second is `stub-addr`, already indented 4 spaces like the line below it. A stub zone sends non-recursive queries to the authoritative servers you list. Unbound also has `forward-zone`/`forward-addr`, which forward to another resolver instead.

</details>

### Your turn: on your own

A tenant instance resolves `github.com` fine, but lookups for names under the site's NICo-managed zone fail. Using dig, how would you work out whether the problem is in the recursive layer or the authoritative layer?

<details>
<summary>Hint 1</summary>

The two layers are Unbound (recursive) and nico-dns (authoritative). Query each one directly.

</details>

<details>
<summary>Hint 2</summary>

Use `+norecurse` when you query nico-dns directly, and look for the `aa` flag.

</details>

<details>
<summary>Hint 3</summary>

If nico-dns answers with `aa` but Unbound fails, look at how Unbound hands that zone to nico-dns. If nico-dns doesn't answer either, look at nico-dns and its VIPs.

</details>

<details>
<summary>Answer</summary>

1) `dig @<unbound-address> <name>` reproduces the failure. 2) `dig @<nico-dns VIP> <name> +norecurse` asks the authoritative server directly. If you get an answer with `aa`, the record exists, so the fault is between Unbound and nico-dns: the zone forwarding, or reachability from Unbound to the nico-dns VIPs. If nico-dns doesn't answer or returns NXDOMAIN, check the nico-dns pods, their LoadBalancer VIPs (`kubectl get svc -n nico-system`), and whether the record should exist. Public names working shows that Unbound's ordinary recursion is fine.

</details>

### Explain it

In your own words: Why does NICo run both an authoritative server and a recursive resolver, instead of one server that does both jobs for managed machines?

### Check

**1. What does the `aa` flag in a DNS response mean?**

A. The answer came from a server that is authoritative for the zone
B. The answer came from a cache
C. The server offers recursion
D. The answer passed DNSSEC validation

<details>
<summary>Answer</summary>

**A.** The answer came from a server that is authoritative for the zone

`aa` means authoritative answer. Recursion available is `ra`, cached answers usually lack `aa`, and DNSSEC validation shows as `ad`.

</details>

**2. A managed machine queries a NICo-managed name. Which path does the query take?**

A. To Unbound, which forwards it to nico-dns
B. Straight to nico-dns, skipping Unbound
C. To the public root servers
D. To nico-dhcp

<details>
<summary>Answer</summary>

**A.** To Unbound, which forwards it to nico-dns

Unbound handles all DNS queries from managed machines and forwards NICo-managed zones to nico-dns. Going to nico-dns directly isn't the documented path for managed machines, and the public root has no knowledge of NICo-delegated zones.

</details>

**3. Which record type in a parent zone delegates a child zone to other name servers?**

<details>
<summary>Answer</summary>

NS records, plus glue A/AAAA records when the name servers are inside the child zone.

NS records are the referrals a recursive resolver follows, as you can see with `dig +trace`.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md)

<a id="dhcp"></a>
## 7. DHCP

*Builds on: CIDR prefixes and /31 point-to-point subnets (ch. 3)*

### Before you read

- A device that has just powered on has no IP address. How can it talk to a DHCP server at all?
- Broadcasts don't cross routers. How could a BMC in rack 12 reach a DHCP server that sits in the control-plane subnet?

<details>
<summary>Answers</summary>

- **A device that has just powered on has no IP address. How can it talk to a DHCP server at all?** It broadcasts. It sends a UDP packet from 0.0.0.0 port 68 to 255.255.255.255 port 67, identifying itself by its MAC address. Every device on the L2 segment receives it, including the DHCP server if one is there.
- **Broadcasts don't cross routers. How could a BMC in rack 12 reach a DHCP server that sits in the control-plane subnet?** Through a DHCP relay on the router or switch interface that faces rack 12. The relay picks up the broadcast and forwards it as unicast to the central server.

</details>

### Explanation

**DHCP** (Dynamic Host Configuration Protocol) gives devices an IP address and settings automatically. The exchange is known as **DORA**:

1. **Discover**: the client broadcasts "I need an address". It is identified by its MAC (the `chaddr` field).
2. **Offer**: a server proposes an address.
3. **Request**: the client asks for that address.
4. **Ack**: the server confirms. The client now has a **lease** for a set time and renews it before it expires.

Along with the address, the server sends **options**: 1 (subnet mask), 3 (router), 6 (DNS servers), 42 (NTP servers, seen in Lesson 5), and boot options that PXE uses later (Chapter 12).

Because Discover is a broadcast, it stays on its L2 segment. A **DHCP relay agent**, usually on the L3 switch interface that is the segment's gateway, catches the broadcast. It writes its own **client-facing interface address** into the packet's **`giaddr`** field and **unicasts** the packet to a configured server. The server uses `giaddr` to choose which subnet to allocate from. That is how one central server can serve many /24s (or /31s, Chapter 3) it isn't attached to. The server replies to the relay, and the relay delivers the reply to the client. Relays may also add **option 82** (relay agent information, such as which port the request came in on).

**In NICo:**

- **nico-dhcp** is the central DHCP service. It handles *relayed* requests from physical networks: `Underlay` endpoints (host BMCs, DPU BMCs, DPU OOB interfaces) and, for zero-DPU hosts, `HostInband` interfaces. It is **stateless**: it converts each DHCP request to gRPC, and **NICo Core does the IP address management**. (Its Helm values have keys under `nico-dhcp.config.kea`, such as `hookParameters`, which suggests a Kea-based implementation; the docs pages here don't describe its internals.)
- A host whose DPU runs in DPU mode gets its own DHCP from a server **on the DPU**. Those requests never reach the underlay or nico-dhcp.
- **BMC discovery:** when a BMC's relayed request arrives, NICo allocates an address and checks the MAC against the expected-machines table to find initial credentials.
- A DPU's RJ45 port gets two addresses: one for the DPU OOB interface and one for the DPU BMC.

**Analogy.** A new employee without a desk number shouts "I need a desk!" in the corridor on floor 12 (broadcast). The floor receptionist (relay) writes "from floor 12" on a note and sends it to HR in another building (unicast to the server), and HR assigns a desk on floor 12 (pool chosen by giaddr). The analogy breaks down in NICo's case: the HR clerk (nico-dhcp) doesn't keep the seating chart. They phone head office (NICo Core) to decide every assignment.

### Worked example: Watch a full DORA exchange between two network namespaces

**Step 1: Start a lab container.**

```bash
docker run --rm -it --privileged --name dhcplab debian:stable-slim bash
# inside:
apt-get update && apt-get install -y iproute2 dnsmasq-base busybox
```
`dnsmasq-base` gives you the dnsmasq binary without a service. `busybox` includes the `udhcpc` DHCP client.

**Step 2: Build one L2 segment.**

```bash
ip netns add srv; ip netns add cli
ip link add v-srv type veth peer name v-cli
ip link set v-srv netns srv; ip link set v-cli netns cli
ip -n srv addr add 10.30.0.1/24 dev v-srv
ip -n srv link set v-srv up
ip -n cli link set v-cli address c4:5a:b1:c8:38:0d   # pretend BMC MAC
ip -n cli link set v-cli up
```

**Step 3: Start a DHCP server.**

```bash
ip netns exec srv dnsmasq --conf-file=/dev/null --no-daemon --user=root --port=0 \
  --interface=v-srv --bind-interfaces \
  --dhcp-range=10.30.0.100,10.30.0.150,255.255.255.0,1h \
  --dhcp-option=option:ntp-server,10.30.0.1 \
  --dhcp-leasefile=/tmp/srv.leases --pid-file=/tmp/srv.pid \
  --log-facility=- --log-dhcp > /tmp/srv.log 2>&1 &
```
`--port=0` turns off dnsmasq's DNS so we only test DHCP.

**Step 4: Run the client.**

```bash
cat > /tmp/udhcpc.sh <<'EOF'
#!/bin/sh
case "$1" in
  bound|renew)
    ip addr add "$ip/$subnet" dev "$interface" 2>/dev/null
    echo "got ip=$ip subnet=$subnet ntp=$ntpsrv"
    ;;
esac
EOF
chmod +x /tmp/udhcpc.sh
ip netns exec cli busybox udhcpc -i v-cli -f -q -n -O ntpsrv -s /tmp/udhcpc.sh
```
You'll see `broadcasting discover`, `broadcasting select`, `lease of 10.30.0.1xx obtained`, then `got ip=... ntp=10.30.0.1`.

**Step 5: Read the server's side.**

```bash
grep -E 'DHCP(DISCOVER|OFFER|REQUEST|ACK)' /tmp/srv.log
cat /tmp/srv.leases     # expiry, MAC, IP, hostname, client-id
```
Four lines, D-O-R-A, each with the MAC `c4:5a:b1:c8:38:0d`. The MAC is the client's identity, which is exactly what NICo matches against expected machines.

### Your turn: finish it

Now put a router between the BMC segment (10.10.0.0/24, router interface 10.10.0.1) and the controller segment, where the DHCP server is at 10.20.0.10. Fill in the relay argument for dnsmasq, whose format is `--dhcp-relay=<local address>,<server address>`.

```text
# runs on the router, in its network namespace
dnsmasq --conf-file=/dev/null --no-daemon --user=root --port=0 \
  --dhcp-relay=___,___ \
  --pid-file=/tmp/relay.pid --log-facility=- --log-dhcp
```

<details>
<summary>Answer</summary>

`--dhcp-relay=10.10.0.1,10.20.0.10`. The first value is the relay's address on the client-facing segment, which ends up in `giaddr`. The second is the central server. The server then needs a `--dhcp-range` (with netmask) covering 10.10.0.0/24 and a route back to it. You'll build all of this in the chapter's build task.

</details>

### Your turn: on your own

A relay on interface 10.10.7.1/24 forwards to a central server that has pools for 10.10.5.0/24, 10.10.7.0/24 and 10.20.0.0/24. (a) Which pool does a BMC behind that relay get an address from, and why? (b) In a NICo site, an engineer points the OOB relay at the nico-api VIP instead of the nico-dhcp VIP. What would you see, and where?

<details>
<summary>Hint 1</summary>

The server never sees the BMC's own address, because it doesn't have one yet. What address does the relay put in the packet?

</details>

<details>
<summary>Hint 2</summary>

giaddr = 10.10.7.1. Which pool contains it?

</details>

<details>
<summary>Hint 3</summary>

For (b), consider who listens on UDP 67 at each VIP, and which logs would stay empty.

</details>

<details>
<summary>Answer</summary>

(a) 10.10.7.0/24. The relay writes its client-facing address 10.10.7.1 into giaddr, and the server picks the pool whose subnet contains giaddr. (b) The BMCs never get leases and keep re-sending Discovers. Nothing listens for DHCP on the nico-api VIP, so `kubectl logs -n nico-system -l app.kubernetes.io/name=nico-dhcp` shows nothing for those MACs, and Site Explorer never finds the BMCs. Fix it by pointing the relay at the nico-dhcp LoadBalancer VIP.

</details>

### Explain it

In your own words: Why does the relay put its own client-facing address into giaddr, and not the address of its uplink towards the server? What would break if it used the uplink address?

### Check

**1. How does a DHCP server decide which subnet to allocate from for a relayed request?**

A. From the giaddr the relay filled in
B. From the vendor prefix of the client's MAC
C. From the request's UDP source port
D. It picks a pool at random

<details>
<summary>Answer</summary>

**A.** From the giaddr the relay filled in

giaddr is the relay's address on the client's segment, so it identifies the subnet. MAC prefixes identify vendors, not locations. The ports are always 67/68.

</details>

**2. In NICo, what decides which IP address a BMC gets?**

A. NICo Core's IP address management; nico-dhcp forwards the request over gRPC
B. The OOB switch's DHCP pool
C. The BMC chooses its own address
D. Kubernetes assigns it

<details>
<summary>Answer</summary>

**A.** NICo Core's IP address management; nico-dhcp forwards the request over gRPC

nico-dhcp is a stateless proxy and Core performs IPAM. The OOB switches only relay requests; they don't allocate addresses.

</details>

**3. Which of these DHCP requests does NOT go to central nico-dhcp?**

A. A DPU-mode host's own DHCP, served by the DHCP server on its DPU
B. A host BMC's request
C. A DPU BMC's request
D. A DPU OOB interface's request

<details>
<summary>Answer</summary>

**A.** A DPU-mode host's own DHCP, served by the DHCP server on its DPU

In DPU mode, the per-host DHCP server on the DPU handles the host's requests locally, so they never reach the physical underlay. BMCs and DPU OOB interfaces are Underlay endpoints that nico-dhcp serves.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="out-of-band-management-network"></a>
## 8. Out-of-band (OOB) management network

*Builds on: Baseboard Management Controller (BMC) (ch. 6), DHCP (ch. 8)*

### Before you read

- Why put BMCs on their own network instead of the same network as the hosts' data NICs?
- Do the OOB switches in a NICo site need to run their own DHCP server?

<details>
<summary>Answers</summary>

- **Why put BMCs on their own network instead of the same network as the hosts' data NICs?** So tenants on the data network can't reach the BMCs that control their hardware, and so management still works when the host OS or data network is broken.
- **Do the OOB switches in a NICo site need to run their own DHCP server?** No. They only relay DHCP to nico-dhcp. NICo manages IP allocation.

</details>

### Explanation

The **OOB management network** is a separate network that connects the BMCs (Chapter 6), and the DPUs' management ports, to the site controller. It is how NICo can discover, power-cycle and repair machines without depending on the host OS. This chapter's pieces meet on it.

**Discovery runs entirely over this network:**

1. A BMC powers on and broadcasts DHCP.
2. The OOB switch's **DHCP relay** forwards the request to the **nico-dhcp VIP** (`NICo_DHCP_EXTERNAL`).
3. nico-dhcp passes it to NICo Core, which allocates an address.
4. Site Explorer crawls the BMC over Redfish. It uses the factory credentials listed for that MAC in `expected_machines.json`, then rotates them to site-managed values.

Only machines in that manifest are ingested. Site Explorer also refuses to contact any BMC (`MissingCredentials`) until the site-wide BMC root credential and the host and DPU UEFI credentials are set.

**Requirements from the docs:**

- Network connectivity from every BMC to the site controller, normally through a dedicated OOB network.
- A DHCP relay on **every BMC-facing network**, pointing at the nico-dhcp service IP. The switches *only relay*; NICo allocates.
- `Underlay` connectivity for DPU BMC and DPU OOB interfaces.

**On the NICo side:** nico-dhcp gets a stable VIP from MetalLB's internal pool, set through `nico-dhcp.externalService.annotations`. `externalService.enabled: true` must be set explicitly, because it defaults to false. Add your OOB and management CIDRs to `deny_prefixes` so tenant instances can't reach them. Unbound serves recursive DNS to managed machines over the OOB network.

**One exception:** a zero-DPU host's *host BMC* (including a host whose DPU policy is `nic`) may share a `HostInband` subnet/VLAN with the host OS. This never applies to DPU BMCs or DPU OOB interfaces, and that topology lacks dedicated network isolation.

**Analogy.** Think of a building's service corridor: only maintenance staff use it, it reaches every room's fuse box, and it stays open when the guest hallways are closed. The analogy breaks down because a real corridor doesn't need a receptionist at each floor forwarding requests to head office. The OOB network does: every segment needs its DHCP relay pointed at nico-dhcp, or the rooms on that floor are never found.

### Worked example: Bring a new rack's OOB segment online for NICo

**Step 1: Find the relay target.**

```bash
kubectl get svc nico-dhcp -n nico-system
```
The external IP should come from your internal VIP pool. If it shows pending, MetalLB hasn't assigned it yet, so fix that first.

**Step 2: List the BMC-facing segments.**

For the new rack, write down every L3 segment that BMCs or DPU management ports sit on, for example host-BMC VLAN `10.91.12.0/24`, plus the Underlay segments for DPU BMC and DPU OOB. Each one needs a relay.

**Step 3: Configure the relay on each segment's gateway.**

On the switch interface that acts as gateway for each segment, enable DHCP relay with the nico-dhcp VIP as the server. The exact syntax depends on the switch OS, so follow your vendor's docs. The switch must not run its own DHCP pool for these segments.

**Step 4: Tell NICo which machines to expect.**

Add each host's BMC MAC, chassis serial and factory credentials to `expected_machines.json`, then upload it:

```bash
nico-admin-cli -a <nico-api-endpoint> em replace-all --filename expected_machines.json
```
Also make sure the site-wide BMC and UEFI credentials have been set (Quick Start, Step 7).

**Step 5: Watch requests arrive.**

```bash
kubectl logs -n nico-system -l app.kubernetes.io/name=nico-dhcp --tail=20
kubectl logs -n nico-system -l app.kubernetes.io/name=nico-api --tail=50 | grep -i "site explorer\|bmc\|discovery"
```
First you should see DHCP activity for the new MACs, then Site Explorer contacting the BMCs.

### Your turn: finish it

Fill in the blanks to print the nico-dhcp VIP and then check that BMC requests are reaching nico-dhcp.

```text
VIP=$(kubectl get svc nico-dhcp -n nico-system -o jsonpath='{.status.loadBalancer.ingress[0].___}')
echo "Configure every BMC-facing relay to forward to $VIP"
kubectl logs -n nico-system -l app.kubernetes.io/name=___ --tail=20
```

<details>
<summary>Answer</summary>

The first blank is `ip`, the field in the LoadBalancer ingress entry that holds the VIP. The second is `nico-dhcp`, the label value that selects the DHCP service pods.

</details>

### Your turn: on your own

Three symptoms in a new NICo site. Diagnose each one. (a) BMCs in rack 7 never show up in the nico-dhcp logs. (b) The rack 9 BMCs show DHCP activity and get addresses, but nothing is ingested, and Site Explorer reports `MissingCredentials`. (c) Hosts ingest fine, but a tenant instance can ping BMC addresses.

<details>
<summary>Hint 1</summary>

Follow the chain: relay → VIP → nico-dhcp → Core → Site Explorer → Redfish. Where does each symptom stop?

</details>

<details>
<summary>Hint 2</summary>

`MissingCredentials` is about site-wide credentials, not about a single host.

</details>

<details>
<summary>Hint 3</summary>

(c) is an isolation problem. Which siteConfig field lists CIDRs that instances must not reach?

</details>

<details>
<summary>Answer</summary>

(a) The requests never reach nico-dhcp. Look for a missing relay on rack 7's BMC segment, a relay pointing at the wrong IP, or no route from that switch to the nico-dhcp VIP. (b) DHCP works. Site Explorer aborts because the site-wide BMC root credential or the host/DPU UEFI site defaults aren't set; set them with `nico-admin-cli credential add-bmc` / `add-uefi` (and confirm the MACs are in `expected_machines.json`). (c) The OOB CIDRs are missing from `deny_prefixes`. Add the OOB and management ranges so instances can't reach them.

</details>

### Explain it

In your own words: Why does NICo want the OOB switches to relay to one central nico-dhcp, instead of each switch handing out addresses itself? Think about discovery and who owns IP allocation.

### Check

**1. What must the OOB switches do for NICo discovery to work?**

A. Relay BMC DHCP requests to the nico-dhcp VIP
B. Run a DHCP pool for each BMC VLAN
C. NAT the BMCs out to the internet
D. Proxy Redfish to NICo

<details>
<summary>Answer</summary>

**A.** Relay BMC DHCP requests to the nico-dhcp VIP

The switches only relay, and NICo manages IP allocation. A local switch pool would hand out addresses NICo doesn't know about, so discovery would never start.

</details>

**2. Which device may share a HostInband subnet with the host OS instead of using a dedicated OOB network?**

A. The host BMC of a zero-DPU host
B. A DPU BMC
C. A DPU OOB interface
D. Any BMC, as long as it uses a tagged VLAN

<details>
<summary>Answer</summary>

**A.** The host BMC of a zero-DPU host

The docs limit the exception to host BMCs on zero-DPU hosts (including DPU policy `nic`) and state that it doesn't apply to DPU BMC or DPU OOB interfaces.

</details>

**3. A BMC's DHCP request reaches nico-dhcp, but the host is never ingested. Its MAC is missing from which file?**

<details>
<summary>Answer</summary>

expected_machines.json (the Expected Machines manifest)

Only hosts listed in the manifest are discovered and ingested. The manifest also supplies the factory credentials Site Explorer uses.

</details>

**Sources:** [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md)

<a id="build-task"></a>
## Build task: Mini OOB network: discover a BMC by relayed DHCP, then provision it over Redfish

**Goal:** Inside one Docker container, build three network namespaces: a BMC, a router acting as the DHCP relay, and a controller running DHCP, DNS and NTP. The BMC gets a fixed address through the relay. The controller finds it by DNS, the BMC checks its time against the controller's NTP server, and the controller then stages an example BIOS change (SR-IOV), sets a one-time PXE boot, reboots, and locks the host down.

**Why it matters for NICo:** This is a small-scale version of NICo's discovery path. A BMC broadcasts DHCP, the OOB relay forwards it to a central server that knows the BMC's MAC, names and time services are handed out, and the controller drives firmware settings, boot order and lockdown over Redfish. Once you've debugged each link here, a real site's "host never appears" or "host won't PXE" problems are much easier to place.

**You need:**

- Docker (or rootful Podman: `sudo podman run --privileged ...`). Docker Desktop on macOS works, because the container runs in its Linux VM.
- A folder (e.g. `~/nico-ch8`) containing `mockbmc.py` from Lesson 1 and `sntp.py` from Lesson 5
- About 200 MB of disk space for packages

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Start the lab container</summary>

```bash
cd ~/nico-ch8      # contains mockbmc.py and sntp.py
docker run --rm -it --privileged -v "$PWD":/lab -w /lab --name ooblab debian:stable-slim bash
# inside the container:
apt-get update && apt-get install -y iproute2 iputils-ping dnsmasq-base busybox chrony bind9-dnsutils curl python3
```
Everything below runs inside this shell. `--rm` means everything is lost when you exit, so paste the steps into `/lab/lab.sh` as you go if you want to re-run them.

</details>

<details>
<summary>Step 2: Build the topology</summary>

```
[bmc] bmc0 ---- oob0 [relay] mgmt0 ---- ctrl0 [ctrl]
   (DHCP)    10.10.0.1/24    10.20.0.1/24    10.20.0.10/24
```
```bash
for ns in bmc relay ctrl; do ip netns add $ns; ip -n $ns link set lo up; done
ip link add bmc0 type veth peer name oob0
ip link set bmc0 netns bmc; ip link set oob0 netns relay
ip link add mgmt0 type veth peer name ctrl0
ip link set mgmt0 netns relay; ip link set ctrl0 netns ctrl
ip -n bmc link set bmc0 address c4:5a:b1:c8:38:0d
ip -n relay addr add 10.10.0.1/24 dev oob0
ip -n relay addr add 10.20.0.1/24 dev mgmt0
ip -n ctrl addr add 10.20.0.10/24 dev ctrl0
ip -n bmc link set bmc0 up; ip -n relay link set oob0 up
ip -n relay link set mgmt0 up; ip -n ctrl link set ctrl0 up
ip -n ctrl route add 10.10.0.0/24 via 10.20.0.1
ip netns exec relay sh -c 'echo 1 > /proc/sys/net/ipv4/ip_forward'
ip netns exec ctrl ping -c1 10.10.0.1     # the controller can reach the relay's OOB side
```
The BMC has no IP address yet. It will get one by DHCP.

</details>

<details>
<summary>Step 3: Start the controller's services (DHCP + DNS, NTP)</summary>

dnsmasq plays both nico-dhcp and the authoritative DNS server for `site.test`. The `dhcp-host` line has the same job as an expected-machines entry: it maps a known MAC to an identity.

```bash
ip netns exec ctrl dnsmasq --conf-file=/dev/null --no-daemon --user=root \
  --interface=ctrl0 --bind-interfaces --no-resolv \
  --local=/site.test/ --domain=site.test \
  --host-record=bmc-host1.site.test,10.10.0.50 \
  --dhcp-range=10.10.0.100,10.10.0.200,255.255.255.0,1h \
  --dhcp-host=c4:5a:b1:c8:38:0d,10.10.0.50,bmc-host1 \
  --dhcp-option=option:router,10.10.0.1 \
  --dhcp-option=option:dns-server,10.20.0.10 \
  --dhcp-option=option:ntp-server,10.20.0.10 \
  --dhcp-leasefile=/tmp/ctrl.leases --pid-file=/tmp/ctrl-dnsmasq.pid \
  --log-facility=- --log-dhcp > /tmp/ctrl-dnsmasq.log 2>&1 &

cat > /tmp/chrony-ctrl.conf <<'EOF'
local stratum 8
allow 10.0.0.0/8
pidfile /tmp/chronyd-ctrl.pid
driftfile /tmp/chronyd-ctrl.drift
cmdport 0
bindcmdaddress /
EOF
ip netns exec ctrl chronyd -x -d -f /tmp/chrony-ctrl.conf > /tmp/chrony.log 2>&1 &
```
`-x` tells chronyd to serve time without trying to set the container's clock. `local stratum 8` makes it serve its own clock as a stratum 8 source, which is a lab shortcut; a real site points at real upstream servers. Note that the `--dhcp-range` covers 10.10.0.0/24 even though the controller has no interface on that subnet. Relayed requests (giaddr 10.10.0.1) are matched against it.

</details>

<details>
<summary>Step 4: Start the DHCP relay on the router</summary>

```bash
ip netns exec relay dnsmasq --conf-file=/dev/null --no-daemon --user=root --port=0 \
  --dhcp-relay=10.10.0.1,10.20.0.10 \
  --pid-file=/tmp/relay.pid --log-facility=- --log-dhcp > /tmp/relay.log 2>&1 &
```
This is the role your OOB switches play in a NICo site: they relay requests and don't allocate any addresses.

</details>

<details>
<summary>Step 5: Power on the BMC: DHCP through the relay, then start Redfish</summary>

```bash
cat > /tmp/bmc-dhcp.sh <<'EOF'
#!/bin/sh
case "$1" in
  bound|renew)
    ip addr add "$ip/$subnet" dev "$interface" 2>/dev/null
    [ -n "$router" ] && ip route replace default via "${router%% *}"
    echo "lease: ip=$ip router=$router dns=$dns ntp=$ntpsrv" | tee /tmp/bmc-lease.txt
    ;;
esac
EOF
chmod +x /tmp/bmc-dhcp.sh
ip netns exec bmc busybox udhcpc -i bmc0 -f -q -n -O ntpsrv -s /tmp/bmc-dhcp.sh
# expect: lease: ip=10.10.0.50 router=10.10.0.1 dns=10.20.0.10 ntp=10.20.0.10

ip netns exec bmc python3 /lab/mockbmc.py 10.10.0.50 8000 > /tmp/bmc.log 2>&1 &
```
Check both logs: `grep -i c4:5a /tmp/ctrl-dnsmasq.log` should show DHCPDISCOVER, OFFER, REQUEST and ACK lines, and `cat /tmp/relay.log` shows the relay's own output.

</details>

<details>
<summary>Step 6: Pre-ingestion checks: name, time, Redfish reachability</summary>

```bash
BMC=$(ip netns exec ctrl dig +short @10.20.0.10 bmc-host1.site.test); echo "BMC is $BMC"
ip netns exec bmc python3 /lab/sntp.py 10.20.0.10      # the BMC checks the NTP server it got by DHCP
rf() { ip netns exec ctrl curl -s -H 'Content-Type: application/json' "$@"; }
B="http://$BMC:8000/redfish/v1/Systems/1"
rf "$B"
```
The SNTP output should show `stratum=8` and an offset near 0. In chrony, the `local stratum` value is exactly the stratum clients see. (ntpd's local-clock driver works differently, which is why you may see "+1" rules of thumb elsewhere.) The Redfish GET goes from ctrl, through the relay, to the BMC.

</details>

<details>
<summary>Step 7: Provision: example BIOS change, PXE once, reboot, lock down</summary>

```bash
rf -X PATCH -d '{"Attributes": {"SriovGlobalEnable": "Enabled"}}' "$B/Bios/Settings"
rf -X PATCH -d '{"Boot": {"BootSourceOverrideEnabled": "Once", "BootSourceOverrideTarget": "Pxe"}}' "$B"
rf -X POST -d '{"ResetType": "ForceRestart"}' "$B/Actions/ComputerSystem.Reset"   # BootedFrom Boot0002
rf -X PATCH -d '{"Oem": {"Mock": {"Lockdown": true}}}' "$B"
```
This is the same order as in Lessons 1–3: finish every firmware change, then lock the host before a tenant would get it. The SR-IOV attribute is just the mock's example setting.

</details>

**Check it works:** Run these inside the container. Each check should give the expected result:
```bash
grep -i c4:5a:b1:c8:38:0d /tmp/ctrl.leases                       # a lease line with 10.10.0.50 bmc-host1
rf "$B/Bios" | grep Sriov                                         # "SriovGlobalEnable": "Enabled"
rf "$B" | grep -E 'LastBootedFrom|Lockdown|OverrideEnabled'       # "Boot0002", true, "Disabled"
ip netns exec bmc curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Mock-Inband: 1' "$B"   # 403
```
You're done when all four match. That shows a relayed DHCP lease for the expected MAC, an applied BIOS change, a one-time PXE boot that has cleared itself, and lockdown blocking in-band access.

<details>
<summary>If you get stuck</summary>

- udhcpc says `no lease, failing`: check `/tmp/relay.log` for errors and `/tmp/ctrl-dnsmasq.log` for a DHCPDISCOVER. If the server sees nothing, the relay isn't running or `--dhcp-relay` has its two addresses swapped (relay's local address first). If the server logs 'no address range available', the `--dhcp-range` doesn't cover 10.10.0.0/24 or is missing its netmask.
- The server sees the request but the BMC never gets the reply: the controller needs `ip -n ctrl route add 10.10.0.0/24 via 10.20.0.1` so it can reach giaddr 10.10.0.1.
- `busybox: applet not found` for udhcpc: run `apt-get install -y udhcpc` and use `udhcpc` instead of `busybox udhcpc`.
- sntp.py shows `stratum=0` or `leap=3`, or times out: chronyd can take a few seconds to enable its local reference. Wait 10–20 s and retry, and check `/tmp/chrony.log`. Once it's ready you should see `stratum=8`.
- `dig` returns nothing: dnsmasq may have failed to start. `cat /tmp/ctrl-dnsmasq.log` and look for 'address already in use' or a typo. Public names won't resolve, because `--no-resolv` makes this server answer only for `site.test`, like an authoritative-only server.
- curl gets 'connection refused' from the BMC: `mockbmc.py` must start *after* the lease, because it binds to 10.10.0.50. Check `/tmp/bmc.log` and confirm `ip -n bmc addr` shows the address.
- The mock keeps state only in memory. If you restart `mockbmc.py`, re-run step 7 before verifying.

</details>

**Stretch goal:** Add a second BMC segment (10.10.1.0/24) on the relay with a second veth pair and a second `--dhcp-relay=10.10.1.1,10.20.0.10` line. Add a matching `--dhcp-range` on the controller, and give the new BMC a MAC that is *not* in any `dhcp-host` line, so it gets a dynamic address. Then write a small Python 'site explorer' that reads `/tmp/ctrl.leases`, cross-references an `expected_machines.json` in the format from the NICo docs, and only sends Redfish requests to BMCs whose MAC is listed. Have it log and skip unknown MACs, just as NICo ingests only the machines in its manifest.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (cloud-init): Optional step 4 says that on Apple silicon you can use the arm64 image with qemu-system-aarch64 and -accel hvf, keeping the rest of the command. qemu-system-aarch64 stops with 'No machine specified' unless you pass -machine virt. It also needs -cpu host with hvf and UEFI firmware (-bios edk2-aarch64-code.fd). Followed as written, the macOS/arm64 variant does not boot. *Fix:* Give the full Apple-silicon command, e.g. `qemu-system-aarch64 -machine virt,accel=hvf -cpu host -m 1024 -nographic -bios $(brew --prefix qemu)/share/qemu/edk2-aarch64-code.fd -drive file=node01.qcow2,if=virtio -nic user,model=virtio-net-pci,hostfwd=tcp::2222-:22 -smbios 'type=1,serial=ds=nocloud;s=http://10.0.2.2:8080/'`, or state that the optional step is only tested on x86_64 Linux with KVM.

---

[← 07-bluefield-dpu-hardware-oob-management.md](07-bluefield-dpu-hardware-oob-management.md) · [09-underlay-bgp.md →](09-underlay-bgp.md)
