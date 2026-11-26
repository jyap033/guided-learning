# Chapter 18: Cryptography

*Part: Security & Identity · 6 concepts · [curriculum](../curriculum.md#chapter-18)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

NICo holds a lot of secrets. Its Site Controller stores the BMC and UEFI passwords for every managed server, the secret from which SuperNIC lockdown keys are derived (the lockdown IKM), and the private keys that sign machine-identity tokens. Every one of its services talks to the others over mutually authenticated TLS. To run NICo safely you need to know what protects each of those secrets, and what breaks if you lose a key.

This chapter starts with the **Site Controller**, the thing you are protecting. You already know Kubernetes (ch. 14) and microservices (ch. 4), so this lesson is about how NICo's control plane is laid out and where its secrets live. The next five lessons build a small cryptography toolkit, one tool at a time:

- **AES-GCM** encrypts data and detects tampering.
- **Key derivation (HKDF)** turns one secret into many independent keys.
- **Hashing** produces fingerprints.
- **Envelope encryption** wraps per-item data keys under a master key encryption key (KEK) that you can rotate.
- **Public-key cryptography** makes signatures possible, which mTLS, SSH and JWTs all depend on.

Each concept is tied to a real NICo mechanism: Flow's encrypted firmware credentials, the SuperNIC lockdown KDF, the Postgres credential store's KEK, and ES256 machine-identity signing keys. All the examples run on a laptop with Python's `cryptography` package and `openssl`. The chapter ends with a build task where you write a small envelope-encrypted credential store, rotate its KEK, derive per-card keys, and sign the result.

**By the end of this chapter you can:**

- Describe the Site Controller's layout: what runs on it, where it runs, how its services talk to each other, and which secrets it holds
- Encrypt and decrypt data with AES-256-GCM, and use additional authenticated data (AAD) to bind context to ciphertext
- Derive stable, independent per-device keys with HKDF-SHA256, and explain why a weak input secret defeats the derivation
- Use SHA-256 for fingerprints and integrity checks, and explain why hashing is not encryption
- Build and rotate an envelope-encryption scheme with key IDs, and say which keys must be retained and backed up
- Generate an ECDSA P-256 key pair, sign and verify data with openssl, and say which key each party needs

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [Site Controller](#site-controller)
2. [AES-GCM symmetric encryption](#aes-gcm-symmetric-encryption)
3. [Key Derivation Function (KDF)](#key-derivation-function)
4. [Cryptographic hashing](#cryptographic-hashing)
5. [Envelope encryption and KEK](#envelope-encryption-and-kek)
6. [Public-key cryptography](#public-key-cryptography)
7. [Build task: Build minivault: an envelope-encrypted credential store with KEK rotation, HKDF and signed snapshots](#build-task)

<a id="site-controller"></a>
## 1. Site Controller

*Builds on: Kubernetes (ch. 14), Microservices architecture (ch. 4)*

### Before you read

- NICo's control plane runs on Kubernetes. What is the minimum number of nodes, and why that number?
- Guess: of all the NICo services, how many are allowed to read from and write to NICo's system database (`nico_system_nico` in PostgreSQL) directly?

<details>
<summary>Answers</summary>

- **NICo's control plane runs on Kubernetes. What is the minimum number of nodes, and why that number?** Three nodes. That is the minimum for high availability: the cluster and its replicated services keep running if one node fails.
- **Guess: of all the NICo services, how many are allowed to read from and write to NICo's system database (`nico_system_nico` in PostgreSQL) directly?** One. Only the API Service (NICo Core) reads and writes that database. Every other service goes through it over mTLS/gRPC.

</details>

### Explanation

The **Site Controller** is NICo's control plane. It is a suite of microservices running on a Kubernetes cluster that sits *inside the datacenter it manages*. The cluster needs **at least three nodes** for high availability. For large GB200-class sites, the docs recommend five nodes or nodes with more cores. Each node is a serious server: two 24+-core x86_64 sockets, 256 GiB RAM minimum, NVMe storage, and a TPM 2.0 with Secure Boot.

The main services:

- **API Service (NICo Core)**: the single source of truth. It runs the state machines and is the *only* service that reads and writes the NICo system database (`nico_system_nico` in PostgreSQL). Flow, NICo's rack orchestration service, keeps its own separate PostgreSQL database for its tasks; it is not the NICo system database.
- **DHCP, PXE, Authoritative DNS, recursive DNS (unbound)**: the boot and network services from chapters 8 and 12.
- **Hardware Health**: scrapes BMCs over Redfish HTTPS.
- **SSH Console Service**: keeps serial-console connections open to host BMCs.
- **Site Agent**: connects the site to **NICo REST** through Temporal. This lets REST run centrally in the cloud while the Site Controller stays on-premises.
- **Admin CLI**: talks directly to the API Service.

All control-plane services talk to each other over **mTLS/gRPC**. Agents on managed hosts call the API Service the same way: Scout runs on the host during discovery, and the DPU Agent polls every 30 seconds.

NICo also depends on off-the-shelf prerequisites, which you met in chapter 17: PostgreSQL, **Vault** (a PKI engine for certificates and a KV store for secrets), **cert-manager** (issues and rotates the mTLS certificates), the **External Secrets Operator** (copies Vault secrets into Kubernetes Secrets), Temporal and MetalLB.

**Scope:** one Site Controller manages one site. Tenancy objects such as VPCs belong to one `siteId`, and nothing is shared between site controllers. To run several sites, you connect each one's Site Agent to a shared NICo REST.

**Why this lesson opens a cryptography chapter:** the Site Controller holds the most sensitive secrets on the site:

- every BMC and UEFI password
- the KEK that protects stored credentials
- the input secret used to derive SuperNIC lockdown keys
- the per-org JWT signing keys
- the TLS private keys of every service

The rest of this chapter covers the tools that protect them.

**Analogy.** The Site Controller is like a building's security office. It has a master records room (the NICo system database) that only the head clerk (API Service) may enter. Everyone else, including the door guards (DHCP, PXE, DNS) and the patrols (Hardware Health), sends requests to the clerk over an authenticated intercom (mTLS/gRPC). Where it breaks down: a real security office is one room. The Site Controller runs replicated across three or more machines precisely so that losing one of them doesn't stop it.

### Worked example: Trace three requests through the Site Controller

**Step 1: Admin lists machines.**

The admin runs Admin CLI → **API Service** over mTLS/gRPC → API Service queries the NICo system database in PostgreSQL. No other service is involved, because only the API Service reads and writes that database.

**Step 2: DPU picks up new network config.**

The DPU Agent on the DPU (ARM OS) polls the **API Service** every 30 s over mTLS/gRPC, gets the desired config, applies it through HBN, and reports observed state back. The DPU Agent runs *on the managed host's DPU*, not in the Site Controller.

**Step 3: Cloud orchestrator provisions an instance.**

The orchestrator calls **NICo REST** over HTTP with a JWT. REST may run centrally in the cloud. It reaches the site through Temporal → **Site Agent** → API Service over mTLS/gRPC.

**Step 4: Look at it on a real cluster (if you have one).**

The reference install runs NICo in the `nico-system` namespace:
```bash
kubectl -n nico-system get pods
kubectl -n nico-system logs deployment/nico-api --tail=20
```
If you have no cluster, sketch the three request paths above on paper instead.

### Your turn: finish it

Fill in the blanks in this request path for Hardware Health reporting a failing fan.

```text
Hardware Health --(Redfish over ___)--> host BMC   # read sensors
Hardware Health --(___)--> API Service             # report the health alert
API Service --> ___                                # persist the alert
```

<details>
<summary>Answer</summary>

Blank 1: HTTPS (Redfish HTTPS). Blank 2: mTLS/gRPC. Blank 3: PostgreSQL (the NICo system database, `nico_system_nico`). Hardware Health never writes the database itself. It reports to the API Service, which is the only service that reads and writes the NICo system database.

</details>

### Your turn: on your own

Your company has two datacenters, East and West. A colleague proposes one Site Controller in East that manages hosts in both. Using what the docs say, explain why this doesn't fit NICo's design, and describe the layout NICo supports instead.

<details>
<summary>Hint 1</summary>

Where does the docs say the Site Controller is located relative to the hardware it manages?

</details>

<details>
<summary>Hint 2</summary>

How many sites does one Site Controller manage, and what scopes a VPC?

</details>

<details>
<summary>Hint 3</summary>

Which component lets several sites share one REST API?

</details>

<details>
<summary>Answer</summary>

The Site Controller is co-located in the datacenter it manages, and one Site Controller manages one site. Tenancy objects such as VPCs are scoped to one siteId and are not shared between controllers. The supported layout is a Site Controller (with three or more nodes) in each of East and West. Each one's Site Agent connects through Temporal to a single, possibly central, NICo REST deployment. A tenant that needs capacity in both sites gets a VPC in each.

</details>

### Explain it

In your own words: Why do you think NICo lets only the API Service read and write the NICo system database, instead of letting every service query it directly? Think about consistency, the state machines, and security.

### Check

**1. Which of these is a prerequisite NICo depends on, rather than a service NICo itself provides in the Site Controller?**

A. API Service (NICo Core)
B. PXE Service
C. Vault
D. Site Agent

<details>
<summary>Answer</summary>

**C.** Vault

Vault is an off-the-shelf prerequisite that provides PKI and KV secrets. The API Service, PXE Service and Site Agent are all NICo-built Site Controller services. Site Agent can be tempting because it connects outward, but it is NICo's own service.

</details>

**2. Where does the DPU Agent run?**

A. On the Site Controller's Kubernetes cluster
B. On the managed host's BlueField DPU
C. Centrally in the cloud next to NICo REST

<details>
<summary>Answer</summary>

**B.** On the managed host's BlueField DPU

The DPU Agent is a persistent daemon on the DPU's ARM OS. It polls the API Service every 30 seconds. It is a managed-host agent, not a Site Controller pod.

</details>

**3. What protocol do the Site Controller's services use to talk to each other?**

A. Plain HTTP with API keys
B. mTLS/gRPC
C. Temporal workflows
D. SSH tunnels

<details>
<summary>Answer</summary>

**B.** mTLS/gRPC

The docs say all NICo control-plane services communicate over mTLS/gRPC. Temporal is not a service-to-service protocol. It is a workflow engine that NICo REST and the Site Agent (and also Flow) use to orchestrate multi-step operations. HTTP with a JWT is how external orchestrators reach NICo REST.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/prerequisites/hardware.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/hardware.md), [getting-started/sizing-and-scale.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/sizing-and-scale.md), [architecture/flow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/flow.md)

<a id="aes-gcm-symmetric-encryption"></a>
## 2. AES-GCM symmetric encryption

### Before you read

- You encrypt a message with a secret key. An attacker can't read it, but flips one bit of the ciphertext. What should a well-designed cipher do when you decrypt?
- What does 'symmetric' mean in 'symmetric encryption'?

<details>
<summary>Answers</summary>

- **You encrypt a message with a secret key. An attacker can't read it, but flips one bit of the ciphertext. What should a well-designed cipher do when you decrypt?** It should detect the change and refuse to decrypt. Authenticated ciphers like AES-GCM do this. Older modes without authentication would quietly hand you corrupted plaintext.
- **What does 'symmetric' mean in 'symmetric encryption'?** The same secret key is used to encrypt and to decrypt.

</details>

### Explanation

**Symmetric encryption** uses one shared secret key for both directions. **AES** (Advanced Encryption Standard) is the standard symmetric cipher. A **256-bit key** is 32 random bytes; `openssl rand -base64 32` prints one in base64, as the NICo Day 0 guides do.

AES on its own encrypts 16-byte blocks. A *mode* says how to handle messages of any length. **GCM** (Galois/Counter Mode) is an **authenticated encryption** mode. One operation gives you both:

- **Confidentiality**: without the key, the ciphertext reveals nothing about the plaintext except its length.
- **Integrity and authenticity**: GCM appends a 16-byte **authentication tag**. If any byte of the ciphertext, the tag, the nonce or the AAD changes, decryption fails outright. You never get garbled plaintext back.

Each encryption takes three inputs besides the plaintext:

1. **Key**: secret, 32 bytes.
2. **Nonce** ("number used once"): 12 bytes. It doesn't have to be secret, but it **must never repeat with the same key**. Reusing one breaks both confidentiality and integrity. Use a fresh random nonce each time and store it next to the ciphertext.
3. **AAD** (additional authenticated data): context that is *not encrypted* but *is authenticated*. Decryption succeeds only if you pass exactly the same AAD. Use it to bind ciphertext to a purpose, version or owner.

**In NICo:** Flow encrypts firmware authentication data with AES-GCM before persisting it to its database or to Temporal. The key is a base64-encoded 32-byte key read from `FLOW_DATA_ENCRYPTION_KEY_PATH`. Flow's AAD provides *domain separation* (this ciphertext is firmware auth data and nothing else) and authenticates the envelope version and key ID. The docs say plainly what the AAD does not cover: it doesn't bind an envelope to a particular database row. A whole envelope could be copied to another row, so database controls have to prevent that. If the key path is unset, requests that carry firmware authentication data fail with `FailedPrecondition` instead of being stored unencrypted.

**Analogy.** AES-GCM is like a locked box with a tamper-evident seal. The key opens the box (confidentiality). The seal (the tag) shows if anyone pried at it (integrity). The AAD is a label glued to the outside: anyone can read it, but the seal covers it, so swapping the label breaks the seal. Where it breaks down: you can reuse a physical lock forever, but a GCM nonce must never be reused with the same key.

### Worked example: Encrypt, tamper and mismatch with AES-256-GCM

**Step 1: Install the library.**

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install cryptography
```

**Step 2: Write the demo.**

Save as `gcm_demo.py`:
```python
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.exceptions import InvalidTag

key = AESGCM.generate_key(bit_length=256)   # 32 random bytes
aes = AESGCM(key)
nonce = os.urandom(12)                      # fresh for every encryption
aad = b"firmware-auth:v1"                   # context, not secret

ct = aes.encrypt(nonce, b"s3cret-token", aad)
print("ciphertext+tag bytes:", len(ct))     # 12 plaintext + 16 tag = 28
print("decrypted:", aes.decrypt(nonce, ct, aad))

bad = bytearray(ct)
bad[0] ^= 1                                 # flip one bit
try:
    aes.decrypt(nonce, bytes(bad), aad)
except InvalidTag:
    print("tampered ciphertext rejected")

try:
    aes.decrypt(nonce, ct, b"other-domain:v1")
except InvalidTag:
    print("wrong AAD rejected")
```

**Step 3: Run and read the output.**

`python3 gcm_demo.py` prints `28`, then `b's3cret-token'`, then both rejection lines. Flipping a single bit or changing the AAD makes decryption fail completely.

**Step 4: Use a key from a file, as NICo does.**

```bash
openssl rand -base64 32 > flow.key
python3 -c 'import base64; print(len(base64.b64decode(open("flow.key").read())))'   # 32
```
Flow reads a base64-encoded 32-byte key file like this one through `FLOW_DATA_ENCRYPTION_KEY_PATH`.

### Your turn: finish it

Complete the script so it encrypts a password bound to a domain label and then decrypts it successfully.

```text
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

key = AESGCM.generate_key(bit_length=256)
aes = AESGCM(key)
context = b"flow:firmware-auth:v1"
nonce = ___
ct = aes.encrypt(nonce, b"bmc-password", context)
print(aes.decrypt(nonce, ct, ___))
```

<details>
<summary>Answer</summary>

`nonce = os.urandom(12)` and `print(aes.decrypt(nonce, ct, context))`. The nonce must be a fresh 12-byte value, and decryption must get exactly the same AAD used for encryption.

</details>

### Your turn: on your own

Flow's docs say its AAD authenticates the envelope version and key ID but does not bind an envelope to a particular database row. Describe an attack that this leaves open, and change the AAD design to stop it in your own toy store. Write a Python snippet that shows the copied envelope failing to decrypt.

<details>
<summary>Hint 1</summary>

The attacker can't read or change ciphertext, but suppose they can write to the database. What if they copy a whole valid envelope from one row into another?

</details>

<details>
<summary>Hint 2</summary>

Decryption succeeds whenever key, nonce, ciphertext and AAD all match. Which of those depends on the row?

</details>

<details>
<summary>Hint 3</summary>

Put the row's identity, such as `task_id`, into the AAD. Decrypting a copied envelope under a different row ID then raises InvalidTag.

</details>

<details>
<summary>Answer</summary>

Attack: replay or relocation. An attacker with write access to the database copies a valid envelope, for example rack A's firmware credentials, into another row (rack B's task). It decrypts cleanly because nothing in the AAD names the row. Fix: include the row identity in the AAD, e.g. `aad = f"firmware-auth:v1:task:{task_id}".encode()`. Demo: `ct = aes.encrypt(n, b"pw", b"firmware-auth:v1:task:A")`; then `aes.decrypt(n, ct, b"firmware-auth:v1:task:B")` raises InvalidTag. The trade-off is that you can no longer move ciphertext between rows on purpose without re-encrypting it.

</details>

### Explain it

In your own words: Why is it better for decryption to fail completely on tampering than to return slightly corrupted plaintext? Think about a BMC password or a firmware token that gets used automatically.

### Check

**1. What does AAD give you in AES-GCM?**

A. It is encrypted together with the plaintext so it stays hidden
B. It is authenticated but not encrypted, so decryption fails if it differs
C. It replaces the need for a nonce
D. It doubles the effective key length

<details>
<summary>Answer</summary>

**B.** It is authenticated but not encrypted, so decryption fails if it differs

AAD stays readable but is covered by the tag. A common misconception is that it gets hidden; it doesn't. It also has nothing to do with nonces or key length.

</details>

**2. Flow starts with FLOW_DATA_ENCRYPTION_KEY_PATH unset, and a request arrives with non-empty authentication_data. What happens?**

A. Flow stores it in plaintext and logs a warning
B. Flow fails the request with FailedPrecondition before persisting it
C. Flow crashes at startup
D. Flow generates a random key and continues

<details>
<summary>Answer</summary>

**B.** Flow fails the request with FailedPrecondition before persisting it

With the variable unset, Flow starts with a warning and serves operations that carry no firmware auth data. Requests that do carry it are rejected. Flow fails at startup only if the variable is set but the key file is unreadable or invalid.

</details>

**3. Two messages are encrypted with the same AES-GCM key and the same nonce. Why is that a problem?**

A. It isn't a problem; nonces are public
B. It breaks confidentiality and integrity for those messages
C. It only makes ciphertexts slightly longer

<details>
<summary>Answer</summary>

**B.** It breaks confidentiality and integrity for those messages

Nonces are public, but they must be unique for each key. Reusing one leaks the relationship between the plaintexts and lets an attacker forge tags.

</details>

**Sources:** [architecture/flow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/flow.md), [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md)

<a id="key-derivation-function"></a>
## 3. Key Derivation Function (KDF)

### Before you read

- You need a different secret key for each of 10,000 network cards, but you can store only one secret. How could that work?
- If your one secret is 'password123', does running it through a strong KDF make the derived keys strong?

<details>
<summary>Answers</summary>

- **You need a different secret key for each of 10,000 network cards, but you can store only one secret. How could that work?** Derive each card's key from the one stored secret plus non-secret, card-specific context such as its MAC address and host ID. A key derivation function produces the same key every time for the same inputs.
- **If your one secret is 'password123', does running it through a strong KDF make the derived keys strong?** No. A KDF like HKDF adds no entropy. An attacker can guess the weak secret offline and check each guess against a leaked derived key.

</details>

### Explanation

A **key derivation function (KDF)** is a deterministic function:

```
key = KDF(secret input material, context) 
```

- **Deterministic**: the same inputs always give the same key, so you can recompute it instead of storing it.
- **Independent**: different contexts give keys that look unrelated. Knowing one derived key tells you nothing about another.
- **One-way**: you can't feasibly recover the secret input from a derived key, *as long as that input is high-entropy*.

**HKDF** (RFC 5869) is the standard KDF built on HMAC. Its inputs:

- **IKM** (input key material): the secret.
- **Salt**: optional; NICo uses none.
- **Info**: the context string. Different info values give independent keys. Putting a label and a version in it is called **domain separation**.
- **Length**: how many output bytes you want.

**In NICo:** SuperNICs in non-ASTRA setups (BF3 in NIC mode, ConnectX-8) are locked with a 64-bit key. If NICo loses that key, the card is effectively bricked. NICo doesn't store per-card keys at all. NICo Core derives each one with **HKDF-SHA256**:

- IKM = the versioned site-wide lockdown IKM from the credential store
- salt = none
- info = `supernic-lock:v1:{mac_address}:{machine_id}`
- output = 8 bytes, shown as 16 hex characters

Derived keys exist only in memory during lock and unlock. They are never written to disk or the database. The MAC address and MachineId are not secret; leaking them is not a security event. All the security rests on the IKM being **secret, random and high-entropy**. The docs warn that HKDF "neither adds entropy nor slows password guessing". Chapter 19 covers that offline-guessing risk in detail.

Because the derivation is deterministic, you can re-derive a key only while you still have the *exact* IKM version, the MachineId and the MAC. If any of them is lost, so is the key.

**Analogy.** A KDF is like a master locksmith who can cut a unique key for any apartment from a sealed master blank and the apartment number. The apartment numbers are public. Without the master blank, knowing them gets you nowhere. Where it breaks down: a physical master key opens every door directly. A derived key opens only its own door, and holding one derived key doesn't let you work back to the master.

### Worked example: Derive SuperNIC-style lockdown keys with HKDF-SHA256

**Step 1: Create a high-entropy IKM.**

```bash
openssl rand -hex 32 > ikm.hex   # 256 random bits, demo only
```

**Step 2: Write the derivation.**

Save as `kdf_demo.py` and use the same venv as before:
```python
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

ikm = bytes.fromhex(open("ikm.hex").read().strip())

def lockdown_key(mac, machine_id):
    info = f"supernic-lock:v1:{mac}:{machine_id}".encode()
    hkdf = HKDF(algorithm=hashes.SHA256(), length=8, salt=None, info=info)
    return hkdf.derive(ikm).hex()   # 8 bytes -> 16 hex chars

m = "fm100hsdhjkfasjkdhaskjdhasd"
print(lockdown_key("00:11:22:33:44:56", m))
print(lockdown_key("00:11:22:33:44:56", m))   # same as line 1
print(lockdown_key("00:11:22:33:44:57", m))   # one MAC digit differs
print(lockdown_key("00:11:22:33:44:56", "other-machine"))
```
This follows the info format from the docs. NICo's internal encoding of the IKM bytes isn't documented, so your values won't match a real site.

**Step 3: Check determinism.**

Run `python3 kdf_demo.py` twice. Lines 1 and 2 match each other and match across runs. This is what lets NICo re-derive a key to unlock a card later.

**Step 4: Check independence.**

Lines 3 and 4 look completely unrelated to line 1, even though only one character of context changed. A compromised card exposes only its own key.

**Step 5: See why the IKM matters.**

Replace the contents of `ikm.hex` with a new random value and rerun. Every key changes. This is why the docs warn: **do not replace an IKM version that cards still use**. Cards locked under the old value could no longer be unlocked.

### Your turn: finish it

Fill in the blanks so the function produces NICo's documented 64-bit lockdown key with the V1 info format.

```text
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

def lockdown_key(ikm, mac, machine_id):
    info = f"___".encode()
    hkdf = HKDF(algorithm=hashes.SHA256(), length=___, salt=None, info=info)
    return hkdf.derive(ikm).hex()
```

<details>
<summary>Answer</summary>

`info = f"supernic-lock:v1:{mac}:{machine_id}".encode()` and `length=8`. 64 bits is 8 bytes, which `.hex()` turns into 16 hex characters.

</details>

### Your turn: on your own

A card was locked using lockdown IKM version 0. An operator runs a credential rotation that creates version 1 and sets it as the site target. `nic_lockdown_ikm_rotation_enabled` is still false, and the operator deletes version 0 from the credential store to tidy up. Later the host is decommissioned and NICo must unlock the card. What happens, and what should the operator have done?

<details>
<summary>Hint 1</summary>

For unlock requests, which IKM version does NICo Core pick: the site target, or something tracked per card?

</details>

<details>
<summary>Hint 2</summary>

The docs say unlock uses rotating_to_version, then current_version, then version 0. With rotation disabled, has this card migrated?

</details>

<details>
<summary>Hint 3</summary>

The docs also say a missing credential fails lookup rather than falling back to another secret. Without v0, can the key be re-derived?

</details>

<details>
<summary>Answer</summary>

Rotation was disabled and not forced, so the card never migrated. Its tracked current_version is still 0, and the unlock uses version 0. That credential is gone, and lookup fails instead of falling back to version 1. Deriving with v1 would give a different key anyway. The key can't be re-derived, and a lost lockdown key leaves the card effectively bricked. The operator should keep every IKM version still referenced by cards or saved firmware operations, and back them up along with the NICo Core database, which holds the MachineIds, MACs and tracked versions. Check convergence with `nico-admin-cli credential rotation-status` before retiring anything.

</details>

### Explain it

In your own words: Why do you think NICo derives each lockdown key on demand instead of generating a random key for each card and storing it in the database? What does NICo gain, and what new risk does it accept?

### Check

**1. An attacker learns every SuperNIC's MAC address and host MachineId. What can they derive?**

A. Every lockdown key, because the HKDF algorithm is public
B. Nothing useful, unless they also have the secret lockdown IKM
C. The IKM itself, by inverting HKDF

<details>
<summary>Answer</summary>

**B.** Nothing useful, unless they also have the secret lockdown IKM

The context values are not secret, and the docs say their leak is not a security event on its own. The algorithm being public doesn't help either. Inverting HKDF to recover a high-entropy IKM is computationally impractical.

</details>

**2. The lockdown IKM is a short, human-chosen password. One derived card key leaks. What is the risk?**

A. None; HKDF stretches weak secrets into strong ones
B. An attacker can guess IKM candidates offline and check each one against the leaked key and its known context
C. Only that single card is affected

<details>
<summary>Answer</summary>

**B.** An attacker can guess IKM candidates offline and check each one against the leaked key and its known context

HKDF adds no entropy and doesn't slow guessing. Once the attacker guesses the IKM, they can derive every card's key, not just the leaked one.

</details>

**3. Where do derived lockdown keys live in NICo?**

A. In the credential store next to the IKM
B. In the NICo Core database, encrypted
C. Only in memory during lock and unlock operations

<details>
<summary>Answer</summary>

**C.** Only in memory during lock and unlock operations

The docs say derived keys are never written to disk or the database, and are absent from persisted operations and reports. What is persisted is the IKM (in the credential store) and the context and versions (in the database).

</details>

**Sources:** [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

<a id="cryptographic-hashing"></a>
## 4. Cryptographic hashing

### Before you read

- Given only the SHA-256 hash of some data, can you compute the original data?
- How long is the SHA-256 output for a 1-byte input, and for a 1 GB file?

<details>
<summary>Answers</summary>

- **Given only the SHA-256 hash of some data, can you compute the original data?** Not directly. Hashes are one-way. If the input could only be one of a few likely values, though, you can hash each guess and compare.
- **How long is the SHA-256 output for a 1-byte input, and for a 1 GB file?** The same: 256 bits, shown as 64 hex characters. The output is fixed-size whatever the input length.

</details>

### Explanation

A **cryptographic hash function** maps any input to a fixed-size **digest**. SHA-256 always gives 32 bytes, or 64 hex characters. A good one has these properties:

- **Deterministic**: the same input always gives the same digest.
- **Preimage resistant**: given a digest, you can't feasibly find an input that produces it.
- **Collision resistant**: you can't feasibly find two different inputs with the same digest.
- **Avalanche effect**: changing one bit of input changes about half the output bits.

Hashing is **not encryption**. There is no key and no way to decrypt. Anyone can compute a hash, so hashing a *guessable* input hides nothing: an attacker hashes candidates until one matches.

Common uses:

- **Integrity checks.** Compare a file's digest to a published one. Container images are identified by `sha256:` digests (ch. 13).
- **Fingerprints.** A short public identifier for a long secret.
- **Building blocks.** HMAC and HKDF (the previous lesson) are built from SHA-256. Digital signatures (the next lesson) sign a hash of the message, not the message itself.

**In NICo:** Flow's ciphertext envelope version 1 records the **non-secret SHA-256 fingerprint** of the encryption key. If Flow is restarted with a different key, it notices the fingerprint mismatch and fails explicitly instead of producing confusing decryption errors. Storing that fingerprint is safe because the key is 256 random bits: there's no feasible way to work back from the fingerprint to the key, and guessing is hopeless.

Hashing alone is the wrong tool for credentials NICo has to *use*. NICo logs into BMCs with the real password, so it needs reversible encryption (AES-GCM) to get the password back. Hashing fits when you only need to *check* a value. Storing user passwords, which needs a slow, salted hash, comes up in chapter 19.

**Analogy.** A hash is like a fingerprint. It identifies a person compactly, the same finger always gives the same print, and you can't rebuild the person from it. Where it breaks down: if a suspect list has only ten people, you can fingerprint all ten and find the match. Hashes of guessable inputs leak those inputs in the same way.

### Worked example: Hash, compare and fingerprint a key

**Step 1: Hash a string.**

```bash
printf 'nico' | sha256sum        # macOS: printf 'nico' | shasum -a 256
printf 'nicO' | sha256sum        # one letter changed: completely different digest
```

**Step 2: Watch out for hidden bytes.**

```bash
echo 'nico' | sha256sum          # differs from printf: echo adds a newline
```
A hash covers *exact bytes*. Most "my hashes don't match" bugs come from a trailing newline or different whitespace.

**Step 3: Fingerprint an encryption key.**

```bash
openssl rand -base64 32 > flow.key
python3 -c 'import base64,hashlib; k=base64.b64decode(open("flow.key").read()); print(hashlib.sha256(k).hexdigest())' > flow.key.fp
cat flow.key.fp
```
This shows the idea behind Flow's key fingerprint. Exactly which bytes Flow hashes isn't documented.

**Step 4: Detect a key swap.**

Generate a second key with `openssl rand -base64 32 > other.key` and hash it the same way. The digest differs from `flow.key.fp`, so a program can say "wrong key" before it even tries to decrypt.

### Your turn: finish it

Complete this startup check, which refuses to run if the loaded key doesn't match the stored fingerprint.

```text
import base64, hashlib

stored_fp = open("flow.key.fp").read().strip()
key = base64.b64decode(open("flow.key").read())
if hashlib.___(key).hexdigest() != stored_fp:
    raise SystemExit("wrong key: fingerprint mismatch")
print("key matches fingerprint")
```

<details>
<summary>Answer</summary>

`hashlib.sha256(key).hexdigest()`. Use the same algorithm and the same input bytes (the decoded key, not the base64 text) that produced the stored fingerprint.

</details>

### Your turn: on your own

Storing the SHA-256 fingerprint of a 256-bit random key next to the ciphertext is safe. A colleague proposes doing the same for a 6-digit numeric PIN that unlocks a device. Explain the difference and show it concretely with a few lines of Python.

<details>
<summary>Hint 1</summary>

Preimage resistance stops you from inverting the hash. Does it stop you from trying every possible input?

</details>

<details>
<summary>Hint 2</summary>

How many possible 6-digit PINs are there, compared with 2^256 keys?

</details>

<details>
<summary>Hint 3</summary>

Loop over range(1_000_000), hash each zero-padded PIN, and compare it to the target digest.

</details>

<details>
<summary>Answer</summary>

A 6-digit PIN has only 10^6 possible values, so an attacker simply hashes all of them. A 256-bit key has 2^256, far beyond any search. Demo: `target = hashlib.sha256(b"042917").hexdigest()`; then `next(p for p in (f"{i:06d}" for i in range(10**6)) if hashlib.sha256(p.encode()).hexdigest() == target)` finds the PIN in about a second. A fingerprint is safe only when the input is high-entropy.

</details>

### Explain it

In your own words: Why does it make sense for Flow to store a hash of its key rather than the key ID alone? What failure does the fingerprint catch that a name like 'kv1' would miss?

### Check

**1. A colleague suggests storing BMC passwords as sha256(password) in the credential store, so they are 'encrypted'. What is the main problem for NICo?**

A. SHA-256 output is too long to fit in a database column
B. NICo needs the real password to log into the BMC, and a hash can't be reversed; guessable passwords also leak
C. SHA-256 is broken, so the passwords are exposed immediately

<details>
<summary>Answer</summary>

**B.** NICo needs the real password to log into the BMC, and a hash can't be reversed; guessable passwords also leak

Hashing is one-way, so NICo could never recover the password to send to the BMC. NICo needs reversible authenticated encryption. SHA-256 itself is not broken, and the digest fits easily in a column.

</details>

**2. Two files have identical SHA-256 digests. What is the reasonable conclusion?**

A. The files are almost certainly identical
B. The files are the same size but may differ
C. Nothing; collisions are common

<details>
<summary>Answer</summary>

**A.** The files are almost certainly identical

Collision resistance means finding two different inputs with the same SHA-256 digest is infeasible. That's why digests work as integrity checks. Size has nothing to do with it.

</details>

**3. Is the SHA-256 fingerprint of Flow's encryption key secret?**

A. Yes; anyone who has it can decrypt Flow's data
B. No; it identifies the key but can't feasibly be turned back into a random 256-bit key

<details>
<summary>Answer</summary>

**B.** No; it identifies the key but can't feasibly be turned back into a random 256-bit key

The docs call it a non-secret fingerprint. Preimage resistance, together with the key's high entropy, makes storing it next to the ciphertext safe.

</details>

**Sources:** [architecture/flow.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/flow.md)

<a id="envelope-encryption-and-kek"></a>
## 5. Envelope encryption and KEK

*Builds on: AES-GCM symmetric encryption (ch. 18)*

### Before you read

- You encrypted 100,000 credentials directly with one master key, and now you must rotate that key. How much data do you have to re-encrypt?
- Guess: with NICo's Postgres credential store and the Integrated provider, where is the master key kept?

<details>
<summary>Answers</summary>

- **You encrypted 100,000 credentials directly with one master key, and now you must rotate that key. How much data do you have to re-encrypt?** All 100,000 credentials. Envelope encryption cuts this down: you re-encrypt only the small per-credential data keys, and the credential ciphertexts stay as they are.
- **Guess: with NICo's Postgres credential store and the Integrated provider, where is the master key kept?** In a Kubernetes Secret (for example `nico-secrets-kek`) in the namespace where nico-api runs. It is exposed to nico-api as an environment variable or a mounted file.

</details>

### Explanation

**Envelope encryption** uses two layers of keys:

1. For each item, generate a random **data encryption key (DEK)** and encrypt the item with it, using AES-GCM.
2. Encrypt (**wrap**) the DEK with a master **key encryption key (KEK)**.
3. Store the ciphertext, the wrapped DEK and the **KEK ID** together. Throw away the plaintext DEK.

To read, use the stored KEK ID to find the KEK, unwrap the DEK, then decrypt the item.

Why bother with two layers?

- **Cheap rotation.** To retire a KEK, unwrap each DEK with the old KEK and re-wrap it with the new one. The bulk data is never touched.
- **Small protected surface.** The KEK is the one secret you must guard and back up. It can live in a KMS such as Vault Transit or a KMIP server, which does the wrap and unwrap itself so the KEK never enters your process.
- **Key ID = traceability.** Every record says which KEK it needs, so several KEKs can coexist during a rotation.

**In NICo:** the Postgres credential store keeps BMC, UEFI and switch credentials *encrypted per credential*. The KEK wraps the per-credential data keys and is "the only material an operator must protect". With the Integrated provider, you put a 256-bit key in a Kubernetes Secret. The Secret's key name, e.g. `site-kek-1`, is the `kek_id`. It appears in the `[secrets]` config and **on every stored row**. At startup, nico-api checks that the key decodes to 32 bytes and that the routing has a `"/"` catch-all. Losing the Integrated KEK loses every stored credential, and a database dump is unreadable without every KEK its rows reference, so back the KEK up offline.

**Machine identity** uses the same key-ID and rotation discipline, though the docs don't describe its internal layout as a data-key layer like the credential store's. Per-org JWT signing private keys are encrypted at rest under a site master encryption key (KEK). The site keeps these keys under IDs like `kv1`, and `current_encryption_key_id` selects the one used for new encryptions. Each encrypted blob carries the `key_id` it was encrypted under, and decryption always uses that embedded ID, not the current one. So you must keep every old key ID until a KEK re-wrap is complete.

**Analogy.** It's like a hotel. Each room has its own key (the DEK), and all the room keys sit in a locked key cabinet (wrapped by the KEK). To change the master cabinet lock you re-lock one cabinet, not every room door. Where it breaks down: in a hotel the room keys stay in one cabinet. In envelope encryption, each wrapped DEK is stored right next to its own ciphertext, and each one is labelled with the ID of the KEK that wrapped it.

### Worked example: Seal, rotate and unseal with a two-key keyring

**Step 1: Define seal (encrypt + wrap).**

Save as `envelope_demo.py`:
```python
import os, json, base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

b64 = lambda b: base64.b64encode(b).decode()
unb64 = base64.b64decode
keyring = {"kv1": AESGCM.generate_key(bit_length=256)}

def seal(plaintext, kek_id):
    dek = AESGCM.generate_key(bit_length=256)
    n1, n2 = os.urandom(12), os.urandom(12)
    return {"kek_id": kek_id,
            "wrapped_dek": b64(n1 + AESGCM(keyring[kek_id]).encrypt(n1, dek, kek_id.encode())),
            "ciphertext": b64(n2 + AESGCM(dek).encrypt(n2, plaintext, None))}
```
Each blob stores its nonce in the first 12 bytes. The KEK ID is used as AAD, so a wrapped DEK can't be relabelled with a different key ID.

**Step 2: Define unwrap, unseal and rewrap.**

Append:
```python
def unwrap(rec):
    blob = unb64(rec["wrapped_dek"])
    return AESGCM(keyring[rec["kek_id"]]).decrypt(blob[:12], blob[12:], rec["kek_id"].encode())

def unseal(rec):
    blob = unb64(rec["ciphertext"])
    return AESGCM(unwrap(rec)).decrypt(blob[:12], blob[12:], None)

def rewrap(rec, new_id):
    dek = unwrap(rec)
    n = os.urandom(12)
    return {**rec, "kek_id": new_id,
            "wrapped_dek": b64(n + AESGCM(keyring[new_id]).encrypt(n, dek, new_id.encode()))}
```

**Step 3: Seal a credential and inspect the record.**

Append:
```python
rec = seal(b"bmc-root-password", "kv1")
print(json.dumps(rec, indent=2))
```
The record holds a key ID, a wrapped DEK and ciphertext. Nothing in it is readable without the KEK.

**Step 4: Rotate the KEK and delete the old one.**

Append:
```python
old_ct = rec["ciphertext"]
keyring["kv2"] = AESGCM.generate_key(bit_length=256)
rec = rewrap(rec, "kv2")
print("ciphertext unchanged:", rec["ciphertext"] == old_ct)
del keyring["kv1"]
print(unseal(rec))
```
Run `python3 envelope_demo.py`. It prints `ciphertext unchanged: True`, then `b'bmc-root-password'`. Only the wrapped DEK changed, and the old KEK could be deleted only after the re-wrap.

### Your turn: finish it

These are the read-path functions from envelope_demo.py with parts missing. Fill them in.

```text
def unwrap(rec):
    blob = unb64(rec["wrapped_dek"])
    kek = keyring[rec[___]]
    return AESGCM(kek).decrypt(blob[:12], blob[12:], rec["kek_id"].encode())

def unseal(rec):
    blob = unb64(rec["ciphertext"])
    return AESGCM(___).decrypt(blob[:12], blob[12:], None)
```

<details>
<summary>Answer</summary>

`kek = keyring[rec["kek_id"]]`, because the KEK is chosen by the ID stored in the record, not by whichever key is current. And `AESGCM(unwrap(rec))`, because the data is decrypted with the unwrapped DEK, not the KEK.

</details>

### Your turn: on your own

Your site has machine identity enabled with `current_encryption_key_id = "kv1"`. You add kv2 to `machine_identity.encryption_keys`, change `current_encryption_key_id` to "kv2", remove kv1 from the secrets in the same change, and restart nico-api. Which per-org data is now at risk, and why? What is the safe order of operations, at the level of principles?

<details>
<summary>Hint 1</summary>

Which key does decryption use: the site's current key ID, or something stored with each blob?

</details>

<details>
<summary>Hint 2</summary>

Per-org signing private keys encrypted before the change still carry key_id kv1.

</details>

<details>
<summary>Hint 3</summary>

The docs say to keep all key IDs that appear in stored ciphertext until a KEK re-wrap is complete.

</details>

<details>
<summary>Answer</summary>

Every per-org JWT signing private key encrypted before the change still has key_id kv1 embedded in it, and decryption uses that embedded ID, not current_encryption_key_id. With kv1 removed, those keys can't be decrypted, so those orgs can't sign tokens. Safe order: (1) add kv2 while keeping kv1; (2) switch current_encryption_key_id to kv2 so new writes use kv2; (3) re-wrap the existing blobs to kv2 following the Master Encryption Key Rotation runbook; (4) remove kv1 only after nothing references it, and keep backups until you are sure.

</details>

### Explain it

In your own words: Why does keeping a key ID on every encrypted row make zero-downtime KEK rotation possible? What would rotation look like if rows didn't record which key encrypted them?

### Check

**1. During a KEK rotation in envelope encryption, what gets re-encrypted?**

A. Every credential's ciphertext
B. Only the wrapped data keys (DEKs)
C. Nothing; the new KEK can decrypt old data automatically

<details>
<summary>Answer</summary>

**B.** Only the wrapped data keys (DEKs)

Re-wrapping unwraps each small DEK with the old KEK and wraps it with the new one. The bulk ciphertext stays as it is. A new KEK can't decrypt anything wrapped under the old one.

</details>

**2. You take a database dump of a site that uses the Postgres credential store. What else must you keep to be able to read the credentials later?**

A. Nothing; the dump is self-contained
B. Every KEK that the dumped rows reference
C. Only the newest KEK

<details>
<summary>Answer</summary>

**B.** Every KEK that the dumped rows reference

The docs say a dump is unreadable without every KEK its rows reference. Rows still wrapped under an older KEK need that KEK, so keeping only the newest one isn't enough.

</details>

**3. At startup, nico-api validates the [secrets] section. Which of these causes a boot failure?**

A. The KEK decodes to 16 bytes instead of 32
B. The KEK Secret is named nico-secrets-kek
C. There is a "/" entry in [secrets.routing]

<details>
<summary>Answer</summary>

**A.** The KEK decodes to 16 bytes instead of 32

The key must decode to 32 bytes (256 bits). The Secret name is your choice, and the "/" catch-all is required, not forbidden.

</details>

**Sources:** [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md), [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md), [architecture/supernic_lockdown_key_management.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/supernic_lockdown_key_management.md)

<a id="public-key-cryptography"></a>
## 6. Public-key cryptography

*Builds on: Cryptographic hashing (ch. 18)*

### Before you read

- Can you publish one of your keys to the whole internet and still be secure?
- To prove a message came from you, which key do you use, and which key does the receiver use?

<details>
<summary>Answers</summary>

- **Can you publish one of your keys to the whole internet and still be secure?** Yes, with public-key cryptography. The public key can be shared freely. Only the matching private key must stay secret.
- **To prove a message came from you, which key do you use, and which key does the receiver use?** You sign with your private key. The receiver verifies with your public key.

</details>

### Explanation

Everything so far has been **symmetric**: both sides share the same secret. That raises a problem: how do two parties get a shared secret in the first place, and how can thousands of verifiers check something without each holding a secret that would let them forge it?

**Public-key (asymmetric) cryptography** uses a **key pair**:

- a **private key**, kept secret by its owner
- a **public key**, derived from the private key and safe to publish

Working backwards from the public key to the private key is computationally infeasible. The pair supports two operations:

1. **Digital signatures.** The owner hashes the message (see the hashing lesson) and signs the digest with the **private** key. Anyone with the **public** key can verify that this key signed exactly this message. One changed byte gives a different hash, and verification fails. Signatures provide authenticity and integrity, **not** confidentiality: the message stays readable.
2. **Encryption and key agreement.** Anyone can encrypt to the public key, and only the private-key holder can decrypt. In practice this is used to agree on or send a symmetric key, which then does the bulk encryption with AES-GCM. TLS works this way.

Common algorithms are RSA, ECDSA and Ed25519. **ES256** means ECDSA on the P-256 curve with SHA-256.

**In NICo:**

- All Site Controller services talk over **mTLS**. Each side proves it holds the private key that matches its certificate. cert-manager and Vault PKI issue those certificates; chapter 19 covers PKI.
- **Machine identity** signs short-lived JWT-SVIDs with per-org signing keys. `ES256` is the only supported algorithm. The private keys are encrypted at rest with the KEK (previous lesson). Verifiers only need the public keys, which can be published.
- **SSH key groups** hold tenants' *public* SSH keys, which grant access to the SSH console.

There is one gap: a public key doesn't say who owns it. Certificates solve this in chapter 19.

**Analogy.** A key pair is like a wax seal and the public's knowledge of what your seal looks like. Only you own the signet ring (the private key), but anyone can compare a seal against the known pattern (the public key). Where it breaks down: a wax seal looks the same on every letter, so it could be lifted and copied. A digital signature is computed from the exact message, so it can't be moved to a different one.

### Worked example: Sign and verify with an ES256-style key pair

**Step 1: Generate a P-256 key pair.**

```bash
openssl ecparam -name prime256v1 -genkey -noout -out priv.pem
openssl ec -in priv.pem -pubout -out pub.pem
cat pub.pem    # safe to share
```
`prime256v1` is P-256, the curve ES256 uses. These commands work with both OpenSSL and macOS LibreSSL.

**Step 2: Sign a message.**

```bash
printf 'sub=spiffe://example.org/machine/abc;exp=1767225600' > token.txt
openssl dgst -sha256 -sign priv.pem -out token.sig token.txt
```
This hashes the file with SHA-256 and signs the digest with the private key.

**Step 3: Verify with only the public key.**

```bash
openssl dgst -sha256 -verify pub.pem -signature token.sig token.txt
# Verified OK
```

**Step 4: Tamper and re-verify.**

```bash
printf 'sub=spiffe://example.org/machine/EVIL;exp=1767225600' > token.txt
openssl dgst -sha256 -verify pub.pem -signature token.sig token.txt
# Verification failure
```
The changed message has a different hash, so the old signature no longer verifies. Only the private-key holder could make a valid signature for the new message.

### Your turn: finish it

Fill in the key file each command needs.

```text
openssl dgst -sha256 -sign ___ -out msg.sig msg.txt
openssl dgst -sha256 -verify ___ -signature msg.sig msg.txt
```

<details>
<summary>Answer</summary>

`-sign priv.pem` (signing needs the private key) and `-verify pub.pem` (verifying needs only the public key).

</details>

### Your turn: on your own

A tenant runs a service that receives JWT-SVIDs that NICo signed for its machines. (a) Which key does the tenant's service need to verify them, and is that key secret? (b) Why does NICo encrypt the per-org signing private keys at rest with the KEK, but has no need to hide the public keys? (c) If an attacker stole one org's decrypted private signing key, what could they do?

<details>
<summary>Hint 1</summary>

Verifying a signature uses the other half of the pair.

</details>

<details>
<summary>Hint 2</summary>

Think about what each half of the pair lets its holder do.

</details>

<details>
<summary>Hint 3</summary>

Signing is the operation only the private key allows. What would an attacker sign?

</details>

<details>
<summary>Answer</summary>

(a) The org's public signing key, which is not secret. It is typically published, for example as JWKS (Day 1 covers JWKS/OIDC verification). (b) The private key lets its holder create valid tokens, so it must be confidential; at rest it is encrypted under the site KEK. The public key only lets you check tokens, so publishing it gives nothing away. (c) They could forge JWT-SVIDs that claim any SPIFFE ID in that org, and verifiers would accept them until the signing key is rotated (see the JWT Signing Key Rotation runbook). Other orgs, which have their own keys, would be unaffected.

</details>

### Explain it

In your own words: Why does a signature sign a SHA-256 hash of the message instead of the raw message? Connect this to the properties of hashing from earlier in the chapter.

### Check

**1. A verifier wants to check a NICo-issued ES256 token. What does it need?**

A. The org's private signing key
B. The site KEK
C. The org's public signing key

<details>
<summary>Answer</summary>

**C.** The org's public signing key

Verification uses the public key. Handing out the private key would let every verifier forge tokens. The KEK only protects the private keys at rest and plays no part in verification.

</details>

**2. What does a valid digital signature on a message NOT give you?**

A. Confidence that the holder of the private key signed it
B. Confidence that the message wasn't altered
C. Confidentiality of the message contents

<details>
<summary>Answer</summary>

**C.** Confidentiality of the message contents

Signatures give authenticity and integrity, but anyone can still read the message. For confidentiality you also need encryption, for example TLS or AES-GCM.

</details>

**3. NICo key groups store tenants' SSH keys for console access. Which half of each key pair does NICo need to store?**

A. The public key
B. The private key
C. Both halves

<details>
<summary>Answer</summary>

**A.** The public key

The server checks that a connecting user can prove possession of the matching private key, so it needs only the public key. Private SSH keys should never leave the user's machine.

</details>

**Sources:** [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [architecture/key_group_sync.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/key_group_sync.md)

<a id="build-task"></a>
## Build task: Build minivault: an envelope-encrypted credential store with KEK rotation, HKDF and signed snapshots

**Goal:** Write a small Python credential store that encrypts each secret with its own AES-256-GCM data key, wraps that key under a KEK with a recorded key ID and SHA-256 fingerprint, and binds each record to its path with AAD. It also derives SuperNIC-style lockdown keys with HKDF from a stored IKM. You then rotate the KEK, delete the old one safely, and sign the final store with an ECDSA P-256 key.

**Why it matters for NICo:** This is a laptop-sized model of what the Site Controller does with secrets. The Postgres credential store wraps per-credential data keys under a kek_id that is recorded on every row. Machine identity decrypts using the key ID embedded in each blob. Flow uses AES-GCM AAD and key fingerprints. NICo Core derives lockdown keys with HKDF-SHA256 from a versioned IKM. Building it yourself shows why NICo's rules exist: keep every referenced key ID until the re-wrap is done, back up the KEK, and never replace an IKM version that cards still use. This is a teaching model; NICo's real storage format is different.

**You need:**

- Linux or macOS with python3 (3.9+) and openssl (macOS LibreSSL is fine)
- An empty working directory: `mkdir minivault && cd minivault`
- A virtualenv with the cryptography package: `python3 -m venv .venv && . .venv/bin/activate && pip install cryptography`
- Optional, without local Python: `docker run --rm -it -v "$PWD":/work -w /work python:3.12-slim bash`, then `apt-get update && apt-get install -y openssl && pip install cryptography`

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Create the first KEK</summary>

```bash
umask 077
mkdir -p keks
openssl rand -base64 32 > keks/kek-1
python3 -c 'import base64,sys; print(len(base64.b64decode(open(sys.argv[1]).read())))' keks/kek-1   # must print 32
```
The file name `kek-1` is the KEK ID, just as the Kubernetes Secret key `site-kek-1` is the `kek_id` in NICo.

</details>

<details>
<summary>Step 2: Write minivault.py</summary>

Save this as `minivault.py`:
```python
#!/usr/bin/env python3
"""minivault: a toy envelope-encrypted credential store. Not for production."""
import base64
import hashlib
import json
import os
import sys
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

STORE = Path(os.environ.get("MINIVAULT_STORE", "store.json"))
KEK_DIR = Path("keks")


def b64(data):
    return base64.b64encode(data).decode()


def unb64(text):
    return base64.b64decode(text)


def fingerprint(key):
    return hashlib.sha256(key).hexdigest()[:16]


def load_kek(kek_id):
    path = KEK_DIR / kek_id
    if not path.exists():
        sys.exit(f"KEK {kek_id} not found, but a record still references it")
    key = base64.b64decode(path.read_text().strip())
    if len(key) != 32:
        sys.exit(f"KEK {kek_id} must decode to 32 bytes, got {len(key)}")
    return key


def load_store():
    return json.loads(STORE.read_text()) if STORE.exists() else {}


def save_store(store):
    STORE.write_text(json.dumps(store, indent=2, sort_keys=True) + "\n")


def wrap(kek_id, dek, path):
    kek = load_kek(kek_id)
    nonce = os.urandom(12)
    aad = f"wrap:{kek_id}:{path}".encode()
    return {
        "kek_id": kek_id,
        "kek_fp": fingerprint(kek),
        "wrap_nonce": b64(nonce),
        "wrapped_dek": b64(AESGCM(kek).encrypt(nonce, dek, aad)),
    }


def unwrap(rec, path):
    kek = load_kek(rec["kek_id"])
    if fingerprint(kek) != rec["kek_fp"]:
        sys.exit(f"KEK file {rec['kek_id']} does not match the fingerprint in the record")
    aad = f"wrap:{rec['kek_id']}:{path}".encode()
    return AESGCM(kek).decrypt(unb64(rec["wrap_nonce"]), unb64(rec["wrapped_dek"]), aad)


def put(path, secret, kek_id):
    dek = AESGCM.generate_key(bit_length=256)
    nonce = os.urandom(12)
    ciphertext = AESGCM(dek).encrypt(nonce, secret.encode(), f"data:{path}".encode())
    store = load_store()
    store[path] = {**wrap(kek_id, dek, path), "nonce": b64(nonce), "ciphertext": b64(ciphertext)}
    save_store(store)


def get(path):
    store = load_store()
    if path not in store:
        sys.exit(f"no credential at {path}")
    rec = store[path]
    dek = unwrap(rec, path)
    plaintext = AESGCM(dek).decrypt(unb64(rec["nonce"]), unb64(rec["ciphertext"]), f"data:{path}".encode())
    return plaintext.decode()


def rewrap(new_kek_id):
    store = load_store()
    for path, rec in store.items():
        dek = unwrap(rec, path)
        rec.update(wrap(new_kek_id, dek, path))
    save_store(store)
    print(f"re-wrapped {len(store)} records with {new_kek_id}")


def lockdown_key(ikm_version, mac, machine_id):
    ikm = get(f"nic_lockdown_ikm/{ikm_version}").encode()
    info = f"supernic-lock:v1:{mac}:{machine_id}".encode()
    hkdf = HKDF(algorithm=hashes.SHA256(), length=8, salt=None, info=info)
    return hkdf.derive(ikm).hex()


USAGE = """usage:
  minivault.py put PATH SECRET KEK_ID
  minivault.py get PATH
  minivault.py rewrap NEW_KEK_ID
  minivault.py lockdown IKM_VERSION MAC MACHINE_ID"""


def main():
    cmd, *args = sys.argv[1:] or ["help"]
    try:
        if cmd == "put" and len(args) == 3:
            put(*args)
        elif cmd == "get" and len(args) == 1:
            print(get(args[0]))
        elif cmd == "rewrap" and len(args) == 1:
            rewrap(args[0])
        elif cmd == "lockdown" and len(args) == 3:
            print(lockdown_key(*args))
        else:
            sys.exit(USAGE)
    except InvalidTag:
        sys.exit("INTEGRITY FAILURE: ciphertext, nonce or bound context does not match")


if __name__ == "__main__":
    main()
```
Find each concept in the code: the AES-GCM DEK and KEK, AAD that binds a record to its path and KEK ID, the SHA-256 KEK fingerprint, and HKDF.

</details>

<details>
<summary>Step 3: Store credentials and read one back</summary>

```bash
python3 minivault.py put bmc/host-a/root 'Sup3r-Secret!' kek-1
python3 minivault.py put nic_lockdown_ikm/v0 "$(openssl rand -hex 32)" kek-1
cat store.json                              # only key IDs, fingerprints, nonces and base64
python3 minivault.py get bmc/host-a/root    # Sup3r-Secret!
```
Note that passing a secret as a command-line argument exposes it in process listings and shell history. NICo's docs give the same warning about `--password` on `credential add-nic-lockdown-ikm`.

</details>

<details>
<summary>Step 4: Derive lockdown keys</summary>

```bash
python3 minivault.py lockdown v0 00:11:22:33:44:56 fm100hsdhjkfasjkdhaskjdhasd
python3 minivault.py lockdown v0 00:11:22:33:44:56 fm100hsdhjkfasjkdhaskjdhasd
python3 minivault.py lockdown v0 00:11:22:33:44:57 fm100hsdhjkfasjkdhaskjdhasd
```
The first two print the same 16 hex characters. The third prints an unrelated value. The derived keys are never saved anywhere.

</details>

<details>
<summary>Step 5: Rotate the KEK, then retire the old one</summary>

```bash
openssl rand -base64 32 > keks/kek-2
python3 minivault.py rewrap kek-2          # re-wrapped 2 records with kek-2
grep -c '"kek-1"' store.json              # 0: nothing references kek-1 any more
mv keks/kek-1 kek-1.retired-backup         # in production: offline backup, not just a rename
python3 minivault.py get bmc/host-a/root   # still works
```
To see why the order matters, try a separate experiment: run `put` with kek-1, then remove kek-1 *before* re-wrapping. `get` fails with `KEK kek-1 not found, but a record still references it`.

</details>

<details>
<summary>Step 6: Sign the store snapshot</summary>

```bash
openssl ecparam -name prime256v1 -genkey -noout -out signer.key
openssl ec -in signer.key -pubout -out signer.pub
openssl dgst -sha256 -sign signer.key -out store.sig store.json
openssl dgst -sha256 -verify signer.pub -signature store.sig store.json   # Verified OK
```
Sign *after* the last change to store.json. Anyone who has `signer.pub` can now check that the snapshot hasn't been altered.

</details>

<details>
<summary>Step 7: Write verify.sh</summary>

Save as `verify.sh` and run `bash verify.sh`:
```bash
#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
echo "1. read after rotation:"; python3 minivault.py get bmc/host-a/root
echo "2. old KEK retired:"; test ! -e keks/kek-1 && echo "kek-1 absent"; grep -c '"kek-1"' store.json
echo "3. relocation detected:"
python3 - <<'EOF'
import json
s = json.load(open("store.json"))
s["bmc/host-b/root"] = s["bmc/host-a/root"]
json.dump(s, open("tampered.json", "w"), indent=2)
EOF
MINIVAULT_STORE=tampered.json python3 minivault.py get bmc/host-b/root
echo "4. stable, independent lockdown keys:"
python3 minivault.py lockdown v0 00:11:22:33:44:56 fm100hsdhjkfasjkdhaskjdhasd
python3 minivault.py lockdown v0 00:11:22:33:44:56 fm100hsdhjkfasjkdhaskjdhasd
python3 minivault.py lockdown v0 00:11:22:33:44:57 fm100hsdhjkfasjkdhaskjdhasd
echo "5. snapshot signature:"
openssl dgst -sha256 -verify signer.pub -signature store.sig store.json
```
Step 3 copies host-a's valid record to host-b in a separate file. The AAD includes the path, so decryption refuses it.

</details>

**Check it works:** `bash verify.sh` prints, in order: (1) `Sup3r-Secret!`; (2) `kek-1 absent` and `0`; (3) `INTEGRITY FAILURE: ciphertext, nonce or bound context does not match`; (4) two identical 16-hex-character lines followed by a different one; (5) `Verified OK`.

<details>
<summary>If you get stuck</summary>

- `ModuleNotFoundError: No module named 'cryptography'`: activate the venv (`. .venv/bin/activate`) in the shell where you run the scripts.
- `KEK ... must decode to 32 bytes, got 48`: you created the KEK with `openssl rand -hex 32`. KEK files must be base64, so use `openssl rand -base64 32`. (The IKM credential is hex text, which is fine because it is stored as a secret, not loaded as a KEK.)
- `INTEGRITY FAILURE` on a normal `get`: you probably edited store.json by hand. Any change to a nonce, ciphertext or wrapped key breaks the tag. Delete store.json and put the credentials again.
- `Verification failure` in check 5: store.json changed after you signed it (for example, you ran rewrap again). Re-run the `openssl dgst -sha256 -sign` command.
- `KEK kek-1 not found` during rewrap: you retired kek-1 before re-wrapping. Restore it from `kek-1.retired-backup`, rewrap, then retire it again.
- On macOS without coreutils, use `shasum -a 256` wherever you'd use `sha256sum`.

</details>

**Stretch goal:** Add a `keks-in-use` command that lists every kek_id referenced in the store, and make retirement safe by refusing to proceed while any record still references the KEK. Then add IKM versioning: store `nic_lockdown_ikm/v1`, keep a per-card `current_version` in a small JSON file, and have `lockdown` use each card's tracked version rather than the newest one. Show that deleting v0 while a card still tracks it makes that card's key impossible to derive. For a bigger challenge, replace the file-based KEK with Vault's Transit engine in a dev container (`docker run --cap-add=IPC_LOCK -e VAULT_DEV_ROOT_TOKEN_ID=root -p 8200:8200 hashicorp/vault`) so the KEK never enters your Python process.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (build task): Step 'Rotate the KEK, then retire the old one' suggests a 'separate experiment': run `put` with kek-1, then remove kek-1 before re-wrapping. At that point kek-1 has already been moved to kek-1.retired-backup, so `put ... kek-1` fails at once, and the message ('KEK kek-1 not found, but a record still references it') is misleading because no record is involved yet. If the learner restores kek-1 to do the experiment, it writes a kek-1 record into the real store.json. verify.sh check 2 then prints 1 instead of 0, and check 5 fails because store.json changed after signing. *Fix:* Run the experiment in isolation, for example in a copy of the directory or with `MINIVAULT_STORE=experiment.json` and a KEK that is only for the experiment. Alternatively, move the experiment before the rotation and tell the learner to delete the extra record afterwards. Also tell them to re-sign or rerun from scratch if they experimented on store.json.
- **minor** (Public-key cryptography): The explanation says 'The owner hashes the message and signs the digest' and lists Ed25519 as a common algorithm. Ed25519 (PureEdDSA) signs the message itself; any hashing is internal to the algorithm. The selfExplanation prompt repeats this generalisation. *Fix:* Scope the claim: 'ECDSA (including ES256) and RSA signatures sign a hash of the message.' Alternatively, note that Ed25519 handles hashing internally.

---

[← 17-helm-gitops-installation-setup.md](17-helm-gitops-installation-setup.md) · [19-pki-certificates-authentication-identity.md →](19-pki-certificates-authentication-identity.md)
