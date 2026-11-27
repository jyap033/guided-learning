# Chapter 20: Credentials & Secrets · Security & Identity

*Part: Security & Identity · 6 concepts · [curriculum](../curriculum.md#chapter-20)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Earlier chapters covered how NICo talks to hardware (BMCs over Redfish, Chapter 6), how Kubernetes stores Secrets (Chapter 14), and how certificates and public-key signatures establish trust (Chapters 18–19). This chapter puts those pieces together around one question: **how does NICo hold the keys to thousands of machines, and how does it know those machines can be trusted?**

The first half is about secrets. You'll meet HashiCorp Vault, NICo's default secrets manager, and its Postgres-only alternative. Then you'll follow the most important credential on a site, the site-wide BMC root password: where it lives, how carbide-api copies it into the `bmc-shared-password` Secret for DPF, and why nothing happens to DPUs until it is set. After that come the factory-default passwords NICo needs for its first login to new hardware, and the reason rotating the BMC password is risky on a DPF site today.

The second half is about hardware identity. TPM-based measured boot shows that a host booted the software you expected. SPDM does the same for individual components such as GPUs and NICs, and NICo's Redfish layer reaches it through the `ComponentIntegrity` endpoints. Both build on what you already know about hashes, signatures and CA chains.

Everything here is about access to the machines themselves. Get it wrong and NICo either can't log into hardware at all, or locks itself out halfway through a change. The lab at the end has you simulate both failure modes on a laptop.

**By the end of this chapter you can:**

- Explain what Vault's KV and PKI engines do for NICo, and what changes when a site is installed with `--skip-vault`
- Trace the site-wide BMC root credential from where it is stored to the `bmc-shared-password` Secret, and name the three ways to set it
- Plan how factory-default BMC and UEFI credentials reach NICo on Vault-backed and Postgres-only sites
- Explain why BMC credential rotation must not be staged while DPF v26.4.0 manages any DPU
- Compute and check a simulated PCR measurement chain, and describe what a TPM quote proves
- Describe the SPDM evidence flow and the Redfish ComponentIntegrity endpoints NICo's libredfish layer uses for it

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [HashiCorp Vault](#hashicorp-vault)
2. [Site-wide BMC root credential](#site-wide-bmc-root-credential)
3. [Factory default credentials](#factory-default-credentials)
4. [BMC credential rotation](#bmc-credential-rotation)
5. [TPM and Measured Boot attestation](#tpm-and-measured-boot-attestation)
6. [SPDM attestation](#spdm-attestation)
7. [Build task: Credential lifecycle and attestation lab: Vault, mock BMCs, a shared-secret sync and a boot verifier](#build-task)

<a id="hashicorp-vault"></a>
## 1. HashiCorp Vault

*Builds on: PKI and TLS certificates (ch. 19), Kubernetes (ch. 14)*

### Before you read

- If you had to store 10,000 BMC passwords for a running service, why might a plain Kubernetes Secret or a database column not be enough?
- Guess: can NICo run without Vault at all?

<details>
<summary>Answers</summary>

- **If you had to store 10,000 BMC passwords for a running service, why might a plain Kubernetes Secret or a database column not be enough?** By default, Kubernetes Secrets are only base64-encoded and keep no version history. A plain column can be read by anyone with database access. A secrets manager adds encryption at rest, per-caller access policies, audit logs and version history.
- **Guess: can NICo run without Vault at all?** Yes. Vault is the default, but a site installed with `setup.sh --skip-vault` keeps credentials in Postgres, with each credential encrypted, and issues service certificates from a different cert-manager issuer.

</details>

### Explanation

**HashiCorp Vault** is a server that holds secrets and hands them out to callers that prove who they are. It is organised into **secrets engines**, which are plug-ins mounted at paths. Two matter for NICo:

- **KV (key/value) engine.** Stores small secrets such as BMC and UEFI passwords under paths like `/machines/bmc/site/root`. The KV v2 flavour keeps **versions**, so you can read the current value or an older one.
- **PKI engine.** A certificate authority (CA) inside Vault. When Vault is installed, cert-manager (Chapter 19) gets certificates through a `ClusterIssuer` named `vault-nico-issuer`. With the chart's default certificate settings, the machine and UFM certificates that `nico-api` requests also come from Vault.

**Kubernetes auth** is Vault's general way of letting a pod log in without a hard-coded password. The pod presents its ServiceAccount token. Vault asks the Kubernetes API whether the token is genuine, maps the ServiceAccount to a Vault *role*, and returns a short-lived Vault token limited by a *policy*. The caller's identity comes from where the workload runs, not from a secret written into a config file.

**Vault is optional.** You choose the credential store at Day 0:

| Install | Credentials live in | Service certs issued by |
|---|---|---|
| Default | Vault KV | `vault-nico-issuer` (Vault) |
| `setup.sh --skip-vault` | Postgres, encrypted per credential | `site-issuer` ClusterIssuer |

The Postgres store uses envelope encryption, which you saw in Chapter 18. Each credential gets its own data key, and every data key is wrapped by a **KEK** (key encryption key). With the Integrated provider, the KEK is held in a Kubernetes Secret. You configure the store in the `[secrets]` section of the nico-api site config (`backends`, `writer`, `[secrets.kms]`, `[secrets.routing]`). A site can also keep Vault installed for certificates while moving credentials to Postgres. In that case the Vault connection settings in the `nico-api` chart are still required.

One operational rule follows directly: **back up the KEK.** A Postgres dump can't be decrypted without every KEK its rows reference, and losing the Integrated KEK loses every stored credential.

**Analogy.** Vault is like a hotel front desk that keeps a key safe (KV) and also cuts new keycards (PKI). Guests prove who they are with their booking (Kubernetes auth), not with a password they carry around. The analogy breaks down because a real front desk throws old keys away, while Vault KV v2 keeps every version on purpose so you can go back.

### Worked example: Run Vault locally and use its KV and PKI engines

**Step 1: Start a dev-mode Vault.**

Dev mode keeps everything in memory, starts already unsealed and uses a known root token. It's for labs only.
```bash
docker run -d --name vault-lab --cap-add=IPC_LOCK -p 8200:8200 \
  -e VAULT_DEV_ROOT_TOKEN_ID=root \
  -e VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200 \
  hashicorp/vault:1.17
v() { docker exec -i -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN=root vault-lab vault "$@"; }
v status   # Sealed: false
```

**Step 2: Write two versions of a secret.**

Dev mode mounts KV v2 at `secret/`.
```bash
v kv put secret/lab/bmc/site/root username=admin password=first
v kv put secret/lab/bmc/site/root username=admin password=second
v kv metadata get secret/lab/bmc/site/root | grep current_version   # 2
```

**Step 3: Read current and old versions.**

```bash
v kv get -field=password secret/lab/bmc/site/root              # second
v kv get -version=1 -field=password secret/lab/bmc/site/root   # first
```
Services normally call the HTTP API instead of the CLI:
```bash
curl -s -H 'X-Vault-Token: root' http://127.0.0.1:8200/v1/secret/data/lab/bmc/site/root
```

**Step 4: Issue a certificate from the PKI engine.**

```bash
v secrets enable pki
v write pki/root/generate/internal common_name=lab.local ttl=24h
v write pki/roles/lab allowed_domains=lab.local allow_subdomains=true max_ttl=1h
v write pki/issue/lab common_name=api.lab.local
```
The output contains `certificate`, `issuing_ca` and `private_key`. In a NICo cluster, cert-manager gets certificates from Vault through `vault-nico-issuer` in the same way.

**Step 5: Clean up.**

`docker rm -f vault-lab`. Dev mode keeps everything in memory, so it's all gone. That's another reason dev mode is never used in production.

### Your turn: finish it

After two writes to `secret/lab/bmc/site/root`, fill in the blanks so the first command prints the *original* password and the second prints which version is current.

```text
v kv get -version=___ -field=password secret/lab/bmc/site/root
v kv ___ get secret/lab/bmc/site/root | grep current_version
```

<details>
<summary>Answer</summary>

First blank: `1`, because KV v2 numbers versions from 1. Second blank: `metadata`, which gives `v kv metadata get secret/lab/bmc/site/root`.

</details>

### Your turn: on your own

A colleague installs a new site with `setup.sh --skip-vault`. Answer three questions: (a) where do BMC and UEFI passwords live, (b) which ClusterIssuer issues the Core service certificates, and (c) what single object must be backed up so that a database dump can still be decrypted?

<details>
<summary>Hint 1</summary>

Look at the Day 0 table: what replaces Vault KV?

</details>

<details>
<summary>Hint 2</summary>

The Postgres store uses envelope encryption. What wraps the per-credential data keys?

</details>

<details>
<summary>Hint 3</summary>

Certificates no longer come from `vault-nico-issuer`. The replacement issuer's name starts with `site-`.

</details>

<details>
<summary>Answer</summary>

(a) In Postgres, with each credential encrypted. (b) The `site-issuer` ClusterIssuer, which issues the Core, RMS, Flow and site-agent service certificates. (c) The KEK Secret, for example `nico-secrets-kek` in `nico-system`. A dump can't be read without every KEK its rows reference. The Transit KEK provider isn't available on a `--skip-vault` site.

</details>

### Explain it

In your own words: In general, why is it safer for a Kubernetes pod to log in to Vault with its ServiceAccount token (Kubernetes auth) than with a long-lived Vault token stored in its config?

### Check

**1. cert-manager's `vault-nico-issuer` gets certificates from Vault. Which kind of Vault engine signs certificates?**

A. KV v2
B. PKI
C. Transit
D. Kubernetes auth

<details>
<summary>Answer</summary>

**B.** PKI

The PKI engine is a CA that signs certificates. KV stores passwords. Transit can hold a KEK, but it doesn't issue certificates. Kubernetes auth is a login method, not an engine that produces anything.

</details>

**2. A site keeps Vault installed but moves credentials to Postgres (`backends = ["postgres"]`). Are the Vault connection settings in the nico-api chart still needed?**

A. No, Vault is now unused
B. Yes, Vault still issues certificates through `vault-nico-issuer`
C. Only if `import_from` is set

<details>
<summary>Answer</summary>

**B.** Yes, Vault still issues certificates through `vault-nico-issuer`

Moving the credential store doesn't move certificate issuance. Only a `--skip-vault` install removes Vault entirely.

</details>

**3. The Integrated KEK is lost and there is no backup. What happens to the stored credentials?**

A. NICo regenerates the KEK at startup
B. Vault decrypts them instead
C. They are unrecoverable
D. Postgres can still read them with superuser access

<details>
<summary>Answer</summary>

**C.** They are unrecoverable

The KEK wraps every data key, so without it neither the data keys nor the credentials they protect can be decrypted. Database privileges don't help, because the stored rows are ciphertext.

</details>

**Sources:** [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

<a id="site-wide-bmc-root-credential"></a>
## 2. Site-wide BMC root credential

*Builds on: Baseboard Management Controller (BMC) (ch. 6), Kubernetes Secret (ch. 14)*

### Before you read

- NICo manages thousands of BMCs. Would you give each one a unique password or one shared password? What's the trade-off?
- If that shared password is missing on a fresh site, what do you think NICo does: crash, wait, or carry on with something else?

<details>
<summary>Answers</summary>

- **NICo manages thousands of BMCs. Would you give each one a unique password or one shared password? What's the trade-off?** NICo applies one site-wide BMC root credential. It's simpler to manage, and other systems such as DPF can reach every BMC through a single Secret. The cost is a large blast radius if it leaks, and rotation has to be coordinated across the whole fleet.
- **If that shared password is missing on a fresh site, what do you think NICo does: crash, wait, or carry on with something else?** In `local_first` or `backend` mode it starts anyway, logs a warning, leaves `bmc-shared-password` unwritten and blocks new DPU registration until the credential appears. Authoritative `local` mode with DPF enabled instead requires local version 0 before Core starts, when v0 is current or the current target can't be resolved.

</details>

### Explanation

The **site-wide BMC root credential** is the shared BMC password NICo applies to the hardware it manages. Once a machine is onboarded, its BMC uses this password instead of the factory default.

DPF (DPU provisioning) talks Redfish to host BMCs, so it needs the password too. NICo doesn't give DPF access to its credential store. Instead, **carbide-api copies the current version into a Kubernetes Secret named `bmc-shared-password` in `dpf-operator-system` and refreshes it every 60 seconds.** Because of the refresh, a credential that is missing at startup still reaches DPF later, without a restart.

What a missing credential means:
- New **DPU registration is blocked**, and DPU provisioning can't proceed.
- **Site Explorer** doesn't run. It needs this credential *and* the host and DPU UEFI site defaults, and it fails each iteration with `MissingCredentials` until all three exist.
- Once a value has been published, a later read failure keeps the last value and logs an error.

**Credential source modes** decide which source is authoritative for version 0 (v0) of the BMC root:
- `backend`: the persistent store (Vault or Postgres).
- `local_first`: a local file or environment value if one is present, otherwise the backend.
- `local`: the local source only. API add/delete for v0 is rejected. With DPF enabled, v0 must exist before Core starts when v0 is current or the current target can't be resolved.

**Three ways to set it:**
1. Export `NICO_DPF_BMC_ROOT_PASSWORD` and run `setup.sh`. This creates `nico-system/nico-bmc-v0-credentials` (username `admin`) and selects `local` ownership.
2. Mount a watched credential-file Secret containing `bmc_site_wide_root` through the `nico-api` chart **before** Core is deployed. Don't use a ConfigMap.
3. Use the API (`nico-admin-cli -a <api> credential add-bmc --kind=site-wide-root --password='...'`) or seed the store directly. Both need `backend` mode, or `local_first` without a local override.

The CLI path leaves the password in shell history and the process list, so prefer seeding with `read -rs`.

**Analogy.** Think of a building manager who keeps the master key and, every minute, puts a fresh copy in a lockbox for the cleaning contractor (DPF). If the master key hasn't been cut yet, the lockbox stays empty and the contractor can't start new floors, but the rest of the building keeps running. The analogy breaks down at rotation: a new master key in a real building doesn't make the old locks change themselves, and that gap is what causes trouble in the rotation lesson.

### Worked example: Bring a fresh site from MissingCredentials to a published shared Secret

**Step 1: Recognise the symptom.**

On a new `backend`-mode site, carbide-api logs a warning about the missing BMC root, and Site Explorer reports `MissingCredentials`. Confirm the derived Secret isn't there yet:
```bash
kubectl -n dpf-operator-system get secret bmc-shared-password
# Error from server (NotFound)
```

**Step 2: Seed the credential without leaking it.**

On a Vault-backed site, use the seeding path from the docs:
```bash
read -rs -p 'Site-wide BMC root password: ' BMC_ROOT_PASSWORD && echo
printf '{"UsernamePassword":{"username":"root","password":"%s"}}' \
  "${BMC_ROOT_PASSWORD}" \
  | vault kv put /machines/bmc/site/root -
unset BMC_ROOT_PASSWORD
```
`read -rs` hides what you type and keeps the value out of history. `printf` is a shell builtin, so the password never appears in a process argument list.

**Step 3: Wait one refresh tick.**

Within about 60 seconds, carbide-api picks up the credential and writes the Secret. No restart is needed.
```bash
kubectl -n dpf-operator-system get secret bmc-shared-password
```

**Step 4: Finish the other prerequisites.**

Site Explorer also needs the host and DPU UEFI site defaults. Until all three credentials exist, it keeps failing with `MissingCredentials`, even though the BMC root is now set.

**Step 5: Simulate the refresh loop locally.**

You can watch the same pattern on a laptop. One file stands in for the source and another for the Secret:
```bash
while true; do
  if [ -f source.txt ]; then cp source.txt shared.txt; echo published; else echo 'WARN: missing, shared unwritten'; fi
  sleep 5
done
# in another terminal, after a few warnings:
echo s3cret > source.txt
```

### Your turn: finish it

Complete the leak-free seeding snippet. One blank makes `read` silent and stops it mangling backslashes. The other tells `vault kv put` to read its data from stdin.

```text
read -___ -p 'Site-wide BMC root password: ' BMC_ROOT_PASSWORD && echo
printf '{"UsernamePassword":{"username":"root","password":"%s"}}' \
  "${BMC_ROOT_PASSWORD}" \
  | vault kv put /machines/bmc/site/root ___
unset BMC_ROOT_PASSWORD
```

<details>
<summary>Answer</summary>

`rs`, giving `read -rs`, and `-`, giving `vault kv put /machines/bmc/site/root -`.

</details>

### Your turn: on your own

A site was installed with `NICO_DPF_BMC_ROOT_PASSWORD` set. Later, an operator runs `nico-admin-cli -a <api> credential add-bmc --kind=site-wide-root --password='newpass'` and it is rejected. Explain why, and say what they should change instead. Assume no managed device is using v0 yet.

<details>
<summary>Hint 1</summary>

Which credential source mode does the setup.sh path select?

</details>

<details>
<summary>Hint 2</summary>

In that mode, which source owns version 0, and what happens to API add/delete calls for v0?

</details>

<details>
<summary>Hint 3</summary>

Where does the setup.sh path store v0, and what is that Secret called?

</details>

<details>
<summary>Answer</summary>

The setup.sh path selects authoritative `local` ownership. In `local` mode, v0 comes only from the local source, and API add/delete for v0 is rejected with instructions to update that source. With no device using v0 yet, they should correct the local source. setup.sh itself refuses to replace `nico-system/nico-bmc-v0-credentials` with a different value, so a different v0 means switching to a watched credential-file Secret they manage themselves. If devices already used v0, it would have to stay unchanged, and moving to a new password would be a coordinated rotation to v1 or later, which isn't possible on DPF sites today.

</details>

### Explain it

In your own words: Why does carbide-api copy the credential into a separate `bmc-shared-password` Secret every 60 seconds, instead of giving DPF direct access to Vault or Postgres?

### Check

**1. Where does carbide-api publish the BMC root for DPF?**

A. Vault path `/machines/bmc/site/root`
B. Secret `bmc-shared-password` in `dpf-operator-system`
C. ConfigMap `carbide-api-site-config-files`
D. Secret `hbn-user-password`

<details>
<summary>Answer</summary>

**B.** Secret `bmc-shared-password` in `dpf-operator-system`

The Vault path is one possible *source*, not what DPF reads. `hbn-user-password` is the HBN local credential. Credentials never belong in a ConfigMap.

</details>

**2. In `backend` mode, the BMC root is added an hour after carbide-api starts. What happens?**

A. Nothing until carbide-api is restarted
B. The next 60-second refresh writes `bmc-shared-password` and DPU registration can proceed
C. carbide-api crashes and restarts in a loop

<details>
<summary>Answer</summary>

**B.** The next 60-second refresh writes `bmc-shared-password` and DPU registration can proceed

The refresh exists so that a bootstrap credential added late propagates without a restart. Only authoritative `local` mode refuses to start without v0, and only under specific conditions.

</details>

**3. You set the BMC root, but Site Explorer still reports `MissingCredentials`. What is the most likely cause?**

A. The KEK is missing
B. The host and DPU UEFI site defaults aren't set
C. DPF isn't installed

<details>
<summary>Answer</summary>

**B.** The host and DPU UEFI site defaults aren't set

Site Explorer needs all three credentials: the BMC root and both UEFI site defaults.

</details>

**Sources:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

<a id="factory-default-credentials"></a>
## 3. Factory default credentials

*Builds on: Baseboard Management Controller (BMC) (ch. 6), UEFI firmware and Secure Boot (ch. 5)*

### Before you read

- A brand-new server arrives with a BMC that NICo has never seen. What password could NICo possibly use for its first login?

<details>
<summary>Answers</summary>

- **A brand-new server arrives with a BMC that NICo has never seen. What password could NICo possibly use for its first login?** The vendor's factory default, such as a well-known default or a per-unit password printed on a label. NICo has to be given these factory-default BMC (and UEFI) credentials before it can onboard the hardware.

</details>

### Explanation

**Factory default credentials** are the BMC and UEFI passwords that hardware ships with. NICo needs them for one thing: the *first* login to new hardware, after which it moves the device to the site-wide credential. A BMC account password is changed through Redfish `PATCH /redfish/v1/AccountService/Accounts/{id}`. A UEFI password is managed through `POST /redfish/v1/Systems/{id}/Bios/Actions/Bios.ChangePassword`. The account `Id` varies by vendor: Lenovo uses `1`, AMI/Viking use `2`, and NVIDIA uses the current user.

NICo keeps separate defaults for hosts and for DPUs. There are three ways to get them into NICo, depending on your credential store:

1. **Seed into Vault.** `helm-prereqs` writes entries such as the DPU BMC factory defaults into Vault KV through the `vault.kvSeeds` value. This works when Vault is the credential backend.
2. **Import once into Postgres.** With `backends = ["postgres"]`, Vault seeds are never read. To carry them over, list `vault` after `postgres` in `backends` and set `import_from = "vault"` for the first boot. When the log shows `Vault secret import completed`, remove `vault` from `backends` and drop `import_from`.
3. **Add through the CLI.** Set `vault.kvSeeds: []`, or install with `--skip-vault` (which has no seeds at all). Once the API is up, run `nico-admin-cli credential add-dpu-factory-default` and `nico-admin-cli credential add-host-factory-default`. Check each command's `--help` for its flags.

On a `--skip-vault` site you also set `siteCredentials.enabled: true`. That renders the site-wide BMC root and UEFI defaults as a credential-file Secret, and you point `nico-api.credentials.file.existingSecret` at it. Factory defaults still go in through the CLI.

Treat factory defaults as public knowledge. Vendors document them, so a device should spend as little time as possible on one.

**Analogy.** Factory defaults are like the temporary PIN a bank mails with a new card: you use it once to get in, then set your own. The analogy breaks down because a bank PIN is unique to you, while many BMC defaults are the same across a whole product line, which makes leaving them in place far more dangerous.

### Worked example: First login with a factory default, then switch to the site credential (mock BMC)

**Step 1: Write a tiny mock BMC.**

Save as `mock_bmc.py`:
```python
import base64, json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1])
STATE = {"user": "admin", "password": sys.argv[2]}
PATH = "/redfish/v1/AccountService/Accounts/2"

class H(BaseHTTPRequestHandler):
    def _authed(self):
        hdr = self.headers.get("Authorization", "")
        if not hdr.startswith("Basic "):
            return False
        user, _, pw = base64.b64decode(hdr[6:]).decode().partition(":")
        return user == STATE["user"] and pw == STATE["password"]

    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self._authed():
            return self._send(401, {"error": "bad credentials"})
        if self.path == PATH:
            return self._send(200, {"Id": "2", "UserName": STATE["user"], "RoleId": "Administrator"})
        self._send(404, {"error": "not found"})

    def do_PATCH(self):
        if not self._authed():
            return self._send(401, {"error": "bad credentials"})
        if self.path != PATH:
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        if "Password" in body:
            STATE["password"] = body["Password"]
        self._send(200, {"Id": "2", "UserName": STATE["user"]})

HTTPServer(("127.0.0.1", PORT), H).serve_forever()
```
Real BMCs serve HTTPS. This lab uses plain HTTP to keep things simple.

**Step 2: Start it with a factory default.**

The `sleep 1` gives the server time to bind its port before curl connects. Without it, you may see `000` (connection refused).
```bash
python3 mock_bmc.py 8001 factory-pass 2>/dev/null & sleep 1
curl -s -o /dev/null -w '%{http_code}\n' -u admin:factory-pass http://127.0.0.1:8001/redfish/v1/AccountService/Accounts/2   # 200
```

**Step 3: Use the default once to set the site password.**

```bash
curl -s -u admin:factory-pass -X PATCH -H 'Content-Type: application/json' \
  -d '{"Password":"site-root-v0"}' http://127.0.0.1:8001/redfish/v1/AccountService/Accounts/2
```

**Step 4: Confirm the default no longer works.**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -u admin:factory-pass  http://127.0.0.1:8001/redfish/v1/AccountService/Accounts/2   # 401
curl -s -o /dev/null -w '%{http_code}\n' -u admin:site-root-v0 http://127.0.0.1:8001/redfish/v1/AccountService/Accounts/2   # 200
kill %1
```

**Step 5: Map this to NICo's choices.**

In NICo you don't run these curls yourself. You supply the factory default through Vault seeds, a one-time import, or `nico-admin-cli credential add-host-factory-default` / `add-dpu-factory-default`, and NICo does the login.

### Your turn: finish it

A Vault-backed site with `helm-prereqs` seeds is moving to Postgres at Day 0 and wants the seeded factory defaults imported on first boot. Fill in the blanks in this `[secrets]` sketch. The KMS and routing tables stay as on the Day 0 page. Check the Secrets Storage reference for exactly where `import_from` goes.

```text
[secrets]
backends = ["postgres", "___"]
writer = "postgres"
import_from = "___"
```

<details>
<summary>Answer</summary>

Both blanks are `vault`, giving `backends = ["postgres", "vault"]` and `import_from = "vault"`. Once the log shows `Vault secret import completed`, remove `vault` from `backends` and delete `import_from`.

</details>

### Your turn: on your own

You're bringing up a `--skip-vault` site with new hosts and BlueField DPUs. List, in order, what you configure so that NICo has (a) the site-wide BMC root and UEFI defaults and (b) the host and DPU factory defaults.

<details>
<summary>Hint 1</summary>

With `--skip-vault` there are no `vault.kvSeeds` and nothing to import.

</details>

<details>
<summary>Hint 2</summary>

A `helm-prereqs` value renders a credential-file Secret, and a `nico-api` value points at it.

</details>

<details>
<summary>Hint 3</summary>

The factory defaults go in after the API is running, through two `credential add-*` subcommands.

</details>

<details>
<summary>Answer</summary>

1) In the `helm-prereqs` values, set `siteCredentials.enabled: true`. This renders the site-wide BMC root and UEFI defaults as a credential-file Secret. 2) Point `nico-api.credentials.file.existingSecret` at that Secret and deploy. 3) Once the API is up, run `nico-admin-cli credential add-host-factory-default` and `nico-admin-cli credential add-dpu-factory-default` with the vendor values.

</details>

### Explain it

In your own words: If NICo replaces factory defaults with the site-wide credential straight away, why does it need them at all?

### Check

**1. A site sets `backends = ["postgres"]` and leaves `vault.kvSeeds` at its default. What happens to the seeded factory defaults?**

A. They are read from Vault automatically
B. They are never read
C. They are copied to Postgres on every boot

<details>
<summary>Answer</summary>

**B.** They are never read

When Postgres is the only backend, Vault seeds are ignored. You either import them once with `import_from = "vault"` or add the credentials through the CLI.

</details>

**2. Which Redfish call changes a BMC account password?**

A. POST /redfish/v1/Systems/{id}/Bios/Actions/Bios.ChangePassword
B. PATCH /redfish/v1/AccountService/Accounts/{id}
C. POST /redfish/v1/Managers/{id}/Actions/Manager.ResetToDefaults

<details>
<summary>Answer</summary>

**B.** PATCH /redfish/v1/AccountService/Accounts/{id}

`Bios.ChangePassword` manages the UEFI password, not the BMC login. `ResetToDefaults` factory-resets the BMC, which would bring the factory default back.

</details>

**Sources:** [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md), [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md)

<a id="bmc-credential-rotation"></a>
## 4. BMC credential rotation

*Builds on: Site-wide BMC root credential (ch. 20), Redfish API (ch. 6)*

### Before you read

- You change a shared password on 1,000 devices. The change happens one device at a time and takes an hour. During that hour, a client that only knows 'the current password' talks to the devices. What goes wrong?

<details>
<summary>Answers</summary>

- **You change a shared password on 1,000 devices. The change happens one device at a time and takes an hour. During that hour, a client that only knows 'the current password' talks to the devices. What goes wrong?** The client switches to the new password while many devices still have the old one, so its logins to those devices fail until they catch up.

</details>

### Explanation

**BMC credential rotation** moves managed BMCs from one version of the site-wide password to a new one. NICo numbers these versions: v0 is the bootstrap value, and rotations advance to v1 or later. New versions come from the persistent backend, because the local file schema has no versioned BMC root key. On each device, a rotation is a Redfish account-password change (`PATCH /redfish/v1/AccountService/Accounts/{id}`), and these changes converge **asynchronously**, one device at a time.

The problem is the `bmc-shared-password` Secret. It holds *one* value: the current site-wide **target**. When a rotation is staged, the Secret switches to the new target **before** device convergence finishes. DPF reads only this Secret, so it can't log in to DPU host BMCs that still have the old password. **DPF v26.4.0 doesn't support BMC credential rotation**, so the rule is:

> Don't stage a site-wide BMC credential rotation while DPF manages any DPU. (Support is tracked in issue #6147.)

Two related traps:
- **The 60-second refresh isn't a rotation mechanism.** It republishes whatever the current target is and does nothing to coordinate devices.
- **Don't "rotate" by editing v0.** Once any managed device uses v0, keep the local value unchanged. Replacing it updates neither the BMC hardware nor NICo's convergence records, so NICo and the hardware end up disagreeing about the password.

If the rotation target disappears from its authoritative source after a value has been published, NICo keeps the last published Secret and logs an error. On a fresh site, the Secret stays unwritten. Either way, the fix is to restore the expected credential.

**Analogy.** Picture an office building having its locks changed one floor per day, while the cleaners get a single key on a ring each morning. From the day they're handed the new key, every floor still on the old lock is closed to them. The analogy breaks down because a person would simply carry both keys, while DPF v26.4.0 can only hold one.

### Worked example: Reproduce the rotation hazard with two mock BMCs

**Step 1: Start two BMCs on v0.**

Use `mock_bmc.py` from the factory-defaults lesson. The `sleep 1` lets both servers bind their ports before anything connects.
```bash
python3 mock_bmc.py 8001 pw-v0 2>/dev/null &
python3 mock_bmc.py 8002 pw-v0 2>/dev/null &
sleep 1
echo 'v0 pw-v0' > bmc-shared-password
```

**Step 2: Write a 'DPF' consumer that knows only the shared value.**

Save as `check.sh` and run `chmod +x check.sh`:
```bash
#!/usr/bin/env bash
read -r VER PW < bmc-shared-password
for port in 8001 8002; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -u "admin:$PW" \
    http://127.0.0.1:$port/redfish/v1/AccountService/Accounts/2)
  echo "BMC :$port using shared $VER -> HTTP $code"
done
```
`./check.sh` returns 200 for both.

**Step 3: Stage rotation: switch the target, converge one device.**

```bash
echo 'v1 pw-v1' > bmc-shared-password      # target switches immediately
curl -s -u admin:pw-v0 -X PATCH -H 'Content-Type: application/json' \
  -d '{"Password":"pw-v1"}' http://127.0.0.1:8001/redfish/v1/AccountService/Accounts/2
./check.sh
# :8001 -> 200, :8002 -> 401   <- the DPF failure window
```

**Step 4: Finish convergence.**

```bash
curl -s -u admin:pw-v0 -X PATCH -H 'Content-Type: application/json' \
  -d '{"Password":"pw-v1"}' http://127.0.0.1:8002/redfish/v1/AccountService/Accounts/2
./check.sh   # both 200
kill %1 %2
```
The failure window lasts as long as convergence does, which on a real fleet can be a long time.

### Your turn: finish it

Complete the curl that moves the BMC on port 8002 from `pw-v0` to `pw-v1`.

```text
curl -s -u admin:pw-v0 -X ___ -H 'Content-Type: application/json' \
  -d '{"___":"pw-v1"}' http://127.0.0.1:8002/redfish/v1/AccountService/Accounts/2
```

<details>
<summary>Answer</summary>

`PATCH` and `Password`.

</details>

### Your turn: on your own

Your manager asks you to rotate the site-wide BMC password tonight on a site running the default pinned DPF v26.4.0 with 40 DPF-managed DPUs. Someone suggests just editing the v0 value in the watched credential Secret instead. Give your recommendation and explain the risk of each option.

<details>
<summary>Hint 1</summary>

What does the pinned DPF version support?

</details>

<details>
<summary>Hint 2</summary>

When does `bmc-shared-password` switch, relative to device convergence?

</details>

<details>
<summary>Hint 3</summary>

Does changing v0 in the local source change the password on the hardware?

</details>

<details>
<summary>Answer</summary>

Don't do either. DPF v26.4.0 doesn't support BMC credential rotation, and NICo says not to stage a rotation while DPF manages any DPU (tracked in #6147). A staged rotation switches `bmc-shared-password` to the new target before devices converge, so DPF can't authenticate to BMCs still on the old password. Editing v0 is worse: once devices use v0 it must stay unchanged, because replacing it updates neither the BMCs nor the convergence records, and NICo's idea of the password stops matching the hardware. Wait for a DPF release that supports rotation.

</details>

### Explain it

In your own words: In your own words, explain why a consumer that holds only one password version can't survive an asynchronous rotation, and what a consumer would need in order to survive one.

### Check

**1. During a staged rotation, when does `bmc-shared-password` switch to the new value?**

A. After every device has converged
B. Before device convergence finishes
C. Only after carbide-api restarts

<details>
<summary>Answer</summary>

**B.** Before device convergence finishes

The early switch is exactly why DPF loses access to BMCs that haven't converged yet. No restart is involved, because the 60-second refresh publishes the new target.

</details>

**2. Is the 60-second refresh a safe way to roll out a new BMC password?**

A. Yes, it updates devices every minute
B. No, it only republishes the current target and doesn't coordinate devices
C. Yes, if the interval is shortened

<details>
<summary>Answer</summary>

**B.** No, it only republishes the current target and doesn't coordinate devices

The refresh exists so a bootstrap credential propagates without a restart. The docs state explicitly that it isn't a safe rotation mechanism.

</details>

**3. Which version does a coordinated rotation advance to, and where does it come from?**

A. v0, from the local file
B. v1 or later, from the persistent backend
C. v1, from `bmc-shared-password`

<details>
<summary>Answer</summary>

**B.** v1 or later, from the persistent backend

The local file has no versioned BMC root key. `bmc-shared-password` is a derived copy, not a source.

</details>

**Sources:** [manuals/dpf.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/manuals/dpf.md), [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

<a id="tpm-and-measured-boot-attestation"></a>
## 5. TPM and Measured Boot attestation

*Builds on: UEFI firmware and Secure Boot (ch. 5), PKI and TLS certificates (ch. 19)*

### Before you read

- Secure Boot (Chapter 5) refuses to run unsigned bootloaders. What can't it tell a remote server about a machine that has already booted?
- If a register can only be updated as new = hash(old || data), can malware set it to any value it likes?

<details>
<summary>Answers</summary>

- **Secure Boot (Chapter 5) refuses to run unsigned bootloaders. What can't it tell a remote server about a machine that has already booted?** Secure Boot enforces policy locally but produces no evidence for anyone else. A remote party can't learn which signed components actually ran, or whether Secure Boot was even on. Measured boot plus attestation provides that evidence.
- **If a register can only be updated as new = hash(old || data), can malware set it to any value it likes?** No. It would have to find inputs that hash to the target value, which is infeasible with a cryptographic hash. Only a platform reset clears the register.

</details>

### Explanation

A **TPM (Trusted Platform Module)** is a small security chip, or a firmware equivalent, on the motherboard. During **measured boot**, each stage hashes the next stage (firmware, bootloader, kernel and so on) before running it, and records the hash in a **Platform Configuration Register (PCR)**.

A PCR can't be written directly. It can only be **extended**:

```
PCR_new = H(PCR_old || H(component))
```

The final value therefore depends on every component *and the order they ran in*. Change one byte of the bootloader and the PCR comes out completely different. Software that runs after boot can't undo a measurement, because all it can do is extend further. PCRs reset only when the platform resets.

**Attestation** turns those values into evidence a remote verifier can trust:
1. The verifier sends a fresh random **nonce**.
2. The TPM produces a **quote**: the selected PCR values plus the nonce, signed by an attestation key that never leaves the TPM.
3. The verifier checks that the key really belongs to a genuine TPM. TPMs carry an endorsement certificate chained to the **TPM Manufacturer CA**, and validating that chain is ordinary PKI (Chapter 19).
4. The verifier checks the signature and the nonce (which proves the quote is fresh, not replayed), then compares the PCRs with known-good "golden" values.

If everything matches, the host booted the expected, untampered software. An event log is usually sent too, so the verifier can recompute the PCRs entry by entry.

**Where NICo touches this in the pages covered here:** NICo reads the optional `TrustedModules` field from Redfish `GET /redfish/v1/Systems/{id}` for TPM status reporting. The steps above are the general attestation model, which you need in order to understand what that TPM is for. These pages don't describe a NICo attestation workflow, so check the NICo documentation for your release before you rely on one.

**Analogy.** A PCR is like a logbook written in permanent ink, where every entry includes a fingerprint of the page before it. You can add entries but never erase them, so a forged page shows up immediately. The analogy breaks down because a real logbook can be photographed and shown again later. That's why the verifier's fresh nonce and the TPM's signature are needed.

### Worked example: Simulate PCR extension and a signed quote

**Step 1: Write the extend function.**

Save as `pcr.py`:
```python
import hashlib, sys

def extend(pcr: bytes, data: bytes) -> bytes:
    return hashlib.sha256(pcr + hashlib.sha256(data).digest()).digest()

pcr = bytes(32)  # PCRs start at all zeros
for path in sys.argv[1:]:
    with open(path, "rb") as f:
        pcr = extend(pcr, f.read())
print(pcr.hex())
```

**Step 2: Record a golden value.**

```bash
mkdir -p boot
echo shim-1.0 > boot/shim.efi; echo grub-2.12 > boot/grub.efi; echo linux-6.8 > boot/vmlinuz
python3 pcr.py boot/shim.efi boot/grub.efi boot/vmlinuz > golden.txt
```
List the files explicitly in boot order. A shell glob sorts them alphabetically, which gives a different PCR.

**Step 3: Produce and sign a quote.**

An RSA key stands in for the TPM's attestation key:
```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ak.pem
openssl pkey -in ak.pem -pubout -out ak.pub
openssl rand -hex 16 > nonce.txt                    # from the verifier
{ python3 pcr.py boot/shim.efi boot/grub.efi boot/vmlinuz; cat nonce.txt; } > quote.txt
openssl dgst -sha256 -sign ak.pem -out quote.sig quote.txt
```

**Step 4: Verify like a remote verifier.**

```bash
openssl dgst -sha256 -verify ak.pub -signature quote.sig quote.txt   # Verified OK
[ "$(head -1 quote.txt)" = "$(cat golden.txt)" ] && echo TRUSTED || echo UNTRUSTED
```

**Step 5: Tamper and observe.**

```bash
echo grub-evil > boot/grub.efi
python3 pcr.py boot/shim.efi boot/grub.efi boot/vmlinuz | diff - golden.txt   # differs
```

### Your turn: finish it

Complete the extend function so it follows the TPM rule `PCR_new = H(PCR_old || H(data))` using SHA-256.

```text
import hashlib

def extend(pcr: bytes, data: bytes) -> bytes:
    return hashlib.sha256(pcr + ___).digest()
```

<details>
<summary>Answer</summary>

`hashlib.sha256(data).digest()`, so the line reads `return hashlib.sha256(pcr + hashlib.sha256(data).digest()).digest()`.

</details>

### Your turn: on your own

An attacker gets root on a host after it boots and wants the next attestation to pass. Explain why they can't just set the PCR back to the golden value, and why replaying yesterday's valid quote fails too.

<details>
<summary>Hint 1</summary>

Which operations does a TPM allow on a PCR?

</details>

<details>
<summary>Hint 2</summary>

Where does the signing key live, and can root read it?

</details>

<details>
<summary>Hint 3</summary>

What does the verifier include in each quote request?

</details>

<details>
<summary>Answer</summary>

PCRs can only be extended, and extending from the current value can't reach a chosen target without breaking SHA-256. PCRs reset only on a platform reset, which starts a fresh measured boot. Root can't forge a quote either, because the attestation key never leaves the TPM. A replayed quote fails because it carries an old nonce, and the verifier checks for the fresh one it just sent.

</details>

### Explain it

In your own words: Why does the verifier need the TPM Manufacturer CA instead of trusting whatever public key the host sends with its quote?

### Check

**1. Two hosts load identical components in a different order. Why do they end up with different PCR values?**

A. PCRs store a timestamp
B. Extend chains each hash onto the previous value, so order matters
C. TPMs randomise PCRs at boot

<details>
<summary>Answer</summary>

**B.** Extend chains each hash onto the previous value, so order matters

H(H(0||a)||b) differs from H(H(0||b)||a). PCRs contain no timestamps or randomness, which is what makes golden values possible.

</details>

**2. Which Redfish field does NICo read for TPM status reporting?**

A. `TrustedModules` on `Systems/{id}`
B. `SecureBootEnable` on `Systems/{id}/SecureBoot`
C. `/redfish/v1/ComponentIntegrity`

<details>
<summary>Answer</summary>

**A.** `TrustedModules` on `Systems/{id}`

`TrustedModules` is an optional Systems field used for TPM status. `SecureBootEnable` reports whether UEFI Secure Boot is on, which is a different feature. ComponentIntegrity carries per-component SPDM evidence, not host TPM status.

</details>

**3. What does the nonce in a quote prove?**

A. The TPM is genuine
B. The quote is fresh, not a replay
C. The PCRs match the golden values

<details>
<summary>Answer</summary>

**B.** The quote is fresh, not a replay

The CA chain proves the TPM is genuine, and comparing with golden values proves the PCRs are correct. The nonce only proves freshness.

</details>

**Sources:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

<a id="spdm-attestation"></a>
## 6. SPDM attestation

*Builds on: PKI and TLS certificates (ch. 19), Redfish API (ch. 6)*

### Before you read

- A TPM measures what the host CPU booted. How would you check the firmware inside a GPU or NIC that the host CPU never measured?

<details>
<summary>Answers</summary>

- **A TPM measures what the host CPU booted. How would you check the firmware inside a GPU or NIC that the host CPU never measured?** Ask the component itself. With SPDM, the device proves its identity with a certificate chain from its vendor and returns firmware measurements signed by its own key.

</details>

### Explanation

**SPDM (Security Protocol and Data Model)** is a DMTF standard for authenticating individual hardware components such as GPUs, NICs and DPUs. It applies the TPM attestation idea to each device:

- **Identity.** The component holds a private key and a **certificate chain** rooted at its vendor's CA. The verifier checks the chain exactly as it would a TLS server certificate (Chapter 19).
- **Measurements.** The component reports hashes of its firmware and configuration, **signed** with its key over a nonce the verifier supplies. That makes the result fresh, and nothing outside the device can forge it.
- **Appraisal.** The verifier checks the chain, the signature and the nonce, then compares the measurements with expected values.

On servers, the BMC usually speaks SPDM to the components and exposes the results over Redfish. These are the `ComponentIntegrity` endpoints NICo uses:

| Endpoint | Method | Purpose |
|---|---|---|
| `/redfish/v1/ComponentIntegrity` | GET | List SPDM attestation components |
| `{component}/Certificates/CertChain` | GET | Component CA certificate |
| `{component}/Actions/ComponentIntegrity.SPDMGetSignedMeasurements` | POST | Trigger evidence collection |

NICo's libredfish layer wraps them in four functions: `get_component_integrities()` lists the components, `get_component_ca_certificate()` fetches a component's certificate chain, `trigger_evidence_collection()` triggers SPDM evidence collection, and `get_evidence()` retrieves the evidence.

SPDM and TPM complement each other. The TPM covers the host's boot chain, and SPDM covers the devices plugged into the host.

**Analogy.** SPDM is like checking each contractor's ID badge on a building site and asking them to sign a statement of which tools they brought today, with a date you write in yourself. The analogy breaks down because a person can lie about their tools, while a device's measurements come from its own firmware root of trust. Even so, the signature proves who is speaking, not that their measuring logic is honest, which is why trust in the vendor matters.

### Worked example: Follow the SPDM evidence flow, then simulate the cryptography locally

**Step 1: Discover components (real BMC).**

This needs a BMC that supports ComponentIntegrity, so it won't run without hardware:
```bash
curl -sk -u "$USER:$PASS" https://$BMC/redfish/v1/ComponentIntegrity
```
Each member is one component that can be attested.

**Step 2: Fetch the cert chain and trigger measurements (real BMC).**

```bash
curl -sk -u "$USER:$PASS" https://$BMC<component>/Certificates/CertChain
curl -sk -u "$USER:$PASS" -X POST -H 'Content-Type: application/json' \
  -d '{"Nonce":"<64 hex chars>"}' \
  https://$BMC<component>/Actions/ComponentIntegrity.SPDMGetSignedMeasurements
```
The action's parameters (such as `Nonce`, `SlotId` and `MeasurementIndices`) come from the DMTF Redfish schema. Check your BMC's documentation for which ones it accepts.

**Step 3: Simulate the vendor CA and device certificate.**

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -subj /CN=VendorCA -days 1
openssl req -newkey rsa:2048 -nodes -keyout dev.key -out dev.csr -subj /CN=GPU-0
openssl x509 -req -in dev.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out dev.pem -days 1
openssl verify -CAfile ca.pem dev.pem     # dev.pem: OK
```

**Step 4: Simulate signed measurements with a nonce.**

```bash
echo 'fw=96.00.5A' > meas.txt
openssl rand -hex 32 > nonce.txt                      # verifier
cat meas.txt nonce.txt > tbs.txt
openssl dgst -sha256 -sign dev.key -out sig.bin tbs.txt   # device
openssl x509 -in dev.pem -pubkey -noout > dev.pub
openssl dgst -sha256 -verify dev.pub -signature sig.bin tbs.txt   # Verified OK
```

**Step 5: Appraise.**

So far: the signature is valid, the chain leads to the vendor CA, and the nonce is the one you sent. The last check is to compare `meas.txt` with the expected firmware value. All four checks must pass.

### Your turn: finish it

Fill in the Redfish action that is POSTed to a component to trigger SPDM evidence collection.

```text
POST {component}/Actions/ComponentIntegrity.___
```

<details>
<summary>Answer</summary>

`SPDMGetSignedMeasurements`

</details>

### Your turn: on your own

A component returns validly signed measurements that match the expected values, but `openssl verify -CAfile vendor-ca.pem device.pem` fails. Should the component be trusted? Explain.

<details>
<summary>Hint 1</summary>

What does a valid signature prove on its own?

</details>

<details>
<summary>Hint 2</summary>

Who could have generated the key that made the signature?

</details>

<details>
<summary>Hint 3</summary>

The chain check is what ties the key to a real device from that vendor.

</details>

<details>
<summary>Answer</summary>

No. A valid signature only proves that whoever holds the key signed the data. Without a chain to the vendor CA, the key could belong to anyone, such as an emulator or a counterfeit part, and its measurements can say anything. Both identity (the chain) and integrity (the signed measurements) have to pass.

</details>

### Explain it

In your own words: If the host's boot chain is already attested with TPM measured boot, why would you also want SPDM?

### Check

**1. Which Redfish resource carries SPDM attestation for NICo?**

A. `/redfish/v1/Systems/{id}/SecureBoot`
B. `/redfish/v1/ComponentIntegrity`
C. `/redfish/v1/AccountService`
D. `/redfish/v1/UpdateService/FirmwareInventory`

<details>
<summary>Answer</summary>

**B.** `/redfish/v1/ComponentIntegrity`

SecureBoot controls UEFI signature enforcement. FirmwareInventory reports versions the BMC *claims*, without signatures, which makes it a common confusion. ComponentIntegrity carries SPDM evidence.

</details>

**2. What does `{component}/Certificates/CertChain` provide?**

A. The component's CA certificate chain, used to verify its identity
B. The BMC's TLS certificate
C. The TPM endorsement key

<details>
<summary>Answer</summary>

**A.** The component's CA certificate chain, used to verify its identity

It's the component's own chain. The BMC's TLS certificate secures the Redfish connection itself, and the TPM endorsement key belongs to host attestation.

</details>

**Sources:** [architecture/redfish/endpoints_reference.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/redfish/endpoints_reference.md)

<a id="build-task"></a>
## Build task: Credential lifecycle and attestation lab: Vault, mock BMCs, a shared-secret sync and a boot verifier

**Goal:** On a laptop, you'll store factory-default and site-wide BMC credentials in Vault and onboard two mock Redfish BMCs. You'll publish the current version to a 'shared Secret' file, the way carbide-api feeds `bmc-shared-password`, and reproduce the rotation failure window. Finally, you'll build a measured-boot verifier that flags a tampered bootloader.

**Why it matters for NICo:** This lab reproduces failure modes you'll debug in NICo: the `MissingCredentials` / empty-Secret state, the one-time use of factory defaults, and the DPF lockout caused by a shared Secret that switches early during rotation. It also shows how attestation tells 'signed' apart from 'expected'.

**You need:**

- Docker or Podman (the commands use `docker`; with Podman, alias it)
- Python 3.9+ (standard library only)
- curl and openssl (LibreSSL on macOS works)
- A working directory: `mkdir -p ~/nico-ch20 && cd ~/nico-ch20`
- `mock_bmc.py` from the factory-defaults lesson, `check.sh` from the rotation lesson and `pcr.py` from the TPM lesson, all saved in that directory

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Start Vault and a helper</summary>

```bash
docker run -d --name vault-lab --cap-add=IPC_LOCK -p 8200:8200 \
  -e VAULT_DEV_ROOT_TOKEN_ID=root -e VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200 \
  hashicorp/vault:1.17
cat > lab.env <<'EOF'
v() { docker exec -i -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN=root vault-lab vault "$@"; }
EOF
source lab.env
sleep 2
v status | grep Sealed   # false
```

</details>

<details>
<summary>Step 2: Seed the factory default and the site root (leak-free)</summary>

```bash
v kv put secret/lab/bmc/factory-default/host username=admin password=factory-pass
read -rs -p 'Site root (initial): ' P && echo
printf '%s' "$P" | v kv put secret/lab/bmc/site/root username=admin password=-
unset P
```
`password=-` makes Vault read the value from stdin. Vault's version counter starts at 1. That is Vault's own numbering, not NICo's v0/v1.

</details>

<details>
<summary>Step 3: Start two mock BMCs on the factory default</summary>

The `sleep 1` lets both servers bind their ports before the next step connects to them.
```bash
python3 mock_bmc.py 8001 factory-pass 2>/dev/null &
python3 mock_bmc.py 8002 factory-pass 2>/dev/null &
sleep 1
```

</details>

<details>
<summary>Step 4: Onboard: one factory login, then the site root</summary>

```bash
FACTORY=$(v kv get -field=password secret/lab/bmc/factory-default/host)
SITE=$(v kv get -field=password secret/lab/bmc/site/root)
for port in 8001 8002; do
  curl -s -u "admin:$FACTORY" -X PATCH -H 'Content-Type: application/json' \
    -d "{\"Password\":\"$SITE\"}" http://127.0.0.1:$port/redfish/v1/AccountService/Accounts/2; echo
done
unset FACTORY SITE
```
Passwords on a curl command line are visible in `ps`. That's acceptable in this lab only. Avoid quotes and backslashes in your lab passwords, because they are spliced into JSON here.

</details>

<details>
<summary>Step 5: Publish the current version to the 'shared Secret' and check access</summary>

Create `sync_once.sh`, which performs one carbide-api refresh tick:
```bash
#!/usr/bin/env bash
set -euo pipefail
curl -sf -H 'X-Vault-Token: root' http://127.0.0.1:8200/v1/secret/data/lab/bmc/site/root \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print("vault-v%s" % d["metadata"]["version"], d["data"]["password"])' \
  > bmc-shared-password.tmp
chmod 600 bmc-shared-password.tmp
mv bmc-shared-password.tmp bmc-shared-password
echo "published $(cut -d' ' -f1 bmc-shared-password)"
```
`check.sh` from the rotation lesson stands in for DPF. Run:
```bash
chmod +x sync_once.sh check.sh
./sync_once.sh && ./check.sh    # both HTTP 200
```

</details>

<details>
<summary>Step 6: Reproduce the rotation failure window</summary>

```bash
read -rs -p 'New site root: ' P && echo
printf '%s' "$P" | v kv put secret/lab/bmc/site/root username=admin password=-
OLD=$(v kv get -version=1 -field=password secret/lab/bmc/site/root)
curl -s -u "admin:$OLD" -X PATCH -H 'Content-Type: application/json' \
  -d "{\"Password\":\"$P\"}" http://127.0.0.1:8001/redfish/v1/AccountService/Accounts/2; echo
./sync_once.sh && ./check.sh    # :8001 200, :8002 401  <- DPF lockout
curl -s -u "admin:$OLD" -X PATCH -H 'Content-Type: application/json' \
  -d "{\"Password\":\"$P\"}" http://127.0.0.1:8002/redfish/v1/AccountService/Accounts/2; echo
./check.sh                      # both 200
unset P OLD
```
Note how long :8002 was locked out. That gap is why NICo forbids staging a rotation while DPF v26.4.0 manages DPUs.

</details>

<details>
<summary>Step 7: Add a measured-boot verifier</summary>

Create `verify_boot.sh`, which uses `pcr.py` from the TPM lesson:
```bash
#!/usr/bin/env bash
set -euo pipefail
openssl rand -hex 16 > nonce.txt                                         # verifier
{ python3 pcr.py boot/shim.efi boot/grub.efi boot/vmlinuz; cat nonce.txt; } > quote.txt
openssl dgst -sha256 -sign ak.pem -out quote.sig quote.txt              # 'TPM'
openssl dgst -sha256 -verify ak.pub -signature quote.sig quote.txt >/dev/null
if [ "$(head -1 quote.txt)" = "$(cat golden.txt)" ]; then echo TRUSTED; else echo UNTRUSTED; fi
```
Then run:
```bash
mkdir -p boot; echo shim-1.0 > boot/shim.efi; echo grub-2.12 > boot/grub.efi; echo linux-6.8 > boot/vmlinuz
python3 pcr.py boot/shim.efi boot/grub.efi boot/vmlinuz > golden.txt
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ak.pem
openssl pkey -in ak.pem -pubout -out ak.pub
chmod +x verify_boot.sh && ./verify_boot.sh   # TRUSTED
echo grub-evil > boot/grub.efi && ./verify_boot.sh   # UNTRUSTED
```

</details>

**Check it works:** Run `source lab.env && v kv metadata get secret/lab/bmc/site/root | grep current_version`, which should show 2. Run `./check.sh`: both BMCs should return HTTP 200 using `vault-v2`. Run `./verify_boot.sh`: it should print UNTRUSTED with the tampered grub, and TRUSTED again after `echo grub-2.12 > boot/grub.efi`. You should also have seen the intermediate `:8002 -> HTTP 401` line in step 6.

<details>
<summary>If you get stuck</summary>

- `v` fails with 'connection refused': the container is still starting or has exited. Check `docker logs vault-lab 2>&1 | tail`. Port 8200 may already be in use.
- `printf ... | v kv put ...` stores an empty value: the helper needs `docker exec -i` to pass stdin through. Check that `lab.env` includes `-i`.
- curl prints `000` or 'connection refused' for a mock BMC: the server hadn't bound its port yet, or it exited. Wait a second and retry, and check `jobs` to see that both mocks are running.
- Onboarding returns 401: a mock BMC was already changed in an earlier attempt. Kill the mocks (`kill %1 %2` or `pkill -f mock_bmc.py`) and restart them with `factory-pass`.
- `sync_once.sh` fails: with `-f`, curl fails on any non-200 response from Vault, such as a wrong path or token. Test the curl command on its own.
- `verify_boot.sh` says UNTRUSTED with untouched files: check that golden.txt was built with the files in the same order as the script, not with a `boot/*` glob.

</details>

**Stretch goal:** Make the rotation safe from the consumer's side. Change `sync_once.sh` to publish the previous *and* current Vault versions, and change `check.sh` to try the current one first and fall back to the previous one. Show that the 401 window disappears, then explain why NICo can't do this on its own: DPF v26.4.0 reads only one value. For extra credit, start a `kind` cluster and have the sync write a real Secret every 60 seconds with `kubectl create secret generic bmc-shared-password --from-literal=password="$PW" --dry-run=client -o yaml | kubectl apply -f -`.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (Site-wide BMC root credential): The independent problem answer says a different v0 'means switching to a watched credential-file Secret they manage themselves'. The docs don't support this. They describe the setup-created `nico-bmc-v0-credentials` as a persistent watched version-0 Secret, and say a watched Secret update 'can supply or correct version 0 before any managed device begins using it'. Only re-running setup.sh with a different value is refused. *Fix:* Say the operator can correct v0 by updating the watched local source (and must not re-run setup.sh with a different NICO_DPF_BMC_ROOT_PASSWORD, because setup fails rather than replace v0). Alternatively, drop the claim that they must switch to their own Secret.
- **minor** (SPDM attestation): The real-BMC curl commands use `-u "$USER:$PASS"`. The shell already sets `$USER` to the local login name, so a learner who sets only PASS and BMC sends the wrong username. *Fix:* Use a dedicated variable name such as `$BMC_USER:$BMC_PASS`.
- **minor** (HashiCorp Vault): The worked example runs `v status` right after `docker run -d`. The dev server may not be listening yet, so the first call can fail with connection refused. The build task adds `sleep 2` for this, but the worked example doesn't. *Fix:* Add `sleep 2` (or a short retry loop) before `v status` in the worked example.
- **minor** (TPM and Measured Boot attestation): The explanation and prequestion say PCRs reset only on a platform reset. That is true for the boot PCRs (0–7), but PCR 16 (debug) and PCR 23 (application) can be reset by software, and PCRs 17–22 reset on a dynamic (DRTM) launch. *Fix:* Qualify it, for example: 'the boot-measurement PCRs reset only when the platform resets'.

---

[← 19-pki-certificates-authentication-identity.md](19-pki-certificates-authentication-identity.md) · [21-authentication-identity.md →](21-authentication-identity.md)
