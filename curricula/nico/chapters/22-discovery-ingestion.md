# Chapter 22: Discovery & Ingestion

*Part: Host Lifecycle · 8 concepts · [curriculum](../curriculum.md#chapter-22)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Day 0 starts when a server is racked and cabled. NICo's goal from that point is **zero-touch**. The BMC asks for an IP address and NICo recognises it. NICo logs in with the factory password, reads the hardware inventory over Redfish, works out which BlueField DPUs belong to the host, and starts ingestion. This chapter covers each piece of that pipeline, plus a few supporting skills you need while operating it.

You already have most of the foundations:
- Chapter 6: how a BMC exposes a Redfish tree.
- Chapter 8: how DHCP and relays work.
- Chapter 12: the difference between DPU mode and NIC mode.
- Chapter 20: why factory default credentials get rotated.

This chapter joins those pieces into one flow: **DHCP request → expected-machines lookup → Redfish exploration → DPU-host pairing → ingestable**.

The lessons come in three groups:
1. **Two operator tools.** **SSH** gives you secure remote shells, and NICo's SSH console builds on it later. **Kubernetes Ingress** exposes `nico-rest-api` on a real domain name with TLS.
2. **Three hardware facts that discovery and validation depend on.** **PN/PSID** identifies NVIDIA NIC models. **Secure Erase** is a drive feature NICo requires. **LLDP** tells devices what they are plugged into.
3. **The three procedures at the core of ingestion.** You write the **Expected Machines Manifest**, learn how **DPU-host pairing** works, and trace **BMC discovery** from end to end.

The chapter ends with a build task. You write a mock "site explorer" in Python that runs fake BMCs on your laptop, reads a manifest, probes Redfish and pairs DPUs to hosts.

**By the end of this chapter you can:**

- Set up key-based SSH access to a remote machine and explain what host-key verification protects against
- Configure the nico-rest-api Helm values to expose the REST API through an Ingress with TLS, and verify the certificate chain
- Read a NIC's part number and PSID and check them against an allow-list, and check whether a drive supports Secure Erase
- Decode an LLDP frame's TLVs and explain what LLDP can and cannot tell you
- Write and validate an expected_machines.json manifest and trace how a BMC's DHCP request leads to authenticated Redfish exploration
- Predict whether Site Explorer will mark a host as ingestable from its host and DPU BMC reports and firmware state

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [SSH](#ssh)
2. [Kubernetes Ingress and ingress controllers](#kubernetes-ingress-and-ingress-controllers)
3. [PN/PSID](#pn-psid)
4. [Secure Erase](#secure-erase)
5. [LLDP](#lldp)
6. [Expected Machines Manifest](#expected-machines-manifest)
7. [DPU-host pairing](#dpu-host-pairing)
8. [BMC Discovery](#bmc-discovery)
9. [Build task: Mini Site Explorer: from DHCP lease to ingestable host](#build-task)

<a id="ssh"></a>
## 1. SSH

*Builds on: Public-key cryptography (ch. 18)*

### Before you read

- When you SSH into a server for the first time, it asks you to confirm a 'fingerprint'. Whose identity is that fingerprint proving: yours or the server's?
- With key-based login, which file has to be copied onto the server: your private key or your public key?

<details>
<summary>Answers</summary>

- **When you SSH into a server for the first time, it asks you to confirm a 'fingerprint'. Whose identity is that fingerprint proving: yours or the server's?** The server's. It is a hash of the server's host public key. Your own identity is proved separately, with your password or your private key.
- **With key-based login, which file has to be copied onto the server: your private key or your public key?** Your public key, which goes into ~/.ssh/authorized_keys on the server. The private key never leaves your machine.

</details>

### Explanation

**SSH (Secure Shell)** gives you an encrypted, authenticated remote shell over TCP, on port 22 by default. It uses the public-key cryptography from Chapter 18 in two directions.

1. **The server proves who it is.** Every SSH server has a **host key pair**. When you connect, the server signs part of the handshake with its host private key. Your client checks that signature against the host public key it saved last time, in `~/.ssh/known_hosts`. On a first connection nothing is saved yet, so the client shows a fingerprint and asks whether to trust it. This is called *trust on first use*. If the key changes later, the client refuses to connect and prints a `REMOTE HOST IDENTIFICATION HAS CHANGED` warning. Either the server was rebuilt, or someone is intercepting the connection.
2. **You prove who you are.** For key authentication you generate a **user key pair** with `ssh-keygen`. The public half goes into `~/.ssh/authorized_keys` on the server. When you log in, your client signs a challenge with the private half and the server verifies the signature. No password crosses the network, so there is no password for anyone to guess.

Once both sides are authenticated, they derive symmetric session keys, and the rest of the session is encrypted.

Useful terms:
- `~/.ssh/config` stores per-host shortcuts: host name, port, user and key file.
- `sshd` is the server daemon. It checks file permissions strictly and ignores an `authorized_keys` file that other users can write to.
- `ssh-keygen -F host` finds a host's entry in `known_hosts`, and `ssh-keygen -R host` removes a stale one. Both work even when the client hashes host names. Debian and Ubuntu clients do this by default (`HashKnownHosts yes`), so the file shows `|1|...` instead of a readable name.

Why this matters for NICo:
- `ssh-keygen` is one of the tools the Quick Start requires on the machine that runs `setup.sh`.
- Setup Phase 4 creates an SSH host key in the `nico-system` namespace.
- NICo's `ssh-console` service gives tenants and admins serial console access to hosts over SSH (Chapter 26). The same host-key checks apply there.

**Analogy.** SSH works like a building with ID checks on both sides. The receptionist shows you a staff badge you remember from your last visit (the host key). You show a badge they have on file (your public key in authorized_keys). The analogy breaks down because anyone can copy a real badge just by looking at it. An SSH private key is never shown. Each side proves it holds its key by signing a fresh challenge.

### Worked example: Key-based SSH into a throwaway container

**Step 1: Generate a user key pair.**

```bash
mkdir -p ~/lab && cd ~/lab
ssh-keygen -t ed25519 -f ./lab_key -N ''
ls lab_key*   # lab_key (private, keep it) and lab_key.pub (public, share it)
```

**Step 2: Start a server and install sshd.**

```bash
docker run -d --name sshlab -p 2222:22 debian:stable-slim sleep infinity
docker exec sshlab sh -c 'apt-get update -qq && apt-get install -y -qq openssh-server && mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh'
```
Installing `openssh-server` generates the container's **host keys** under `/etc/ssh/`.

**Step 3: Authorise your public key and start sshd.**

```bash
docker cp lab_key.pub sshlab:/root/.ssh/authorized_keys
docker exec sshlab sh -c 'chown root:root /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && /usr/sbin/sshd'
```
Debian's default setting `PermitRootLogin prohibit-password` lets root log in with a key but not with a password.

**Step 4: Connect and accept the host key.**

```bash
ssh -i ./lab_key -p 2222 -o UserKnownHostsFile=./known_hosts -o HashKnownHosts=no root@127.0.0.1 hostname
```
Type `yes` when the fingerprint appears. Then run `cat known_hosts`. The port is not 22, so the entry starts with `[127.0.0.1]:2222`.

Without `-o HashKnownHosts=no`, a Debian or Ubuntu client hashes the host name and you would see a `|1|...` line instead. You can confirm the entry exists either way:
```bash
ssh-keygen -F '[127.0.0.1]:2222' -f ./known_hosts
```
Run the `ssh` command again. There is no prompt this time, because the host key matches.

**Step 5: Compare the fingerprint the server actually has.**

```bash
docker exec sshlab ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```
The SHA256 value should match the one you accepted. In production, check this through a trusted channel *before* you type `yes`.

### Your turn: finish it

Add a ~/.ssh/config entry so that `ssh sshlab hostname` works with no flags. Your key is at ~/lab/lab_key, and the container's port 22 is published on 2222.

```text
Host sshlab
    HostName 127.0.0.1
    Port ___
    User root
    IdentityFile ___
    UserKnownHostsFile ~/lab/known_hosts
```

<details>
<summary>Answer</summary>

Port 2222 and IdentityFile ~/lab/lab_key. IdentityFile takes the private key. The .pub file lives on the server.

</details>

### Your turn: on your own

You delete the sshlab container and recreate it with the same commands. Now `ssh sshlab hostname` fails with 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!'. Explain why, and give the command that fixes it safely.

<details>
<summary>Hint 1</summary>

What gets generated when openssh-server is installed in a fresh container?

</details>

<details>
<summary>Hint 2</summary>

The new container has a new host key pair, so its fingerprint no longer matches the one saved in known_hosts.

</details>

<details>
<summary>Hint 3</summary>

Remove the old entry with ssh-keygen -R, using the [host]:port form and your custom known_hosts file. This works whether or not the entry is hashed.

</details>

<details>
<summary>Answer</summary>

Installing openssh-server in the new container generated fresh host keys. The fingerprint saved in ~/lab/known_hosts belongs to the old container, so the client assumes a possible man-in-the-middle and refuses to connect. You know why the key changed, because you rebuilt the server. Remove the stale entry with `ssh-keygen -R '[127.0.0.1]:2222' -f ~/lab/known_hosts`. Then reconnect and accept the new fingerprint, ideally after checking it with `docker exec sshlab ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.

</details>

### Explain it

In your own words: Why does SSH need two separate key pairs, one for the server and one for the user? What attack becomes possible if you remove either one?

### Check

**1. Which file on the server lists the public keys allowed to log in as a user?**

A. ~/.ssh/known_hosts
B. ~/.ssh/authorized_keys
C. /etc/ssh/ssh_host_ed25519_key
D. ~/.ssh/config

<details>
<summary>Answer</summary>

**B.** ~/.ssh/authorized_keys

authorized_keys holds the user public keys the server accepts. known_hosts lives on the client and stores server host keys. ssh_host_ed25519_key is the server's own private host key. ~/.ssh/config only holds client-side shortcuts.

</details>

**2. During login, what does the client do with your private key?**

A. Sends it to the server for comparison
B. Uses it to sign a challenge, which the server verifies with your public key
C. Encrypts your password with it
D. Nothing; only the public key is used

<details>
<summary>Answer</summary>

**B.** Uses it to sign a challenge, which the server verifies with your public key

The private key never leaves your machine. The server checks a signature, so the key is never sent or compared. The 'encrypts your password' option confuses key authentication with password authentication.

</details>

**3. A host-key-changed warning appears for a server you have not touched. What is the safest response?**

A. Run ssh-keygen -R and reconnect immediately
B. Stop and confirm the new fingerprint out of band before trusting it
C. Add StrictHostKeyChecking=no to your config
D. Regenerate your own user key

<details>
<summary>Answer</summary>

**B.** Stop and confirm the new fingerprint out of band before trusting it

An unexpected key change is exactly what a man-in-the-middle attack looks like. Deleting the entry straight away, or turning off checking, would let an attacker in. Your user key has nothing to do with this warning.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md)

<a id="kubernetes-ingress-and-ingress-controllers"></a>
## 2. Kubernetes Ingress and ingress controllers

*Builds on: Kubernetes Service types (LoadBalancer, NodePort, ClusterIP) (ch. 14), cert-manager (ch. 19)*

### Before you read

- If you create a Kubernetes Ingress object in a cluster that has no ingress controller installed, what happens to HTTP traffic for that hostname?
- A NodePort exposes a Service on a high port of every node. Name one thing an Ingress gives you that a NodePort does not.

<details>
<summary>Answers</summary>

- **If you create a Kubernetes Ingress object in a cluster that has no ingress controller installed, what happens to HTTP traffic for that hostname?** Nothing. The Ingress is only a routing rule stored in the API server. Without a controller to read it and program a proxy, nothing serves the traffic.
- **A NodePort exposes a Service on a high port of every node. Name one thing an Ingress gives you that a NodePort does not.** Routing by hostname or path on the standard ports 80/443, plus TLS termination with a real certificate for a DNS name.

</details>

### Explanation

In Chapter 14 you exposed Services with `NodePort` and `LoadBalancer`. Both work at the TCP level: one port forwards to one Service. An **Ingress** works at the HTTP level. It is a Kubernetes object that holds rules such as "requests for host `rest-api.mysite.example.com`, path `/`, go to Service `nico-rest-api` on port X, and terminate TLS using the certificate in Secret Y."

An Ingress does nothing on its own. An **ingress controller** watches Ingress objects and configures a real reverse proxy from them. Two examples are **Contour**, which drives **Envoy**, and **ingress-nginx**. The controller's proxy is normally exposed by its own `LoadBalancer` Service. In NICo, MetalLB assigns that address from `vip-pool-external`. The field `spec.ingressClassName` (the chart's `className` value) chooses which controller handles a given Ingress.

TLS pieces:
- `spec.tls[]` lists hosts and the **Secret** that holds their certificate and key. The Secret must be in the **same namespace** as the Ingress.
- **cert-manager** (Chapter 19) can create that Secret from a `Certificate` resource.

How NICo uses it:
- By default, `setup.sh` exposes `nico-rest-api` on a NodePort.
- In `helm-prereqs/values/nico-rest.yaml` you can set `nodePort.enabled: false` and `ingress.enabled: true`, then list your hostname under `ingress.hosts`. The chart rejects a config that enables both.
- With `ingress.certificate.enabled: true`, the chart creates a cert-manager Certificate signed by `nico-rest-ca-issuer`, a private CA. It derives the TLS hosts and `dnsNames` from `ingress.hosts`.
- If your cluster has no controller, `./setup.sh --install-contour` installs Contour/Envoy.

Rules worth remembering from the docs:
- A `spec.tls` block does not redirect port 80 to HTTPS. The chart's default annotation `ingress.kubernetes.io/force-ssl-redirect: "true"` works for Contour. ingress-nginx needs `nginx.ingress.kubernetes.io/force-ssl-redirect` instead.
- Annotation values must be **quoted strings**.
- `ingress.tls[].hosts` must name the host **exactly**, even when the Secret holds a wildcard certificate, because Contour matches the literal string.
- The API pod itself still serves plain HTTP. TLS ends at the proxy.

**Analogy.** An Ingress is like a building directory that reads 'Accounts: floor 3, Legal: floor 5'. The ingress controller is the receptionist who reads the directory and walks visitors to the right floor. With no receptionist, the directory just hangs on the wall and nobody gets anywhere. The analogy is weak on TLS. Here the receptionist also checks and opens every sealed envelope at the door, which a building directory never does.

### Worked example: Expose nico-rest-api on a domain with a managed certificate

**Step 1: Switch from NodePort to Ingress in values.**

In `helm-prereqs/values/nico-rest.yaml`:
```yaml
nico-rest-api:
  nodePort:
    enabled: false
  ingress:
    enabled: true
    className: contour
    hosts:
      - host: rest-api.mysite.example.com
        paths:
          - path: /
            pathType: Prefix
    certificate:
      enabled: true
      secretName: rest-api-mysite-example-com-tls
```
The hostname appears only under `hosts`. The chart copies it into `spec.tls` and into the certificate's `dnsNames`.

**Step 2: Make sure a controller exists.**

Fill in the `vip-pool-external` addresses in `helm-prereqs/values/metallb-config.yaml`. Then run setup with the optional controller:
```bash
./setup.sh --install-contour
```

**Step 3: Point DNS at the proxy.**

```bash
kubectl get service contour-envoy -n projectcontour \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```
Create an `A` record for `rest-api.mysite.example.com` that points at this IP.

**Step 4: Trust the private CA and verify.**

```bash
kubectl get secret rest-api-mysite-example-com-tls -n nico-rest \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > nico-rest-ca.crt
openssl s_client -connect rest-api.mysite.example.com:443 \
  -servername rest-api.mysite.example.com \
  -CAfile nico-rest-ca.crt </dev/null | grep 'Verify return code'
```
You want to see `Verify return code: 0 (ok)`. Clients then call the API with `curl --cacert nico-rest-ca.crt https://rest-api.mysite.example.com/...`.

### Your turn: finish it

Your cluster already runs ingress-nginx and has a wildcard Secret `mysite-wildcard-tls` for *.mysite.example.com, already copied into the nico-rest namespace. Fill in the blanks so the chart accepts this config.

```text
nico-rest-api:
  nodePort:
    enabled: false
  ingress:
    enabled: true
    className: ___
    annotations:
      nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
    hosts:
      - host: rest-api.mysite.example.com
        paths:
          - path: /
            pathType: Prefix
    certificate:
      enabled: false
    tls:
      - secretName: mysite-wildcard-tls
        hosts:
          - ___
```

<details>
<summary>Answer</summary>

className: nginx, and the tls host is rest-api.mysite.example.com. The certificate is a wildcard, but ingress.tls[].hosts must still name the concrete host exactly. The chart rejects any ingress.hosts entry that the tls list does not name exactly.

</details>

### Your turn: on your own

A teammate enabled the ingress with `certificate.enabled: false` and `tls[].secretName: corp-wildcard`. That Secret exists in the `default` namespace. They also wrote the annotation as `nginx.ingress.kubernetes.io/force-ssl-redirect: true`. Find the two problems and say how to fix each.

<details>
<summary>Hint 1</summary>

One problem shows up when the YAML is applied. The other shows up when the proxy looks for the certificate.

</details>

<details>
<summary>Hint 2</summary>

Kubernetes annotations are map[string]string, and spec.tls[].secretName is looked up in the Ingress's own namespace.

</details>

<details>
<summary>Hint 3</summary>

Quote the value, and copy or mirror the Secret into nico-rest.

</details>

<details>
<summary>Answer</summary>

(1) The unquoted `true` is a YAML boolean. Applying it fails with `cannot unmarshal bool into Go struct field ObjectMeta.metadata.annotations of type string`. Write the value as "true". (2) secretName is resolved in the Ingress's own namespace (nico-rest), so the controller cannot find a Secret that lives in default. Copy or mirror the Secret into nico-rest. With Contour, reading a Secret from another namespace would also need a TLSCertificateDelegation.

</details>

### Explain it

In your own words: Why does Kubernetes split routing into two parts, an Ingress object and a separately installed controller, instead of building one HTTP proxy into the cluster?

### Check

**1. Where does TLS terminate when nico-rest-api is exposed through the chart's Ingress?**

A. Inside the nico-rest-api pod
B. At the ingress controller's proxy (e.g. Envoy)
C. At MetalLB
D. At cert-manager

<details>
<summary>Answer</summary>

**B.** At the ingress controller's proxy (e.g. Envoy)

The docs state that the API pod still serves plain HTTP internally. MetalLB only hands out the VIP, and cert-manager only issues the certificate. Neither of them carries the traffic.

</details>

**2. What does the chart do if both `ingress.enabled` and `nodePort.enabled` are true?**

A. Exposes the API both ways
B. Prefers the Ingress silently
C. Rejects the configuration
D. Disables TLS

<details>
<summary>Answer</summary>

**C.** Rejects the configuration

The docs say the chart rejects `ingress.enabled` together with `nodePort.enabled`. It does not quietly pick one.

</details>

**3. With Contour, why does putting `*.mysite.example.com` in `ingress.tls[].hosts` fail even though the certificate is a wildcard?**

A. Wildcard certificates are not allowed in Kubernetes
B. Contour keys its HTTPS virtual host by the literal host string and attaches routes only on an exact match
C. cert-manager cannot issue wildcards
D. Envoy does not support SNI

<details>
<summary>Answer</summary>

**B.** Contour keys its HTTPS virtual host by the literal host string and attaches routes only on an exact match

The wildcard certificate itself still works, and certificate.dnsNames does accept wildcards. The exact-match rule applies only to the tls hosts list.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="pn-psid"></a>
## 3. PN/PSID

### Before you read

- Two NICs have the same part number. Can they still need different firmware images? Guess why or why not.

<details>
<summary>Answers</summary>

- **Two NICs have the same part number. Can they still need different firmware images? Guess why or why not.** Yes. Cards built for different OEMs or configurations can share a base model but carry different board-specific firmware settings. The PSID tells you which variant a card is.

</details>

### Explanation

NVIDIA (Mellanox) network adapters, including BlueField DPUs, carry two identifiers that matter for automation.

- **PN (part number)** names the board model as ordered. It tells you the hardware: chip, port count, speed and form factor. For example, the BlueField-3 B3220 P-Series DPU recommended in NICo's hardware prerequisites is `900-9D3B6-00CV-AA0`.
- **PSID (Parameter-Set ID)** is a short string stored in the adapter's firmware. It identifies the **firmware configuration** for that board, meaning its default settings and board-specific parameters. NVIDIA-branded cards use PSIDs that start with `MT_`, and OEM-branded variants have their own. NVIDIA publishes firmware images per PSID. The firmware tools refuse to burn an image whose PSID does not match the card unless you explicitly force it.

You can read both values with the Mellanox tools from Chapter 12. On a real host, `mlxfwmanager --query` prints `Part Number:` and `PSID:` for each device, and `flint -d <device> query` prints the PSID.

**Why you check both (general practice).** In fleet automation, an **allow-list** is the set of device variants a site has validated and will accept. A part number alone cannot tell apart two cards that look identical but run different firmware configurations. A PSID alone does not describe the hardware clearly. If you key the allow-list on the **(PN, PSID) pair**, one check answers two questions: is this the card we expect, and is its firmware a variant we know how to update? Many tools that manage NVIDIA NIC firmware follow this pattern. NICo's own NIC firmware policy is covered later, in Chapter 36 (NIC firmware baseline policy) and Chapter 23 (Mellanox device kinds). Do not assume any specific NICo behaviour from this lesson.

**What this chapter's docs do say about NICo.** Part numbers matter during discovery. When Site Explorer pairs DPUs to hosts, it prefers inventory records that carry a BlueField part number when it decides which PCIe devices are DPUs.

**Analogy.** PN and PSID are like a car's model name and its trim or market code. 'Sedan X' tells you the body and engine. The trim code tells you whether it is the EU or US variant, and which software and parts it takes. The analogy breaks down because a mechanic can fit a car with parts from another trim. NIC firmware tools block you from flashing another PSID's image unless you force it.

### Worked example: Check a card against a (PN, PSID) allow-list

**Step 1: Get the tool output.**

On a host with the Mellanox tools you would run `sudo mlxfwmanager --query`. On a laptop, save this example output as `query.txt`. The values are illustrative.
```text
Device #1:
----------
  Device Type:      BlueField3
  Part Number:      900-9D3B6-00CV-AA0
  PSID:             MT_0000000884
  PCI Device Name:  /dev/mst/mt41692_pciconf0
```

**Step 2: Extract the identifiers.**

```bash
grep -E 'Part Number|PSID' query.txt
```

**Step 3: Compare against the allow-list.**

Save as `check_nic.py`:
```python
import sys

ALLOWED = {("900-9D3B6-00CV-AA0", "MT_0000000884")}

fields = {}
for line in open(sys.argv[1]):
    if ":" in line:
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip()

pair = (fields.get("Part Number"), fields.get("PSID"))
print("ALLOWED" if pair in ALLOWED else f"NOT ALLOWED: {pair}")
```
Run `python3 check_nic.py query.txt`. It prints `ALLOWED`.

**Step 4: Try a variant.**

Change the PSID in `query.txt` to `DEL0000000099`, an imaginary OEM PSID, and run the script again. It prints `NOT ALLOWED`. The hardware model is the same, but you have not approved this firmware configuration.

### Your turn: finish it

Extend the allow-list check so it also reports *why* a card failed: either the model is unknown, or the model is known but the PSID is not.

```text
ALLOWED = {("900-9D3B6-00CV-AA0", "MT_0000000884")}
KNOWN_PNS = {pn for pn, _ in ALLOWED}

def verdict(pn, psid):
    if (pn, psid) in ALLOWED:
        return "ALLOWED"
    if pn in ___:
        return "KNOWN MODEL, UNAPPROVED PSID"
    return "UNKNOWN MODEL"

print(verdict("900-9D3B6-00CV-AA0", "DEL0000000099"))
```

<details>
<summary>Answer</summary>

The blank is KNOWN_PNS. The call prints 'KNOWN MODEL, UNAPPROVED PSID'.

</details>

### Your turn: on your own

A vendor ships replacement DPUs whose part number is on your allow-list but whose PSID is not. Someone suggests matching on part number only so the cards are accepted. Give one concrete risk of doing that.

<details>
<summary>Hint 1</summary>

Think about what the PSID selects.

</details>

<details>
<summary>Hint 2</summary>

Firmware images are published per PSID.

</details>

<details>
<summary>Hint 3</summary>

Automated firmware updates and baselines depend on knowing which image belongs on the card.

</details>

<details>
<summary>Answer</summary>

The PSID selects the card's firmware configuration and which firmware images apply to it. If you accept cards on PN alone, your firmware baseline and update automation may have no approved image for that PSID. Updates could then fail, or someone could force a mismatched image, or the card could run with board defaults you have never validated. The safe options are to validate the new (PN, PSID) pair and add it, or to reject the cards.

</details>

### Explain it

In your own words: Why is the pair (PN, PSID) a better key for an allow-list than either value alone?

### Check

**1. What does a PSID identify?**

A. The card's serial number
B. The board-specific firmware configuration (parameter set) of the adapter
C. The PCIe slot the card is in
D. The card's MAC address

<details>
<summary>Answer</summary>

**B.** The board-specific firmware configuration (parameter set) of the adapter

Every card of a given variant shares the same PSID, so it is not unique per card the way a serial number or MAC address is. It also has nothing to do with the slot the card sits in.

</details>

**2. Two cards report the same part number but different PSIDs. What is the most likely explanation?**

A. One card is faulty
B. They are the same hardware model with different firmware configurations, e.g. NVIDIA-branded vs OEM-branded
C. They are different chip generations
D. One is in NIC mode and one in DPU mode

<details>
<summary>Answer</summary>

**B.** They are the same hardware model with different firmware configurations, e.g. NVIDIA-branded vs OEM-branded

The part number pins down the hardware, so a different chip generation is ruled out. DPU vs NIC mode is a runtime setting and does not change the PSID. A different PSID does not indicate a fault.

</details>

**3. Which use of part numbers do NICo's discovery docs describe?**

A. Site Explorer prefers inventory records with a BlueField part number when deciding which PCIe devices are DPUs
B. Site Explorer rejects any host whose NIC PSID is not on an allow-list
C. The DHCP hook reads the part number from the DHCP packet
D. The manifest must list each DPU's part number

<details>
<summary>Answer</summary>

**A.** Site Explorer prefers inventory records with a BlueField part number when deciding which PCIe devices are DPUs

The Redfish workflow page describes this part-number preference during pairing. This chapter's pages say nothing about a PSID allow-list in discovery. The DHCP hook extracts the MAC address and vendor class, not part numbers. The manifest's required fields do not include part numbers.

</details>

**Sources:** [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md)

<a id="secure-erase"></a>
## 4. Secure Erase

*Builds on: Server hardware basics (ch. 1)*

### Before you read

- You run `rm -rf` on every file on an SSD and empty the trash. Is the data gone? Why or why not?
- A 7.68 TB self-encrypting drive can be 'erased' in a few seconds. How could that be possible?

<details>
<summary>Answers</summary>

- **You run `rm -rf` on every file on an SSD and empty the trash. Is the data gone? Why or why not?** No. Deleting files only removes filesystem references. The data blocks stay on flash until something overwrites them, and SSD wear-levelling means some copies may never be overwritten.
- **A 7.68 TB self-encrypting drive can be 'erased' in a few seconds. How could that be possible?** Cryptographic erase. The drive already encrypts everything with an internal key, so destroying and replacing that key makes all the old data unreadable instantly.

</details>

### Explanation

When NICo hands a host from one tenant to the next, the second tenant must not be able to read anything the first tenant stored. Deleting files and reformatting does not achieve that. Even overwriting the whole disk from the OS is unreliable on SSDs. The drive controller remaps blocks as they wear (**wear-levelling**) and keeps spare capacity the host cannot address (**over-provisioning**), so old copies can survive.

**Secure Erase** is a command the drive runs on itself. Because the drive does the work, the erase covers every block, including the ones the host cannot see. The command depends on the drive type:

| Drive | Commands |
|---|---|
| NVMe | **Format NVM** with a Secure Erase Setting (user-data erase or crypto erase); **Sanitize** (block erase, crypto erase, overwrite) |
| SATA | ATA **Security Erase Unit** (normal or enhanced) |
| SAS | SCSI **SANITIZE** |

**Crypto erase** relies on the encryption from Chapter 18. A self-encrypting drive always encrypts stored data with an internal media key. To erase, the drive destroys that key and generates a new one, so the old ciphertext becomes unreadable within seconds. You have to trust that the drive firmware really did this.

NICo's hardware prerequisites word the requirement differently for the two kinds of machine:
- **Site controller nodes:** *all* local storage drives must support Secure Erase.
- **Managed hosts:** *NVMe* drives must support Secure Erase. Their firmware must be updated only via signed images, and rollback must not be possible. The signed, no-rollback rule protects the trust that crypto erase depends on.

NICo uses Secure Erase during tenant transitions (Day 2). The first sanitization step is **secure erase of NVMe and SAS/SATA drives**. Next comes verification of the UEFI memory-overwrite request, which clears RAM.

An NVMe drive without Secure Erase support therefore does more than slow down cleanup. It does not meet the prerequisites for a managed host. You can check support with a read-only query, as the example below shows.

**Analogy.** Crypto erase is like a safe-deposit vault where one master key locks every box. Instead of emptying thousands of boxes, you melt the key and cut a new one, and every old box stays sealed for good. The analogy breaks down because with a real key you can watch it melt. With a drive, you can only trust that its firmware destroyed the key. That is why NICo also requires signed, no-rollback NVMe firmware on managed hosts.

### Worked example: Check whether your drives support Secure Erase (read-only)

**Step 1: List drives and their transport.**

On Linux:
```bash
lsblk -d -o NAME,TRAN,MODEL,SIZE
```
`nvme` means an NVMe drive. `sata` or `sas` means a SATA or SAS drive. On macOS, `diskutil list` shows the disks, but the commands below are Linux-only.

**Step 2: Query NVMe capabilities.**

Install `nvme-cli` (`sudo apt install nvme-cli`), then run:
```bash
sudo nvme id-ctrl /dev/nvme0 -H | grep -iE 'crypto erase|sanitize'
```
In the Format NVM attributes, look for a line similar to `Crypto Erase Supported as part of Secure Erase`. Also look for the Sanitize capabilities: crypto erase, block erase and overwrite. This command only reads the controller's identify data.

**Step 3: Query SATA capabilities.**

```bash
sudo hdparm -I /dev/sda | sed -n '/^Security:/,/^[A-Z]/p'
```
`supported` and `supported: enhanced erase` mean the drive has the ATA Security Erase feature set. `frozen` means the BIOS has locked it until the next power cycle.

**Step 4: Decide.**

Apply the rule for the machine's role. On a **managed host**, an NVMe drive that reports none of these capabilities does not meet NICo's prerequisites. On a **site controller node**, *every* local drive, of any type, must support Secure Erase.

**Do not run the erase commands themselves on your laptop.** They destroy all data on the drive.

### Your turn: finish it

Complete this loop so it prints the erase-related capability lines for every NVMe controller on the machine.

```text
for ctrl in /dev/nvme[0-9]; do
  [ -e "$ctrl" ] || continue
  echo "== $ctrl"
  sudo nvme id-ctrl "$ctrl" -H | grep -iE '___'
done
```

<details>
<summary>Answer</summary>

The pattern is 'crypto erase|sanitize'. grep then matches the Format NVM crypto-erase attribute and the Sanitize capability lines.

</details>

### Your turn: on your own

Explain why crypto erase on a 7.68 TB NVMe drive finishes in seconds while an overwrite sanitize takes hours. Then name the assumption crypto erase depends on, and the NICo managed-host requirement that protects that assumption.

<details>
<summary>Hint 1</summary>

What does crypto erase actually change on the drive?

</details>

<details>
<summary>Hint 2</summary>

It replaces one small key and never touches the stored data blocks.

</details>

<details>
<summary>Hint 3</summary>

You have to trust the drive firmware to really destroy the old key. Look at the NVMe firmware requirements for managed hosts on the hardware page.

</details>

<details>
<summary>Answer</summary>

Crypto erase destroys and regenerates only the media encryption key, which is a few bytes. The terabytes of ciphertext stay on the drive, but nobody can decrypt them. An overwrite has to physically write every block. Crypto erase assumes the firmware really encrypted everything and really destroyed the old key. NICo requires managed-host NVMe firmware to be updated only via signed images, with no rollback possible. That stops an attacker from installing, or downgrading to, firmware that only pretends to erase.

</details>

### Explain it

In your own words: Why can't NICo just reformat drives from the host OS between tenants? What does a drive-level command guarantee that an OS-level wipe cannot?

### Check

**1. Why is overwriting a whole SSD from the operating system not a reliable wipe?**

A. SSDs are read-only from the OS
B. Wear-levelling and over-provisioning leave blocks the host cannot address
C. Overwrites are always cached and never written
D. Only HDDs store data magnetically

<details>
<summary>Answer</summary>

**B.** Wear-levelling and over-provisioning leave blocks the host cannot address

The controller remaps writes and keeps spare blocks that the host cannot address, so stale copies can survive. The other options are false. The OS can write to an SSD, and those writes do reach the flash.

</details>

**2. In NICo's tenant sanitization sequence, which step comes first?**

A. TPM clear
B. Secure erase of NVMe and SAS/SATA drives
C. Firmware integrity revalidation
D. InfiniBand device reset

<details>
<summary>Answer</summary>

**B.** Secure erase of NVMe and SAS/SATA drives

The lifecycle page lists secure erase first. After it come UEFI memory-overwrite verification, IB reset, TPM clear (where supported), re-attestation and firmware revalidation.

</details>

**3. According to NICo's hardware prerequisites, which statement is correct?**

A. All drives on both site controllers and managed hosts must support Secure Erase
B. Site controllers need Secure Erase on all local drives; managed hosts need it on NVMe drives, with signed, no-rollback firmware
C. Only site controllers need Secure Erase
D. Secure Erase is optional if attestation is enabled

<details>
<summary>Answer</summary>

**B.** Site controllers need Secure Erase on all local drives; managed hosts need it on NVMe drives, with signed, no-rollback firmware

The page states the two requirements separately. The 'all drives on both' option stretches the site controller rule to managed hosts. Attestation does not replace drive sanitization.

</details>

**Sources:** [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md), [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md)

<a id="lldp"></a>
## 5. LLDP

*Builds on: IP networking fundamentals (ch. 3)*

### Before you read

- Can a server learn the name of a switch two hops away using LLDP?

<details>
<summary>Answers</summary>

- **Can a server learn the name of a switch two hops away using LLDP?** No. LLDP frames go only to directly connected neighbours. Bridges do not forward them and routers do not route them.

</details>

### Explanation

**LLDP (Link Layer Discovery Protocol, IEEE 802.1AB)** lets a device tell whatever is on the other end of the cable "this is who I am and which port this is". It is a Layer 2 protocol (Chapter 3). There is no IP, and no request or reply. Every port simply sends a frame at regular intervals. The frame:

- is addressed to the multicast MAC `01:80:C2:00:00:0E`, which standard bridges do **not** forward, so it travels exactly one hop;
- has EtherType `0x88CC`;
- carries a payload that is a list of **TLVs** (Type-Length-Value records).

Each TLV starts with a 2-byte header. The top 7 bits hold the type and the low 9 bits hold the length. Three TLVs are mandatory and come first:

| Type | TLV | Example |
|---|---|---|
| 1 | Chassis ID | the switch's MAC |
| 2 | Port ID | `swp7` |
| 3 | Time To Live | 120 seconds |

Optional TLVs include Port Description (4), System Name (5) and Management Address (8). Type 0 marks the end. The receiver stores what it hears in a neighbour table and drops each entry when its TTL runs out.

On Linux, the `lldpd` daemon sends and receives these frames, and `lldpcli show neighbors` prints the neighbour table. Cumulus/NVOS switches (Chapter 9) run LLDP by default.

**Why NICo cares.** A data centre has thousands of cables, and nobody wants to type up a wiring map by hand. With LLDP, each end of a link reports its neighbour, for example "this DPU port is plugged into leaf01 port swp7". NICo's docs state that discovery pairs DPUs with their host servers **using LLDP and serial-number matching**, with no manual inventory entry. The DPU-host pairing lesson covers the serial-number side. LLDP adds evidence about the physical topology: where each port is cabled.

LLDP has one major limitation. It is self-reported and unauthenticated, so any device can claim any name. Treat it as evidence about cabling, not as proof of identity.

**Analogy.** LLDP is like the name tag each person wears at a networking event, which only the person standing right in front of them can read. The analogy breaks down because nobody checks the tags. A device can write anything it likes on its own.

### Worked example: Build and decode an LLDP frame in pure Python

**Step 1: Write the builder and parser.**

Save as `lldp.py`:
```python
import struct


def tlv(t, value):
    return struct.pack("!H", (t << 9) | len(value)) + value


def build_frame():
    dst = bytes.fromhex("0180c200000e")
    src = bytes.fromhex("aabbcc000001")
    body = (
        tlv(1, b"\x04" + src)              # Chassis ID, subtype 4 = MAC
        + tlv(2, b"\x05" + b"swp7")        # Port ID, subtype 5 = interface name
        + tlv(3, struct.pack("!H", 120))   # TTL in seconds
        + tlv(5, b"leaf01")                # System Name
        + tlv(0, b"")                      # End of LLDPDU
    )
    return dst + src + struct.pack("!H", 0x88CC) + body


NAMES = {1: "Chassis ID", 2: "Port ID", 3: "TTL", 4: "Port Description", 5: "System Name"}


def show(t, v):
    if t == 3:
        return f"{int.from_bytes(v, 'big')} s"
    if t in (1, 2):
        sub, rest = v[0], v[1:]
        if (t, sub) in ((1, 4), (2, 3)):
            return ":".join(f"{b:02x}" for b in rest)
        return rest.decode()
    return v.decode(errors="replace")


def parse(frame):
    assert frame[12:14] == b"\x88\xcc", "not an LLDP frame"
    i = 14
    while i + 2 <= len(frame):
        (header,) = struct.unpack("!H", frame[i:i + 2])
        t = header >> 9
        length = header & 0x1FF
        value = frame[i + 2:i + 2 + length]
        i += 2 + length
        if t == 0:
            break
        print(f"{NAMES.get(t, t)}: {show(t, value)}")


frame = build_frame()
print(frame.hex())
parse(frame)
```

**Step 2: Run it and read the TLVs.**

`python3 lldp.py` prints the raw hex, then:
```text
Chassis ID: aa:bb:cc:00:00:01
Port ID: swp7
TTL: 120 s
System Name: leaf01
```

**Step 3: Decode one header by hand.**

The Port ID TLV header is `0405`. In binary that is `0000010 000000101`. The top 7 bits give type 2. The low 9 bits give length 5: one subtype byte plus the four bytes of `swp7`.

**Step 4: Relate to a real host.**

On a Linux server with `lldpd` running, `sudo lldpcli show neighbors` shows the same fields (ChassisID, SysName, PortID) for each cabled port. That is how you find out which switch port each NIC or DPU port is plugged into.

### Your turn: finish it

Fill in the two blanks that split a TLV header into its 7-bit type and 9-bit length.

```text
(header,) = struct.unpack("!H", frame[i:i + 2])
t = header ___ 9
length = header & ___
```

<details>
<summary>Answer</summary>

t = header >> 9 and length = header & 0x1FF. 0x1FF is nine 1-bits, or 511 in decimal.

</details>

### Your turn: on your own

A DPU advertises the System Name 'dpu-bf3-07'. What are the two header bytes of that TLV, in hex?

<details>
<summary>Hint 1</summary>

System Name is type 5. Count the bytes in the string.

</details>

<details>
<summary>Hint 2</summary>

The string is 10 bytes long. The header is (type << 9) | length.

</details>

<details>
<summary>Hint 3</summary>

(5 << 9) is 2560. Add 10 and convert to hex.

</details>

<details>
<summary>Answer</summary>

0x0A0A. Type 5 shifted left by 9 is 2560 (0x0A00). Adding the length of 10 gives 2570, which is 0x0A0A, so the bytes are 0A 0A.

</details>

### Explain it

In your own words: Why is LLDP useful evidence for working out which DPU belongs to which host, and why is it not enough on its own to prove identity?

### Check

**1. Which three TLVs are mandatory at the start of every LLDPDU?**

A. Chassis ID, Port ID, TTL
B. System Name, Port Description, TTL
C. Chassis ID, Management Address, End
D. Port ID, VLAN, TTL

<details>
<summary>Answer</summary>

**A.** Chassis ID, Port ID, TTL

System Name, Port Description and Management Address are optional. End (type 0) closes the LLDPDU but is not one of the three identifying TLVs.

</details>

**2. Why does an LLDP frame reach only the directly connected neighbour?**

A. It has an IP TTL of 1
B. It is sent to a reserved multicast MAC that standard bridges do not forward
C. Switches encrypt it
D. It uses UDP port 1

<details>
<summary>Answer</summary>

**B.** It is sent to a reserved multicast MAC that standard bridges do not forward

LLDP has no IP header, so the IP TTL and UDP options cannot apply. It is not encrypted either. It is unauthenticated plain text.

</details>

**Sources:** [overview/capabilities.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/capabilities.md), [overview/lifecycle.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/lifecycle.md)

<a id="expected-machines-manifest"></a>
## 6. Expected Machines Manifest

*Builds on: MAC address (ch. 1), Factory default credentials (ch. 20)*

### Before you read

- A new server is racked, cabled and powered on, but it is not listed in expected_machines.json. Will NICo ingest it?
- Why might the manifest include the chassis serial number when NICo already knows the BMC MAC address?

<details>
<summary>Answers</summary>

- **A new server is racked, cabled and powered on, but it is not listed in expected_machines.json. Will NICo ingest it?** No. Only hosts listed in the manifest are discovered and ingested.
- **Why might the manifest include the chassis serial number when NICo already knows the BMC MAC address?** To confirm that the BMC answering on that MAC really sits in the chassis you expected, which catches mis-typed MACs and swapped boards.

</details>

### Explanation

The **Expected Machines Manifest** (`expected_machines.json`) tells NICo which machines it may take over. It is an allow-list and a book of factory passwords in one file. NICo discovers and ingests only the hosts listed in it.

Each entry has four required fields:

| Field | Purpose |
|---|---|
| `bmc_mac_address` | MAC of the host BMC interface. NICo looks it up when the BMC appears on DHCP. |
| `chassis_serial_number` | Confirms that the BMC with that MAC is in the chassis you expected. |
| `bmc_username` | Factory default user, typically `root`. |
| `bmc_password` | Factory default password. |

NICo uses the factory credentials only for first contact. After discovery it rotates them to site-managed values (Chapter 20). Until then the file holds working passwords for every new BMC, so restrict its permissions and keep it out of Git.

The docs also mention optional per-host fields:
- `"dpf_enabled": false` keeps a host on the deprecated iPXE path. The default is `true`, meaning DPF provisioning.
- The expected-machine record can carry `fallback_dpu_serial_numbers`, which are used during DPU pairing (next lesson).

**Uploading.** You load the file into NICo Core with the admin CLI, which calls the gRPC API `ReplaceAllExpectedMachines`:

```bash
nico-admin-cli -a <nico-api-endpoint> em replace-all --filename expected_machines.json
```

As the name says, this *replaces the whole set*. The file must list every machine you expect, not just the new ones.

**Order of operations.** Set the site-wide credentials first: the site-wide BMC root, plus the host and DPU UEFI defaults. Site Explorer checks them before contacting any BMC. If any of them is missing, it aborts every run with `MissingCredentials`.

**Analogy.** The manifest is like the guest list at a venue door. For each guest it holds a name (the MAC), an ID card number to check (the chassis serial), and the temporary entry code they arrive with (the factory password). Once inside, every guest gets a new code. The analogy breaks down because a bouncer can make an exception for someone. NICo ignores anyone who is not on the list.

### Worked example: Prepare and sanity-check a manifest

**Step 1: Write the file.**

```bash
mkdir -p ~/em && cd ~/em
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
      "chassis_serial_number": "SERIAL-2",
      "dpf_enabled": false
    }
  ]
}
EOF
```

**Step 2: Protect it.**

```bash
chmod 600 expected_machines.json
```
The file contains working factory passwords for every new BMC.

**Step 3: Check structure with jq.**

```bash
jq '.expected_machines | length' expected_machines.json
jq -r '.expected_machines[] | [.bmc_mac_address, .chassis_serial_number] | @tsv' expected_machines.json
jq '[.expected_machines[].bmc_mac_address | ascii_upcase] | group_by(.) | map(select(length > 1))' expected_machines.json
```
The last command prints `[]` when no MAC appears twice.

**Step 4: Upload (on a real site).**

After you have set the site-wide credentials:
```bash
nico-admin-cli -a <nico-api-endpoint> em replace-all --filename expected_machines.json
```
The second host stays on the iPXE path because its `dpf_enabled` is `false`. The first host uses the default, DPF.

### Your turn: finish it

Finish this validator so it flags missing fields, malformed MACs and duplicate MACs (case-insensitive). Run it with `python3 validate_em.py expected_machines.json`.

```text
import json
import re
import sys

MAC = re.compile(r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")
REQUIRED = ["bmc_mac_address", "bmc_username", "bmc_password", "chassis_serial_number"]

doc = json.load(open(sys.argv[1]))
seen = set()
errors = 0
for i, m in enumerate(doc["expected_machines"]):
    for field in REQUIRED:
        if not m.get(field):
            print(f"entry {i}: missing {field}")
            errors += 1
    mac = m.get("bmc_mac_address", "")
    if not MAC.match(mac):
        print(f"entry {i}: bad MAC {mac!r}")
        errors += 1
    if mac.upper() in seen:
        print(f"entry {i}: duplicate MAC {mac}")
        errors += 1
    seen.add(___)
print("OK" if errors == 0 else f"{errors} problem(s)")
sys.exit(1 if errors else 0)
```

<details>
<summary>Answer</summary>

seen.add(mac.upper()). Because the set stores upper-cased MACs, 'c4:5a:...' and 'C4:5A:...' are caught as the same address.

</details>

### Your turn: on your own

Host SERIAL-1 had its motherboard replaced, and the BMC went with it. The new BMC MAC is C4:5A:B1:00:00:42, and a fresh factory password is printed on the board. What do you change, and why must the uploaded file still contain SERIAL-2's entry?

<details>
<summary>Hint 1</summary>

Which fields describe the BMC rather than the chassis?

</details>

<details>
<summary>Hint 2</summary>

The MAC and the factory password belong to the BMC. The chassis serial stays with the chassis.

</details>

<details>
<summary>Hint 3</summary>

Think about what 'replace-all' does to entries that are missing from the file.

</details>

<details>
<summary>Answer</summary>

Update SERIAL-1's bmc_mac_address to C4:5A:B1:00:00:42. Set its bmc_password, and its username if that differs, to the new board's factory values. Keep chassis_serial_number as SERIAL-1. Then upload with `em replace-all`. That call replaces the entire expected-machines set, so the file must still include SERIAL-2 and every other host. Any entry left out would be dropped.

</details>

### Explain it

In your own words: Why does NICo insist on an explicit manifest instead of ingesting any BMC that appears on the OOB network?

### Check

**1. Which field does NICo use as the lookup key when a BMC appears on DHCP?**

A. chassis_serial_number
B. bmc_mac_address
C. bmc_username
D. dpf_enabled

<details>
<summary>Answer</summary>

**B.** bmc_mac_address

A DHCP request carries the client's MAC, and NICo matches on that. The chassis serial only becomes known later from Redfish, and NICo uses it to verify the match.

</details>

**2. Site Explorer logs `MissingCredentials` and contacts no BMCs, even though the manifest is uploaded. What is missing?**

A. The chassis serial numbers
B. One or more site-wide credentials: the BMC root, or the host/DPU UEFI defaults
C. The dpf_enabled field
D. A DHCP relay

<details>
<summary>Answer</summary>

**B.** One or more site-wide credentials: the BMC root, or the host/DPU UEFI defaults

Site Explorer checks the site-wide BMC root and both UEFI site defaults before contacting any BMC. A missing relay would mean no BMCs appear at all, not this error.

</details>

**3. What happens to a host's manifest password after successful discovery?**

A. It is used forever
B. NICo rotates the BMC credentials to site-managed values
C. It is written into the BMC's DHCP options
D. It becomes the UEFI password

<details>
<summary>Answer</summary>

**B.** NICo rotates the BMC credentials to site-managed values

NICo uses the factory password only for first contact. After rotation, Site Explorer looks up credentials by BMC MAC address.

</details>

**Sources:** [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md)

<a id="dpu-host-pairing"></a>
## 7. DPU-host pairing

*Builds on: DPU mode vs NIC mode (ch. 12), PCIe device (ch. 1), MAC address (ch. 1), Redfish resource tree (Systems, Chassis, Managers) (ch. 6)*

### Before you read

- A host BMC and a DPU BMC are separate network endpoints with separate IPs. Which piece of data could both of them report that proves the DPU is plugged into that host?

<details>
<summary>Answers</summary>

- **A host BMC and a DPU BMC are separate network endpoints with separate IPs. Which piece of data could both of them report that proves the DPU is plugged into that host?** The DPU's serial number. The host sees the DPU as a PCIe device or network adapter with a serial, and the DPU's own BMC reports the same serial.

</details>

### Explanation

A managed host has its own BMC, and each BlueField DPU in it has a separate BMC too (Chapter 7). Site Explorer explores each BMC independently. It then has to answer the question **which DPU belongs to which host?**, and it does so by **serial-number correlation**.

The Redfish workflow docs describe four steps:

1. **Build a DPU serial map.** For every explored DPU BMC, record `serial → endpoint`.
2. **Collect host inventory.** Gather devices from the host's `system.pcie_devices` and its chassis inventory (`NetworkAdapters`). Trim whitespace, drop blank serials and deduplicate across both sources. Prefer records with a BlueField part number (the PN from the earlier lesson).
3. **Match.** Look up each inventory serial in the DPU map. A match identifies the device as a DPU even if the host reported no BlueField part number.
4. **Add configured serials.** Always add `expected_machine.fallback_dpu_serial_numbers`, trimmed and deduplicated. A serial found in both sources counts once.

Next comes **validation**:
- **Mode.** Site Explorer works out the target mode from the host's DPU policy and the device part number. A mode change needs a host power cycle, so ingestion waits for a later pass. Devices in **NIC mode** count toward completeness but are **not attached as managed DPUs**.
- **Completeness.** Every configured serial must have an explored DPU BMC. Every matched DPU must be ready. The ready matches must cover the DPU count the host reports. If any of these fails, the pairing is **deferred**, not failed.

**Firmware is the other half of "ingestable".** The architecture overview defines an ingestable host as one whose components are all found *and* have up-to-date firmware versions. If a host's firmware is below the minimum required for ingestion, it waits while **Preingestion Manager** updates it. This matters most for very old host or DPU BMCs, which may not yet report the data needed to map the host to its DPUs. Once pairing validation passes and the firmware is up to date, Site Explorer starts ingestion through the ManagedHost state machine (Chapter 4).

Two edge cases:
- If `system.serial_number` is missing, the chassis serial is used instead.
- Hosts with `dpu_policy = "ignore"` skip DPU matching.

Take care after a DPU replacement (RMA). If the old serial is still in `fallback_dpu_serial_numbers`, it **blocks ingestion**, even when every DPU the host reports is present.

**Analogy.** Pairing is like matching luggage to passengers. The passenger's ticket stub carries a bag tag number (the host's PCIe serial), and the bag carries the same tag (the DPU BMC's serial). The flight cannot leave until every tagged bag is on board (completeness) and the plane has passed its checks (firmware). The analogy breaks down with NIC mode. A bag in the 'wrong mode' still counts as loaded, but the passenger is not given it to manage.

### Worked example: Run the matching and completeness logic by hand

**Step 1: Describe what was explored.**

```python
dpu_reports = {
    "MT2333X00001": {"mode": "DPU"},
    "MT2333X00002": {"mode": "NIC"},
}
host_pcie = [" MT2333X00001", "MT2333X00002", "", "MT2333X00001"]
fallback = ["MT2333X00009", " "]
```

**Step 2: Normalise inventory and configured serials.**

```python
inventory = {s.strip() for s in host_pcie if s.strip()}
configured = {s.strip() for s in fallback if s.strip()}
print(inventory, configured)
```
Trimming and dropping blanks gives `{'MT2333X00001', 'MT2333X00002'}` and `{'MT2333X00009'}`. The duplicate `MT2333X00001` collapses to a single entry.

**Step 3: Match against explored DPU BMCs.**

```python
wanted = inventory | configured
found = {s for s in wanted if s in dpu_reports}
missing_configured = configured - found
nic_mode = {s for s in found if dpu_reports[s]["mode"] == "NIC"}
managed = found - nic_mode
print(managed, nic_mode, missing_configured)
```

**Step 4: Decide.**

The results are `managed = {'MT2333X00001'}`, `nic_mode = {'MT2333X00002'}` and `missing_configured = {'MT2333X00009'}`. Every configured serial must be discovered, so this host is **deferred**. If `MT2333X00009` is a DPU that was swapped out, update or remove that serial in `fallback_dpu_serial_numbers`. Even with pairing fixed, the host becomes ingestable only once its components also have the required firmware versions.

### Your turn: finish it

Fill in the blanks so that `wanted` combines both sources and `nic_mode` picks out the devices that will not be attached as managed DPUs.

```text
wanted = inventory ___ configured
found = {s for s in wanted if s in dpu_reports}
nic_mode = {s for s in found if dpu_reports[s]["mode"] == ___}
managed = found - nic_mode
```

<details>
<summary>Answer</summary>

wanted = inventory | configured (set union, so a serial in both sets counts once), and the mode check compares against "NIC".

</details>

### Your turn: on your own

A host's DPU MT2333X00005 was replaced under RMA with MT2333X00077. The new DPU's BMC is explored and ready, and the host's PCIe inventory now reports MT2333X00077. The host's expected-machine record still has fallback_dpu_serial_numbers = ["MT2333X00005"]. Will the host ingest? Why, and what is the fix?

<details>
<summary>Hint 1</summary>

Step 4 says configured serials are always considered, even when the host inventory is fully matched.

</details>

<details>
<summary>Hint 2</summary>

Every configured serial must have an explored DPU BMC.

</details>

<details>
<summary>Hint 3</summary>

No DPU BMC reports MT2333X00005 any more.

</details>

<details>
<summary>Answer</summary>

No. Configured fallback serials are always included, and each one must be discovered with its DPU ready. MT2333X00005 no longer exists, so the completeness check fails and ingestion is deferred, even though the real DPU MT2333X00077 is matched and ready. To fix it, change the record's fallback_dpu_serial_numbers to MT2333X00077 or remove the stale entry. The host also still needs its components at the required firmware versions before it becomes ingestable.

</details>

### Explain it

In your own words: Why does Site Explorer pair DPUs to hosts using serial numbers reported by two different BMCs, instead of trusting the host's PCIe inventory alone?

### Check

**1. A host contains a BlueField device that reports NIC mode after the mode checks succeed. How is it treated?**

A. Ingestion fails permanently
B. It counts toward pairing completeness but is not attached as a managed DPU
C. It is attached as a managed DPU anyway
D. It is ignored entirely

<details>
<summary>Answer</summary>

**B.** It counts toward pairing completeness but is not attached as a managed DPU

The docs say NIC-mode devices count toward completeness but are not attached as managed DPUs. The device is not ignored, and it does not cause a fatal error.

</details>

**2. All of a host's DPUs are matched and ready, but its BMC firmware is below the minimum required for ingestion. What happens?**

A. The host is ingested immediately and updated later
B. The host is not yet ingestable; Preingestion Manager updates the firmware first
C. The host is permanently rejected
D. Site Explorer ignores firmware during Day 0

<details>
<summary>Answer</summary>

**B.** The host is not yet ingestable; Preingestion Manager updates the firmware first

The architecture overview defines ingestable as all components found with up-to-date firmware versions. Preingestion Manager updates hosts that are below the minimum. The host is not rejected outright, but pairing alone is not enough.

</details>

**3. Which hosts skip DPU matching entirely?**

A. Hosts with dpf_enabled: false
B. Hosts with dpu_policy = "ignore"
C. Hosts whose BMC uses factory credentials
D. Hosts with only one DPU

<details>
<summary>Answer</summary>

**B.** Hosts with dpu_policy = "ignore"

dpf_enabled chooses the provisioning path (DPF or iPXE) and does not affect matching. Only dpu_policy = "ignore" skips DPU matching.

</details>

**Sources:** [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md)

<a id="bmc-discovery"></a>
## 8. BMC Discovery

*Builds on: DHCP (ch. 8), Expected Machines Manifest (ch. 22)*

### Before you read

- BMCs sit on an OOB network, and NICo's DHCP service runs as a pod in Kubernetes on another subnet. DHCP discovery messages are broadcasts. How do they reach NICo?
- Before NICo knows a BMC's vendor, which Redfish request can it safely send without credentials?

<details>
<summary>Answers</summary>

- **BMCs sit on an OOB network, and NICo's DHCP service runs as a pod in Kubernetes on another subnet. DHCP discovery messages are broadcasts. How do they reach NICo?** A DHCP relay on each BMC-facing network forwards the requests as unicast to the NICo DHCP service IP.
- **Before NICo knows a BMC's vendor, which Redfish request can it safely send without credentials?** An anonymous GET of the service root, /redfish/v1.

</details>

### Explanation

BMC discovery is the first stage of the Day 0 pipeline. It runs in five steps:

1. **DHCP request.** A newly powered BMC sends a DHCP request. The OOB switches do **not** assign addresses. Instead they run a **DHCP relay** that points at the NICo DHCP service VIP. The docs call it `NICo_DHCP_EXTERNAL`. It is the `nico-dhcp` LoadBalancer IP from setup Step 3h.
2. **Kea hook.** `nico-dhcp` is the Kea DHCP server plus a Rust hook. The hook extracts the **MAC address, vendor class string, relay address, circuit ID and remote ID** from the packet. It then makes a gRPC `discover_dhcp()` call to NICo Core. `nico-dhcp` itself is a **stateless proxy**. NICo Core performs IP address management and returns the BMC's network configuration (IP address, gateway and so on). DHCP entries are tracked by MAC address, and the vendor class string helps identify the BMC type.
3. **Site Explorer probes.** With the BMC's IP known, Site Explorer sends an **anonymous** `GET /redfish/v1` to detect the vendor (Chapter 6).
4. **Authenticate.** Site Explorer opens a session with **Direct** credentials: the factory username and password from the **Expected Machines** entry whose MAC matches. After credential rotation it switches to **Key** auth, which looks up the credential by BMC MAC.
5. **Inventory.** Site Explorer reads Systems, Chassis, NetworkAdapters, Managers, firmware inventory, boot options and power state. The result is an `EndpointExplorationReport`, which feeds DPU-host pairing.

You control these preconditions:
- Every BMC can reach the site controller over the network, and every BMC-facing network has a relay.
- DPU BMC and DPU OOB interfaces have `Underlay` connectivity.
- The manifest is uploaded and the site-wide credentials are set. Without the credentials, each Site Explorer run aborts with `MissingCredentials`.

The MAC address ties the whole flow together. DHCP reports it, the manifest is keyed by it, and credentials are looked up by it after rotation.

**Analogy.** Discovery is like a hotel front desk. A guest calls from the lobby courtesy phone (the DHCP relay). The desk finds the booking by phone number (the MAC in the manifest), assigns a room (an IP), and lets the guest in with the temporary key from the booking (factory credentials). Later the hotel re-keys the room (rotation). The analogy breaks down at step 3: a hotel never asks what brand a guest is before checking their booking.

### Worked example: Trace and verify a BMC's discovery on a site

**Step 1: Find the DHCP VIP the relay must target.**

```bash
kubectl get svc nico-dhcp -n nico-system
```
The external IP comes from the internal MetalLB pool. Configure it as the DHCP relay helper address on every BMC-facing OOB switch network.

**Step 2: Confirm requests arrive.**

Power on the server, or reset its BMC. Then run:
```bash
kubectl logs -n nico-system -l app.kubernetes.io/name=nico-dhcp --tail=20
```
If nothing appears for the BMC's MAC, the problem is in the relay or routing, not in NICo Core.

**Step 3: Check the precondition for exploration.**

Check that the site-wide credentials exist: the BMC root plus the host and DPU UEFI defaults. Without them, Site Explorer aborts with `MissingCredentials` before contacting any BMC. Also check that the BMC's MAC is in the uploaded manifest.

**Step 4: Watch Site Explorer work.**

```bash
kubectl logs -n nico-system -l app.kubernetes.io/name=nico-api --tail=50 \
  | grep -i "site explorer\|bmc\|discovery"
```
You can also see what was found through the `FindExploredEndpoints` APIs or the Debug Web UI under `/admin`.

**Step 5: Reproduce the probe by hand (optional).**

From a machine on the OOB network, you can send the same anonymous probe that Site Explorer starts with:
```bash
curl -sk https://<bmc-ip>/redfish/v1 | jq .
```
The service root needs no credentials. Everything below it requires authentication.

### Your turn: finish it

Fill in the blanks in this discovery sequence.

```text
1. BMC broadcasts a DHCP request on its OOB network.
2. A ___ on the OOB switch forwards it to the nico-dhcp VIP.
3. The Kea hook extracts MAC, vendor class, relay address, circuit ID and remote ID, and calls ___ on NICo Core over gRPC.
4. NICo Core allocates the address and returns the network config.
5. Site Explorer sends an anonymous GET /redfish/v1, then authenticates with the factory credentials from the manifest entry whose ___ matches.
```

<details>
<summary>Answer</summary>

(2) DHCP relay; (3) discover_dhcp(); (5) bmc_mac_address (the BMC MAC).

</details>

### Your turn: on your own

A new rack is powered on. The nico-dhcp logs show requests from all twelve BMC MACs, but only ten hosts ever show up as explored. The other two never get past Site Explorer. Suggest two likely causes and how to check each.

<details>
<summary>Hint 1</summary>

DHCP is working, so look at what Site Explorer needs for each host.

</details>

<details>
<summary>Hint 2</summary>

Site Explorer needs a manifest entry for the MAC, and credentials that actually work.

</details>

<details>
<summary>Hint 3</summary>

Compare the two MACs against expected_machines.json (case, typos), and check whether their factory passwords are correct.

</details>

<details>
<summary>Answer</summary>

(1) The two BMC MACs are missing from the uploaded manifest, or mistyped in it. Only listed hosts are discovered. Compare the MACs in the DHCP logs against the manifest (for example with jq), fix the entries and re-upload with em replace-all. (2) The manifest has the wrong factory username or password for those BMCs, so Direct authentication fails after the anonymous probe. Check the nico-api logs for those BMCs, compare the factory credentials with the labels on the boards, and fix the entries. A related check is the chassis serial, which verifies that the MAC belongs to the expected chassis. MissingCredentials cannot be the cause, because it would block all twelve hosts, not two.

</details>

### Explain it

In your own words: Why is NICo's DHCP service built as a stateless proxy that forwards to NICo Core, instead of a normal DHCP server with its own lease database?

### Check

**1. What do the OOB switches need to do for BMC discovery?**

A. Run a DHCP server with a pool for BMCs
B. Relay DHCP requests to the NICo DHCP service
C. Run LLDP towards NICo
D. Nothing; BMCs contact NICo directly by DNS name

<details>
<summary>Answer</summary>

**B.** Relay DHCP requests to the NICo DHCP service

NICo manages IP allocation, so the OOB switches only relay. A DHCP server on the switch would hand out addresses that NICo does not know about.

</details>

**2. In what order does Site Explorer use its authentication methods over a BMC's life?**

A. Key, then Direct, then Anonymous
B. Anonymous probe, then Direct (manifest factory creds), then Key (after rotation)
C. Direct only
D. Anonymous only

<details>
<summary>Answer</summary>

**B.** Anonymous probe, then Direct (manifest factory creds), then Key (after rotation)

The anonymous request detects the vendor. The factory credentials let NICo take ownership. After rotation, credentials are looked up by BMC MAC.

</details>

**3. Which component performs IP address management for BMCs?**

A. nico-dhcp
B. NICo Core
C. The OOB switch
D. Site Explorer

<details>
<summary>Answer</summary>

**B.** NICo Core

nico-dhcp converts DHCP requests into gRPC calls and forwards them. NICo Core does the IP address management. Site Explorer only uses the resulting BMC addresses.

</details>

**Sources:** [architecture/redfish_workflow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish_workflow.md), [getting-started/prerequisites/bmc-oob-setup.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/bmc-oob-setup.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [architecture/overview.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/overview.md)

<a id="build-task"></a>
## Build task: Mini Site Explorer: from DHCP lease to ingestable host

**Goal:** Build a laptop-scale imitation of NICo's discovery pipeline using only Python's standard library. Mock host and DPU BMCs serve Redfish-like JSON, and a simulated DHCP lease table stands in for nico-dhcp output. An explorer script matches leases against expected_machines.json, probes anonymously, authenticates with factory credentials and verifies chassis serials. It then identifies DPUs by part-number allow-list or by serial, and decides whether each host is INGESTABLE or DEFERRED.

**Why it matters for NICo:** NICo runs this Day 0 flow for every new host. It looks up the MAC from DHCP in the manifest, sends an anonymous Redfish probe followed by Direct authentication, and ends with serial-number pairing and a completeness check. Building it yourself makes NICo's behaviour predictable, for example why a host stays deferred or why a BMC is never explored. It also gives you a sandbox for practising manifest edits before you touch a real site. This is a teaching mock with simplified Redfish shapes, not NICo code. It also leaves out the firmware-version requirement: real NICo treats a host as ingestable only once its components have the required firmware, and Preingestion Manager updates hosts that are too old.

**You need:**

- Linux or macOS terminal
- Python 3.8+ (standard library only)
- curl (and optionally jq)
- Free local ports 8001-8002 and 8101-8103

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Create the manifest and site config</summary>

```bash
mkdir -p ~/minise/bmcs && cd ~/minise
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
chmod 600 expected_machines.json
cat > site.json <<'EOF'
{"dpu_bmc_user": "root", "dpu_bmc_password": "lab-dpu-pass",
 "dpu_part_numbers": ["900-9D3B6-00CV-AA0"]}
EOF
```
`site.json` is a simplification for the mock. It holds a lab DPU BMC credential and a list of BlueField part numbers that the explorer treats as DPUs. This mirrors the BlueField part-number preference from the pairing lesson.

</details>

<details>
<summary>Step 2: Write a mock BMC</summary>

Save as `fake_bmc.py`:
```python
import base64
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

cfg = json.load(open(sys.argv[1]))
token = base64.b64encode(f"{cfg['user']}:{cfg['password']}".encode()).decode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/redfish/v1":
            return self.send_json(200, {"RedfishVersion": "1.15.0", "Vendor": cfg["vendor"]})
        if self.headers.get("Authorization") != f"Basic {token}":
            return self.send_json(401, {"error": "authentication required"})
        if self.path == "/redfish/v1/Systems/1":
            return self.send_json(200, {
                "SerialNumber": cfg["serial"],
                "Mode": cfg.get("mode"),
                "PCIeDevices": cfg.get("pcie", []),
            })
        self.send_json(404, {"error": "not found"})


HTTPServer(("127.0.0.1", cfg["port"]), Handler).serve_forever()
```
In real Redfish, PCIe devices are separate linked resources. The mock puts them inline to stay small.

</details>

<details>
<summary>Step 3: Describe the hardware</summary>

```bash
cat > bmcs/host1.json <<'EOF'
{"port": 8001, "vendor": "MockVendor", "user": "root", "password": "default-password1",
 "serial": "SERIAL-1", "pcie": [
  {"PartNumber": "900-9D3B6-00CV-AA0", "SerialNumber": "MT2333X00001"},
  {"PartNumber": "NVME-3T84", "SerialNumber": "S6NVME0001"}]}
EOF
cat > bmcs/host2.json <<'EOF'
{"port": 8002, "vendor": "MockVendor", "user": "root", "password": "default-password2",
 "serial": "SERIAL-2", "pcie": [
  {"PartNumber": "900-9D3B6-00CV-AA0", "SerialNumber": "MT2333X00002"},
  {"PartNumber": "900-9D3B6-00CV-AA0", "SerialNumber": " MT2333X00003 "}]}
EOF
cat > bmcs/dpu1.json <<'EOF'
{"port": 8101, "vendor": "MockDPU", "user": "root", "password": "lab-dpu-pass",
 "serial": "MT2333X00001", "mode": "DPU"}
EOF
cat > bmcs/dpu2.json <<'EOF'
{"port": 8102, "vendor": "MockDPU", "user": "root", "password": "lab-dpu-pass",
 "serial": "MT2333X00002", "mode": "NIC"}
EOF
cat > bmcs/dpu3.json <<'EOF'
{"port": 8103, "vendor": "MockDPU", "user": "root", "password": "lab-dpu-pass",
 "serial": "MT2333X00003", "mode": "DPU"}
EOF
```
Host 2's second DPU serial has deliberate whitespace around it, which the explorer must trim.

</details>

<details>
<summary>Step 4: Start four BMCs and probe them</summary>

```bash
for b in host1 host2 dpu1 dpu2; do python3 fake_bmc.py bmcs/$b.json & done
sleep 1
curl -s http://127.0.0.1:8001/redfish/v1; echo
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8001/redfish/v1/Systems/1
curl -s -u root:default-password1 http://127.0.0.1:8001/redfish/v1/Systems/1; echo
```
You should see the anonymous service root, then `401`, then the system JSON. Do not start DPU 3 yet. In this scenario it has not been racked.

</details>

<details>
<summary>Step 5: Simulate the DHCP lease table</summary>

In NICo, nico-dhcp hands the MAC to Core, and Core records the address. Here a file plays that role:
```bash
cat > leases.json <<'EOF'
[
  {"mac": "c4:5a:b1:c8:38:0d", "ip": "127.0.0.1", "port": 8001, "kind": "host_bmc"},
  {"mac": "C4:5A:FF:FF:FF:FF", "ip": "127.0.0.1", "port": 8002, "kind": "host_bmc"},
  {"mac": "B8:3F:D2:00:00:01", "ip": "127.0.0.1", "port": 8101, "kind": "dpu_bmc"},
  {"mac": "B8:3F:D2:00:00:02", "ip": "127.0.0.1", "port": 8102, "kind": "dpu_bmc"},
  {"mac": "02:00:00:00:00:99", "ip": "127.0.0.1", "port": 8003, "kind": "host_bmc"}
]
EOF
```
The `kind` field stands in for vendor-class parsing. The first MAC is lowercase on purpose. The last MAC belongs to a rogue BMC that is not in the manifest.

</details>

<details>
<summary>Step 6: Write the explorer</summary>

Save as `explorer.py`:
```python
import base64
import json
import urllib.error
import urllib.request

manifest = json.load(open("expected_machines.json"))["expected_machines"]
leases = json.load(open("leases.json"))
site = json.load(open("site.json"))
by_mac = {m["bmc_mac_address"].upper(): m for m in manifest}


def get(lease, path, user=None, pw=None):
    req = urllib.request.Request(f"http://{lease['ip']}:{lease['port']}{path}")
    if user:
        token = base64.b64encode(f"{user}:{pw}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")
    with urllib.request.urlopen(req, timeout=3) as resp:
        return json.load(resp)


hosts, dpus = {}, {}
for lease in leases:
    mac = lease["mac"].upper()
    if lease["kind"] == "dpu_bmc":
        user, pw = site["dpu_bmc_user"], site["dpu_bmc_password"]
    elif mac in by_mac:
        user, pw = by_mac[mac]["bmc_username"], by_mac[mac]["bmc_password"]
    else:
        print(f"SKIP {mac}: not in expected_machines.json")
        continue
    root = get(lease, "/redfish/v1")  # anonymous vendor probe
    try:
        system = get(lease, "/redfish/v1/Systems/1", user, pw)
    except urllib.error.HTTPError as err:
        print(f"AUTH-FAIL {mac}: HTTP {err.code}")
        continue
    serial = system["SerialNumber"].strip()
    print(f"EXPLORED {mac} vendor={root['Vendor']} serial={serial}")
    if lease["kind"] == "dpu_bmc":
        dpus[serial] = system
        continue
    expected = by_mac[mac]["chassis_serial_number"]
    if serial != expected:
        print(f"MISMATCH {mac}: BMC reports {serial}, manifest says {expected}")
        continue
    hosts[serial] = system

for serial, system in hosts.items():
    managed, nic_mode, missing = [], [], []
    seen = set()
    for dev in system.get("PCIeDevices", []):
        s = dev.get("SerialNumber", "").strip()
        if not s or s in seen:
            continue
        seen.add(s)
        if s not in dpus and dev.get("PartNumber") not in site["dpu_part_numbers"]:
            continue  # not a DPU, e.g. an NVMe drive
        if s not in dpus:
            missing.append(s)
        elif dpus[s].get("Mode") == "NIC":
            nic_mode.append(s)
        else:
            managed.append(s)
    status = "DEFERRED" if missing else "INGESTABLE"
    print(f"{status} host={serial} managed_dpus={managed} nic_mode={nic_mode} missing={missing}")
```
Run `python3 explorer.py`. The expected output is:
```text
EXPLORED C4:5A:B1:C8:38:0D vendor=MockVendor serial=SERIAL-1
EXPLORED C4:5A:FF:FF:FF:FF vendor=MockVendor serial=SERIAL-2
EXPLORED B8:3F:D2:00:00:01 vendor=MockDPU serial=MT2333X00001
EXPLORED B8:3F:D2:00:00:02 vendor=MockDPU serial=MT2333X00002
SKIP 02:00:00:00:00:99: not in expected_machines.json
INGESTABLE host=SERIAL-1 managed_dpus=['MT2333X00001'] nic_mode=[] missing=[]
DEFERRED host=SERIAL-2 managed_dpus=[] nic_mode=['MT2333X00002'] missing=['MT2333X00003']
```

</details>

<details>
<summary>Step 7: Rack the missing DPU and re-run</summary>

```bash
python3 fake_bmc.py bmcs/dpu3.json &
sleep 1
python3 -c 'import json; l = json.load(open("leases.json")); l.append({"mac": "B8:3F:D2:00:00:03", "ip": "127.0.0.1", "port": 8103, "kind": "dpu_bmc"}); json.dump(l, open("leases.json", "w"), indent=2)'
python3 explorer.py
```
The `sleep 1` gives the new mock BMC time to start listening on port 8103. Without it, the explorer's anonymous probe can hit a closed port and crash with a `URLError`. Host SERIAL-2 now becomes INGESTABLE, with one managed DPU and one DPU in NIC mode. When you are finished, run `pkill -f fake_bmc.py`.

</details>

**Check it works:** After the final step, `python3 explorer.py | tail -2` prints exactly:
INGESTABLE host=SERIAL-1 managed_dpus=['MT2333X00001'] nic_mode=[] missing=[]
INGESTABLE host=SERIAL-2 managed_dpus=['MT2333X00003'] nic_mode=['MT2333X00002'] missing=[]
The full output also includes a SKIP line for 02:00:00:00:00:99. For a negative test, change SERIAL-1's chassis_serial_number in the manifest to SERIAL-X and re-run. You should see a MISMATCH line, and SERIAL-1 should be gone from the pairing results.

<details>
<summary>If you get stuck</summary>

- `ConnectionRefusedError` (shown inside a `URLError`) means a mock BMC is not running on that port yet. Check with `jobs` or `lsof -i :8001`. Restart it with `python3 fake_bmc.py bmcs/host1.json &`, wait a second, then re-run the explorer.
- `OSError: [Errno 98] Address already in use` means an old copy is still running. Run `pkill -f fake_bmc.py` and start the mocks again.
- `json.decoder.JSONDecodeError` usually means a trailing comma or a smart quote in one of the heredoc files. Run `python3 -m json.tool <file>` to find the line.
- `AUTH-FAIL ... HTTP 401` means the password in expected_machines.json (or site.json) does not match the one in the bmcs/*.json file. A wrong factory password causes the same failure on a real site.
- If SERIAL-2 still shows missing=['MT2333X00003'] after step 7, check that leases.json has the new entry (`cat leases.json`) and that port 8103 answers `curl -s http://127.0.0.1:8103/redfish/v1`.

</details>

**Stretch goal:** Try one or more of these harder extensions. (1) Credential rotation: after the explorer explores a host with Direct credentials, have it generate a new password and store it in a `rotated.json` keyed by BMC MAC. Make fake_bmc.py accept a POST that changes its password. On the next run, the explorer should use the rotated credential (Key-style lookup by MAC) and never fall back to the factory one. (2) Firmware gate: give each mock BMC a `bmc_firmware` version and add a `min_bmc_firmware` to site.json. Report hosts below the minimum as `PREINGESTION-UPDATE` instead of INGESTABLE. (3) Ingress: containerise the mock BMCs and the explorer, run them in a local kind cluster, and add a small HTTP endpoint that serves the pairing report. Expose it through ingress-nginx with a cert-manager self-signed Certificate on a hostname such as `explorer.lab.test`, and verify it with `curl --cacert` against the exported CA.

## Review notes

The draft was rewritten twice using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **ok**, no issues found.

---

[← 21-authentication-identity.md](21-authentication-identity.md) · [23-nico-architecture-bluefield-dpu.md →](23-nico-architecture-bluefield-dpu.md)
