# Chapter 19: PKI & Certificates · Authentication & Identity

*Part: Security & Identity · 8 concepts · [curriculum](../curriculum.md#chapter-19)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Chapter 18 gave you the building blocks: hashes, key derivation functions, AES-GCM and public-key signatures. This chapter puts them together into the two trust systems NICo depends on. The first answers **who is calling?** using identity tokens (OIDC, OAuth2, JWT). The second answers **which service am I actually talking to?** using certificates (PKI, TLS, mTLS).

We start with a warning about secret strength. Entropy tells you how hard a secret is to guess, and no KDF can make a weak secret stronger. Next comes the token side: how Keycloak and other OIDC identity providers issue signed JWTs, how a script gets one through the client credentials flow, and how RFC 8693 token exchange turns one token into another. The last part covers certificates: how a CA vouches for keys, how SANs and wildcards decide which hostnames a certificate covers, how mutual TLS protects NICo's gRPC control plane, and how cert-manager issues and renews all of those certificates inside Kubernetes.

These ideas come up all over NICo. Every control-plane service (API Service, DHCP, PXE, DNS, Hardware Health, the DPU Agent, the admin CLI and RMS) talks gRPC over mTLS. NICo REST accepts JWT bearer tokens. The `site-issuer` and `vault-nico-issuer` ClusterIssuers sign the site's certificates. When an install fails with `401`, `certificate verify failed` or `unknown ca`, you will need this chapter to work out why.

**By the end of this chapter you can:**

- Estimate a secret's entropy in bits and explain why HKDF cannot protect a weak input key from offline guessing
- Obtain a JWT through the OAuth2 client credentials flow, decode its claims, and diagnose iss/aud mismatches such as the Keycloak port-forward trap
- Describe an RFC 8693 token exchange request and name the NICo site settings that limit token delegation
- Build a small CA with openssl, issue certificates with correct SANs, and predict which hostnames a wildcard covers
- Run a mutual-TLS service, test it with good and bad client certificates, and explain how NICo control-plane services authenticate each other
- Write cert-manager ClusterIssuer and Certificate resources and relate them to NICo's selfsigned-bootstrap, site-issuer and vault-nico-issuer

**How to use this chapter:** answer each *Before you read* question first, even if you have to guess. Try every problem before opening its answer. Guessing and getting things wrong first is part of how this works.

## Contents

1. [Entropy and Offline Guessing](#entropy-and-offline-guessing)
2. [OIDC / JWT authentication (Keycloak)](#oidc-jwt-authentication)
3. [OAuth2 client credentials flow and JWT bearer tokens](#oauth2-client-credentials-flow-and-jwt-bearer-tokens)
4. [Token delegation (RFC 8693 token exchange)](#token-delegation)
5. [PKI and TLS certificates](#pki-and-tls-certificates)
6. [TLS certificates and X.509 SAN](#tls-certificates-and-x-509-san)
7. [mTLS / gRPC](#mtls-grpc)
8. [cert-manager](#cert-manager)
9. [Build task: A mini site-controller trust chain on your laptop](#build-task)

<a id="entropy-and-offline-guessing"></a>
## 1. Entropy and Offline Guessing

*Builds on: Key Derivation Function (KDF) (ch. 18)*

### Before you read

- A 4-digit PIN goes through HKDF-SHA256 to produce a 256-bit AES key. An attacker knows the salt and info and holds the derived key. At most, how many guesses do they need to recover the PIN?
- Why is guessing passwords against a login page much slower than guessing against a stolen hash or derived key?

<details>
<summary>Answers</summary>

- **A 4-digit PIN goes through HKDF-SHA256 to produce a 256-bit AES key. An attacker knows the salt and info and holds the derived key. At most, how many guesses do they need to recover the PIN?** 10,000. HKDF is deterministic, so 10,000 possible PINs give only 10,000 possible keys. The 256-bit output length doesn't matter.
- **Why is guessing passwords against a login page much slower than guessing against a stolen hash or derived key?** A login page can rate-limit, lock accounts and log attempts. With a stolen verifier, the attacker guesses on their own hardware at billions of tries per second, and nobody can stop or see them.

</details>

### Explanation

**Entropy** measures how unpredictable a secret is, in bits. If a secret is chosen uniformly from N possibilities, it has log2(N) bits. A 4-digit PIN has log2(10,000) ≈ 13.3 bits. Thirty-two bytes from a cryptographically secure random number generator (CSPRNG) have 256 bits. Entropy depends on **how the secret was chosen**, not on how it looks. `Summer2024!` looks complex, but it sits near the top of every attacker's guess list.

Recall HKDF from chapter 18. It *extracts* (HMAC of the input key material, IKM, under a salt) and then *expands* (produces as many bytes as you ask for, tied to an `info` label). The output looks perfectly random, and that is the trap. HKDF is deterministic: the same IKM, salt and info always give the same output. If the IKM was one of 10,000 PINs, there are only 10,000 possible outputs, however long they are. **HKDF concentrates and spreads entropy. It never adds any.** Salt and info are usually not secret, so assume the attacker knows them.

**Offline guessing** means the attacker has a *verifier*: something that tells them a guess is right without asking your server. Examples are a leaked derived key, a password hash, or an AES-GCM ciphertext whose authentication tag only checks out under the right key. There is no rate limit, no lockout and no log, and GPUs compute fast functions like HMAC-SHA256 billions of times per second. Online guessing (a login form) can be throttled. Offline guessing can't.

So one leaked derived key (for example, a key derived for a single card or device) is bad on its own. If the IKM behind it is weak, the damage is much worse. The attacker brute-forces the IKM and can then derive every sibling key by changing `info`.

Defences:
1. **Use high-entropy IKM**: at least 128 bits, usually 256, from a CSPRNG.
2. **If a human must type the secret**, use a deliberately slow password KDF (Argon2id, scrypt, PBKDF2). This makes each guess expensive, but it still adds no entropy.

NICo's docs generate site master keys with `openssl rand -base64 32`, which gives 256 random bits. When configured with an Integrated KEK, `nico-api` checks that the key decodes to 32 bytes. That is only a *length* check: it can't tell random bytes from 32 copies of `a`. Making the key random is your job.

**Analogy.** Picture a bike lock with 4 real number dials plus 30 decorative dials glued on that do nothing. The extra dials (HKDF's long output) make it look strong, but a thief only has to work through the 4 real dials. Where the analogy breaks down: a thief at a bike rack is slow and can be seen. An offline attacker tries billions of combinations per second where nobody can watch.

### Worked example: Recover a PIN from an HKDF-derived key in milliseconds

**Step 1: Count the entropy.**

```bash
python3 -c 'import math; print(math.log2(10**4), 8*math.log2(26), 32*8)'
# 13.28...  37.6...  256
```
A 4-digit PIN gives about 13 bits, 8 random lowercase letters about 38 bits, and 32 random bytes 256 bits.

**Step 2: Derive a key from a weak IKM.**

Save this as `brute.py`. It implements HKDF-SHA256 (RFC 5869) with only the standard library:
```python
import hmac, hashlib, secrets, time

def hkdf(ikm, salt, info, length=32):
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()  # extract
    okm, block, counter = b'', b'', 1
    while len(okm) < length:                             # expand
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        okm += block
        counter += 1
    return okm[:length]

SALT, INFO = b'lab-salt', b'card-42'
pin = f'{secrets.randbelow(10000):04d}'
leaked = hkdf(pin.encode(), SALT, INFO)
print('leaked key:', leaked.hex())
```

**Step 3: Act as the attacker and guess offline.**

Add this to the bottom of `brute.py` and run `python3 brute.py`:
```python
start = time.time()
for guess in range(10000):
    g = f'{guess:04d}'.encode()
    if hkdf(g, SALT, INFO) == leaked:
        print(f'recovered PIN {g.decode()} in {time.time() - start:.3f}s')
        break
```
Pure Python recovers it in a fraction of a second. The attacker can now derive the key for `card-43` as well.

**Step 4: Repeat with a strong IKM.**

Replace the PIN with `ikm = secrets.token_bytes(32)`. The search space becomes 2^256. Even at 10^12 guesses per second, the expected time is far longer than the age of the universe. The HKDF code is identical, so only the input's entropy changed.

### Your turn: finish it

A passphrase is made of 6 words chosen at random from the 7,776-word Diceware list. Fill in the blanks so the one-liner prints its entropy in bits.

```text
python3 -c 'import math; print(___ * math.log2(___))'
```

<details>
<summary>Answer</summary>

python3 -c 'import math; print(6 * math.log2(7776))'  → about 77.5 bits. Each word contributes log2(7776) ≈ 12.9 bits, and independent choices add.

</details>

### Your turn: on your own

An attacker can test 10^9 guesses per second against a leaked derived key. Roughly how long does it take on average to find (a) a 40-bit IKM and (b) a 128-bit IKM?

<details>
<summary>Hint 1</summary>

On average the attacker searches half the space before hitting the right value.

</details>

<details>
<summary>Hint 2</summary>

Work out 2^40 / 2 and 2^128 / 2, then divide by 10^9 guesses per second.

</details>

<details>
<summary>Hint 3</summary>

2^40 ≈ 1.1 × 10^12 and 2^128 ≈ 3.4 × 10^38.

</details>

<details>
<summary>Answer</summary>

(a) 2^39 ≈ 5.5 × 10^11 guesses ÷ 10^9/s ≈ 550 s, about 9 minutes. (b) 2^127 ≈ 1.7 × 10^38 ÷ 10^9 ≈ 1.7 × 10^29 s, about 5 × 10^21 years. Every extra bit doubles the attacker's work.

</details>

### Explain it

In your own words: In your own words: why does running a weak secret through HKDF produce something that looks random but is still easy to guess, and what is the only thing that actually fixes it?

### Check

**1. You derive a 256-bit AES key with HKDF-SHA256 from a 6-character random lowercase password (about 28 bits). What is its effective strength against offline guessing?**

A. 256 bits, because that is the key length
B. About 28 bits
C. About 284 bits (28 + 256)
D. 128 bits, because birthday attacks halve SHA-256

<details>
<summary>Answer</summary>

**B.** About 28 bits

The attacker guesses the password, not the key. Each of the ~2^28 passwords maps to exactly one key. The output length and the hash only shape the result; they don't add unpredictability.

</details>

**2. Which situation allows offline guessing?**

A. Trying passwords against a rate-limited login form
B. Holding an AES-GCM ciphertext and knowing the HKDF salt and info used to derive its key
C. Port-scanning the site controller
D. Reading the expires_in field of a token response

<details>
<summary>Answer</summary>

**B.** Holding an AES-GCM ciphertext and knowing the HKDF salt and info used to derive its key

The GCM tag checks out only under the right key, so the ciphertext works as a verifier the attacker can test locally. The login form is online guessing and can be throttled. The other two give the attacker nothing to test guesses against.

</details>

**3. nico-api accepts your Integrated KEK because it decodes to exactly 32 bytes. Does that prove the key is strong?**

<details>
<summary>Answer</summary>

No. The check confirms length, not randomness. Thirty-two bytes of zeros or a typed phrase would pass. Strength comes from generating the key with a CSPRNG, for example `openssl rand -base64 32` as the docs show.

No length or format check can measure entropy, because entropy is a property of how the value was chosen.

</details>

**Sources:** [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md), [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md)

<a id="oidc-jwt-authentication"></a>
## 2. OIDC / JWT authentication (Keycloak)

*Builds on: HTTP and web APIs (ch. 3), Public-key cryptography (ch. 18)*

### Before you read

- A JWT's payload is base64url-encoded. Can anyone who copies the token read its claims?
- How could an API check that a token is genuine without calling the identity provider on every request?

<details>
<summary>Answers</summary>

- **A JWT's payload is base64url-encoded. Can anyone who copies the token read its claims?** Yes. A standard JWT is signed, not encrypted. Base64url is an encoding, not a cipher.
- **How could an API check that a token is genuine without calling the identity provider on every request?** By verifying the token's signature locally with the identity provider's public key, which it fetches once and caches.

</details>

### Explanation

Logging in separately to every service doesn't scale. Instead, an **identity provider (IdP)** such as Keycloak authenticates users and machines and issues **tokens** that other services trust.

**OAuth 2.0** is the framework for obtaining access tokens. **OpenID Connect (OIDC)** adds identity on top of it. It defines a standard browser login (the IdP authenticates you and redirects back to the app with a code the app swaps for tokens). It also defines a **discovery document** at `<issuer>/.well-known/openid-configuration`, which lists the token endpoint and the `jwks_uri`, the URL of the IdP's public signing keys as a **JWKS** (JSON Web Key Set). In Keycloak each *realm* is its own issuer, for example `https://keycloak.example.com/realms/nico`.

A **JWT** (JSON Web Token) is three base64url parts joined by dots: `header.payload.signature`.
- **Header**: the algorithm (`RS256` = RSA, `ES256` = ECDSA P-256) and a `kid` (key ID).
- **Payload**: the **claims**. `iss` is the issuer, `sub` the subject (who), `aud` the audience (which API it is for), `exp` the expiry and `iat` the issue time.
- **Signature**: made with the IdP's private key over the first two parts.

A signed JWT is not encrypted, so never put secrets in claims. The token itself *is* a secret: whoever holds it can use it.

A correct verifier:
1. Picks the key by `kid` from the trusted issuer's JWKS and accepts only the expected algorithms.
2. Verifies the signature.
3. Checks that `iss` **exactly** equals a trusted issuer.
4. Checks that `aud` names this API.
5. Checks `exp`, allowing only a small clock skew. This is one reason NTP (chapter 8) matters.

Skipping any of these is a classic vulnerability. Verification is local, with no IdP call per request, which is why JWTs scale.

**In NICo:** NICo REST (the JSON API) accepts JWTs, and orchestrators and admins connect over HTTP/JWT. In `helm-prereqs/values/nico-rest.yaml` you either point it at Keycloak (`baseURL`, `realm`, `clientID`) or set `keycloak.enabled: false` and list generic OIDC `issuers`, each with an `issuer` and an `audience`. The API Service's debug web UI on `/admin` uses HTTPS with OIDC login. Keycloak is an optional prerequisite, and `setup.sh` deploys a dev Keycloak with a `nico` realm.

**Analogy.** A festival wristband with a hologram. Staff at any gate check the hologram (signature) and the printed date (exp) without phoning the ticket office (the IdP). Where it breaks down: a wristband is physically tied to one wrist. A JWT is just text, so anyone who copies it can use it until it expires.

### Worked example: Mint, read, verify and tamper with an ES256 JWT

**Step 1: Set up a lab with a signing key.**

```bash
mkdir -p ~/jwt-lab && cd ~/jwt-lab
python3 -m venv .venv && . .venv/bin/activate
pip install 'pyjwt[crypto]'
openssl ecparam -name prime256v1 -genkey -noout -out idp.key   # IdP private key
openssl ec -in idp.key -pubout -out idp.pub                    # what the API gets
```

**Step 2: Act as the IdP and sign a token.**

`mint.py`:
```python
import jwt, time
now = int(time.time())
claims = {'iss': 'https://keycloak.example.com/realms/nico', 'sub': 'svc-123',
          'aud': 'nico-api', 'iat': now, 'exp': now + 300}
print(jwt.encode(claims, open('idp.key').read(), algorithm='ES256', headers={'kid': 'lab-key-1'}))
```
```bash
TOKEN=$(python mint.py); echo "$TOKEN"
```

**Step 3: Read the claims without any key.**

```bash
python -c 'import sys,base64,json
for part in sys.argv[1].split(".")[:2]:
    print(json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))))' "$TOKEN"
```
You see the header (`alg`, `kid`) and every claim. That shows the token is readable by anyone who holds it.

**Step 4: Act as the API and verify.**

`verify.py`:
```python
import jwt, sys
claims = jwt.decode(sys.argv[1], open('idp.pub').read(), algorithms=['ES256'],
                    audience='nico-api', issuer='https://keycloak.example.com/realms/nico')
print('valid:', claims)
```
`python verify.py "$TOKEN"` prints `valid: {...}`.

**Step 5: Tamper and watch it fail.**

`tamper.py` rewrites `sub` but keeps the old signature:
```python
import base64, json, sys
h, p, s = sys.argv[1].split('.')
claims = json.loads(base64.urlsafe_b64decode(p + '=' * (-len(p) % 4)))
claims['sub'] = 'admin'
p2 = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b'=').decode()
print(f'{h}.{p2}.{s}')
```
`python verify.py "$(python tamper.py "$TOKEN")"` raises `InvalidSignatureError: Signature verification failed`.

### Your turn: finish it

Your API is configured like the NICo REST generic-issuer option, with `issuer: "https://idp.mysite.example.com"` and `audience: "nico-api"`. Fill in the blanks in the verify call.

```text
claims = jwt.decode(token, public_key, algorithms=['ES256'],
                    audience=___, issuer=___)
```

<details>
<summary>Answer</summary>

claims = jwt.decode(token, public_key, algorithms=['ES256'],
                    audience='nico-api', issuer='https://idp.mysite.example.com')

</details>

### Your turn: on your own

Using the lab above, mint a token whose `iss` is `https://keycloak.example.com/realms/nico/` (note the trailing slash) and verify it with the unchanged `verify.py`. Predict the result first, then explain it.

<details>
<summary>Hint 1</summary>

Edit only the `iss` value in `mint.py`.

</details>

<details>
<summary>Hint 2</summary>

How does the verifier compare issuers: by meaning, or by exact string?

</details>

<details>
<summary>Hint 3</summary>

PyJWT, like the OIDC spec, needs an exact string match on `iss`.

</details>

<details>
<summary>Answer</summary>

It fails with `InvalidIssuerError: Invalid issuer`. Issuer matching is an exact string comparison, so one trailing slash is a different issuer. The signature is valid, but that only proves who signed the token, not that the issuer is one this API trusts.

</details>

### Explain it

In your own words: Why does an API need to check `iss` and `aud` even when the signature is valid?

### Check

**1. What does a valid JWT signature guarantee?**

A. Nobody except the API can read the claims
B. The header and claims were produced by the holder of the signing private key and haven't changed since
C. The token is being presented by the client it was issued to
D. The token has not expired

<details>
<summary>Answer</summary>

**B.** The header and claims were produced by the holder of the signing private key and haven't changed since

Signatures give integrity and origin, not confidentiality. Anyone holding a bearer token can present it. Expiry is a separate `exp` check.

</details>

**2. How does an API that accepts JWTs usually verify them without contacting the IdP on every request?**

A. It decrypts each token with a shared password
B. It checks the signature with the issuer's public key, fetched from the issuer's JWKS and cached
C. It looks up each token in its database
D. It accepts any token that is valid base64url

<details>
<summary>Answer</summary>

**B.** It checks the signature with the issuer's public key, fetched from the issuer's JWKS and cached

Public-key signatures let any holder of the public key verify locally. A shared password would let every API forge tokens.

</details>

**3. Which NICo interface uses OIDC login for human operators, according to the docs?**

<details>
<summary>Answer</summary>

The API Service's debug web UI on `/admin`, served over HTTPS with OIDC authentication. Keycloak is the optional IdP for it.

NICo REST also accepts JWTs, but for API clients. The `/admin` UI is the OIDC browser login.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="oauth2-client-credentials-flow-and-jwt-bearer-tokens"></a>
## 3. OAuth2 client credentials flow and JWT bearer tokens

*Builds on: OIDC / JWT authentication (Keycloak) (ch. 19)*

### Before you read

- A nightly script needs to call NICo REST. No human is there to type a password into a browser. How might it get a token?
- You port-forward Keycloak to your laptop, fetch a token from localhost, and nico-rest-api rejects it. Which claim do you suspect?

<details>
<summary>Answers</summary>

- **A nightly script needs to call NICo REST. No human is there to type a password into a browser. How might it get a token?** It authenticates to the IdP's token endpoint with its own client ID and client secret and receives an access token. That is the client credentials grant.
- **You port-forward Keycloak to your laptop, fetch a token from localhost, and nico-rest-api rejects it. Which claim do you suspect?** `iss`. Keycloak typically puts the URL you reached it through into the issuer, so the token names a localhost issuer that the API doesn't expect.

</details>

### Explanation

OIDC browser login suits humans. Scripts, CI jobs and services need a flow with no browser: the **client credentials grant**.

**Roles:**
- **Client**: your program, registered at the IdP with a **client ID** and **client secret**.
- **Authorization server**: the IdP, which exposes a **token endpoint**.
- **Resource server**: the API, here nico-rest-api.

**Flow:**
1. The client POSTs a form (`application/x-www-form-urlencoded`) with `grant_type=client_credentials`, `client_id` and `client_secret` to the token endpoint. Some servers also accept the ID and secret as HTTP Basic auth.
2. The IdP checks them and returns JSON with `access_token` (a JWT in Keycloak), `token_type: "Bearer"` and `expires_in` in seconds.
3. The client sends `Authorization: Bearer <access_token>` on every API call.
4. The API verifies the JWT as in the previous lesson: signature, `iss`, `aud` and `exp`.
5. When the token expires, the client repeats step 1.

**Bearer** means whoever holds the token has its authority. So send it only over TLS, never log it, and keep lifetimes short. The client secret is a long-lived password: generate it with high entropy and store it like one, for example in a Kubernetes Secret.

**The `iss` trap.** The API needs `iss` to match its configured issuer exactly. By default, Keycloak builds `iss` from the URL the client used to reach it. The NICo dev setup uses:

| Value | Setting |
|---|---|
| Token endpoint | `http://keycloak.nico-rest:8082/realms/nico/protocol/openid-connect/token` |
| `grant_type` | `client_credentials` |
| `client_id` | `ncx-service` |
| `client_secret` | `nico-local-secret` |

The docs say to fetch tokens **from inside the cluster only**. If you port-forward and request against `localhost`, the JWT's `iss` won't match what nico-rest-api expects and the token is rejected. The helper `helm-prereqs/keycloak/get-token.sh` runs curl from a throwaway in-cluster pod to avoid this. The docs don't spell out the exact issuer string nico-rest-api expects; it follows from the Keycloak settings (`baseURL`, `externalBaseURL`, `realm`) or the `issuers` list in `values/nico-rest.yaml`.

The same token goes into `~/.nico/config.yaml` under `auth.token` for `nicocli`. It is also what the one-time org bootstrap call (`GET /v2/org/ncx/nico/service-account/current`) uses; chapter 33 covers that call.

**Analogy.** A hotel key-card desk for staff. A contractor shows a badge and PIN (client ID and secret) at the desk (token endpoint) and gets a key card (access token) that opens doors until checkout time (exp). Where it breaks down: a hotel desk can see who is standing there. The token endpoint only sees whoever knows the secret, so a leaked secret is a full impersonation.

### Worked example: Fetch and use a NICo REST token (needs a running NICo site)

**Step 1: Fetch the token in-cluster with the helper.**

```bash
TOKEN=$(helm-prereqs/keycloak/get-token.sh)
```
If you want to see the raw grant, here is a hand-written equivalent that also runs inside the cluster:
```bash
kubectl run -i --rm --restart=Never --image=curlimages/curl get-token -n nico-rest --quiet -- \
  -s -X POST http://keycloak.nico-rest:8082/realms/nico/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=ncx-service -d client_secret=nico-local-secret \
  | jq -r .access_token
```

**Step 2: Inspect the claims.**

```bash
python3 -c 'import sys,base64,json; p=sys.argv[1].split(".")[1]; print(json.dumps(json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4))), indent=2))' "$TOKEN"
```
Check two things: `iss` does **not** name `localhost`, and it equals the issuer nico-rest-api is configured to trust (derived from the Keycloak `baseURL`/`externalBaseURL` and `realm`, or the `issuers` list, in `values/nico-rest.yaml`). Don't expect a particular hostname; compare with your own config. Note `exp` too.

**Step 3: Call the API with the bearer token.**

From the docs:
```bash
kubectl run -i --rm --restart=Never --image=curlimages/curl curl-test \
  -n nico-rest --quiet -- \
  -sf http://nico-rest-api.nico-rest:8388/v2/org/ncx/nico/user/current \
  -H "Authorization: Bearer $TOKEN"
```
A JSON body means the token was accepted. With `-f`, curl prints nothing and exits non-zero on a 401.

**Step 4: Reuse it for the org bootstrap.**

With `kubectl port-forward -n nico-rest svc/nico-rest-api 8388:8388` running (port-forwarding the *API* is fine, only the *token* must come from in-cluster):
```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://localhost:8388/v2/org/ncx/nico/service-account/current | python3 -m json.tool
```

### Your turn: finish it

Complete this client-credentials sequence against a generic token endpoint so that the second command sends the token correctly.

```text
TOKEN=$(curl -s -X POST https://idp.example.com/realms/nico/protocol/openid-connect/token \
  -d grant_type=___ -d client_id=my-svc -d client_secret="$SECRET" | jq -r .access_token)
curl -s https://api.example.com/v2/org/ncx/nico/user/current -H "___"
```

<details>
<summary>Answer</summary>

grant_type=client_credentials, and the header is "Authorization: Bearer $TOKEN".

</details>

### Your turn: on your own

A colleague runs `kubectl port-forward -n nico-rest svc/keycloak 8082:8082`, fetches a token from `http://localhost:8082/realms/nico/protocol/openid-connect/token`, and every nico-rest-api call returns 401, even though the token endpoint returned 200. Explain what's wrong and how to fix it.

<details>
<summary>Hint 1</summary>

The 200 from Keycloak proves the client ID and secret were right.

</details>

<details>
<summary>Hint 2</summary>

Decode the token and compare its `iss` with the issuer nico-rest-api is configured to trust.

</details>

<details>
<summary>Hint 3</summary>

The docs require fetching tokens from inside the cluster, for example with `helm-prereqs/keycloak/get-token.sh`.

</details>

<details>
<summary>Answer</summary>

Keycloak set `iss` from the URL it was reached through, so it names `http://localhost:8082/realms/nico`. nico-rest-api is configured to trust a different issuer (from its Keycloak settings), and the exact-match check fails. Fix it by fetching the token in-cluster with `TOKEN=$(helm-prereqs/keycloak/get-token.sh)` or a throwaway `kubectl run` curl pod. Port-forwarding nico-rest-api to call it afterwards is fine.

</details>

### Explain it

In your own words: Why is a bearer token both convenient and dangerous, and which practices limit the danger?

### Check

**1. Which header carries the access token to nico-rest-api?**

A. Authorization: Bearer <token>
B. X-Client-Secret: <secret>
C. Cookie: token=<token>
D. Authorization: Basic <token>

<details>
<summary>Answer</summary>

**A.** Authorization: Bearer <token>

Bearer is the token scheme from OAuth2. Basic carries a username:password pair, sometimes used *at the token endpoint* for client credentials but not for API calls.

</details>

**2. You fetch a token through a localhost port-forward to Keycloak and nico-rest-api returns 401. What is the most likely cause?**

A. The client secret was wrong
B. The token's iss claim names localhost, not the issuer nico-rest-api expects
C. Bearer tokens cannot travel through a port-forward
D. The token was encrypted for the wrong audience

<details>
<summary>Answer</summary>

**B.** The token's iss claim names localhost, not the issuer nico-rest-api expects

A wrong secret would have failed at the token endpoint, so you would have no token at all. A port-forward is just a TCP tunnel. Keycloak JWTs are signed, not encrypted.

</details>

**3. Why isn't the client credentials grant suitable for a human logging in to the `/admin` UI?**

<details>
<summary>Answer</summary>

It authenticates a *program* by a stored secret. It carries no user identity, MFA or interactive consent, and the secret would have to sit on the user's machine. Humans use the OIDC browser flow instead.

Pick the grant that matches the kind of party: machine-to-machine uses client credentials, people use interactive OIDC login.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="token-delegation"></a>
## 4. Token delegation (RFC 8693 token exchange)

*Builds on: OAuth2 client credentials flow and JWT bearer tokens (ch. 19)*

### Before you read

- A service holds a JWT from issuer A, but an external storage API only accepts tokens from its own issuer B. Why not just forward the A token?
- Guess: what does an STS (security token service) take as input and give as output?

<details>
<summary>Answers</summary>

- **A service holds a JWT from issuer A, but an external storage API only accepts tokens from its own issuer B. Why not just forward the A token?** Its `aud` and `iss` are wrong for B, so B would reject it. Handing a broad token to a third party also lets that party reuse it elsewhere.
- **Guess: what does an STS (security token service) take as input and give as output?** It takes a token (plus who the new token is for) and returns a different token, usually with a new issuer, audience, scope and lifetime.

</details>

### Explanation

Sometimes a caller holds a token from one issuer but needs a token that a different system accepts. Forwarding the original is wrong. Its `aud` names some other API, the receiver may not trust its issuer, and spreading a broad token to third parties widens the damage if it leaks.

**RFC 8693, OAuth 2.0 Token Exchange**, standardises the swap. A **security token service (STS)** is any authorization server that implements it. The caller POSTs a form to the STS token endpoint:
- `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
- `subject_token`: the token for the identity the request is about.
- `subject_token_type`: for example `urn:ietf:params:oauth:token-type:jwt` or `urn:ietf:params:oauth:token-type:access_token`.
- Optional `audience` and/or `resource`: where the new token will be used.
- Optional `scope` and `requested_token_type`.
- Optional `actor_token` and `actor_token_type`: the party acting on the subject's behalf.

The response is JSON with `access_token`, `issued_token_type`, `token_type` and usually `expires_in`.

**Delegation vs impersonation.** If an actor is identified, the issued token can record both the subject and the actor (the `act` claim): "service A acting for workload B". Without an actor, the new token simply represents the subject. The STS's policy decides what is allowed. It must trust the subject token's issuer (often by fetching that issuer's JWKS) and it chooses the audience, scope and lifetime.

**A typical use:** a workload holding a short-lived JWT identity from its platform exchanges it at a cloud provider's STS for a cloud credential, so no long-lived secret ever sits on the machine.

**What NICo's docs say.** NICo's machine identity feature (SPIFFE JWT-SVIDs, chapter 21) can delegate tokens to external STS endpoints. Per-org identity settings, created on Day 1 with `PUT …/tenant-identity/config`, include token delegation. The Day 0 `[machine_identity]` site config adds two guard rails:
- `token_endpoint_http_proxy`: an egress proxy, recommended when delegating to external HTTPS STS endpoints.
- `token_endpoint_domain_allowlist`: restricts which hosts may be used as a delegation `token_endpoint`.

The docs don't say which token NICo sends as `subject_token` or which component sends the request, so don't assume either.

**Analogy.** An airport currency exchange desk. You hand over euros (the subject token) and receive yen (a new token) that only works in Japan (the audience). Where it breaks down: the desk doesn't care who you are. An STS checks the subject token's signature and issuer, applies policy, and can record who is acting for whom.

### Worked example: Compose an RFC 8693 request and constrain it at the site

**Step 1: Build the request body (runnable).**

```python
from urllib.parse import urlencode
body = {
    'grant_type': 'urn:ietf:params:oauth:grant-type:token-exchange',
    'subject_token': 'eyJhbGciOiJFUzI1NiJ9.e30.sig',  # placeholder JWT
    'subject_token_type': 'urn:ietf:params:oauth:token-type:jwt',
    'audience': 'https://storage.example.com',
    'requested_token_type': 'urn:ietf:params:oauth:token-type:access_token',
}
print(urlencode(body))
```
This is the exact form body an STS would receive.

**Step 2: Send it to the STS (illustrative).**

```bash
curl -s https://sts.example.com/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  -d subject_token="$SUBJECT_JWT" \
  -d subject_token_type=urn:ietf:params:oauth:token-type:jwt \
  -d audience=https://storage.example.com
```
`sts.example.com` is a placeholder. Real STSs also authenticate the caller in their own way.

**Step 3: Read the response.**

```json
{"access_token": "eyJ...", "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
 "token_type": "Bearer", "expires_in": 3600}
```
The caller now uses `Authorization: Bearer <new token>` against the storage API. The original token never reaches it.

**Step 4: Constrain delegation in NICo site config.**

From the Day 0 machine identity guide (`[machine_identity]` in the NICo API site config):
```toml
[machine_identity]
enabled = true
current_encryption_key_id = "kv1"
algorithm = "ES256"
token_endpoint_http_proxy = "https://nico-egress-proxy.example.com"
token_endpoint_domain_allowlist = ["sts.example.com", "*.tenant.example.com"]
```
The proxy controls the outbound path, and the allowlist controls which STS hosts tokens may be sent to. Restart `nico-api` after editing, because this section is not hot-reloaded.

### Your turn: finish it

Fill in the two blanks so this is a valid RFC 8693 request for a JWT subject token.

```text
curl -s https://sts.example.com/token \
  -d grant_type=___ \
  -d subject_token="$SVID" \
  -d subject_token_type=___ \
  -d audience=https://storage.example.com
```

<details>
<summary>Answer</summary>

grant_type=urn:ietf:params:oauth:grant-type:token-exchange and subject_token_type=urn:ietf:params:oauth:token-type:jwt

</details>

### Your turn: on your own

A site sets `token_endpoint_domain_allowlist = ["sts.example.com", "*.tenant.example.com"]`. A tenant tries to configure delegation to `https://sts.attacker.net/token`. What should happen, and what risk do the allowlist and `token_endpoint_http_proxy` reduce?

<details>
<summary>Hint 1</summary>

Is `sts.attacker.net` on the list in any form?

</details>

<details>
<summary>Hint 2</summary>

Think about what an attacker-controlled STS would receive in the request body.

</details>

<details>
<summary>Hint 3</summary>

The proxy is a single, controlled exit point for outbound traffic.

</details>

<details>
<summary>Answer</summary>

The host isn't on the allowlist, so it shouldn't be accepted as a token endpoint. The risk is tokens being sent to an arbitrary host, which could collect them or the identity they carry. The allowlist limits where tokens may go. The egress proxy forces outbound HTTPS through one controlled, auditable path instead of letting the API reach the internet directly.

</details>

### Explain it

In your own words: Why is exchanging a token at an STS safer than forwarding the original token to a third-party API?

### Check

**1. In RFC 8693, what does `subject_token` represent?**

A. The identity the new token will be about
B. The STS's client secret
C. The new token being requested
D. The caller's TLS certificate

<details>
<summary>Answer</summary>

**A.** The identity the new token will be about

The subject is who the new token speaks for. An optional `actor_token` identifies who is acting. The new token comes back in the response, not the request.

</details>

**2. What does `token_endpoint_domain_allowlist` in NICo's `[machine_identity]` site config do?**

A. Restricts which hosts may be used as token delegation token_endpoints
B. Lists the issuers nico-rest-api trusts
C. Sets the DNS zones NICo is authoritative for
D. Sets the egress proxy URL

<details>
<summary>Answer</summary>

**A.** Restricts which hosts may be used as token delegation token_endpoints

The proxy is the separate `token_endpoint_http_proxy`. Trusted REST issuers live in the nico-rest values, not here.

</details>

**3. Which statement about token exchange is correct?**

A. An STS can issue a token for a different audience and, with an actor token, record who is acting for whom
B. Token exchange decrypts the subject token so the STS can read it
C. Token exchange forwards the same token unchanged to a new API
D. Token exchange replaces TLS between services

<details>
<summary>Answer</summary>

**A.** An STS can issue a token for a different audience and, with an actor token, record who is acting for whom

JWTs are usually signed, not encrypted, so the STS verifies rather than decrypts. The output is a new token. TLS is still needed to carry it.

</details>

**Sources:** [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md)

<a id="pki-and-tls-certificates"></a>
## 5. PKI and TLS certificates

*Builds on: Public-key cryptography (ch. 18)*

### Before you read

- Public-key signatures prove a message came from a particular private key. What stops an attacker from handing you *their* public key and claiming it belongs to nico-api?
- Guess: is a 'root CA' certificate signed by someone else?

<details>
<summary>Answers</summary>

- **Public-key signatures prove a message came from a particular private key. What stops an attacker from handing you *their* public key and claiming it belongs to nico-api?** A certificate: a document signed by an authority you already trust, binding the name nico-api to one specific public key.
- **Guess: is a 'root CA' certificate signed by someone else?** No. A root is self-signed. You trust it because you deliberately installed it in your trust store.

</details>

### Explanation

Public-key crypto (chapter 18) lets anyone verify a signature with a public key. That leaves one question: **whose key is it?**

**Public key infrastructure (PKI)** answers with **certificates**. A certificate is a signed document, in the **X.509** format, that binds an identity to a public key. It contains:
- **Subject**: who it identifies.
- **Issuer**: who signed it.
- **Serial number** and **validity** (`notBefore` and `notAfter`).
- **Public key**.
- **Extensions**, such as `basicConstraints`, `keyUsage`, `extendedKeyUsage` and Subject Alternative Names (next lesson).
- **The issuer's signature** over all of the above.

The signer is a **certificate authority (CA)**: a key pair whose certificate says `basicConstraints: CA:TRUE` and allows `keyCertSign`. A **root CA** is self-signed, and you trust it only because you put it in your **trust store** (the OS bundle, or a `ca.crt` file you pass in). Often a root signs an **intermediate CA**, which signs **leaf** certificates for services. A verifier walks the chain leaf → intermediate → root, checking each signature, validity window and CA flag, until it reaches a root it trusts.

To get a leaf certificate, the service generates its own key pair and sends a **CSR** (certificate signing request) containing its public key and requested names. The CSR is signed with the service's private key to prove it holds it. The private key never leaves the service.

What follows from this:
- Whoever holds a CA's private key can mint a trusted certificate for **any** name, so CA keys must be guarded closely.
- Certificates expire, so renewal has to be automated (see the cert-manager lesson).
- A private site CA is trusted only by clients you give its certificate to, so you have to distribute `ca.crt`.

**TLS** uses PKI. In the handshake the server sends its chain and signs the handshake to prove it holds the matching private key, and the client verifies the chain and the hostname. **mTLS** runs the same check in both directions.

**NICo's PKI** (from the docs): a `selfsigned-bootstrap` issuer signs the `site-root` CA. `site-issuer` is a cert-manager CA ClusterIssuer backed by the `site-root` Secret, and `vault-nico-issuer` is backed by Vault's PKI engine (the root/intermediate chain). External Secrets Operator copies the CA bundle into the NICo namespaces as the Secret `nico-roots`, with keys `site-root` and `nico-root`, so workloads can verify their peers.

**Analogy.** A passport. The government (CA) checks who you are and issues a document binding your name to your photo (your public key). Border officers trust it because they trust the issuing government's seal. Where it breaks down: a passport photo can only be compared by eye. A certificate is backed by math, because the holder must *prove* they have the private key in every TLS handshake. And anyone who steals the government's seal (the CA key) can make perfect passports for any name.

### Worked example: Build a lab site-root CA and issue a nico-api-style certificate

**Step 1: Write the extension files.**

```bash
mkdir -p ~/pki-lab && cd ~/pki-lab
cat > ca.ext <<'EOF'
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
EOF
cat > server.ext <<'EOF'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:nico-api.nico-system.svc.cluster.local,DNS:nico-api.nico-system,DNS:localhost,IP:127.0.0.1
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
```
The names imitate Kubernetes service DNS. Being a CA comes from the `basicConstraints` extension, not from the file name.

**Step 2: Create the self-signed root.**

```bash
openssl req -new -newkey rsa:2048 -nodes -keyout ca.key -subj '/CN=lab-site-root' -out ca.csr
openssl x509 -req -in ca.csr -signkey ca.key -days 365 -extfile ca.ext -out ca.crt
```
`-signkey` means the CA signs its own certificate, so issuer = subject.

**Step 3: Issue a leaf from a CSR.**

```bash
openssl req -new -newkey rsa:2048 -nodes -keyout server.key -subj '/CN=nico-api' -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 \
  -extfile server.ext -out server.crt
```
`server.key` was generated here and never sent to the CA. Only the CSR is.

**Step 4: Verify the chain and inspect.**

```bash
openssl verify -CAfile ca.crt server.crt        # server.crt: OK
openssl x509 -in server.crt -noout -subject -issuer -dates
openssl x509 -in server.crt -noout -text | grep -A1 'Subject Alternative Name'
```
Keep `~/pki-lab`: the next two lessons reuse it.

### Your turn: finish it

You have `dns.csr` and `dns.ext` in `~/pki-lab`. Fill in the blanks to sign it with the lab CA and then check the chain.

```text
openssl x509 -req -in dns.csr ___ -CAcreateserial -days 30 -extfile dns.ext -out dns.crt
openssl verify ___ dns.crt
```

<details>
<summary>Answer</summary>

openssl x509 -req -in dns.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 -extfile dns.ext -out dns.crt
openssl verify -CAfile ca.crt dns.crt

</details>

### Your turn: on your own

Extend the lab to a three-level chain: the root signs `int.crt` (an intermediate CA that may not create further CAs), the intermediate signs `leaf.crt` using `server.ext`, and `openssl verify` succeeds while trusting only the root.

<details>
<summary>Hint 1</summary>

The intermediate needs its own extension file with `CA:TRUE`. Look up `pathlen:0`.

</details>

<details>
<summary>Hint 2</summary>

Sign the leaf with `-CA int.crt -CAkey int.key`.

</details>

<details>
<summary>Hint 3</summary>

`openssl verify` takes the trusted root via `-CAfile` and non-trusted intermediates via `-untrusted`.

</details>

<details>
<summary>Answer</summary>

```bash
cat > int.ext <<'EOF'
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
openssl req -new -newkey rsa:2048 -nodes -keyout int.key -subj '/CN=lab-intermediate' -out int.csr
openssl x509 -req -in int.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 180 -extfile int.ext -out int.crt
openssl req -new -newkey rsa:2048 -nodes -keyout leaf.key -subj '/CN=leaf' -out leaf.csr
openssl x509 -req -in leaf.csr -CA int.crt -CAkey int.key -CAcreateserial -days 30 -extfile server.ext -out leaf.crt
openssl verify -CAfile ca.crt -untrusted int.crt leaf.crt   # leaf.crt: OK
```
Without `-untrusted int.crt` it fails with `unable to get local issuer certificate`, because the verifier can't build the path.

</details>

### Explain it

In your own words: Why does trusting one root certificate let a client trust thousands of service certificates it has never seen before, and why does that make the root's private key so valuable?

### Check

**1. What makes a certificate a CA certificate?**

A. basicConstraints CA:TRUE (with keyCertSign key usage)
B. Being self-signed
C. A CN ending in -root
D. A longer validity period

<details>
<summary>Answer</summary>

**A.** basicConstraints CA:TRUE (with keyCertSign key usage)

Self-signed leaf certificates exist and can't sign others. Names and lifetimes carry no authority. Verifiers check the extension.

</details>

**2. In NICo's reference installation, what is `site-issuer`?**

A. A cert-manager CA ClusterIssuer backed by the site-root Secret
B. A Vault PKI role
C. A Keycloak realm
D. An External Secrets ClusterSecretStore

<details>
<summary>Answer</summary>

**A.** A cert-manager CA ClusterIssuer backed by the site-root Secret

`vault-nico-issuer` is the Vault-backed one. ClusterSecretStores belong to ESO, which copies the CA bundle into namespaces.

</details>

**3. An attacker steals the site-root private key. What can they do, and what must you do?**

<details>
<summary>Answer</summary>

They can mint certificates for any name that every client trusting site-root will accept, which means impersonating any service. You must replace the root (new key and certificate), reissue every certificate under it, and distribute the new trust bundle.

Trust flows down from the root, so a compromised root compromises everything beneath it.

</details>

**Sources:** [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md)

<a id="tls-certificates-and-x-509-san"></a>
## 6. TLS certificates and X.509 SAN

*Builds on: PKI and TLS certificates (ch. 19), DNS (authoritative and recursive) (ch. 8)*

### Before you read

- Does a certificate for `*.mysite.example.com` cover `a.b.mysite.example.com`?
- A chain verifies perfectly to a trusted CA. Why might the client still reject the connection?

<details>
<summary>Answers</summary>

- **Does a certificate for `*.mysite.example.com` cover `a.b.mysite.example.com`?** No. A wildcard covers exactly one DNS label, so it matches `rest-api.mysite.example.com` but not names two labels deep, and not `mysite.example.com` itself.
- **A chain verifies perfectly to a trusted CA. Why might the client still reject the connection?** The name the client connected to isn't listed in the certificate's Subject Alternative Names.

</details>

### Explanation

A valid chain proves only that the CA vouched for *some* identity. The client must also check that it's the identity it meant to reach. This is **hostname verification**: the client compares the name it dialled with the certificate's **Subject Alternative Name (SAN)** extension.

**SAN entry types:** `DNS:` hostnames, `IP:` addresses, `URI:` (used for SPIFFE IDs, chapter 21) and email. Older practice put the hostname in the subject's Common Name (CN). Modern clients use the SAN and ignore the CN when a SAN is present, and browsers ignore the CN entirely. Put **every** name in the SAN.

**Names must match how clients actually connect.** Inside Kubernetes (chapter 14), a Service can be reached as `svc.ns` or `svc.ns.svc.cluster.local` (and shorter forms via DNS search domains). The client checks whatever string it used. If clients connect by IP address, for example a MetalLB VIP, the certificate needs an `IP:` SAN, because a DNS SAN never covers an IP.

**Wildcard rules:** `*.mysite.example.com` matches exactly **one** label in the leftmost position.
- `rest-api.mysite.example.com`: matches.
- `mysite.example.com`: no match (zero labels where the `*` is).
- `a.b.mysite.example.com`: no match (two labels).

Partial wildcards like `api*.example.com` are poorly supported, so avoid them.

**SNI (Server Name Indication):** the client sends the hostname in its first TLS message so that a server or ingress hosting many names can choose the right certificate. With openssl you set it with `-servername`.

**NICo specifics from the docs:**
- Typical SANs include internal service names and optional external FQDNs. ClusterIssuers must be able to issue certificates for cluster-internal service DNS SANs and for externally facing FQDNs.
- In the NICo REST Ingress chart, `ingress.hosts` feeds the certificate's `dnsNames`, and the first host becomes the common name. `certificate.dnsNames` accepts a wildcard covering one label, as X.509 SAN matching does. `ingress.tls[].hosts`, however, must name the host **exactly**, because Contour keys its secure virtual host by that literal string.
- To check a deployment, run `openssl s_client -connect rest-api.mysite.example.com:443 -servername rest-api.mysite.example.com -CAfile nico-rest-ca.crt` and expect `Verify return code: 0 (ok)`.

**Analogy.** A delivery driver checks the house number, not just that the parcel has a valid courier stamp. The stamp is the CA signature, and the address list is the SAN. A wildcard is like addressing a parcel to 'any flat in Block 7': it reaches flat 7A but not the block's car park (the apex) or a room inside flat 7A (a deeper label). Where it breaks down: a driver can use judgement. TLS hostname matching is strict string rules with no exceptions.

### Worked example: Test which names a certificate covers (in ~/pki-lab)

**Step 1: Issue a wildcard certificate.**

```bash
cd ~/pki-lab
cat > wild.ext <<'EOF'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:*.mysite.example.com
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
openssl req -new -newkey rsa:2048 -nodes -keyout wild.key -subj '/CN=wildcard' -out wild.csr
openssl x509 -req -in wild.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 -extfile wild.ext -out wild.crt
```

**Step 2: Check candidate hostnames.**

```bash
for h in rest-api.mysite.example.com mysite.example.com a.b.mysite.example.com; do
  openssl x509 -in wild.crt -noout -checkhost "$h"
done
```
Expected: the first `does match certificate`, the other two `does NOT match certificate`.

**Step 3: Check the service-style certificate.**

```bash
openssl x509 -in server.crt -noout -checkhost nico-api.nico-system     # match
openssl x509 -in server.crt -noout -checkhost nico-api                 # NOT match
openssl x509 -in server.crt -noout -checkip 127.0.0.1                  # match
openssl x509 -in server.crt -noout -checkip 10.0.0.5                   # NOT match
```
The short name `nico-api` would fail for a client that dials exactly that.

**Step 4: See it in a live handshake.**

```bash
openssl s_server -accept 4443 -cert server.crt -key server.key -www &
sleep 1   # give the server time to start listening
openssl s_client -connect 127.0.0.1:4443 -servername localhost -CAfile ca.crt \
  -verify_hostname localhost </dev/null 2>/dev/null | grep 'Verify return code'
openssl s_client -connect 127.0.0.1:4443 -CAfile ca.crt \
  -verify_hostname wrong.example </dev/null 2>/dev/null | grep 'Verify return code'
kill %1
```
The first prints `0 (ok)`. The second prints a hostname mismatch error (code 62), even though the chain is fine. If grep prints nothing, the server wasn't up yet: rerun the s_client lines.

### Your turn: finish it

You want one certificate that covers both `mysite.example.com` and any single-label name under it, such as `rest-api.mysite.example.com`. Fill in the SAN line of the extension file.

```text
subjectAltName=DNS:___,DNS:___
```

<details>
<summary>Answer</summary>

subjectAltName=DNS:mysite.example.com,DNS:*.mysite.example.com (the wildcard alone can't cover the apex).

</details>

### Your turn: on your own

Clients reach an API in four ways: in-cluster as `nico-api.nico-system`, in-cluster as `nico-api.nico-system.svc.cluster.local`, externally as `nico.mysite.example.com`, and by a monitoring probe straight to the VIP `10.180.126.161`. Write the `subjectAltName` line, then prove it with `-checkhost` / `-checkip`.

<details>
<summary>Hint 1</summary>

Every distinct string a client dials needs its own entry.

</details>

<details>
<summary>Hint 2</summary>

The VIP needs an `IP:` entry, not a `DNS:` one.

</details>

<details>
<summary>Hint 3</summary>

Reuse the `server.ext` template, change the SAN, sign it with the lab CA, then run `openssl x509 -in <file> -noout -checkhost <name>` for each name and `-checkip` for the address.

</details>

<details>
<summary>Answer</summary>

`subjectAltName=DNS:nico-api.nico-system,DNS:nico-api.nico-system.svc.cluster.local,DNS:nico.mysite.example.com,IP:10.180.126.161`. After signing, `-checkhost` reports a match for each of the three names and `-checkip 10.180.126.161` reports a match.

</details>

### Explain it

In your own words: Why can the NICo REST chart accept a wildcard in `certificate.dnsNames` but require the exact hostname in `ingress.tls[].hosts`?

### Check

**1. Which hostname does `*.mysite.example.com` cover?**

A. rest-api.mysite.example.com
B. mysite.example.com
C. v2.rest-api.mysite.example.com
D. rest-api.mysite.example.com.evil.net

<details>
<summary>Answer</summary>

**A.** rest-api.mysite.example.com

One label exactly. The apex has zero labels in the wildcard position, `v2.rest-api` has two, and the last name ends in a different domain entirely.

</details>

**2. Your NICo REST ingress serves a Secret holding a `*.mysite.example.com` certificate. What belongs in `ingress.tls[].hosts`?**

A. The concrete host, e.g. rest-api.mysite.example.com
B. *.mysite.example.com
C. Nothing; the field is ignored with wildcards
D. The Envoy LoadBalancer IP

<details>
<summary>Answer</summary>

**A.** The concrete host, e.g. rest-api.mysite.example.com

Per the docs, Contour keys the secure virtual host by the literal string. A wildcard there leaves the route without an HTTPS virtual host, and the chart rejects hosts that aren't named exactly.

</details>

**3. A probe connects to `https://10.180.126.161` and the certificate's only SAN is `DNS:nico.mysite.example.com`. What happens, and what are two fixes?**

<details>
<summary>Answer</summary>

Hostname verification fails (the chain is fine, but no SAN matches the IP). Fix it by adding `IP:10.180.126.161` to the SAN, or by having the probe connect using `nico.mysite.example.com`.

A DNS SAN never matches an IP literal, even if that name resolves to the IP.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md)

<a id="mtls-grpc"></a>
## 7. mTLS / gRPC

*Builds on: TLS certificates and X.509 SAN (ch. 19), Protocol Buffers (ch. 1)*

### Before you read

- In ordinary HTTPS to a website, which side proves its identity with a certificate?
- Guess: in mutual TLS, what extra must the client have besides the CA certificate?

<details>
<summary>Answers</summary>

- **In ordinary HTTPS to a website, which side proves its identity with a certificate?** Only the server. The client usually authenticates later at the application layer, with a password, cookie or token.
- **Guess: in mutual TLS, what extra must the client have besides the CA certificate?** Its own certificate (signed by a CA the server trusts) and the matching private key.

</details>

### Explanation

**gRPC** is an RPC framework. You define services and messages in a `.proto` file (Protocol Buffers, chapter 1), generate client and server code, and call remote methods like local functions. It runs on **HTTP/2**: binary framing, many concurrent calls over one connection, and streaming in either direction. gRPC gets its security from TLS, configured as the channel's credentials.

In ordinary TLS only the server is authenticated. In **mutual TLS (mTLS)** the server also sends a *CertificateRequest*. The client replies with its own certificate chain and a *CertificateVerify* message: a signature over the handshake made with its private key, which proves it holds the key. The server verifies that chain against the CA(s) it trusts for clients. Both ends know who the other is cryptographically before any RPC is sent.

**What you need:**
- A client certificate whose extended key usage includes `clientAuth`. Server certificates need `serverAuth`, and one certificate can carry both.
- A server configured to **require** client certificates, with a trust store containing the CA that signs them.
- A way to read identity from the certificate, usually a SAN (a DNS name or a URI such as a SPIFFE ID). That gives you *authentication*. Deciding which identities may call which methods (*authorization*) is a separate layer on top.

**Why a control plane uses it:** there are no shared passwords to leak or rotate by hand, every connection is authenticated in both directions, and getting onto the network isn't enough to make calls. Short-lived certificates can be renewed automatically (next lesson).

**In NICo:** all control-plane services communicate over mTLS/gRPC. The API Service is the hub. The DHCP, PXE, Hardware Health, SSH Console and DNS services reach it over mTLS/gRPC. On managed hosts, Scout and the DPU Agent report to it the same way, and `nico-admin-cli` connects to it directly. NICo Core reaches RMS's `rms-api-server` over gRPC on port `8801` with mutual TLS. The RMS server certificate comes from the same cert-manager issuer that signs NICo's certificate, so both directions verify without extra configuration. The RMS client library discovers NICo's SPIFFE certificate mount and presents it. By contrast, NICo REST serves orchestrators over HTTP with JWT bearer tokens.

**Analogy.** A secure facility with guards on both sides of the door. You show your badge to the guard, and the guard shows theirs to you, before either of you speaks. Where it breaks down: badges can be photocopied. In mTLS each side must sign a fresh handshake with its private key, so a copied certificate without the key is useless.

### Worked example: Run an mTLS server and test it with good and bad clients (in ~/pki-lab)

**Step 1: Issue a client certificate.**

```bash
cd ~/pki-lab
cat > client.ext <<'EOF'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
subjectAltName=URI:spiffe://lab.internal/admin-cli
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
openssl req -new -newkey rsa:2048 -nodes -keyout client.key -subj '/CN=lab-admin-cli' -out client.csr
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 -extfile client.ext -out client.crt
```

**Step 2: Write a server that requires client certificates.**

`mtls_server.py`:
```python
import http.server, ssl

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        cert = self.connection.getpeercert()
        sans = [v for _, v in cert.get('subjectAltName', ())]
        body = f'hello {sans}\n'.encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain('server.crt', 'server.key')
ctx.load_verify_locations('ca.crt')      # CA trusted for CLIENT certs
ctx.verify_mode = ssl.CERT_REQUIRED       # no client cert, no connection
srv = http.server.HTTPServer(('127.0.0.1', 8443), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
```
Run it with `python3 mtls_server.py & sleep 1`.

**Step 3: Call it with a valid client certificate.**

```bash
curl --cacert ca.crt --cert client.crt --key client.key https://localhost:8443/
# hello ['spiffe://lab.internal/admin-cli']
```
The server read the client's identity from its SAN.

**Step 4: Try without a certificate, and with a rogue one.**

```bash
curl --cacert ca.crt https://localhost:8443/          # TLS alert error (curl code 35 or 56)
openssl req -x509 -newkey rsa:2048 -nodes -keyout rogue.key -out rogue.crt -days 1 -subj '/CN=rogue'
curl --cacert ca.crt --cert rogue.crt --key rogue.key https://localhost:8443/   # rejected: unknown CA
kill %1
```
The exact error text depends on your TLS library. The important point is that no HTTP response comes back.

**Step 5: Map it to gRPC.**

gRPC tools take the same three files. For example, `grpcurl` has `-cacert`, `-cert` and `-key` flags. Only the protocol on top differs (HTTP/2 + protobuf instead of HTTP/1.1 + text). The trust decisions are identical.

### Your turn: finish it

Fill in the blanks so this server trusts the lab CA for client certificates and refuses clients that don't present one.

```text
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain('server.crt', 'server.key')
ctx.___('ca.crt')
ctx.verify_mode = ssl.___
```

<details>
<summary>Answer</summary>

ctx.load_verify_locations('ca.crt') and ctx.verify_mode = ssl.CERT_REQUIRED (CERT_OPTIONAL would let clients without a certificate in).

</details>

### Your turn: on your own

Issue a second client certificate, `bad.crt`, signed by the lab CA but with `extendedKeyUsage=serverAuth` instead of `clientAuth`. Predict what `mtls_server.py` does when curl presents it, test it, and explain.

<details>
<summary>Hint 1</summary>

Copy `client.ext`, change only the EKU line, and sign it with the lab CA as before.

</details>

<details>
<summary>Hint 2</summary>

The chain is valid, so the failure must come from something other than trust.

</details>

<details>
<summary>Hint 3</summary>

OpenSSL checks the certificate's purpose when verifying a TLS client.

</details>

<details>
<summary>Answer</summary>

The handshake fails, and curl reports a TLS alert (the server-side reason is `unsupported certificate purpose`). The chain is valid, but the EKU says the certificate may only be used to authenticate servers, so it can't act as a client certificate. Fix it by issuing the certificate with `clientAuth` (or both `serverAuth,clientAuth`).

</details>

### Explain it

In your own words: In your own words: why does it matter that NICo's control-plane services authenticate each other with certificates instead of shared passwords?

### Check

**1. In mTLS, how does the client prove it owns the certificate it sent?**

A. It signs the handshake transcript with its private key (CertificateVerify)
B. It sends its private key encrypted to the server
C. The server calls the CA to confirm the client
D. It attaches a JWT to the handshake

<details>
<summary>Answer</summary>

**A.** It signs the handshake transcript with its private key (CertificateVerify)

Private keys never leave their owner. Verification is offline against the trusted CA. JWTs are an application-layer mechanism.

</details>

**2. Why can NICo Core and RMS complete mutual TLS without extra certificate configuration?**

A. Both certificates are issued by the same cert-manager issuer, so each side's chain verifies against the other's trust
B. RMS turns off client verification
C. They share one private key
D. RMS uses JWT instead of certificates

<details>
<summary>Answer</summary>

**A.** Both certificates are issued by the same cert-manager issuer, so each side's chain verifies against the other's trust

The RMS docs say its server certificate is minted from the same issuer that signs NICo's certificate, and the RMS client presents NICo's SPIFFE certificate mount.

</details>

**3. Which NICo interface uses HTTP with JWT bearer tokens rather than mTLS/gRPC?**

A. NICo REST (JSON API) for orchestrators and admins
B. nico-admin-cli to the API Service
C. DPU Agent to the API Service
D. NICo Core to RMS

<details>
<summary>Answer</summary>

**A.** NICo REST (JSON API) for orchestrators and admins

The other three are documented as mTLS/gRPC connections.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [architecture/backends/rms.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/backends/rms.md)

<a id="cert-manager"></a>
## 8. cert-manager

*Builds on: Kubernetes Custom Resource (CR/CRD) (ch. 14), mTLS / gRPC (ch. 19)*

### Before you read

- A site has dozens of services, each with a 90-day certificate. Who renews them in the middle of the night?
- Guess: in cert-manager, what is the difference between an Issuer and a Certificate?

<details>
<summary>Answers</summary>

- **A site has dozens of services, each with a 90-day certificate. Who renews them in the middle of the night?** A controller, cert-manager, which watches certificate resources and reissues each one before it expires.
- **Guess: in cert-manager, what is the difference between an Issuer and a Certificate?** An Issuer (or ClusterIssuer) describes *how* to sign, such as a CA key or Vault. A Certificate describes *what* you want: names, lifetime and the Secret to store it in.

</details>

### Explanation

**cert-manager** is a Kubernetes controller that automates certificates. You declare what you want as custom resources (CRDs, chapter 14), and it obtains certificates and renews them.

**Core resources (`cert-manager.io/v1`):**
- **Issuer** (namespaced) and **ClusterIssuer** (cluster-wide) describe *how* to sign. Types include `selfSigned`, `ca` (signs with a CA key pair held in a Secret), `vault` (asks Vault's PKI engine) and ACME.
- **Certificate** describes the certificate you want: `secretName`, `dnsNames` / `ipAddresses` / `uris`, `duration`, `renewBefore`, `usages`, `isCA` and `issuerRef`.
- **CertificateRequest** is a single signing request that cert-manager creates from a Certificate and the issuer fulfils.

The result is a Secret of type `kubernetes.io/tls` containing `tls.crt`, `tls.key` and usually `ca.crt`, which pods mount. Before expiry (per `renewBefore`) cert-manager reissues the certificate and updates the Secret. Applications must reload the files to pick up the new certificate.

One trap: a `ca` **ClusterIssuer** reads its CA Secret from cert-manager's *cluster resource namespace*, which is `cert-manager` by default.

**approver-policy:** out of the box, cert-manager approves every CertificateRequest. approver-policy replaces that with policies (CertificateRequestPolicy resources) stating which requests may be approved, for example which issuers and which names. The NICo docs say approver flows must allow Certificate resources for NICo namespaces.

**NICo facts from the docs:**
- cert-manager issues and rotates the TLS certificates NICo services use for mTLS/gRPC. The validated version is v1.11.1 with approver-policy v0.6.3. The `setup.sh` component list installs cert-manager v1.17.1.
- Required ClusterIssuers are `site-issuer` (CA, backed by the `site-root` Secret) and `vault-nico-issuer` (Vault PKI). The reference install also creates `selfsigned-bootstrap`, which signs `site-root`.
- With `--skip-vault`, there is no `vault-nico-issuer`. The Core, RMS, Flow and site-agent service certificates come from `site-issuer`, and `nico-api` requests machine and UFM certificates through cert-manager.
- The NICo REST chart can create a Certificate for its ingress TLS from `nico-rest-ca-issuer`.
- Health checks include `kubectl get clusterissuer` and `kubectl get certificate core-grpc-client-site-agent-certs -n nico-rest`.

**Analogy.** A standing order with your bank. You state once what you want (Certificate), from whom (issuerRef) and when to renew (renewBefore), and it happens automatically. Where it breaks down: a bank deposits money that you can spend right away. cert-manager only updates the Secret, and your application still has to reload the new certificate.

### Worked example: Recreate a selfsigned-bootstrap → site CA → service certificate chain in kind

**Step 1: Create a cluster and install cert-manager.**

```bash
kind create cluster --name cm-lab
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.17.1/cert-manager.yaml
kubectl wait --for=condition=Available deployment --all -n cert-manager --timeout=180s
```

**Step 2: Bootstrap a CA and a CA ClusterIssuer.**

`issuers.yaml` (the names use a `lab-` prefix; they model NICo's pattern, not its exact manifests):
```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-bootstrap
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: lab-site-root
  namespace: cert-manager
spec:
  isCA: true
  commonName: lab-site-root
  secretName: lab-site-root
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: selfsigned-bootstrap
    kind: ClusterIssuer
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: lab-site-issuer
spec:
  ca:
    secretName: lab-site-root
```
`kubectl apply -f issuers.yaml && kubectl get clusterissuer` should show both issuers `READY True` (rerun if the webhook wasn't ready yet).

**Step 3: Request a service certificate.**

`demo-cert.yaml`:
```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: demo-api-tls
  namespace: default
spec:
  secretName: demo-api-tls
  duration: 24h
  renewBefore: 8h
  dnsNames:
    - demo-api.default.svc.cluster.local
    - demo-api.default
  usages:
    - server auth
    - client auth
  issuerRef:
    name: lab-site-issuer
    kind: ClusterIssuer
```
`kubectl apply -f demo-cert.yaml && kubectl get certificate demo-api-tls` should show `READY True`.

**Step 4: Inspect the issued Secret.**

```bash
kubectl get secret demo-api-tls -o jsonpath='{.data.tls\.crt}' | base64 -d \
  | openssl x509 -noout -subject -issuer -enddate -serial
kubectl get secret demo-api-tls -o jsonpath='{.data.tls\.crt}' | base64 -d \
  | openssl x509 -noout -text | grep -A1 'Subject Alternative Name'
```
The issuer is `CN=lab-site-root`, the SANs are the two service names, and the end date is about 24 hours away.

**Step 5: Watch it self-heal.**

```bash
kubectl delete secret demo-api-tls
kubectl get certificate demo-api-tls -w     # goes not-ready, then READY True again (Ctrl-C)
kubectl get secret demo-api-tls -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -serial
```
The serial is new: cert-manager reissued the certificate because the desired state wasn't met. Clean up with `kind delete cluster --name cm-lab`.

### Your turn: finish it

Fill in the blanks so this Certificate is signed by the lab CA ClusterIssuer from the worked example.

```text
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: rms-demo-tls
  namespace: default
spec:
  secretName: rms-demo-tls
  dnsNames:
    - rms-api-server.rack-manager.svc.cluster.local
  issuerRef:
    name: ___
    kind: ___
```

<details>
<summary>Answer</summary>

name: lab-site-issuer and kind: ClusterIssuer. If you leave out `kind`, cert-manager looks for a namespaced Issuer, which doesn't exist here.

</details>

### Your turn: on your own

A teammate creates the CA Secret `team-root` in the `default` namespace and a ClusterIssuer with `spec.ca.secretName: team-root`. Certificates using it never become Ready. Diagnose and fix it.

<details>
<summary>Hint 1</summary>

Start with `kubectl describe clusterissuer <name>` and read the conditions and events.

</details>

<details>
<summary>Hint 2</summary>

Which namespace does a ClusterIssuer read its referenced Secret from?

</details>

<details>
<summary>Hint 3</summary>

It's cert-manager's cluster resource namespace, `cert-manager` by default.

</details>

<details>
<summary>Answer</summary>

The ClusterIssuer isn't Ready because it looks for `team-root` in the `cert-manager` namespace (the cluster resource namespace), where it doesn't exist. Fix it by creating the CA Secret, or the `isCA` Certificate that produces it, in `cert-manager`, as the worked example does with `lab-site-root`. The alternative is a namespaced `Issuer` in `default`, but that only serves Certificates in `default`.

</details>

### Explain it

In your own words: Why does NICo use a controller like cert-manager instead of a one-time openssl script for its mTLS certificates, and what still has to happen in the application after cert-manager renews a certificate?

### Check

**1. What does a cert-manager Certificate resource produce?**

A. A Secret holding tls.crt and tls.key (and usually ca.crt), renewed before expiry
B. A new ClusterIssuer
C. A Vault PKI role
D. A ConfigMap containing the CA private key

<details>
<summary>Answer</summary>

**A.** A Secret holding tls.crt and tls.key (and usually ca.crt), renewed before expiry

Issuers are separate resources you create. Private keys go in Secrets, never ConfigMaps.

</details>

**2. On a site installed with `--skip-vault`, which ClusterIssuer issues the Core, RMS, Flow and site-agent service certificates?**

A. site-issuer
B. vault-nico-issuer
C. selfsigned-bootstrap
D. nico-rest-ca-issuer

<details>
<summary>Answer</summary>

**A.** site-issuer

With --skip-vault no vault-nico-issuer exists. selfsigned-bootstrap only signs site-root, and nico-rest-ca-issuer belongs to the REST stack, for example its ingress certificate.

</details>

**3. What does cert-manager's approver-policy do?**

A. Decides which CertificateRequests may be approved, based on policies
B. Signs certificates using Vault
C. Copies CA bundles into NICo namespaces
D. Renews expiring certificates

<details>
<summary>Answer</summary>

**A.** Decides which CertificateRequests may be approved, based on policies

Vault signing is vault-nico-issuer's job, copying CA bundles is External Secrets Operator's, and renewal is cert-manager's core controller's.

</details>

**Sources:** [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [architecture/backends/rms.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/backends/rms.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md)

<a id="build-task"></a>
## Build task: A mini site-controller trust chain on your laptop

**Goal:** Build a private CA and issue a server certificate and a client certificate with correct SANs. Run a toy OIDC-style token service that implements the client credentials grant with ES256 JWTs, and an API that requires both mutual TLS and a valid bearer token with the right `iss` and `aud`. Then show that each defence rejects the wrong input.

**Why it matters for NICo:** This is NICo's security model in small. Control-plane calls are authenticated with mTLS certificates from a site CA (`site-issuer` / `vault-nico-issuer`), and NICo REST accepts JWTs from Keycloak obtained through client credentials. The failures you trigger here (missing client certificate, wrong issuer, hostname not in the SAN) are the same ones you'll debug on a real site, such as the Keycloak port-forward `iss` mismatch.

**You need:**

- Linux or macOS with bash, openssl and curl (on macOS, if system openssl/LibreSSL complains, use `brew install openssl` and put it first on PATH)
- Python 3.9+ with the venv module
- Internet access once, for `pip install 'pyjwt[crypto]'`
- Free local ports 9000 and 8443

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Prepare the workspace and a strong client secret</summary>

```bash
mkdir -p ~/trust-lab/pki && cd ~/trust-lab
python3 -m venv .venv && . .venv/bin/activate
pip install 'pyjwt[crypto]'
export LAB_CLIENT_SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
echo "$LAB_CLIENT_SECRET"   # 256 bits from a CSPRNG
```
Run every later command from `~/trust-lab` in this same shell, so the venv and variable stay set.

</details>

<details>
<summary>Step 2: Build the PKI</summary>

Save as `pki.sh` and run `bash pki.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
cd pki
cat > ca.ext <<'EOF'
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
EOF
cat > server.ext <<'EOF'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,DNS:api.lab.internal,IP:127.0.0.1
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
cat > client.ext <<'EOF'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
subjectAltName=URI:spiffe://lab.internal/site-agent
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
openssl req -new -newkey rsa:2048 -nodes -keyout ca.key -subj '/CN=lab-site-root' -out ca.csr
openssl x509 -req -in ca.csr -signkey ca.key -days 365 -extfile ca.ext -out ca.crt
for n in server client; do
  openssl req -new -newkey rsa:2048 -nodes -keyout $n.key -subj "/CN=lab-$n" -out $n.csr
  openssl x509 -req -in $n.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 -extfile $n.ext -out $n.crt
done
openssl ecparam -name prime256v1 -genkey -noout -out idp.key
openssl ec -in idp.key -pubout -out idp.pub
openssl verify -CAfile ca.crt server.crt client.crt
```
The last line should print `server.crt: OK` and `client.crt: OK`.

</details>

<details>
<summary>Step 3: Check SAN coverage before running anything</summary>

```bash
openssl x509 -in pki/server.crt -noout -checkhost api.lab.internal   # does match
openssl x509 -in pki/server.crt -noout -checkhost x.lab.internal     # does NOT match
openssl x509 -in pki/client.crt -noout -text | grep -A1 'Subject Alternative Name'
```

</details>

<details>
<summary>Step 4: Write the token service (client credentials grant)</summary>

`idp.py`:
```python
import hmac, json, os, time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs
import jwt

ISSUER = os.environ.get('LAB_ISSUER', 'http://127.0.0.1:9000')
CLIENTS = {'lab-service': os.environ['LAB_CLIENT_SECRET']}
KEY = open('pki/idp.key').read()

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/token':
            return self.reply(404, {'error': 'not_found'})
        n = int(self.headers.get('Content-Length', 0))
        form = {k: v[0] for k, v in parse_qs(self.rfile.read(n).decode()).items()}
        if form.get('grant_type') != 'client_credentials':
            return self.reply(400, {'error': 'unsupported_grant_type'})
        cid, secret = form.get('client_id', ''), form.get('client_secret', '')
        if cid not in CLIENTS or not hmac.compare_digest(CLIENTS[cid], secret):
            return self.reply(401, {'error': 'invalid_client'})
        now = int(time.time())
        claims = {'iss': ISSUER, 'sub': cid, 'aud': 'lab-api', 'iat': now, 'exp': now + 300}
        token = jwt.encode(claims, KEY, algorithm='ES256')
        self.reply(200, {'access_token': token, 'token_type': 'Bearer', 'expires_in': 300})

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

HTTPServer(('127.0.0.1', 9000), H).serve_forever()
```
The token endpoint is plain HTTP on loopback to keep the lab simple. A real IdP must use HTTPS.

</details>

<details>
<summary>Step 5: Write the API (mTLS + JWT)</summary>

`api.py`:
```python
import json, ssl
from http.server import HTTPServer, BaseHTTPRequestHandler
import jwt

EXPECTED_ISS = 'http://127.0.0.1:9000'
PUB = open('pki/idp.pub').read()

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        sans = [v for _, v in self.connection.getpeercert().get('subjectAltName', ())]
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer '):
            return self.reply(401, {'error': 'missing bearer token'})
        try:
            claims = jwt.decode(auth[7:], PUB, algorithms=['ES256'],
                                audience='lab-api', issuer=EXPECTED_ISS)
        except jwt.InvalidTokenError as e:
            return self.reply(401, {'error': f'{type(e).__name__}: {e}'})
        self.reply(200, {'tls_client': sans, 'jwt_sub': claims['sub'], 'iss': claims['iss']})

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain('pki/server.crt', 'pki/server.key')
ctx.load_verify_locations('pki/ca.crt')
ctx.verify_mode = ssl.CERT_REQUIRED
srv = HTTPServer(('127.0.0.1', 8443), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
```

</details>

<details>
<summary>Step 6: Run both and make an authenticated call</summary>

```bash
python idp.py & python api.py &
sleep 1
TOKEN=$(curl -s -X POST http://127.0.0.1:9000/token \
  -d grant_type=client_credentials -d client_id=lab-service -d client_secret="$LAB_CLIENT_SECRET" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
curl -s --resolve api.lab.internal:8443:127.0.0.1 --cacert pki/ca.crt \
  --cert pki/client.crt --key pki/client.key \
  -H "Authorization: Bearer $TOKEN" https://api.lab.internal:8443/
```
Expected: `{"tls_client": ["spiffe://lab.internal/site-agent"], "jwt_sub": "lab-service", "iss": "http://127.0.0.1:9000"}`

</details>

<details>
<summary>Step 7: Prove each defence works</summary>

```bash
# 1. No client certificate: the TLS handshake is refused (curl error 35 or 56, no JSON)
curl -s --resolve api.lab.internal:8443:127.0.0.1 --cacert pki/ca.crt \
  -H "Authorization: Bearer $TOKEN" https://api.lab.internal:8443/; echo "exit=$?"
# 2. Client certificate but no token: 401 missing bearer token
curl -s --resolve api.lab.internal:8443:127.0.0.1 --cacert pki/ca.crt \
  --cert pki/client.crt --key pki/client.key https://api.lab.internal:8443/; echo
# 3. Wrong issuer (like the Keycloak localhost port-forward trap)
pkill -f idp.py; LAB_ISSUER=http://localhost:9000 python idp.py & sleep 1
BAD=$(curl -s -X POST http://127.0.0.1:9000/token -d grant_type=client_credentials \
  -d client_id=lab-service -d client_secret="$LAB_CLIENT_SECRET" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
curl -s --resolve api.lab.internal:8443:127.0.0.1 --cacert pki/ca.crt \
  --cert pki/client.crt --key pki/client.key -H "Authorization: Bearer $BAD" https://api.lab.internal:8443/; echo
# 4. Hostname not in the SAN: curl error 60, certificate does not match the name
curl -s --resolve x.lab.internal:8443:127.0.0.1 --cacert pki/ca.crt \
  --cert pki/client.crt --key pki/client.key https://x.lab.internal:8443/; echo "exit=$?"
pkill -f idp.py; pkill -f api.py
```

</details>

**Check it works:** The authenticated call in step 6 returns JSON containing both "tls_client": ["spiffe://lab.internal/site-agent"] and "jwt_sub": "lab-service". In step 7: test 1 exits non-zero with no JSON, test 2 returns {"error": "missing bearer token"}, test 3 returns {"error": "InvalidIssuerError: Invalid issuer"}, and test 4 exits with code 60.

<details>
<summary>If you get stuck</summary>

- `ModuleNotFoundError: No module named 'jwt'`: you're in a shell without the venv. Run `. .venv/bin/activate` from ~/trust-lab.
- `KeyError: 'LAB_CLIENT_SECRET'` when starting idp.py: export the variable (step 1) in the same shell before starting the servers.
- `Address already in use`: an earlier run is still alive. Run `pkill -f idp.py; pkill -f api.py` and start again.
- curl error 60 on the *good* call: you forgot `--cacert pki/ca.crt`, or you used a name that isn't in the server SAN. The `--resolve` flag maps api.lab.internal to 127.0.0.1 without editing /etc/hosts.
- `unable to load private key` or extension errors from openssl on macOS: the system LibreSSL may differ. Install OpenSSL with Homebrew and rerun pki.sh with that openssl first on PATH.
- Test 3 still returns 200: the old idp.py is still running with the default issuer. Check with `pgrep -fl idp.py`, kill it, and restart with `LAB_ISSUER` set.

</details>

**Stretch goal:** Replace the openssl CA with cert-manager. In a kind cluster, recreate the selfsigned-bootstrap → CA ClusterIssuer chain from the cert-manager lesson. Issue the server and client certificates as Certificate resources (`usages: [server auth]` and `[client auth]`, with the client using a `uris:` SAN), export `tls.crt`, `tls.key` and `ca.crt` with `kubectl get secret -o jsonpath`, and point api.py and curl at them. Then add a `/token-exchange` endpoint to idp.py that accepts RFC 8693 parameters (`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token`, `subject_token_type`, `audience`), verifies the subject token, and returns a new JWT whose `aud` is the requested audience.

## Review notes

The draft was rewritten once using review issues; the notes below are from the last review.

This chapter was written with 6 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **minor-issues**. Issues to fix before relying on this chapter:

- **minor** (cert-manager): The worked example runs `kubectl apply -f issuers.yaml && kubectl get clusterissuer` and expects both issuers READY True, with the note 'rerun if the webhook wasn't ready yet'. Right after apply, lab-site-issuer is normally not Ready yet, because the lab-site-root Secret hasn't been issued. A webhook that isn't ready makes the apply itself fail, not the get. The demo Certificate is likewise usually not Ready immediately after apply. *Fix:* Add a wait before checking, for example `kubectl wait --for=condition=Ready clusterissuer/lab-site-issuer --timeout=60s` and `kubectl wait --for=condition=Ready certificate/demo-api-tls --timeout=60s`. Reword the note: if apply fails with a webhook error, wait and re-apply; if an issuer or Certificate shows False, wait a few seconds for the CA Secret to be issued.

---

[← 18-cryptography.md](18-cryptography.md) · [20-credentials-secrets-security-identity.md →](20-credentials-secrets-security-identity.md)
