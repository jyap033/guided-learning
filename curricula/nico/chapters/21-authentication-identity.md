# Chapter 21: Authentication & Identity

*Part: Security & Identity · 5 concepts · [curriculum](../curriculum.md#chapter-21)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Chapter 19 covered how TLS certificates and JWTs prove things. Chapter 20 covered where secrets live: Vault, the site-wide BMC root, rotation. This chapter asks a different question: **who is calling, and what may they do?** Every NICo control-plane service talks to `nico-api` over mTLS/gRPC. Every DPU agent polls Core every 30 seconds. Operators use `nico-admin-cli` against Core, and orchestrators send JWTs to NICo REST. The server has to check each caller's identity, and rules have to decide what that identity may do.

The chapter has five lessons:

- **SPIFFE** is the standard vocabulary for workload identity: SPIFFE IDs, trust domains and SVIDs. NICo uses it for service identity and, later in the course (ch. 43), to issue JWT-SVIDs to tenant workloads.
- **Client identity** is the verified identity a server takes from a caller's certificate. The server can use it for decisions such as per-client limits.
- **RBAC** maps identities to roles and roles to permissions. You'll see it as a general model and in NICo REST's provider/tenant admin and viewer roles.
- The **External Secrets Operator** copies CA bundles and database credentials into the namespaces that need them.
- The **KMIP KEK provider** keeps the keys that protect stored secrets in an external key manager. NICo reaches that key manager with its own client certificate.

The last two are the plumbing that makes identity work in a real cluster.

You need all five to run a NICo site. A DPU agent gets rejected, an admin gets `403`, a pod can't find `nico-roots`, preflight complains about your KMIP directory: the cause is almost always one of these five ideas. The build task has you assemble a small identity-aware API on your laptop using only `openssl`, Python and `curl`.

**By the end of this chapter you can:**

- Read a SPIFFE ID, tell an X.509-SVID from a JWT-SVID, and issue an X.509-SVID with openssl
- Explain how an mTLS server gets a verified client identity from a certificate, and why per-client limits need one identity per caller
- Model access as identity → role → permission and pick the right NICo REST role (provider/tenant, admin/viewer) for a persona
- Write an External Secrets Operator ClusterSecretStore and ExternalSecret that copy a CA bundle across namespaces, and check NICo's nico-roots Secret
- Prepare and validate a KMIP client TLS directory (ca.pem, client.pem, client.key) for NICO_KMIP_CLIENT_DIR

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [SPIFFE](#spiffe)
2. [Client identity](#client-identity)
3. [Role-Based Access Control (RBAC)](#role-based-access-control)
4. [External Secrets Operator (ESO)](#external-secrets-operator)
5. [KMIP KEK provider](#kmip-kek-provider)
6. [Build task: Build an identity-aware mini control plane](#build-task)

<a id="spiffe"></a>
## 1. SPIFFE

*Builds on: PKI and TLS certificates (ch. 19), OIDC / JWT authentication (Keycloak) (ch. 19)*

### Before you read

- A service presents a TLS certificate. Where in the certificate would you put a machine-readable statement like "I am the DPU agent for dpu-01 in site nico.lab", so that any verifier knows exactly where to look?
- Name one situation where a workload would rather prove its identity with a signed JWT than with an X.509 certificate.

<details>
<summary>Answers</summary>

- **A service presents a TLS certificate. Where in the certificate would you put a machine-readable statement like "I am the DPU agent for dpu-01 in site nico.lab", so that any verifier knows exactly where to look?** In a Subject Alternative Name of type URI, written as `spiffe://nico.lab/dpu-agent/dpu-01`. SPIFFE standardises this: one URI SAN holds the ID. The Common Name is not used for identity.
- **Name one situation where a workload would rather prove its identity with a signed JWT than with an X.509 certificate.** When there is no end-to-end TLS session to the verifier. For example, a proxy terminates TLS, or the identity has to reach a third-party HTTP API or token-exchange endpoint. A JWT can travel as a bearer token. The catch is that anyone holding it can replay it, so JWT-SVIDs are short-lived and tied to an audience.

</details>

### Explanation

**SPIFFE** (Secure Production Identity Framework For Everyone) is an open standard for giving *workloads* (processes, pods, agents) cryptographic identities without passwords. It defines three terms.

- **SPIFFE ID**: a URI of the form `spiffe://<trust-domain>/<path>`, for example `spiffe://nico.lab/dpu-agent/dpu-01`. You choose the path and what it means.
- **Trust domain**: the part after `spiffe://` (`nico.lab`). It is an identity namespace with its own root signing keys. The set of public keys or CA certificates for a trust domain is its **trust bundle**. A verifier accepts an identity only if it can check it against that trust domain's bundle.
- **SVID** (SPIFFE Verifiable Identity Document): the proof. It comes in two forms.
  - **X.509-SVID**: a certificate whose *single* URI SAN is the SPIFFE ID. The workload proves the identity by using the private key during a TLS handshake, which makes this form a natural fit for mTLS. A stolen certificate is useless without the key.
  - **JWT-SVID**: a signed JWT whose `sub` claim is the SPIFFE ID. The `aud` (audience) claim is required. A JWT-SVID is a bearer token: anyone who holds it can use it until `exp`. Keep JWT-SVIDs short-lived and scoped to one audience.

A verifier makes three checks on an SVID:
1. The signature chains to the trust bundle.
2. The trust domain is one it accepts.
3. For JWTs only: the verifier's own name is in `aud` and the token hasn't expired.

**In NICo.** The glossary says NICo uses SPIFFE-based identities for service-to-service authentication, and its control-plane services all talk over mTLS/gRPC. NICo also issues SPIFFE **JWT-SVIDs** to tenant workloads, a feature called "machine identity". NICo signs the token, with per-tenant keys, when a DPU calls the Core gRPC API or when a workload reads the instance metadata service (IMDS) on the DPU. Day 0 site config turns the feature on with a `[machine_identity]` section (`enabled`, `algorithm = "ES256"`, `current_encryption_key_id`). An optional `trust_domain_allowlist` restricts which trust domains tenant orgs may use for their JWT issuer. Chapter 43 covers this in depth. This lesson gives you the vocabulary.

**Analogy.** A SPIFFE ID is like a passport number plus the issuing country, which plays the role of the trust domain. The X.509-SVID is the passport booklet: it only works when the holder turns up in person, which is the equivalent of proving the private key. The JWT-SVID is a printed boarding pass for one flight (the audience) that expires soon. The analogy breaks down on lifetime and copying. Passports last years, while SVIDs last hours or minutes. A photocopied boarding pass is rejected at the gate, but a copied JWT-SVID works for whoever presents it until it expires.

### Worked example: Mint and inspect an X.509-SVID for a lab trust domain

**Step 1: Create the trust domain's root.**

A CA key backs the trust domain `nico.lab`. Its certificate, `ca.pem`, is the trust bundle.
```bash
mkdir -p ~/nico-ch21/pki && cd ~/nico-ch21
openssl ecparam -genkey -name prime256v1 -noout -out pki/ca.key
openssl req -x509 -new -key pki/ca.key -sha256 -days 30 \
  -subj "/CN=nico.lab trust root" -out pki/ca.pem
```

**Step 2: Issue an X.509-SVID with a SPIFFE URI SAN.**

```bash
openssl ecparam -genkey -name prime256v1 -noout -out pki/dpu-01.key
openssl req -new -key pki/dpu-01.key -subj "/CN=dpu-01" -out pki/dpu-01.csr
cat > pki/dpu-01.ext <<'EOF'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
subjectAltName=URI:spiffe://nico.lab/dpu-agent/dpu-01
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EOF
openssl x509 -req -in pki/dpu-01.csr -CA pki/ca.pem -CAkey pki/ca.key \
  -CAcreateserial -sha256 -days 1 -extfile pki/dpu-01.ext -out pki/dpu-01.pem
```
The certificate is a leaf (`CA:FALSE`). It is for TLS clients (`clientAuth`), it carries exactly one URI SAN, and it lives for only 1 day.

**Step 3: Read the identity back out.**

```bash
openssl x509 -in pki/dpu-01.pem -noout -text | grep -A1 "Subject Alternative Name"
```
Expected:
```
            X509v3 Subject Alternative Name: 
                URI:spiffe://nico.lab/dpu-agent/dpu-01
```
The CN `dpu-01` is only a label. Verifiers read the URI SAN.

**Step 4: Verify it against the trust bundle.**

```bash
openssl verify -CAfile pki/ca.pem pki/dpu-01.pem
# pki/dpu-01.pem: OK
```
Verify it against a different trust domain's bundle and it fails with `unable to get local issuer certificate`. The ID claims `nico.lab`, and only `nico.lab`'s keys can back that claim.

**Step 5: Compare with a JWT-SVID's shape.**

A JWT-SVID carries the same identity as signed claims, for example:
```json
{"alg": "ES256", "kid": "key-1", "typ": "JWT"}
{"sub": "spiffe://nico.lab/dpu-agent/dpu-01",
 "aud": ["nico-rest"],
 "iat": 1795600000, "exp": 1795600300}
```
A verifier checks the signature against the trust domain's public keys, which are often published as a JWKS. It also checks that its own name is in `aud` and that `exp` is in the future. NICo's machine identity uses ES256, as in this header.

### Your turn: finish it

Fill in the blanks in this openssl extension file. The result should be an X.509-SVID that DPU `dpu-07` can use as an mTLS **client** in trust domain `nico.lab`, with the same path scheme as the worked example.

```text
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=___
subjectAltName=___
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
```

<details>
<summary>Answer</summary>

extendedKeyUsage=clientAuth
subjectAltName=URI:spiffe://nico.lab/dpu-agent/dpu-07

</details>

### Your turn: on your own

Your service is named `nico-rest` and trusts only the trust domain `nico.lab`. It receives three JWT-SVIDs, and each has a valid signature from *some* trust domain's key. Which do you accept, and why are the others rejected?

A: `sub=spiffe://nico.lab/tenant/acme/job-1`, `aud=["nico-rest"]`, `exp` in 4 minutes, signed by a `nico.lab` key
B: `sub=spiffe://evil.lab/tenant/acme/job-1`, `aud=["nico-rest"]`, `exp` in 4 minutes, signed by an `evil.lab` key
C: `sub=spiffe://nico.lab/tenant/acme/job-1`, `aud=["billing"]`, `exp` in 4 minutes, signed by a `nico.lab` key

<details>
<summary>Hint 1</summary>

List the three checks a JWT-SVID verifier makes and apply each one to each token.

</details>

<details>
<summary>Hint 2</summary>

For B, ask which trust bundle you would need to validate that signature, and whether you have it.

</details>

<details>
<summary>Hint 3</summary>

C is correctly signed and hasn't expired. Look at who it was issued *for*.

</details>

<details>
<summary>Answer</summary>

Accept only A.

Reject B: it names a trust domain (`evil.lab`) whose bundle you don't hold, and its signature doesn't chain to `nico.lab`'s keys. A valid signature from *some* key means nothing unless it is the key of a trust domain you trust.

Reject C: it passes the signature check but was issued for the audience `billing`. Accepting it would let anyone who got hold of a billing token replay it against you. This is why the audience claim is mandatory for JWT-SVIDs.

</details>

### Explain it

In your own words: An X.509-SVID is useless without its private key, but a JWT-SVID works for whoever holds it. In your own words, explain why that difference makes short lifetimes and a mandatory audience much more important for JWT-SVIDs than for X.509-SVIDs.

### Check

**1. Where does a verifier read the SPIFFE ID in an X.509-SVID?**

A. The subject Common Name (CN)
B. A single URI Subject Alternative Name
C. The issuer field
D. The certificate serial number

<details>
<summary>Answer</summary>

**B.** A single URI Subject Alternative Name

SPIFFE puts the ID in exactly one URI SAN. The CN is a legacy free-text field that is often wrongly treated as identity. The issuer field names the CA, not the workload. A serial number is only unique within one CA.

</details>

**2. Which claim is required in a JWT-SVID and limits which services may accept it?**

A. iss
B. aud
C. jti
D. kid

<details>
<summary>Answer</summary>

**B.** aud

`aud` (audience) is required in JWT-SVIDs, and a verifier must find itself listed there. `iss` names the issuer but doesn't limit where the token can be replayed. `jti` is an optional unique ID. `kid` is a header field that picks the signing key.

</details>

**3. In NICo, which path issues SPIFFE JWT-SVIDs to tenant workloads on an instance?**

A. Keycloak's client_credentials flow
B. cert-manager's site-issuer
C. The DPU's instance metadata service (IMDS), with NICo signing using per-tenant keys
D. Vault PKI

<details>
<summary>Answer</summary>

**C.** The DPU's instance metadata service (IMDS), with NICo signing using per-tenant keys

According to the glossary and the Day 0 machine identity guide, tenant processes read identity from IMDS on the DPU (or the DPU calls Core gRPC), and NICo signs the JWT-SVID. Keycloak issues REST API tokens for operators. cert-manager and Vault PKI issue X.509 service certificates.

</details>

**Sources:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md)

<a id="client-identity"></a>
## 2. Client identity

*Builds on: mTLS / gRPC (ch. 19)*

### Before you read

- A gRPC server sits behind Kubernetes networking and 200 agents call it. To limit each agent to N requests per minute, what should the server key the limit on: the source IP, a header the client sends, or something else?
- Ten simulated agents in a lab all use the same client certificate. How many clients does the server see?

<details>
<summary>Answers</summary>

- **A gRPC server sits behind Kubernetes networking and 200 agents call it. To limit each agent to N requests per minute, what should the server key the limit on: the source IP, a header the client sends, or something else?** Something else: the identity in the client's TLS certificate, which the server verified itself during the mTLS handshake. NAT and proxies rewrite source IPs, and pods change IPs. A header is whatever the client chooses to send, so the server can't trust it.
- **Ten simulated agents in a lab all use the same client certificate. How many clients does the server see?** One. The server can only tell callers apart by the identity they prove. All ten share one identity, so they share one limit.

</details>

### Explanation

In ordinary TLS, only the server proves who it is. In **mutual TLS (mTLS)**, which you met in ch. 19, the server also asks for a client certificate and checks that it chains to a CA the server trusts. The client proves it holds the matching private key. When the handshake finishes, the server has a **verified client identity**: the subject and SANs of a certificate it validated itself. Nothing in the request body can forge that.

**Client identity** means using that verified identity as the key for decisions. A common example is **per-client limits**, where each caller gets its own budget so one misbehaving caller can't starve the rest. This course defines client identity as the identity `nico-api` uses to apply such limits. The pages cited in this lesson don't document how `nico-api` does it, so this lesson teaches the general mTLS pattern. Chapter 32 (API admission control) returns to `nico-api` specifics.

**Why NICo needs this pattern.** Many agents call Core at the same time. The architecture overview says each DPU agent polls the API Service every 30 seconds, and that Scout, DHCP, PXE, DNS, Hardware Health, the SSH console and the admin CLI all connect over mTLS/gRPC. The Quick Start health check lists a cert-manager `Certificate` named `core-grpc-client-site-agent-certs` in the `nico-rest` namespace. Its name indicates a dedicated Core gRPC client certificate for the site agent.

**A documented NICo limit.** The DPU agent rate-limits IMDS identity requests (`GET …/meta-data/identity`) with a GCRA limiter, set in the `[machine-identity]` section of its config. The defaults are `requests-per-second = 3`, `burst = 8` and `wait-timeout-secs = 2`. A request that gets no permit within the wait time fails. This is admission control on the agent side. The docs don't say how it groups callers, so don't assume it is per client.

Three consequences of keying on identity:

1. **Identity comes from the certificate, not the network.** Pod IPs, NAT and load balancers make the source address meaningless as an identity.
2. **Use one identity per caller.** If each agent has its own certificate, each gets its own limit and its own audit trail. If several processes share a certificate, which is common in labs, the server sees one client. They then share one budget and their actions can't be told apart.
3. **Identity is not permission.** Identity answers *who*. Limits answer *how much*. Deciding *what they may do* is authorization, the topic of the next lesson (RBAC).

Three terms to keep apart:
- **Authentication**: proving who you are (the handshake).
- **Authorization**: deciding what you may do.
- **Admission control**: deciding whether to accept this request right now. Limits are one kind.

**Analogy.** Think of an office gym whose badge reader allows each employee three visits a day. It counts by badge, not by which door you came through. The analogy breaks down when people share badges. If a team passes one badge around, the reader sees one person who hits the limit quickly, and the log can't say who actually came in. A shared client certificate has the same problem, and copying a private key is as easy as lending a badge.

### Worked example: See exactly what an mTLS server learns about its client

**Step 1: Issue a server cert and a second client SVID.**

Run this in `~/nico-ch21` (from the SPIFFE lesson). First define a helper. You'll reuse it in the KMIP lesson, so keep this shell open or save the function to a file.
```bash
issue() {  # name san eku
  openssl ecparam -genkey -name prime256v1 -noout -out "pki/$1.key"
  openssl req -new -key "pki/$1.key" -subj "/CN=$1" -out "pki/$1.csr"
  printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=%s\nsubjectAltName=%s\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n' "$3" "$2" > "pki/$1.ext"
  openssl x509 -req -in "pki/$1.csr" -CA pki/ca.pem -CAkey pki/ca.key \
    -CAcreateserial -sha256 -days 7 -extfile "pki/$1.ext" -out "pki/$1.pem"
}
issue server "DNS:localhost,IP:127.0.0.1" serverAuth
issue dpu-02 "URI:spiffe://nico.lab/dpu-agent/dpu-02" clientAuth
```
Certificates from this helper are valid for 7 days.

**Step 2: Run a server that requires and prints client certs.**

Save as `whoami.py`:
```python
import http.server, ssl

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        cert = self.connection.getpeercert()
        body = f"subject={cert.get('subject')}\nsan={cert.get('subjectAltName')}\n".encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("pki/server.pem", "pki/server.key")
ctx.load_verify_locations("pki/ca.pem")
ctx.verify_mode = ssl.CERT_REQUIRED
srv = http.server.HTTPServer(("127.0.0.1", 9443), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
```
Start it with `python3 whoami.py`. `CERT_REQUIRED` is what turns plain TLS into mTLS.

**Step 3: Call it as two different agents.**

In a second terminal:
```bash
cd ~/nico-ch21
for a in dpu-01 dpu-02; do
  curl -s --cacert pki/ca.pem --cert pki/$a.pem --key pki/$a.key https://127.0.0.1:9443/
done
```
Expected:
```
subject=((('commonName', 'dpu-01'),),)
san=(('URI', 'spiffe://nico.lab/dpu-agent/dpu-01'),)
subject=((('commonName', 'dpu-02'),),)
san=(('URI', 'spiffe://nico.lab/dpu-agent/dpu-02'),)
```
Both calls come from the same IP (127.0.0.1), yet the server sees two distinct, verified identities.

**Step 4: Try to call anonymously.**

```bash
curl -s --cacert pki/ca.pem https://127.0.0.1:9443/ ; echo "exit=$?"
```
curl fails with a TLS error, typically exit 35 or 56, because the server rejects a handshake with no client certificate. Without an identity there is no request, and no application code runs.

### Your turn: finish it

Complete this admission function. It should key a per-client call counter on the caller's single SPIFFE URI SAN and reject a caller once it exceeds `LIMIT` calls. `cert` is the dict returned by `getpeercert()`.

```text
from collections import Counter

calls = Counter()
LIMIT = 3

def admit(cert):
    sans = cert.get("subjectAltName", ())
    ids = [v for (k, v) in sans if k == ___]
    if len(ids) != 1:
        return False
    calls[ids[0]] += 1
    return calls[ids[0]] <= ___
```

<details>
<summary>Answer</summary>

The first blank is "URI", the SAN type Python reports for SPIFFE IDs. The second blank is LIMIT. The filled lines read:
    ids = [v for (k, v) in sans if k == "URI"]
    return calls[ids[0]] <= LIMIT

</details>

### Your turn: on your own

In a test lab you run 50 simulated DPU agents against a server that enforces per-client limits keyed on client-certificate identity. All 50 agents mount the same client certificate and key from one Kubernetes Secret. After you turn the limits on, most agents get rejected, even though each one only calls every 30 seconds. Explain what is happening and give two possible fixes. Say which one is the sound design.

<details>
<summary>Hint 1</summary>

How many distinct identities does the server see?

</details>

<details>
<summary>Hint 2</summary>

50 agents × 2 calls per minute all land in which bucket?

</details>

<details>
<summary>Hint 3</summary>

One fix changes the certificates and the other changes the limit. Only one keeps per-agent isolation.

</details>

<details>
<summary>Answer</summary>

The server sees one client, because all 50 agents prove the same identity. Their combined ~100 calls per minute land in a single per-client bucket and quickly exceed a limit sized for one agent.

Fix 1, the sound design: give each agent its own certificate with a distinct SAN, for example `spiffe://nico.lab/dpu-agent/sim-17`, so each gets its own budget and its own audit trail. This is the one-identity-per-caller pattern.

Fix 2, a lab-only workaround: raise the limit for the shared identity. This hides the problem and loses per-agent isolation and auditing.

Keying on pod IP instead would be fragile, because IPs change and NAT rewrites them.

</details>

### Explain it

In your own words: Why is the identity from a verified client certificate a better key for per-client limits than the request's source IP address or a client-supplied header? Name the specific failure each alternative would cause.

### Check

**1. A server applies per-client limits over mTLS. Where should it take the client identity from?**

A. The client's source IP address
B. A username field in the gRPC request body
C. The client certificate the server verified during the TLS handshake
D. The Kubernetes namespace of the server pod

<details>
<summary>Answer</summary>

**C.** The client certificate the server verified during the TLS handshake

Only the certificate is proven cryptographically. IPs change, and NAT and load balancers rewrite them. Body fields are whatever the client chooses to send. The server's own namespace says nothing about the caller.

</details>

**2. Two processes share one client certificate. What does a server with per-client limits do?**

A. Gives each process its own limit, because they have different PIDs
B. Treats them as one client sharing one limit
C. Rejects both, because certificates can't be shared
D. Falls back to IP-based limits automatically

<details>
<summary>Answer</summary>

**B.** Treats them as one client sharing one limit

The server can only tell callers apart by the identity they prove, and it can't see PIDs. TLS doesn't detect sharing, because anyone holding the key can complete the handshake. There is no automatic IP fallback.

</details>

**3. A DPU agent completes the mTLS handshake but then calls an RPC it isn't allowed to use. Which concept rejects that call?**

A. Authentication
B. Authorization (e.g. RBAC)
C. The TLS cipher suite
D. Certificate revocation

<details>
<summary>Answer</summary>

**B.** Authorization (e.g. RBAC)

The handshake already authenticated the caller, so the server knows who it is. Whether that identity may call this RPC is an authorization decision. Cipher suites protect the connection and revocation covers whether the certificate is still valid. Neither grants or denies individual RPCs.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md)

<a id="role-based-access-control"></a>
## 3. Role-Based Access Control (RBAC)

*Builds on: Client identity (ch. 21)*

### Before you read

- A site has 40 operators. When someone joins or leaves the on-call rotation, which is less error-prone: editing a list of permissions on each operator, or editing which group each operator is in? Why?
- Kubernetes RBAC (ch. 14) has Roles and RoleBindings. Which one says *what* is allowed and which says *who* gets it?

<details>
<summary>Answers</summary>

- **A site has 40 operators. When someone joins or leaves the on-call rotation, which is less error-prone: editing a list of permissions on each operator, or editing which group each operator is in? Why?** Editing group (role) membership. Each role's permissions are defined once, so a change in who is on call is a single membership change. You don't rebuild permission lists person by person, which is where mistakes and leftover privileges creep in.
- **Kubernetes RBAC (ch. 14) has Roles and RoleBindings. Which one says *what* is allowed and which says *who* gets it?** A Role lists the permitted verbs on resources (what). A RoleBinding attaches that Role to users, groups or service accounts (who).

</details>

### Explanation

**Role-Based Access Control (RBAC)** puts a layer between identities and permissions:

```
identity  ──(binding)──▶  role  ──(grant)──▶  permissions
```

Permissions are named actions such as "read sites" or "start rack maintenance". You grant permissions to **roles**, and you **bind** identities to roles. An authorization check asks one question: *does any role bound to this caller include this permission?* If nothing grants it, the answer is no. This is **default deny**. Giving each role only what its job needs is **least privilege**.

RBAC builds on client identity. The previous lesson gave the server a verified *who*. RBAC turns that into *what*.

**In NICo REST (JWT).** Callers send a JWT. The *JWT claims processor pipeline* maps the token's claims into an internal authorization context. It has processor types for Custom, KAS (NGC), Keycloak and SSA (service account) tokens. Roles come in two families, each with an admin and a viewer variant:

| Role | Scope | Can do |
|---|---|---|
| Provider admin | org / infrastructure provider | manage sites, hardware, tenants, expected machines, racks |
| Provider viewer | org / infrastructure provider | read sites, expected racks, machines |
| Tenant admin | org / tenant | manage instances, SSH keys, VPC peering in *that* tenant |
| Tenant viewer | org / tenant | read tenant resources |

Two details matter in practice:

- **Scope.** A tenant admin is an admin of *their own* tenant only. Every role grant applies within a scope.
- **Role string format.** The REST SDK and current OpenAPI use suffixes such as `PROVIDER_ADMIN` and `TENANT_ADMIN`. Some older snapshots and the bundled dev Keycloak examples use prefixed strings such as `NICO_PROVIDER_ADMIN`. Use whatever format your issuer and API version expect. A mismatch shows up as `403`, not as a login failure.

**In NICo Core (gRPC).** Site administrators reach Core with `nico-admin-cli` over mTLS/gRPC. This course's outline mentions Core-side RBAC, with a permission named `OnDemandRackMaintenance` granted to a role named `NicoAdminCLI`. The docs pages cited here don't describe Core's role model, though. In this lesson's exercises, treat Core-style role and permission names as illustrative and don't rely on them as real NICo strings.

**Analogy.** RBAC is like job titles in a building access system. The system grants "Electrician" access to the plant rooms, and HR assigns people to titles. When someone moves teams, you change their title and leave the door list alone. The analogy breaks down on scope. In NICo, "Tenant admin" means admin of one specific tenant, closer to "Electrician, Building B only". A title without its scope isn't the whole grant.

### Worked example: A tiny RBAC engine modelled on NICo REST roles

**Step 1: Define role → permission grants.**

Save as `rbac.py`. The role names follow NICo REST's suffix style. The permission names are illustrative, not NICo's internal strings.
```python
PERMISSIONS = {
    "PROVIDER_ADMIN":  {"site:read", "site:write", "machine:read", "machine:write", "tenant:write"},
    "PROVIDER_VIEWER": {"site:read", "machine:read"},
    "TENANT_ADMIN":    {"instance:read", "instance:write", "sshkey:write"},
    "TENANT_VIEWER":   {"instance:read"},
}
```

**Step 2: Bind identities to roles.**

Add the bindings:
```python
BINDINGS = {
    "ops-bot":  ["PROVIDER_ADMIN"],
    "auditor":  ["PROVIDER_VIEWER"],
    "acme-ci":  ["TENANT_ADMIN"],
}
```
In NICo REST these identities and roles come from JWT claims, through the claims processor pipeline. In an mTLS service, the identity could instead be the verified certificate SAN from the previous lesson.

**Step 3: Write a default-deny check.**

```python
def allowed(who, perm):
    return any(perm in PERMISSIONS.get(r, set()) for r in BINDINGS.get(who, []))

for who, perm in [("auditor", "site:read"), ("auditor", "site:write"),
                  ("acme-ci", "instance:write"), ("acme-ci", "site:read"),
                  ("stranger", "site:read")]:
    print(f"{who:9} {perm:15} {'ALLOW' if allowed(who, perm) else 'DENY'}")
```
An unknown identity has no roles and an unknown role has no permissions, so both fall through to `DENY`.

**Step 4: Run it and read the results.**

```bash
python3 rbac.py
```
```
auditor   site:read       ALLOW
auditor   site:write      DENY
acme-ci   instance:write  ALLOW
acme-ci   site:read       DENY
stranger  site:read       DENY
```
To give a second auditor access, you add one binding and change no permission lists.

### Your turn: finish it

This is an illustrative model of RBAC in a gRPC control plane. The role names, permission names and SPIFFE IDs are made up for practice and are not taken from NICo's code. Fill in the blanks so that `allowed()` is default-deny and doesn't crash for an identity with no role.

```text
PERMISSIONS = {
    "AdminCli": {"RackMaintenance", "ListMachines"},
    "DpuAgent": {"GetNetworkConfig", "ReportHealth"},
}
ROLE_OF = {
    "spiffe://nico.lab/admin-cli/alice": "AdminCli",
    "spiffe://nico.lab/dpu-agent/dpu-01": "DpuAgent",
}

def allowed(identity, permission):
    role = ROLE_OF.get(identity)
    return permission in PERMISSIONS.get(___, ___)
```

<details>
<summary>Answer</summary>

Fill in role and set(), giving: return permission in PERMISSIONS.get(role, set()). For an unknown identity, role is None, PERMISSIONS.get(None, set()) returns an empty set, and the check returns False.

</details>

### Your turn: on your own

Add scope to the worked example's model. Bindings become (role, scope) pairs such as ("TENANT_ADMIN", "tenant:acme"), and each check names the scope of the target resource. Write `allowed(who, perm, scope)` and show that acme's CI can write instances in tenant acme but not in tenant globex.

<details>
<summary>Hint 1</summary>

Change BINDINGS so each value is a list of (role, scope) tuples.

</details>

<details>
<summary>Hint 2</summary>

A grant applies only when the binding's scope equals the resource's scope and the role contains the permission.

</details>

<details>
<summary>Hint 3</summary>

any(perm in PERMISSIONS.get(r, set()) and s == scope for (r, s) in BINDINGS.get(who, []))

</details>

<details>
<summary>Answer</summary>

BINDINGS = {"acme-ci": [("TENANT_ADMIN", "tenant:acme")], "auditor": [("PROVIDER_VIEWER", "provider:ncx")]}

def allowed(who, perm, scope):
    return any(perm in PERMISSIONS.get(r, set()) and s == scope
               for (r, s) in BINDINGS.get(who, []))

allowed("acme-ci", "instance:write", "tenant:acme")   # True
allowed("acme-ci", "instance:write", "tenant:globex") # False

This matches NICo REST, where the tenant admin role is scoped to an org and a tenant. Without scope, any tenant admin could manage every tenant's instances.

</details>

### Explain it

In your own words: NICo REST grants capabilities to roles such as provider admin and tenant viewer, not to individual users. Explain why. What goes wrong over time if you grant permissions to each identity directly?

### Check

**1. A support engineer must look at sites and machines across the provider's infrastructure but must not change anything. Which NICo REST role fits?**

A. Provider admin
B. Provider viewer
C. Tenant admin
D. Tenant viewer

<details>
<summary>Answer</summary>

**B.** Provider viewer

Provider viewer gives read-only access to infrastructure-provider resources such as sites, expected racks and machines. Provider admin can also modify them, which breaks least privilege. The tenant roles cover one tenant's resources, such as instances, not provider infrastructure.

</details>

**2. A token from your IdP carries the role NICO_TENANT_ADMIN. The user authenticates fine, but tenant calls return 403. What is the most likely cause?**

A. The JWT signature is invalid
B. The role string format doesn't match what the target API version expects (e.g. TENANT_ADMIN)
C. Tenant admins can never call tenant endpoints
D. The client certificate is missing

<details>
<summary>Answer</summary>

**B.** The role string format doesn't match what the target API version expects (e.g. TENANT_ADMIN)

Authentication worked, so the signature is fine; a bad signature usually gives 401. The glossary notes that both prefixed (NICO_...) and suffix-style role strings appear, depending on the issuer and API version. If the format doesn't match, no role matches and access is denied. REST uses JWTs, not client certificates.

</details>

**3. Under default deny, what happens when an identity is bound to no roles?**

A. It gets viewer access
B. It gets whatever its certificate's CN implies
C. Every permission check fails
D. It inherits the permissions of the last caller

<details>
<summary>Answer</summary>

**C.** Every permission check fails

Under default deny, a permission must be granted explicitly through a role. There is no implicit viewer role, a CN isn't a grant, and permissions never carry over between callers.

</details>

**Sources:** [glossary.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/glossary.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md)

<a id="external-secrets-operator"></a>
## 4. External Secrets Operator (ESO)

*Builds on: Kubernetes Custom Resource (CR/CRD) (ch. 14), HashiCorp Vault (ch. 20), Kubernetes Secret (ch. 14)*

### Before you read

- A pod in namespace `nico-system` needs a CA certificate stored in a Secret in namespace `cert-manager`. Can the pod mount that Secret directly?
- Suppose you copied that Secret once by hand with kubectl. What problem would show up a few months later?

<details>
<summary>Answers</summary>

- **A pod in namespace `nico-system` needs a CA certificate stored in a Secret in namespace `cert-manager`. Can the pod mount that Secret directly?** No. Secret volume mounts and env references only resolve in the pod's own namespace. Something has to put a copy into `nico-system`.
- **Suppose you copied that Secret once by hand with kubectl. What problem would show up a few months later?** When the source rotates (a new CA, a new DB password), the copy goes stale and nothing updates it. There's also no record of where the copy came from.

</details>

### Explanation

An **operator** is a Kubernetes controller that watches Custom Resources (ch. 14) and keeps the cluster matching them. The **External Secrets Operator (ESO)** works with two kinds of resource.

- **SecretStore / ClusterSecretStore** says *where* secrets come from and *how to authenticate* there. ESO supports many backends: Vault, cloud secret managers, and a **Kubernetes provider** that reads Secrets in another namespace or cluster. A SecretStore can only be used from its own namespace. A **ClusterSecretStore** can be referenced from any namespace.
- **ExternalSecret** says *what* to fetch, the name of the **target** Secret to write in the ExternalSecret's own namespace, and a `refreshInterval`. ESO creates and owns the target Secret and re-syncs it on that interval. Rotations propagate, and hand edits to the target get overwritten.

Applications keep mounting a plain Kubernetes Secret and never talk to the backend.

**In NICo.** The architecture overview describes ESO in general terms, as syncing secrets into NICo namespaces. The software prerequisites page is more specific about the reference install. There, ESO copies the **`site-root` CA bundle** and the **database credentials** into the NICo namespaces, through ClusterSecretStores that read Kubernetes Secrets in the `cert-manager` and `postgres` namespaces. In that setup *ESO does not read Vault*. The required objects include:

- ClusterSecretStores for the `cert-manager` and `postgres` namespaces
- ExternalSecret `nico-roots-eso` → target Secret `nico-roots` with keys `site-root` and `nico-root`
- per-namespace DB credential ExternalSecrets, e.g. `clouddb-db-eso` → `nico.nico-pg-cluster.credentials`

The source Secrets live in those namespaces because cert-manager holds the CA there and the Zalando operator writes DB credentials there. ESO comes first in the foundation-services install order, and `setup.sh` installs it in phase 5 alongside `nico-prereqs` and `nico-pg-cluster`. The Quick Start health check confirms the result:

```bash
kubectl get clustersecretstore
kubectl get secret nico-roots -n nico-system
kubectl get secret nico-system.nico.nico-pg-cluster.credentials -n nico-system
```

**Analogy.** ESO is like a records clerk with a standing order: "Keep a current copy of document X from the Finance cabinet in the Engineering cabinet, and check every minute." Engineering reads its own cabinet and never needs a key to Finance. The analogy breaks down on direction and ownership. The clerk copies one way only and treats the Engineering copy as theirs, so anything you scribble on it is replaced at the next check.

### Worked example: Copy a CA bundle across namespaces with ESO on kind (mirrors NICo's nico-roots pattern)

**Step 1: Create a cluster and install ESO.**

You need Docker, `kind`, `kubectl` and `helm`. Pin ESO to 0.14.3, the version `setup.sh` installs, so that the `v1beta1` API used below is served.
```bash
kind create cluster --name eso-lab
helm repo add external-secrets https://charts.external-secrets.io && helm repo update
helm install external-secrets external-secrets/external-secrets \
  -n external-secrets --create-namespace --version 0.14.3
kubectl wait -n external-secrets --for=condition=Available deploy --all --timeout=180s
```

**Step 2: Create the source Secret where the CA lives.**

Reuse `ca.pem` from the SPIFFE lesson. A CA certificate is public, so it's safe to use here.
```bash
cd ~/nico-ch21
kubectl create namespace cert-manager
kubectl create namespace nico-system
kubectl create secret generic site-root -n cert-manager --from-file=ca.crt=pki/ca.pem
```

**Step 3: Give ESO a least-privilege reader and a ClusterSecretStore.**

Save as `store.yaml` and run `kubectl apply -f store.yaml`:
```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: eso-reader
  namespace: cert-manager
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: eso-reader
  namespace: cert-manager
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["authorization.k8s.io"]
    resources: ["selfsubjectrulesreviews"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: eso-reader
  namespace: cert-manager
subjects:
  - kind: ServiceAccount
    name: eso-reader
    namespace: cert-manager
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: eso-reader
---
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: lab-cert-manager-store
spec:
  provider:
    kubernetes:
      remoteNamespace: cert-manager
      server:
        url: https://kubernetes.default.svc
        caProvider:
          type: ConfigMap
          name: kube-root-ca.crt
          key: ca.crt
          namespace: cert-manager
      auth:
        serviceAccount:
          name: eso-reader
          namespace: cert-manager
```
This applies Kubernetes RBAC from ch. 14 to ESO: the store can read Secrets in `cert-manager` and nowhere else.

**Step 4: Declare the ExternalSecret.**

Save as `es.yaml` and run `kubectl apply -f es.yaml`:
```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: nico-roots-eso
  namespace: nico-system
spec:
  refreshInterval: 1m
  secretStoreRef:
    kind: ClusterSecretStore
    name: lab-cert-manager-store
  target:
    name: nico-roots
  data:
    - secretKey: site-root
      remoteRef:
        key: site-root
        property: ca.crt
```
`remoteRef.key` is the source Secret's name, `property` is the key inside it, and `secretKey` is the key to write in the target.

**Step 5: Verify the copy and watch a rotation propagate.**

```bash
kubectl get clustersecretstore            # STATUS Valid, READY True
kubectl get externalsecret -n nico-system  # STATUS SecretSynced
kubectl get secret nico-roots -n nico-system -o jsonpath='{.data.site-root}' \
  | base64 -d | openssl x509 -noout -subject   # subject=CN = nico.lab trust root
# "rotate" the source (any PEM shows the change):
kubectl create secret generic site-root -n cert-manager \
  --from-file=ca.crt=pki/dpu-01.pem --dry-run=client -o yaml | kubectl apply -f -
sleep 70
kubectl get secret nico-roots -n nico-system -o jsonpath='{.data.site-root}' \
  | base64 -d | openssl x509 -noout -subject   # subject=CN = dpu-01
```
Clean up with `kind delete cluster --name eso-lab`.

### Your turn: finish it

Fill in the blanks so that this ExternalSecret uses the cluster-wide store from the worked example and writes a Secret with the name NICo pods expect for the root CA bundle.

```text
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: nico-roots-eso
  namespace: nico-system
spec:
  refreshInterval: 1m
  secretStoreRef:
    kind: ___
    name: lab-cert-manager-store
  target:
    name: ___
  data:
    - secretKey: site-root
      remoteRef:
        key: site-root
        property: ca.crt
```

<details>
<summary>Answer</summary>

kind: ClusterSecretStore, because nico-system couldn't reference a namespaced SecretStore in cert-manager. name: nico-roots, the target Secret name from NICo's software prerequisites.

</details>

### Your turn: on your own

In your kind lab, create a namespace `postgres` holding a Secret `pg-nico-creds` with keys `username` and `password`. Write the objects that make ESO copy **both keys** into a Secret named `nico.nico-pg-cluster.credentials` in `nico-system`, following the pattern NICo uses for DB credentials. Name the ExternalSecret `nico-db-eso`.

<details>
<summary>Hint 1</summary>

You need a second ClusterSecretStore, because the first one's remoteNamespace is cert-manager. It also needs its own reader ServiceAccount, Role and RoleBinding in `postgres`.

</details>

<details>
<summary>Hint 2</summary>

Instead of listing each key under `data`, ESO can copy every key from one source Secret using `dataFrom` with `extract`.

</details>

<details>
<summary>Hint 3</summary>

dataFrom:
    - extract:
        key: pg-nico-creds

</details>

<details>
<summary>Answer</summary>

Create the source first: `kubectl create ns postgres; kubectl create secret generic pg-nico-creds -n postgres --from-literal=username=nico --from-literal=password=s3cret`.

Next, copy the ServiceAccount, Role and RoleBinding from store.yaml, changing their namespace to postgres. Add a ClusterSecretStore named lab-postgres-store with remoteNamespace: postgres, caProvider namespace: postgres and auth.serviceAccount namespace: postgres.

Then add the ExternalSecret:

apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: nico-db-eso
  namespace: nico-system
spec:
  refreshInterval: 1m
  secretStoreRef:
    kind: ClusterSecretStore
    name: lab-postgres-store
  target:
    name: nico.nico-pg-cluster.credentials
  dataFrom:
    - extract:
        key: pg-nico-creds

Verify with `kubectl get secret nico.nico-pg-cluster.credentials -n nico-system -o jsonpath='{.data.password}' | base64 -d`, which should print s3cret.

</details>

### Explain it

In your own words: NICo could put CA bundles and DB passwords into its namespaces with a one-off kubectl copy. Explain why a continuously reconciling operator is the better design, and what new risk it introduces. Think about who can read the source namespaces.

### Check

**1. In NICo's reference install, where do the ClusterSecretStores read the site-root CA bundle and the DB credentials from?**

A. Directly from Vault's KV engine
B. From Kubernetes Secrets in the cert-manager and postgres namespaces
C. From the nico-api ConfigMap
D. From the NGC registry

<details>
<summary>Answer</summary>

**B.** From Kubernetes Secrets in the cert-manager and postgres namespaces

The software prerequisites page says so explicitly, and adds that ESO does not read Vault in this setup. Choosing Vault is a common mistake, because ESO *can* use Vault as a backend in general. ConfigMaps and the registry don't hold these secrets.

</details>

**2. An operator hand-edits the `nico-roots` Secret in `nico-system`. What happens?**

A. ESO pushes the edit back to the source Secret
B. The edit persists permanently
C. ESO overwrites it from the source on the next sync
D. nico-api rejects the Secret

<details>
<summary>Answer</summary>

**C.** ESO overwrites it from the source on the next sync

ESO owns the target and keeps reconciling it toward the source. Sync is one-way, so nothing is written back to the source. Make changes in the source Secret instead.

</details>

**3. Why is a ClusterSecretStore, rather than a SecretStore, the natural choice for NICo's CA bundle?**

A. ClusterSecretStores encrypt data and SecretStores don't
B. One store must serve ExternalSecrets in several NICo namespaces
C. SecretStores can't use the Kubernetes provider
D. ClusterSecretStores don't need any RBAC

<details>
<summary>Answer</summary>

**B.** One store must serve ExternalSecrets in several NICo namespaces

A SecretStore can only be used from its own namespace, while a ClusterSecretStore can be referenced from any namespace, and NICo copies the bundle into several of them. Neither kind adds encryption, and both can use the Kubernetes provider. A ClusterSecretStore still needs a reader with RBAC on the source namespace.

</details>

**Sources:** [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="kmip-kek-provider"></a>
## 5. KMIP KEK provider

*Builds on: mTLS / gRPC (ch. 19), Envelope encryption and KEK (ch. 18)*

### Before you read

- With envelope encryption (ch. 18), data is encrypted with a DEK and the DEK is wrapped with a KEK. Suppose the wrapped DEKs, the ciphertext *and* the KEK all sit in the same database backup. What has the encryption achieved against someone who steals that backup?
- An external key server wants to know which program is asking it for keys. What would you expect that program to present when it connects?

<details>
<summary>Answers</summary>

- **With envelope encryption (ch. 18), data is encrypted with a DEK and the DEK is wrapped with a KEK. Suppose the wrapped DEKs, the ciphertext *and* the KEK all sit in the same database backup. What has the encryption achieved against someone who steals that backup?** Almost nothing. The thief has everything needed to unwrap the DEKs and decrypt the data. The KEK only adds protection if it lives somewhere separate from the ciphertext.
- **An external key server wants to know which program is asking it for keys. What would you expect that program to present when it connects?** A client certificate and its private key over mutual TLS. It also needs a CA bundle to verify the key server. This is the client-identity idea from earlier in the chapter, with NICo now acting as the client.

</details>

### Explanation

Recall envelope encryption. Each secret is encrypted with a **DEK** (data encryption key), and the DEK is stored wrapped by a **KEK** (key-encryption key). Protecting stored secrets therefore comes down to protecting the KEK and controlling who can use it.

**KMIP** (Key Management Interoperability Protocol) is an OASIS standard for talking to key-management servers. Many enterprise key managers and HSM-backed appliances speak it, by convention on TCP port 5696 over mutually authenticated TLS. The key server decides what to allow based on the client's certificate identity. That is client identity and RBAC again, with the key manager as the server.

NICo's **KMIP KEK provider** is an **opt-in** feature. With it enabled, the KEKs that protect stored secrets come from an external KMIP server, so they don't sit in the cluster next to the ciphertext. Other KEK sources exist. The `--skip-vault` preflight, for example, mentions a Vault *Transit* KEK provider. KMIP is the choice when the site's security policy says keys belong in a dedicated key manager.

The connection needs three **client TLS files**:

| File | Purpose |
|---|---|
| `ca.pem` | CA(s) used to verify the KMIP *server's* certificate |
| `client.pem` | nico-api's client certificate, i.e. its identity to the key manager |
| `client.key` | the private key matching `client.pem` |

**How setup wires it in.**
- Set `NICO_KMIP_CLIENT_DIR` to a directory holding exactly those three files. Before Core deploys, `setup.sh` creates the `nico-system/nico-kmip-client` Secret from them for `nico-api` to mount.
- Preflight checks that each of the provider's TLS paths lies under a chart-provided mount, or under a mounted Secret that exists and contains the key the path reads.
- When the site config mentions KMIP, that check needs Python 3.11+ or the `tomli` package. Without either, preflight warns and skips the check, or fails if `NICO_KMIP_CLIENT_DIR` is set.
- Setting the variable together with `--skip-core` is an error, because the Secret exists for Core.

The provider's own TOML settings are documented on NICo's KMIP KEK provider configuration page. Look them up there rather than guessing.

**The trade-off.** You gain separation of duties, the ability to cut off access by revoking the client certificate, and the key manager's audit logs. In return, the key manager becomes a dependency. In general, anything that needs the KEK can't unwrap secrets while the key manager is unreachable.

**Analogy.** It works like a bank's safe-deposit vault. Your locked boxes (the wrapped DEKs) can sit in your own office, but the master key is held at the bank. Before using it you show bank-issued ID (`client.pem` and `client.key`) and check that you're at the real bank (`ca.pem`). The analogy breaks down because a bank never hands out its master key. Whether a KMIP key ever leaves the key manager, or the server unwraps on your behalf, depends on how the provider uses KMIP. Check NICo's KMIP configuration page rather than assuming either.

### Worked example: Prepare and validate a NICO_KMIP_CLIENT_DIR

**Step 1: Get a client certificate for nico-api.**

In production, the key-manager team issues this certificate from a CA their KMIP server trusts. In the lab, the `nico.lab` CA stands in for it. Use the `issue()` helper from the client-identity lesson, which issues certificates valid for 7 days. If you're in a new shell, paste the helper's definition in again first.
```bash
cd ~/nico-ch21
issue nico-api-kmip "URI:spiffe://nico.lab/nico-api" clientAuth
```

**Step 2: Assemble the directory with the exact file names.**

```bash
mkdir -p kmip-client
cp pki/ca.pem            kmip-client/ca.pem      # lab: same CA signs the server too
cp pki/nico-api-kmip.pem kmip-client/client.pem
cp pki/nico-api-kmip.key kmip-client/client.key
chmod 600 kmip-client/client.key
ls kmip-client   # ca.pem  client.key  client.pem
```

**Step 3: Check that the key matches the certificate.**

A key/cert mismatch is the most common packaging error. Compare the public keys:
```bash
cert_pub=$(openssl x509 -in kmip-client/client.pem -noout -pubkey)
key_pub=$(openssl pkey -in kmip-client/client.key -pubout)
[ "$cert_pub" = "$key_pub" ] && echo match || echo MISMATCH
```
Expected: `match`.

**Step 4: Check purpose and lifetime.**

```bash
openssl x509 -in kmip-client/client.pem -noout -text | grep -A1 "Extended Key Usage"
openssl x509 -in kmip-client/client.pem -noout -checkend 86400 && echo "valid >24h"
```
Expected output:
```
            X509v3 Extended Key Usage: 
                TLS Web Client Authentication
Certificate will not expire
valid >24h
```
`-checkend 86400` asks whether the certificate is still valid 24 hours from now. That works here because the helper issued the certificate for 7 days. A 1-day certificate would print `Certificate will expire` and skip the echo.

In the lab, `openssl verify -CAfile kmip-client/ca.pem kmip-client/client.pem` also passes, because one CA signs everything. That's a lab-only check. In production, `ca.pem` is the CA of the KMIP *server*, which may differ from the CA that signed your client certificate.

**Step 5: Probe a real KMIP server, then hand the directory to setup.**

**The lab certificates are for practice only.** On a real site, use the CA bundle and client certificate supplied by your key-manager team and repeat the checks above on those files.

If you have a KMIP server, a plain TLS probe shows whether both sides accept each other:
```bash
openssl s_client -connect kmip.example.com:5696 \
  -CAfile kmip-client/ca.pem -cert kmip-client/client.pem -key kmip-client/client.key </dev/null \
  | grep 'Verify return code'
```
Then opt in. Export the variable as an **absolute** path, change into the `helm-prereqs/` directory of your infra-controller repository checkout, and run preflight there:
```bash
export NICO_KMIP_CLIENT_DIR="$HOME/nico-ch21/kmip-client"   # absolute path
cd /path/to/infra-controller/helm-prereqs                     # your repo checkout
source ./preflight.sh
```
Preflight also checks the cluster, tools and values files, so expect it to fail fast if you don't have a real target cluster.

### Your turn: finish it

Complete the key/certificate match check. Both commands must print the public key in the same PEM format so the two strings can be compared.

```text
cert_pub=$(openssl x509 -in client.pem -noout ___)
key_pub=$(openssl pkey -in client.key ___)
[ "$cert_pub" = "$key_pub" ] && echo match || echo MISMATCH
```

<details>
<summary>Answer</summary>

cert_pub=$(openssl x509 -in client.pem -noout -pubkey) and key_pub=$(openssl pkey -in client.key -pubout). Both print a "-----BEGIN PUBLIC KEY-----" block.

</details>

### Your turn: on your own

After a certificate rotation, the KMIP connection breaks. For each symptom reported by the TLS layer, say which of the three files is wrong and why:
(a) On the client side: "certificate verify failed: unable to get local issuer certificate" when verifying the KMIP server.
(b) The KMIP server aborts the handshake with an "unknown ca" or "bad certificate" alert after receiving the client's certificate.
(c) Loading the TLS files fails with "key values mismatch" before any connection is attempted.

<details>
<summary>Hint 1</summary>

For each case, work out which side is doing the verifying: the client verifying the server, or the server verifying the client.

</details>

<details>
<summary>Hint 2</summary>

ca.pem is only used to judge the server. client.pem is what the server judges.

</details>

<details>
<summary>Hint 3</summary>

(c) never touches the network, so it's about two local files disagreeing.

</details>

<details>
<summary>Answer</summary>

(a) ca.pem. The client can't build a chain from the KMIP server's certificate to anything in ca.pem, so the bundle is missing the server's issuing CA, possibly a new one.

(b) client.pem. The server doesn't trust the CA that signed the new client certificate, or the certificate has the wrong purpose or has expired. Get it reissued by a CA the key manager trusts, and make sure the key manager's policy grants that identity access.

(c) client.key and client.pem don't belong together. Typically the new certificate was copied in alongside the old key. Re-pair them and confirm with the public-key comparison.

</details>

### Explain it

In your own words: Explain why keeping the KEK in an external KMIP server, rather than in the same database or cluster as the encrypted secrets, actually increases security. What operational cost does the site take on in exchange?

### Check

**1. What does NICo's KMIP KEK provider get from the external KMIP server?**

A. Every stored credential, in plaintext
B. The key-encryption keys that protect stored secrets
C. nico-api's TLS serving certificate
D. Tenant JWT-SVIDs

<details>
<summary>Answer</summary>

**B.** The key-encryption keys that protect stored secrets

The provider deals only in KEKs. The secrets themselves stay envelope-encrypted where NICo stores them. Serving certificates come from cert-manager, and NICo's machine identity feature signs JWT-SVIDs.

</details>

**2. Which file in NICO_KMIP_CLIENT_DIR is nico-api's identity to the key manager?**

A. ca.pem
B. client.pem (with client.key proving possession)
C. nico-kmip-client
D. site-root

<details>
<summary>Answer</summary>

**B.** client.pem (with client.key proving possession)

client.pem is the certificate the KMIP server checks, and client.key proves nico-api holds it. ca.pem is only for verifying the server. nico-kmip-client is the Secret setup creates from the directory. site-root is NICo's CA bundle and has nothing to do with KMIP.

</details>

**3. You run `setup.sh --skip-core` with NICO_KMIP_CLIENT_DIR exported. What happens?**

A. setup silently ignores the variable
B. setup creates the Secret anyway for later
C. It's an error, because the Secret exists for nico-api, which this run won't deploy
D. setup switches to the Vault Transit provider

<details>
<summary>Answer</summary>

**C.** It's an error, because the Secret exists for nico-api, which this run won't deploy

The Quick Start's variable table says NICO_KMIP_CLIENT_DIR is an error with --skip-core. setup creates the Secret just before Core deploys so that nico-api can mount it. It doesn't silently ignore the variable or switch providers.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md)

<a id="build-task"></a>
## Build task: Build an identity-aware mini control plane

**Goal:** Run a local mTLS API that takes each caller's SPIFFE ID from its X.509-SVID, rejects callers from other trust domains, authorises actions by role, and applies per-client limits. Then package and validate a KMIP-style client TLS directory.

**Why it matters for NICo:** NICo's control-plane services and agents all talk to nico-api over mTLS/gRPC, and NICo REST authorises callers by role. This lab puts the layers from the chapter side by side:
- the verified certificate identity (authentication)
- a per-identity budget (admission control)
- a role check (authorization)
- the trust bundle that stops foreign certificates at the handshake

The role names and the limiter are illustrative, not NICo's internals. The layering is what you'll reason about when a real agent is throttled or an admin gets 403. The last step practises the checks to run before you point NICO_KMIP_CLIENT_DIR at a directory.

**You need:**

- Linux or macOS with bash, curl and Python 3.8+ (standard library only)
- OpenSSL 1.1.1+ or 3.x. On macOS, if the system LibreSSL errors, run `brew install openssl@3` and put it first on PATH
- Two terminals and a free TCP port 8443
- A fresh working directory, e.g. `mkdir ~/idlab && cd ~/idlab`. Run every command from there

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Mint the trust domain and SVIDs</summary>

Save as `mkcerts.sh`, then run `bash mkcerts.sh`:
```bash
#!/usr/bin/env bash
# mkcerts.sh - lab trust domain "nico.lab", its SVIDs, and a rogue CA
set -euo pipefail
rm -rf pki rogue && mkdir pki rogue

newca() {  # dir cn
  openssl ecparam -genkey -name prime256v1 -noout -out "$1/ca.key"
  openssl req -x509 -new -key "$1/ca.key" -sha256 -days 30 -subj "/CN=$2" -out "$1/ca.pem"
}

issue() {  # dir name san eku
  local dir=$1 name=$2 san=$3 eku=$4
  openssl ecparam -genkey -name prime256v1 -noout -out "$dir/$name.key"
  openssl req -new -key "$dir/$name.key" -subj "/CN=$name" -out "$dir/$name.csr"
  cat > "$dir/$name.ext" <<EOF
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=$eku
subjectAltName=$san
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EOF
  openssl x509 -req -in "$dir/$name.csr" -CA "$dir/ca.pem" -CAkey "$dir/ca.key" \
    -CAcreateserial -sha256 -days 7 -extfile "$dir/$name.ext" -out "$dir/$name.pem"
}

newca pki "nico.lab trust root"
issue pki server   "DNS:localhost,IP:127.0.0.1"             serverAuth
issue pki dpu-01   "URI:spiffe://nico.lab/dpu-agent/dpu-01" clientAuth
issue pki dpu-02   "URI:spiffe://nico.lab/dpu-agent/dpu-02" clientAuth
issue pki alice    "URI:spiffe://nico.lab/admin-cli/alice"  clientAuth
issue pki nico-api "URI:spiffe://nico.lab/nico-api"         clientAuth

newca rogue "rogue root"
issue rogue dpu-01 "URI:spiffe://nico.lab/dpu-agent/dpu-01" clientAuth
echo done
```
The rogue `dpu-01` *claims* the same SPIFFE ID as the real one but is signed by a different root.

</details>

<details>
<summary>Step 2: Inspect the identities</summary>

```bash
for c in pki/dpu-01 pki/alice rogue/dpu-01; do
  echo "$c:"; openssl x509 -in $c.pem -noout -text | grep -A1 'Subject Alternative Name' | tail -1
  openssl verify -CAfile pki/ca.pem $c.pem 2>&1 | tail -1
done
```
Both `dpu-01` certificates show the same URI, but only the real one verifies against `pki/ca.pem`. An identity claim is worth nothing without the trust bundle.

</details>

<details>
<summary>Step 3: Write the server: identity, limits, RBAC</summary>

Save as `server.py`:
```python
#!/usr/bin/env python3
import http.server, json, ssl, time

TRUST_DOMAIN = "spiffe://nico.lab/"
ROLES = {  # SPIFFE ID prefix -> role (illustrative, not NICo role names)
    "spiffe://nico.lab/dpu-agent/": "Agent",
    "spiffe://nico.lab/admin-cli/": "Admin",
}
PERMS = {  # role -> allowed actions (illustrative names)
    "Agent": {"GetNetworkConfig", "ReportHealth"},
    "Admin": {"GetNetworkConfig", "ListMachines", "RackMaintenance"},
}
LIMIT, WINDOW = 5, 10  # 5 requests per client per 10 seconds
counters = {}

def spiffe_id(cert):
    ids = [v for (k, v) in cert.get("subjectAltName", ()) if k == "URI"]
    return ids[0] if len(ids) == 1 else None

def role_for(sid):
    for prefix, role in ROLES.items():
        if sid.startswith(prefix):
            return role
    return None

class H(http.server.BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        sid = spiffe_id(self.connection.getpeercert())
        if sid is None or not sid.startswith(TRUST_DOMAIN):
            return self.reply(401, {"error": "no SPIFFE ID in nico.lab"})
        now = time.time()
        start, n = counters.get(sid, (now, 0))
        if now - start >= WINDOW:
            start, n = now, 0
        n += 1
        counters[sid] = (start, n)
        if n > LIMIT:
            return self.reply(429, {"client": sid, "error": "per-client limit"})
        action = self.path.strip("/")
        role = role_for(sid)
        if action not in PERMS.get(role, set()):
            return self.reply(403, {"client": sid, "role": role, "action": action})
        self.reply(200, {"client": sid, "role": role, "action": action})

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("pki/server.pem", "pki/server.key")
ctx.load_verify_locations("pki/ca.pem")
ctx.verify_mode = ssl.CERT_REQUIRED
srv = http.server.HTTPServer(("127.0.0.1", 8443), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
print("listening on https://127.0.0.1:8443")
srv.serve_forever()
```
Start it in terminal 1 with `python3 server.py`. A handshake from an untrusted CA fails inside `accept()` and is dropped before `do_GET` runs.

</details>

<details>
<summary>Step 4: Exercise it by hand</summary>

In terminal 2:
```bash
curl -s --cacert pki/ca.pem --cert pki/alice.pem --key pki/alice.key https://127.0.0.1:8443/RackMaintenance; echo
curl -s --cacert pki/ca.pem --cert pki/dpu-01.pem --key pki/dpu-01.key https://127.0.0.1:8443/RackMaintenance; echo
```
Alice, with role `Admin`, gets a `200` JSON reply. dpu-01, with role `Agent`, gets a `403` body that names its role and the action it was denied.

</details>

<details>
<summary>Step 5: Package and check a KMIP client directory</summary>

```bash
mkdir -p kmip-client
cp pki/ca.pem kmip-client/ca.pem
cp pki/nico-api.pem kmip-client/client.pem
cp pki/nico-api.key kmip-client/client.key
chmod 600 kmip-client/client.key
```
Save the following as `check-kmip-dir.sh`, then run `chmod +x check-kmip-dir.sh`:
```bash
#!/usr/bin/env bash
# check-kmip-dir.sh DIR - sanity-check a KMIP client TLS directory
set -euo pipefail
d=${1:?usage: $0 DIR}
for f in ca.pem client.pem client.key; do
  [ -s "$d/$f" ] || { echo "FAIL: missing $d/$f"; exit 1; }
done
cert_pub=$(openssl x509 -in "$d/client.pem" -noout -pubkey)
key_pub=$(openssl pkey -in "$d/client.key" -pubout)
[ "$cert_pub" = "$key_pub" ] || { echo "FAIL: client.key does not match client.pem"; exit 1; }
openssl x509 -in "$d/client.pem" -noout -checkend 86400 >/dev/null \
  || { echo "FAIL: client.pem expires within 24h"; exit 1; }
openssl x509 -in "$d/client.pem" -noout -text | grep -q "TLS Web Client Authentication" \
  || { echo "FAIL: client.pem lacks clientAuth"; exit 1; }
# Lab-only: one CA signs everything here. In production ca.pem verifies the KMIP server.
openssl verify -CAfile "$d/ca.pem" "$d/client.pem" >/dev/null \
  || { echo "FAIL: client.pem does not chain to ca.pem (lab check)"; exit 1; }
echo "OK: $d is a usable KMIP client TLS directory"
```
The certificates from mkcerts.sh are valid for 7 days, so the 24-hour `-checkend` test passes.

Now break it on purpose: copy `pki/dpu-01.key` over `kmip-client/client.key`, rerun the script and see the mismatch reported. Then restore the correct key with `cp pki/nico-api.key kmip-client/client.key`.

</details>

<details>
<summary>Step 6: Run the end-to-end verification</summary>

Save as `verify.sh`:
```bash
#!/usr/bin/env bash
# verify.sh - expects server.py running in another terminal
c() {  # dir name action
  curl -s -o /dev/null -w '%{http_code} ' --cacert pki/ca.pem \
    --cert "$1/$2.pem" --key "$1/$2.key" "https://127.0.0.1:8443/$3" || true
}
sleep 11   # let any earlier rate-limit window expire
c pki dpu-01 GetNetworkConfig
c pki dpu-01 RackMaintenance
c pki alice RackMaintenance
c rogue dpu-01 GetNetworkConfig
for i in 1 2 3 4 5; do c pki dpu-01 ReportHealth; done
c pki dpu-02 GetNetworkConfig
echo
./check-kmip-dir.sh kmip-client
```
With the server still running, run `bash verify.sh`.

</details>

**Check it works:** `bash verify.sh` prints exactly:
```
200 403 200 000 200 200 200 429 429 200 
OK: kmip-client is a usable KMIP client TLS directory
```
Reading left to right:
- dpu-01 may read config (200) but may not start rack maintenance (403, RBAC).
- Alice's Admin role may start rack maintenance (200).
- The rogue certificate never completes the handshake (000).
- dpu-01's 6th and 7th requests in the window are throttled (429), while dpu-02 still gets 200. The limits are per client.
- The KMIP directory passes every check.

<details>
<summary>If you get stuck</summary>

- Every request prints 000: the server isn't running, or you started it from a different directory. The `pki/...` paths are relative, so start server.py and verify.sh from the same directory.
- `openssl x509 -req ... -extfile` errors on macOS: the system LibreSSL may be too old. Install openssl@3 with Homebrew, put it first on PATH and rerun mkcerts.sh.
- Python raises `ssl.SSLError: [SSL] PEM lib` at startup: server.pem and server.key don't match, usually because mkcerts.sh only half ran. Rerun it from scratch.
- The counts are off by one or two (e.g. 429 appears early): requests you made by hand in the last 10 seconds count against dpu-01's window. verify.sh sleeps 11 seconds first to avoid this. Restarting server.py also resets the counters.
- `Address already in use`: another process holds port 8443. Change the port in both server.py and verify.sh.
- The KMIP check says the key doesn't match: you copied the cert and key from different names, e.g. nico-api.pem with dpu-01.key.

</details>

**Stretch goal:** Two extensions.

(1) Replace the fixed-window limiter with a GCRA limiter keyed on the SPIFFE ID. GCRA, with a rate plus a burst, is the algorithm NICo's DPU agent uses to limit IMDS identity requests (defaults: 3 requests per second, burst 8). Show that a burst of 8 passes while a sustained flood is smoothed.

(2) In a kind cluster with ESO 0.14.3:
- store `pki/ca.pem` as `cert-manager/site-root`
- mirror it into `nico-system/nico-roots` with a ClusterSecretStore and an ExternalSecret
- run server.py in a pod that mounts `nico-roots` as its trust bundle
- rotate the CA in the source Secret

Show that clients signed by the old CA start failing once the pod restarts with the new bundle.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (External Secrets Operator (ESO)): The lesson says the architecture overview "describes ESO in general terms, as syncing secrets into NICo namespaces." The overview actually says ESO "syncs secrets from Vault into Kubernetes Secret objects." That contradicts the software prerequisites page, and the lesson's check question depends on the software page's version ("it does not read Vault"). A learner who reads the cited overview will find an unexplained conflict. *Fix:* Say plainly that the overview describes ESO as syncing from Vault, and that the software prerequisites page is more specific about the reference install: there, ESO reads Kubernetes Secrets in cert-manager and postgres, not Vault.
- **minor** (External Secrets Operator (ESO)): Two statements sit side by side without explanation: "ESO comes first in the foundation-services install order" and "setup.sh installs it in phase 5." Phase 5 comes after cert-manager (phase 2) and Vault (phase 3). The docs also mark ESO as optional in that order. Learners may read the two as contradicting each other. *Fix:* Note that the prerequisites page lists ESO (optional) first in its suggested manual order, while setup.sh installs external-secrets in phase 5, after cert-manager and Vault have created the source Secrets it copies.
- **minor** (KMIP KEK provider): "Set NICO_KMIP_CLIENT_DIR to a directory holding exactly those three files" goes further than the docs. The docs only say the directory holds ca.pem, client.pem and client.key. They don't say other files are forbidden. *Fix:* Change "exactly those three files" to "those three files (ca.pem, client.pem, client.key)", or cite the helm-prereqs README if it really does require exactly three.

---

[← 20-credentials-secrets-security-identity.md](20-credentials-secrets-security-identity.md) · [22-discovery-ingestion.md →](22-discovery-ingestion.md)
