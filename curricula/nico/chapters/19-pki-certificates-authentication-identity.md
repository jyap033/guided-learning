# Chapter 19: PKI & Certificates · Authentication & Identity

*Part: Security & Identity · 8 concepts · [curriculum](../curriculum.md#chapter-19)*

> AI-generated and checked by an AI review pass, not yet by a person. Where a lesson lists sources, those docs pages are the authority.

Chapter 18 gave you the primitives: hashes, KDFs, symmetric encryption, envelope encryption and public-key signatures. This chapter builds the two trust systems NICo puts on top of them. One is **identity for callers**: who is calling the REST API, and how do they prove it? The other is **identity for services**: how does `nico-api` know the process connecting to it really is the site agent or RMS, and not something else on the network?

The first half covers tokens. You'll see why a key is only as strong as the randomness it came from, how an OIDC identity provider such as Keycloak issues signed JWTs, how a machine gets a token through the OAuth2 client credentials flow (the way you'll authenticate to NICo REST in later chapters), and how token exchange lets one token be swapped for another at an external STS.

The second half covers certificates. You'll build a small PKI with `openssl`, learn exactly which hostnames a certificate covers (wildcards included), run mutual TLS, and see how cert-manager automates all of it inside Kubernetes. NICo says plainly that *all control-plane services communicate over mTLS/gRPC*, so when a NICo pod can't reach another pod, the cause is often a certificate problem rather than a network one.

Everything here runs on a laptop with `openssl`, Python, Docker or Podman, and optionally `kind`. The build task wires the pieces into a tiny zero-trust API: it accepts a request only when the caller presents both a client certificate signed by your CA and a valid Keycloak-issued JWT.

**By the end of this chapter you can:**

- Estimate the entropy of a secret and explain why HKDF cannot rescue weak input key material from offline guessing
- Obtain a JWT with the OAuth2 client credentials flow, decode its claims, and diagnose an `iss` mismatch that makes an API reject it
- Describe what an RFC 8693 token exchange request contains and which NICo site settings constrain token delegation
- Build a root CA, an intermediate and leaf certificates with openssl, and predict which hostnames a SAN list (including wildcards) covers
- Run and troubleshoot a mutual-TLS connection, and explain how NICo services such as nico-api and RMS trust each other
- Use cert-manager Issuers and Certificates to issue and rotate certificates in a Kubernetes cluster

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
9. [Build task: A zero-trust API on your laptop: mTLS plus Keycloak JWTs](#build-task)

<a id="entropy-and-offline-guessing"></a>
## 1. Entropy and Offline Guessing

*Builds on: Key Derivation Function (KDF) (ch. 18)*

### Before you read

- You feed a 4-digit PIN into HKDF-SHA256 and get a 256-bit key. How many guesses does an attacker need, at most, to find that key?
- What is the difference between an attacker guessing your password at a login page and guessing it 'offline'?

<details>
<summary>Answers</summary>

- **You feed a 4-digit PIN into HKDF-SHA256 and get a 256-bit key. How many guesses does an attacker need, at most, to find that key?** 10,000. The output looks like 256 bits, but HKDF is deterministic. The attacker just runs HKDF on each of the 10,000 possible PINs and checks each result.
- **What is the difference between an attacker guessing your password at a login page and guessing it 'offline'?** At a login page every guess goes through your server, which can slow it down, lock the account or raise an alert. Offline, the attacker already holds something to test guesses against (a hash, a ciphertext, a derived key), so they can try billions of guesses on their own hardware and you never see it.

</details>

### Explanation

**Entropy** measures how unpredictable a secret is, in bits. A secret picked uniformly at random from *N* possibilities has log2(N) bits. A 4-digit PIN has log2(10,000) ≈ 13.3 bits. Six random lowercase letters have 6 × log2(26) ≈ 28 bits. Thirty-two bytes from a cryptographically secure random generator have 256 bits. Each extra bit doubles the attacker's work.

**Offline guessing** is the attack that makes entropy matter. If an attacker gets anything that lets them check a guess without talking to you, such as a stolen key, a ciphertext with a known structure, a hash, or a signed token, they can try guesses as fast as their GPUs allow. Nothing rate-limits them, nothing locks them out, and nothing logs the attempts. At a billion guesses per second, 13 bits falls in microseconds, about 40 bits in minutes, and 256 bits never.

In chapter 18 you met KDFs. **HKDF** takes *input key material* (IKM) and produces well-formed keys of any length, with different keys for different purposes via the `info` string. It is deterministic: the same IKM always gives the same output. So HKDF **adds no entropy**. If the IKM has 13 bits, the 256-bit output still has 13 bits, because the attacker simply runs HKDF on every candidate IKM. Password-hashing KDFs (Argon2, scrypt, PBKDF2) make each guess slower by a constant factor. They still don't add entropy, and HKDF isn't even slow.

The practical rule: **any IKM you derive keys from must already be full-entropy random**. Later (chapter 35) you'll derive per-device keys from an IKM. If one derived key, say a card key, ever leaks, an attacker can test IKM guesses against it offline. A weak IKM then exposes every key derived from it.

NICo's Day 0 guides generate key material this way: `openssl rand -base64 32` gives 256 random bits. The Integrated KEK provider checks that the key *decodes to 32 bytes*. Note what that check can't do: 32 bytes of the letter `a` pass the length check and have essentially zero entropy. Length is not unpredictability, so always generate keys and never type them.

**Analogy.** A combination lock with a very long dial readout but only one working digit wheel. The readout looks like it has millions of combinations, but a thief only has to spin the single real wheel. HKDF is the long readout: it makes the key look big without adding real wheels. Where it breaks down: a physical lock is guessed one try at a time by hand, while an offline attacker tries billions of combinations per second in parallel, so even 'pretty good' locks of 40 bits fall.

### Worked example: Brute-forcing an HKDF key derived from a PIN

**Step 1: Measure the entropy of each candidate secret.**

```bash
python3 -c 'import math; print("PIN:", math.log2(10**4)); print("6 lowercase:", 6*math.log2(26)); print("32 random bytes:", 32*8)'
```
You get about 13.3, 28.2 and 256 bits.

**Step 2: Derive a key from a weak IKM.**

Save as `hkdf_pin.py` (standard library only; this is RFC 5869 HKDF-SHA256):
```python
import hmac, hashlib, time

def hkdf_sha256(ikm, salt=b"", info=b"", length=32):
    prk = hmac.new(salt or b"\x00" * 32, ikm, hashlib.sha256).digest()
    okm, block, counter = b"", b"", 1
    while len(okm) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        okm += block
        counter += 1
    return okm[:length]

secret_pin = b"4831"
leaked = hkdf_sha256(secret_pin, info=b"card-key")
print("derived key:", leaked.hex())

start = time.time()
for n in range(10000):
    guess = f"{n:04d}".encode()
    if hkdf_sha256(guess, info=b"card-key") == leaked:
        print(f"recovered PIN {guess.decode()} in {time.time() - start:.3f}s")
        break
```

**Step 3: Play the attacker.**

Run `python3 hkdf_pin.py`. The derived key prints as 64 random-looking hex characters, and the loop still recovers `4831` in a fraction of a second. The attacker only needed the leaked key and the public algorithm (HKDF-SHA256 with `info=card-key`).

**Step 4: Generate a full-entropy key the way NICo's Day 0 guides do.**

```bash
openssl rand -base64 32          # 32 bytes = 256 bits from the OS CSPRNG
openssl rand -base64 32 | base64 -d | wc -c   # prints 32
```
A 256-bit search space can't be enumerated, so offline guessing is no longer a realistic threat. The `wc -c` check confirms the length, which is also what the Integrated KEK provider checks. It tells you nothing about randomness.

### Your turn: finish it

Complete the script so it prints the entropy of a 4-digit PIN and of a key from `openssl rand -base64 32`.

```text
import math
print("4-digit PIN:", math.log2(___), "bits")
print("openssl rand -base64 32:", ___ * 8, "bits")
```

<details>
<summary>Answer</summary>

import math
print("4-digit PIN:", math.log2(10000), "bits")
print("openssl rand -base64 32:", 32 * 8, "bits")

The PIN has 10,000 equally likely values (about 13.3 bits). The `32` in the openssl command is a byte count, before base64 encoding, so the key has 256 bits. The 44-character base64 string carries the same 256 bits.

</details>

### Your turn: on your own

A teammate proposes deriving a site KEK with HKDF from a passphrase of 4 words chosen at random from the 7,776-word Diceware list, so that operators can remember it. Estimate the entropy, estimate how long an offline attacker doing 10^9 HKDF guesses per second needs to search the whole space, and recommend what to do instead.

<details>
<summary>Hint 1</summary>

Entropy is log2 of the number of equally likely passphrases. How many 4-word combinations are there?

</details>

<details>
<summary>Hint 2</summary>

7776^4 ≈ 3.66 × 10^15, so log2 is about 51.7 bits. Divide the number of combinations by 10^9 to get seconds.

</details>

<details>
<summary>Hint 3</summary>

About 3.66 × 10^6 seconds is roughly 42 days for the full space, and about 21 days on average. Compare that with `openssl rand -base64 32`.

</details>

<details>
<summary>Answer</summary>

Entropy is 4 × log2(7776) ≈ 51.7 bits, about 3.66 × 10^15 combinations. At 10^9 guesses per second the whole space takes about 3.66 × 10^6 s ≈ 42 days, and on average half that. A determined attacker with several GPUs can do it, and HKDF adds no cost per guess. Recommendation: don't derive the KEK from anything memorable. Generate 32 random bytes (`openssl rand -base64 32`, or straight into a Kubernetes Secret as the Day 0 credential-store guide shows) and protect that key with backups and access control rather than human memory.

</details>

### Explain it

In your own words: In your own words, explain why running a weak secret through HKDF produces a key that looks 256 bits strong but isn't. What exactly does the attacker do to get around it?

### Check

**1. You run HKDF-SHA256 on a password made of 6 random lowercase letters and get a 256-bit key. Roughly how much entropy does the key have?**

A. 256 bits
B. About 28 bits
C. 512 bits, because HKDF uses HMAC twice
D. It depends on the length of the `info` string

<details>
<summary>Answer</summary>

**B.** About 28 bits

Entropy can't grow through a deterministic function: 6 × log2(26) ≈ 28 bits. The 256-bit output length is just the size of the key. HMAC's internal structure and the public `info` string add no unpredictability, because the attacker knows both.

</details>

**2. Which of these is offline guessing?**

A. An attacker tries 5 passwords per minute against the NICo REST login and gets locked out
B. An attacker who copied a database dump tests candidate passwords against stored hashes on their own GPUs
C. An attacker floods the Keycloak token endpoint until it is rate-limited
D. An attacker phishes an operator for their password

<details>
<summary>Answer</summary>

**B.** An attacker who copied a database dump tests candidate passwords against stored hashes on their own GPUs

Offline means guesses are checked against material the attacker already holds, with no server in the loop to rate-limit or log them. The login and token-endpoint attacks are online guessing, which the server can throttle. Phishing doesn't guess at all.

</details>

**3. NICo's Integrated KEK provider refuses to start unless the key decodes to 32 bytes. What does that check guarantee?**

A. The key has 256 bits of entropy
B. The key has the right length, but nothing about how random it is
C. The key was produced by `openssl rand`
D. The key has never been used before

<details>
<summary>Answer</summary>

**B.** The key has the right length, but nothing about how random it is

A length check can't measure randomness. 32 bytes of `a` pass it. You get the entropy only by generating the key with a CSPRNG, which is why the docs pipe `openssl rand -base64 32` straight into the Secret.

</details>

**Sources:** [getting-started/installation-options/day0-credential-store.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-credential-store.md), [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md)

<a id="oidc-jwt-authentication"></a>
## 2. OIDC / JWT authentication (Keycloak)

*Builds on: HTTP and web APIs (ch. 3), Public-key cryptography (ch. 18)*

### Before you read

- A JWT is three base64url strings joined by dots. If someone intercepts one, can they read what's inside?
- To check a token signed by Keycloak, does the API server need to call Keycloak on every request?

<details>
<summary>Answers</summary>

- **A JWT is three base64url strings joined by dots. If someone intercepts one, can they read what's inside?** Yes. Base64url is an encoding, not encryption. Anyone can decode the header and payload. The signature stops people from *changing* the token, not from reading it.
- **To check a token signed by Keycloak, does the API server need to call Keycloak on every request?** No. The server fetches Keycloak's public signing keys once and caches them, then checks each token's signature locally. That's public-key cryptography doing its job.

</details>

### Explanation

**Authentication** answers 'who are you?'. Instead of every service storing passwords, an **identity provider (IdP)** does the login once and hands out proof. **OAuth 2.0** is the standard framework for issuing access tokens. **OpenID Connect (OIDC)** is a layer on top of OAuth 2.0 that standardises identity: login flows, ID tokens, and a discovery document at `<issuer>/.well-known/openid-configuration` that lists the IdP's `token_endpoint` and `jwks_uri` (where its public keys live).

**Keycloak** is an open-source IdP. A Keycloak **realm** is an isolated space of users and clients, and its issuer URL has the form `<base-url>/realms/<realm>`.

The tokens are **JWTs (JSON Web Tokens)**: `header.payload.signature`, each part base64url-encoded.
- The header names the algorithm (`RS256`, `ES256`) and a `kid` (key id).
- The payload holds **claims**: `iss` (issuer, meaning who signed it), `sub` (subject, meaning who it's about), `aud` (audience, meaning who it's for), `exp` (expiry), `iat` (issued at), and often `azp` (the client it was issued to).
- The signature is the IdP's private-key signature over the first two parts.

A service that accepts JWTs (a *resource server*) verifies four things:
1. The signature checks out with the IdP public key matching `kid`, fetched from the JWKS.
2. `iss` equals the issuer it's configured to trust.
3. `aud` contains its own audience.
4. `exp` hasn't passed.

If any check fails, it rejects the token. Because verification only needs the public key, no per-request call to the IdP is needed. JWTs are signed, not encrypted, so never put secrets in claims, and treat the token itself as a secret: whoever holds it can use it.

**In NICo:** orchestrators and admins reach NICo REST (the JSON API) over HTTP with JWTs. The API Service's debug web UI at `/admin` uses OIDC login. Keycloak is an optional prerequisite, and `setup.sh` deploys a dev instance with a `nico` realm. In `helm-prereqs/values/nico-rest.yaml` you can point `nico-rest-api` at your own Keycloak (`baseURL`, `realm`, `clientID`) or disable Keycloak and list generic OIDC `issuers`, each with an `issuer` and `audience`. Those two values are exactly checks 2 and 3 above.

**Analogy.** A festival wristband with a hologram. Security at each stage doesn't phone the ticket office; they check the hologram (signature), the festival name (issuer), the stage it's valid for (audience) and the date (expiry). Where it breaks down: anyone can photocopy and read a JWT perfectly, and a stolen one works for whoever holds it until it expires. A wristband is at least attached to one wrist.

### Worked example: Sign, decode, verify and tamper with a JWT

**Step 1: Install the libraries.**

```bash
python3 -m venv jwtlab && . jwtlab/bin/activate
pip install "pyjwt[crypto]"
```

**Step 2: Act as the IdP: sign a token.**

Save as `jwt_demo.py`:
```python
import base64, json, time, jwt
from cryptography.hazmat.primitives.asymmetric import ec

idp_key = ec.generate_private_key(ec.SECP256R1())
ISSUER = "https://idp.example.com/realms/ops"
now = int(time.time())
claims = {"iss": ISSUER, "sub": "svc-123", "aud": "nico-api", "iat": now, "exp": now + 300}
token = jwt.encode(claims, idp_key, algorithm="ES256", headers={"kid": "key-1"})
print(token, "\n")

def b64d(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

header_b64, payload_b64, sig_b64 = token.split(".")
print("header :", json.loads(b64d(header_b64)))
print("payload:", json.loads(b64d(payload_b64)))

pub = idp_key.public_key()
print("verified:", jwt.decode(token, pub, algorithms=["ES256"], issuer=ISSUER, audience="nico-api"))

forged_claims = dict(claims, sub="admin")
forged_payload = base64.urlsafe_b64encode(json.dumps(forged_claims).encode()).rstrip(b"=").decode()
forged = ".".join([header_b64, forged_payload, sig_b64])
try:
    jwt.decode(forged, pub, algorithms=["ES256"], issuer=ISSUER, audience="nico-api")
except jwt.InvalidSignatureError as e:
    print("forged token rejected:", e)

try:
    jwt.decode(token, pub, algorithms=["ES256"], issuer="https://other.example.com/realms/ops", audience="nico-api")
except jwt.InvalidIssuerError as e:
    print("wrong issuer rejected:", e)
```

**Step 3: Read the token without any key.**

Run `python3 jwt_demo.py`. The header and payload print in plain JSON, and decoding them needed no key. That's why claims must never carry secrets.

**Step 4: Verify like a resource server.**

The `verified:` line shows that `jwt.decode` checked the signature with the **public** key, then `iss`, `aud` and `exp`. This is the job `nico-rest-api` does with the `issuer` and `audience` values in its config.

**Step 5: Watch the checks catch attacks.**

Changing `sub` to `admin` breaks the signature (`InvalidSignatureError`). A perfectly valid token checked against a different expected issuer fails too (`InvalidIssuerError`). Remember this second failure, because it's the most common real-world NICo token problem, covered in the next lesson.

### Your turn: finish it

Your organisation runs its own OIDC provider at `https://idp.example.com/realms/ops`, which issues tokens with `aud: nico-api`. Fill in the blanks so `nico-rest-api` validates tokens against it instead of the bundled Keycloak (Option 2 in the quick start).

```text
nico-rest-api:
  config:
    keycloak:
      enabled: ___
    issuers:
      - issuer: "https://idp.example.com/realms/ops"
        audience: ___
```

<details>
<summary>Answer</summary>

nico-rest-api:
  config:
    keycloak:
      enabled: false
    issuers:
      - issuer: "https://idp.example.com/realms/ops"
        audience: "nico-api"

`enabled: false` stops nico-rest-api from using Keycloak for token validation. The docs note that setup.sh still deploys the Keycloak instance. `audience` must match the `aud` claim your IdP puts in tokens.

</details>

### Your turn: on your own

nico-rest-api is configured with `issuer: "https://idp.example.com/realms/ops"` and `audience: "nico-api"`. A token has a valid signature from that IdP, and its decoded payload is `{"iss": "https://idp.example.com/realms/ops", "sub": "8f1c...", "aud": ["account"], "azp": "ops-bot", "exp": <one hour from now>}`. Is it accepted? If not, which check fails, and where would you fix it?

<details>
<summary>Hint 1</summary>

Go through the four checks one at a time: signature, iss, aud, exp.

</details>

<details>
<summary>Hint 2</summary>

Signature, iss and exp all pass. Compare the `aud` list with the configured audience.

</details>

<details>
<summary>Hint 3</summary>

`aud` contains only `account`, not `nico-api`. The fix belongs on the IdP side, in what it puts into tokens for this client.

</details>

<details>
<summary>Answer</summary>

Rejected. The audience check fails: the API expects `nico-api` in `aud`, but the token only names `account`. Signature, issuer and expiry are all fine. The fix is at the IdP: configure the `ops-bot` client so its tokens include `nico-api` in `aud` (in Keycloak, an audience mapper on the client or client scope). Don't relax the API's audience check. That check stops a token minted for some other service being replayed against NICo.

</details>

### Explain it

In your own words: Why can nico-rest-api trust a JWT it has never seen before without calling Keycloak, and why does it still have to check `iss` and `aud` when the signature is valid?

### Check

**1. What does the resource server need in order to verify a JWT's signature?**

A. The IdP's private key
B. The IdP's public key, usually fetched from its JWKS endpoint
C. The client's secret
D. A shared HMAC key with every client

<details>
<summary>Answer</summary>

**B.** The IdP's public key, usually fetched from its JWKS endpoint

The IdP signs with its private key, which never leaves it, and anyone can verify with the public key. Client secrets authenticate the client *to the IdP* and play no part in verifying tokens. Shared HMAC keys exist (HS256) but would let every verifier forge tokens.

</details>

**2. Which NICo component uses OIDC login for a web UI?**

A. The DHCP server
B. The API Service's debug web UI on `/admin`
C. The DPU Agent
D. The PXE service

<details>
<summary>Answer</summary>

**B.** The API Service's debug web UI on `/admin`

The architecture overview says the API Service exposes `/admin` over HTTPS with OIDC authentication. DHCP, PXE and the DPU Agent talk to the API Service over mTLS/gRPC (or serve hosts directly) and have no human login.

</details>

**3. A JWT's payload contains `"iss": "http://keycloak.nico-rest:8082/realms/nico"`. What does this claim tell the API?**

A. Which IdP and realm signed the token
B. Which API the token is meant for
C. The user's email address
D. Where to send the token next

<details>
<summary>Answer</summary>

**A.** Which IdP and realm signed the token

`iss` is the issuer. The intended recipient is `aud`. Identity details live in `sub` and optional profile claims. Nothing in a JWT tells you where to forward it.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="oauth2-client-credentials-flow-and-jwt-bearer-tokens"></a>
## 3. OAuth2 client credentials flow and JWT bearer tokens

*Builds on: OIDC / JWT authentication (Keycloak) (ch. 19)*

### Before you read

- A nightly automation job needs to call an API, and no human is around to log in. What could it send to the identity provider to get a token?
- You get a token by port-forwarding Keycloak to localhost and requesting it there. The token is genuine and unexpired, but the API rejects it. Guess why.

<details>
<summary>Answers</summary>

- **A nightly automation job needs to call an API, and no human is around to log in. What could it send to the identity provider to get a token?** Its own credentials: a client ID and client secret registered with the IdP. That's the OAuth2 client credentials flow.
- **You get a token by port-forwarding Keycloak to localhost and requesting it there. The token is genuine and unexpired, but the API rejects it. Guess why.** Keycloak puts the URL you used to reach it into the token's `iss` claim. A localhost URL doesn't match the in-cluster issuer the API trusts.

</details>

### Explanation

The **client credentials grant** (OAuth 2.0, RFC 6749 §4.4) is for machine-to-machine calls with no user involved. The procedure:

1. **Register a client** at the IdP. It gets a `client_id` and a `client_secret`.
2. **Request a token.** The client sends an HTTP `POST` to the IdP's token endpoint with a form-encoded body: `grant_type=client_credentials`, `client_id=...`, `client_secret=...`.
3. **Receive the token.** The IdP replies with JSON: `access_token` (a signed JWT, in Keycloak's case), `expires_in` and `token_type: Bearer`.
4. **Call the API** with the header `Authorization: Bearer <access_token>`. The API verifies the JWT as in the previous lesson.
5. **Refresh by repeating step 2** before `expires_in` runs out.

**Bearer** means 'whoever bears this token may use it'. There's no extra proof of possession, so protect tokens like passwords and keep lifetimes short. The client secret is a long-lived credential and needs real entropy (lesson 1).

**The `iss` trap.** Unless Keycloak is configured with a fixed hostname, it builds the `iss` claim from the URL the request arrived on. NICo's dev Keycloak is reached in-cluster as `keycloak.nico-rest:8082`, so `nico-rest-api` expects `iss` to be `http://keycloak.nico-rest:8082/realms/nico`. The NICo quick start is explicit: *do not* port-forward Keycloak and request tokens against `localhost`, or the `iss` won't match and the token is rejected. Fetch tokens from inside the cluster.

**NICo's dev values** (when `keycloak.enabled: true`, the default):

| Setting | Value |
|---|---|
| Token endpoint | `http://keycloak.nico-rest:8082/realms/nico/protocol/openid-connect/token` |
| `grant_type` | `client_credentials` |
| `client_id` | `ncx-service` |
| `client_secret` | `nico-local-secret` |

The helper `helm-prereqs/keycloak/get-token.sh` runs `curl` from a throw-away in-cluster pod and prints the token. That token is how you authenticate later to `nicocli` and to the one-time org bootstrap call (`/v2/org/ncx/nico/service-account/current`). These dev credentials are well known, so production sites point NICo REST at their own IdP.

**Analogy.** A hotel key-card machine for staff. The cleaning contractor shows their company badge (client ID and secret) at the front desk (token endpoint) and gets a key card (access token) that opens doors until it expires. Doors check the card, never the badge. Where it breaks down: a hotel card is encoded for *this* hotel's locks. The `iss` problem is like getting a card from a desk the doors don't recognise because you walked in through a side entrance with a different name on it.

### Worked example: Get a NICo REST token and use it

**Step 1: Collect the flow parameters.**

From the quick start: token endpoint `http://keycloak.nico-rest:8082/realms/nico/protocol/openid-connect/token`, `client_id=ncx-service`, `client_secret=nico-local-secret`, grant `client_credentials`. These only apply when the bundled dev Keycloak is enabled.

**Step 2: Request the token from inside the cluster.**

Use the documented helper:
```bash
TOKEN=$(helm-prereqs/keycloak/get-token.sh)
```
Under the hood this is a standard OAuth2 request made from a pod. Done by hand, the same request looks like this:
```bash
kubectl run -i --rm --restart=Never --image=curlimages/curl get-token \
  -n nico-rest --quiet -- \
  -s -X POST http://keycloak.nico-rest:8082/realms/nico/protocol/openid-connect/token \
  -d grant_type=client_credentials \
  -d client_id=ncx-service \
  -d client_secret=nico-local-secret
```
The JSON response has `access_token`, `expires_in` and `token_type`.

**Step 3: Inspect the claims.**

```bash
python3 -c 'import sys,json,base64; p=sys.argv[1].split(".")[1]; print(json.dumps(json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4))), indent=2))' "$TOKEN"
```
Check that `iss` is `http://keycloak.nico-rest:8082/realms/nico` and that `exp` is in the future.

**Step 4: Send it as a bearer token.**

```bash
kubectl run -i --rm --restart=Never --image=curlimages/curl curl-test \
  -n nico-rest --quiet -- \
  -sf http://nico-rest-api.nico-rest:8388/v2/org/ncx/nico/user/current \
  -H "Authorization: Bearer $TOKEN"
```
A JSON response means the token verified. With `-sf`, a rejection makes curl exit non-zero instead.

**Step 5: Know the failure mode.**

If you had run `kubectl port-forward` to Keycloak and requested `http://localhost:8082/...`, the token's `iss` would be `http://localhost:8082/realms/nico`, and nico-rest-api would reject it even though the signature is valid.

### Your turn: finish it

Fill in the blanks in this generic client-credentials request and API call (any OAuth2 IdP).

```text
TOKEN=$(curl -s -X POST "$TOKEN_ENDPOINT" \
  -d grant_type=___ \
  -d client_id="$CLIENT_ID" \
  -d client_secret="$CLIENT_SECRET" | jq -r .access_token)

curl -s "$API/v2/org/ncx/nico/user/current" -H "Authorization: ___ $TOKEN"
```

<details>
<summary>Answer</summary>

TOKEN=$(curl -s -X POST "$TOKEN_ENDPOINT" \
  -d grant_type=client_credentials \
  -d client_id="$CLIENT_ID" \
  -d client_secret="$CLIENT_SECRET" | jq -r .access_token)

curl -s "$API/v2/org/ncx/nico/user/current" -H "Authorization: Bearer $TOKEN"

The grant type names the flow, and `Bearer` is the authorization scheme the API expects. One gotcha: `curl -d` doesn't URL-encode values, so a secret containing `+` or `&` gets mangled. Use `--data-urlencode` for such secrets.

</details>

### Your turn: on your own

A colleague writes: "I ran `kubectl port-forward -n nico-rest svc/keycloak 8082:8082`, got a token from http://localhost:8082/realms/nico/protocol/openid-connect/token with the ncx-service credentials, and nico-rest-api returns 401. The secret is right, because Keycloak gave me a token." Diagnose the problem, give one command that proves it, and give the fix.

<details>
<summary>Hint 1</summary>

The token was issued, so the client ID and secret are fine. The problem is on the verification side.

</details>

<details>
<summary>Hint 2</summary>

Decode the payload and look at one specific claim. Which value does nico-rest-api expect?

</details>

<details>
<summary>Hint 3</summary>

`iss` will be `http://localhost:8082/realms/nico`, and nico-rest-api trusts `http://keycloak.nico-rest:8082/realms/nico`.

</details>

<details>
<summary>Answer</summary>

Keycloak built the `iss` claim from the URL used, so the token says `iss: http://localhost:8082/realms/nico`. nico-rest-api trusts the in-cluster issuer `http://keycloak.nico-rest:8082/realms/nico`, so it rejects the token. Prove it by decoding the payload: `python3 -c 'import sys,json,base64; p=sys.argv[1].split(".")[1]; print(json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4)))["iss"])' "$TOKEN"`. Fix: fetch the token from inside the cluster with `TOKEN=$(helm-prereqs/keycloak/get-token.sh)`. Port-forwarding *nico-rest-api* for nicocli is fine, because that doesn't change what is inside the token.

</details>

### Explain it

In your own words: Explain why a perfectly valid, unexpired, correctly signed token can still be rejected purely because of the hostname used to request it.

### Check

**1. In the client credentials flow, where does the client put the access token when calling the API?**

A. In an `Authorization: Bearer <token>` header
B. In the request body as `client_secret`
C. In a cookie named `iss`
D. In the URL as `?grant_type=<token>`

<details>
<summary>Answer</summary>

**A.** In an `Authorization: Bearer <token>` header

The bearer header is the standard way to present an access token. `client_secret` and `grant_type` are only sent to the token endpoint, never to the API, and putting tokens in URLs leaks them into logs.

</details>

**2. Why does the NICo quick start insist that you fetch Keycloak tokens from inside the cluster?**

A. Keycloak blocks connections from outside the cluster
B. The token's `iss` claim reflects the URL used, and must match the issuer nico-rest-api expects
C. Tokens fetched from outside are unsigned
D. The client secret only works inside the cluster

<details>
<summary>Answer</summary>

**B.** The token's `iss` claim reflects the URL used, and must match the issuer nico-rest-api expects

A port-forwarded request succeeds, so Keycloak isn't blocking it and the secret works. Tokens are always signed. The only difference is `iss`.

</details>

**3. Why are bearer tokens usually short-lived?**

A. Because JWT signatures weaken over time
B. Because anyone who steals one can use it, so a short lifetime limits the damage
C. Because Keycloak's database can only store a few tokens
D. Because HTTP headers have a time limit

<details>
<summary>Answer</summary>

**B.** Because anyone who steals one can use it, so a short lifetime limits the damage

Bearer means possession is enough. The signature doesn't decay, and access tokens aren't looked up in a database per request. Expiry is what caps the damage from a leaked token.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="token-delegation"></a>
## 4. Token delegation (RFC 8693 token exchange)

*Builds on: OAuth2 client credentials flow and JWT bearer tokens (ch. 19)*

### Before you read

- A workload on a NICo-managed machine has a token NICo issued to it. It now needs to call an external storage service that only trusts tokens from its own issuer. Without storing a long-lived password on the machine, how might it get a suitable token?
- If a control plane sends HTTP requests to URLs that tenants configure, what could go wrong?

<details>
<summary>Answers</summary>

- **A workload on a NICo-managed machine has a token NICo issued to it. It now needs to call an external storage service that only trusts tokens from its own issuer. Without storing a long-lived password on the machine, how might it get a suitable token?** Swap its NICo token for a new one at a token service the storage provider trusts. The service checks the first token and issues the second. That's token exchange (RFC 8693).
- **If a control plane sends HTTP requests to URLs that tenants configure, what could go wrong?** A tenant could point it at internal addresses (metadata endpoints, admin APIs, the database) and use the control plane as a stepping stone. This is server-side request forgery (SSRF). Allowlists and egress proxies limit where those requests can go.

</details>

### Explanation

**Token exchange** (RFC 8693) is an OAuth 2.0 extension: a client sends a token it already has to a **security token service (STS)** and gets back a different token. Typically the new token has a different issuer, audience or scope. The request is a `POST` to the STS token endpoint with form fields:

- `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
- `subject_token`: the token being exchanged, which represents *who* the request is about
- `subject_token_type`: what kind of token it is, e.g. `urn:ietf:params:oauth:token-type:jwt`
- optional `actor_token` / `actor_token_type`: who is acting on the subject's behalf
- optional `audience`, `resource`, `scope`, `requested_token_type`: what you want back

The STS verifies the subject token (signature, issuer, audience, expiry, as in the OIDC lesson), applies its own policy, and returns JSON with `access_token`, `issued_token_type` and `token_type`. When there's an actor, it's called **delegation**: the new token says 'A acting for B'. When the STS just issues a token as B, it's called impersonation.

Why bother? Identities can then be bridged between trust domains without long-lived secrets. A workload proves who it is with a short-lived token from one issuer and receives a short-lived token another system accepts.

**In NICo:** NICo's machine identity feature lets workloads on provisioned instances obtain short-lived signed JWTs (you'll meet the SPIFFE details in chapter 21). Per-org settings configured on Day 1 include token delegation. NICo can then exchange tokens with external STS endpoints. The site-wide Day 0 `[machine_identity]` section has two related guard rails:

- `token_endpoint_http_proxy`: an egress proxy for delegation calls. It's recommended when delegating to external HTTPS STS endpoints, so outbound traffic leaves through one controlled, auditable path.
- `token_endpoint_domain_allowlist`: restricts which `token_endpoint` hosts a per-org config may use. Empty means no extra restriction beyond API validation.

Both guard against a tenant-supplied URL turning NICo into an SSRF tool. Site config for `[machine_identity]` isn't hot-reloaded, so restart `nico-api` after changing it.

**Analogy.** A currency exchange desk at an airport. You hand over money issued by one country (the subject token), the desk checks it's genuine and gives you local currency (the new token) that shops here accept. Where it breaks down: an exchange desk doesn't care who you are, while an STS issues the new token *about* the identity in the old one, and may record who acted on whose behalf.

### Worked example: Following a delegated token from NICo to an external STS

**Step 1: Enable the site-level guard rails (Day 0).**

In the nico-api site config (from the Day 0 machine identity guide):
```toml
[machine_identity]
enabled = true
current_encryption_key_id = "kv1"
algorithm = "ES256"
token_endpoint_http_proxy = "https://nico-egress-proxy.example.com"
token_endpoint_domain_allowlist = ["sts.example.com", "*.tenant.example.com"]
```
Then restart nico-api, because this section isn't hot-reloaded.

**Step 2: Identify the subject token.**

The workload holds a short-lived JWT signed by NICo with the org's ES256 signing key. That JWT is the `subject_token`. Per-org issuer, audiences, TTL and the delegation target are Day 1 settings, made with `PUT …/tenant-identity/config`.

**Step 3: See the shape of the exchange request.**

This illustrates RFC 8693 on the wire, aimed at a hypothetical STS. It isn't a NICo command:
```bash
curl -s -X POST https://sts.example.com/oauth2/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  --data-urlencode subject_token="$NICO_JWT" \
  -d subject_token_type=urn:ietf:params:oauth:token-type:jwt \
  -d audience=storage.example.com
```

**Step 4: Read the response.**

A successful STS reply looks like:
```json
{"access_token": "eyJ...", "issued_token_type": "urn:ietf:params:oauth:token-type:access_token", "token_type": "Bearer", "expires_in": 900}
```
The new token is then used as an ordinary bearer token against `storage.example.com`.

**Step 5: Check the egress path.**

Because `token_endpoint_http_proxy` is set, NICo sends the call through the egress proxy. Because of the allowlist, a per-org config that names a host outside `sts.example.com` / `*.tenant.example.com` is restricted. Tenants can't make NICo call arbitrary hosts.

### Your turn: finish it

Complete the RFC 8693 request that exchanges a JWT held in `$SUBJECT` for a token aimed at `api.partner.example`.

```text
curl -s -X POST "$STS_TOKEN_ENDPOINT" \
  -d grant_type=___ \
  --data-urlencode subject_token="$SUBJECT" \
  -d subject_token_type=___ \
  -d audience=api.partner.example
```

<details>
<summary>Answer</summary>

curl -s -X POST "$STS_TOKEN_ENDPOINT" \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  --data-urlencode subject_token="$SUBJECT" \
  -d subject_token_type=urn:ietf:params:oauth:token-type:jwt \
  -d audience=api.partner.example

The grant type is a URN, not a short word like `client_credentials`. The subject token type tells the STS how to parse and verify what you sent.

</details>

### Your turn: on your own

Your site has `token_endpoint_domain_allowlist = ["sts.example.com", "*.tenant.example.com"]` and no `token_endpoint_http_proxy`. A tenant asks to configure delegation to `https://sts.attacker.example.net/token`. (a) What should happen, and why does the allowlist exist? (b) Why would you also add an egress proxy? (c) After you add the proxy setting, what must you do for it to take effect?

<details>
<summary>Hint 1</summary>

Compare the requested host with the two allowlist entries.

</details>

<details>
<summary>Hint 2</summary>

Think about SSRF and about having one place to see and control outbound traffic.

</details>

<details>
<summary>Hint 3</summary>

The Day 0 guide says something specific about reloading `[machine_identity]`.

</details>

<details>
<summary>Answer</summary>

(a) The host matches neither entry, so the allowlist restricts it and NICo won't use that token endpoint. The allowlist stops tenants pointing NICo's outbound token calls (which carry subject tokens) at arbitrary or malicious hosts. (b) An egress proxy sends all delegation traffic through one controlled, logged exit. You can apply network policy there, and the control plane doesn't need broad internet access. The Day 0 guide recommends it for delegation to external HTTPS STS endpoints. (c) Restart `nico-api`, because site config for `[machine_identity]` isn't hot-reloaded.

</details>

### Explain it

In your own words: Why is exchanging a short-lived token at an STS safer than placing a long-lived API key for the external service on every provisioned machine?

### Check

**1. In an RFC 8693 request, what is the `subject_token`?**

A. The token being exchanged, which represents who the request is about
B. The new token the STS returns
C. The STS's signing key
D. The client secret of the STS

<details>
<summary>Answer</summary>

**A.** The token being exchanged, which represents who the request is about

The client sends the subject token, and the STS returns `access_token`. Signing keys and secrets never travel in the request.

</details>

**2. What does NICo's `token_endpoint_http_proxy` setting do?**

A. Routes token-delegation calls to external STS endpoints through an egress proxy
B. Proxies all NICo REST API traffic
C. Replaces Keycloak as the token issuer
D. Caches JWTs for faster validation

<details>
<summary>Answer</summary>

**A.** Routes token-delegation calls to external STS endpoints through an egress proxy

It's a `[machine_identity]` Day 0 option for delegation traffic only. It doesn't touch REST ingress or Keycloak, and it doesn't cache anything.

</details>

**3. You change `token_endpoint_domain_allowlist` in the site config. Nothing changes in behaviour. Why?**

A. The allowlist only applies on Day 1
B. `[machine_identity]` isn't hot-reloaded, so nico-api must be restarted
C. Allowlists only take IP addresses
D. The DPU agent caches the allowlist

<details>
<summary>Answer</summary>

**B.** `[machine_identity]` isn't hot-reloaded, so nico-api must be restarted

The Day 0 guide says to restart nico-api after editing this section. The allowlist is a Day 0 site setting, it takes hostnames (including wildcard patterns, as in the example), and the DPU agent's `[machine-identity]` section is a separate config.

</details>

**Sources:** [getting-started/installation-options/day0-machine-identity.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/installation-options/day0-machine-identity.md)

<a id="pki-and-tls-certificates"></a>
## 5. PKI and TLS certificates

*Builds on: Public-key cryptography (ch. 18)*

### Before you read

- Someone sends you a public key and says 'this is nico-api's key'. What's missing before you should believe them?
- A root CA certificate is signed by its own key. Why would anyone trust it?

<details>
<summary>Answers</summary>

- **Someone sends you a public key and says 'this is nico-api's key'. What's missing before you should believe them?** Proof that binds the key to that identity, from someone you already trust. A certificate supplies that proof: a trusted CA signs a statement that this key belongs to this name.
- **A root CA certificate is signed by its own key. Why would anyone trust it?** Because it's been placed in the trust store on purpose (shipped with the OS or browser, or distributed by the operator, like NICo's `nico-roots` bundle). Trust in a root comes from configuration, not from its signature.

</details>

### Explanation

Public-key crypto (chapter 18) lets you verify signatures and set up encrypted sessions, but a bare public key says nothing about *whose* key it is. **Public key infrastructure (PKI)** solves this with certificates.

An **X.509 certificate** is a signed document containing:
- a **subject** (who it's for) and **Subject Alternative Names (SANs)**, the DNS names, IPs or URIs it covers (next lesson)
- the subject's **public key**
- a **validity window** (`notBefore`/`notAfter`)
- **extensions**: `basicConstraints` (is this a CA?), `keyUsage`/`extendedKeyUsage` (server auth, client auth, cert signing)
- the **issuer** name and the issuer's **signature** over all of it

A **certificate authority (CA)** is a key pair whose job is signing certificates. Certificates form a **chain**: leaf ← intermediate CA ← root CA. The root is self-signed and sits in a **trust store**. To verify a leaf, a client checks each signature up the chain until it reaches a trusted root, and also checks validity dates, CA flags and key usages. Requesters create their own key pair and send a **certificate signing request (CSR)**, so the private key never leaves them.

**TLS** uses this: during the handshake the server presents its certificate chain and proves it holds the private key. **mTLS** (lesson 7) does the same in both directions.

**NICo's PKI** (reference install) is a private one, built by cert-manager in phase 2 of `setup.sh`:
- a `selfsigned-bootstrap` issuer signs the **`site-root`** CA
- the `site-issuer` ClusterIssuer is a CA issuer backed by the `site-root` Secret
- `vault-nico-issuer` is backed by Vault's PKI engine (absent with `--skip-vault`, where `site-issuer` signs the Core, RMS, Flow and site-agent certs)
- External Secrets Operator copies the root bundle into each NICo namespace as the `nico-roots` Secret (keys `site-root`, `nico-root`), so every service knows which roots to trust

When a NICo client says 'unknown CA', it usually means one of these trust bundles is missing or holds the wrong root.

**Analogy.** A passport. The passport office (CA) checks who you are and issues a document binding your name and photo (public key) to its seal (signature). Border guards (clients) don't know you, but they trust the seals of a list of passport offices (trust store). Where it breaks down: a forged-looking passport can still fool a tired guard, but a certificate signature either checks out mathematically or it doesn't. The weak points are instead CAs issuing to the wrong party and private keys being stolen.

### Worked example: Build a one-level private CA with openssl

**Step 1: Create the root CA.**

```bash
mkdir pki-lab && cd pki-lab
openssl req -x509 -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout ca.key -out ca.crt -days 30 -subj "/CN=Lab Site Root" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"
```
This needs OpenSSL 1.1.1 or later. On macOS, `brew install openssl@3` if the built-in LibreSSL complains.

**Step 2: Create a key and CSR for a service.**

```bash
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout api.key -out api.csr -subj "/CN=api.lab.internal"
```
The private key `api.key` stays with the service. Only `api.csr` goes to the CA.

**Step 3: Have the CA sign it.**

```bash
openssl x509 -req -in api.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out api.crt -days 7 \
  -extfile <(printf "subjectAltName=DNS:api.lab.internal\nextendedKeyUsage=serverAuth")
```

**Step 4: Inspect and verify the chain.**

```bash
openssl x509 -in api.crt -noout -subject -issuer -dates
openssl verify -CAfile ca.crt api.crt        # api.crt: OK
```
`issuer` is `CN=Lab Site Root`. `openssl verify` checks the signature against the root you told it to trust, the same way a NICo service checks a peer against `nico-roots`.

**Step 5: See verification fail without the right root.**

```bash
openssl req -x509 -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout other.key -out other.crt -days 1 -subj "/CN=Some Other Root"
openssl verify -CAfile other.crt api.crt
```
You get `unable to get local issuer certificate`. The cert is fine, but the verifier trusts the wrong root.

### Your turn: finish it

Sign `dhcp.csr` with the lab root from the worked example. Fill in the two arguments that name the CA's certificate and private key.

```text
openssl x509 -req -in dhcp.csr -CA ___ -CAkey ___ -CAcreateserial \
  -out dhcp.crt -days 7 \
  -extfile <(printf "subjectAltName=DNS:dhcp.lab.internal\nextendedKeyUsage=serverAuth")
```

<details>
<summary>Answer</summary>

openssl x509 -req -in dhcp.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out dhcp.crt -days 7 \
  -extfile <(printf "subjectAltName=DNS:dhcp.lab.internal\nextendedKeyUsage=serverAuth")

`-CA` supplies the issuer name that goes into the new cert, and `-CAkey` is the private key that signs it. (Create the CSR first with `openssl req -new ... -keyout dhcp.key -out dhcp.csr -subj "/CN=dhcp.lab.internal"`.)

</details>

### Your turn: on your own

Real PKIs keep the root offline and sign day-to-day certificates with an intermediate. Extend the lab: create `inter.key`/`inter.crt` signed by `ca.crt`, then a leaf `svc.crt` (SAN `DNS:svc.lab.internal`) signed by the intermediate. Prove the chain verifies when the client trusts only the root.

<details>
<summary>Hint 1</summary>

The intermediate is a CSR signed by the root, like the service cert, but its extensions must mark it as a CA.

</details>

<details>
<summary>Hint 2</summary>

Use `-extfile <(printf "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign")` when the root signs the intermediate. Then sign the leaf with `-CA inter.crt -CAkey inter.key`.

</details>

<details>
<summary>Hint 3</summary>

`openssl verify -CAfile ca.crt -untrusted inter.crt svc.crt`. `-untrusted` supplies the middle of the chain without trusting it as a root.

</details>

<details>
<summary>Answer</summary>

```bash
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout inter.key -out inter.csr -subj "/CN=Lab Intermediate"
openssl x509 -req -in inter.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out inter.crt -days 14 \
  -extfile <(printf "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign")
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout svc.key -out svc.csr -subj "/CN=svc.lab.internal"
openssl x509 -req -in svc.csr -CA inter.crt -CAkey inter.key -CAcreateserial -out svc.crt -days 7 \
  -extfile <(printf "subjectAltName=DNS:svc.lab.internal\nextendedKeyUsage=serverAuth")
openssl verify -CAfile ca.crt -untrusted inter.crt svc.crt   # svc.crt: OK
```
Without `-untrusted inter.crt`, verification fails because the client can't build the path. That's why servers send the intermediate along with their leaf (a 'full chain').

</details>

### Explain it

In your own words: Explain why NICo distributes the `nico-roots` Secret to every namespace, and what would happen to service-to-service connections if one namespace had a stale root.

### Check

**1. What does a CA's signature on a certificate assert?**

A. That the public key in the certificate belongs to the identity named in it
B. That the certificate's private key is encrypted
C. That the server is free of malware
D. That the connection will use AES-GCM

<details>
<summary>Answer</summary>

**A.** That the public key in the certificate belongs to the identity named in it

A certificate binds a name to a key. It says nothing about the server's software, it contains no private key, and the cipher is negotiated separately in the TLS handshake.

</details>

**2. In NICo's reference install, what is `site-issuer`?**

A. A cert-manager CA ClusterIssuer backed by the `site-root` Secret
B. The Keycloak realm for operators
C. A Vault KV path for BMC passwords
D. The DNS zone for the site

<details>
<summary>Answer</summary>

**A.** A cert-manager CA ClusterIssuer backed by the `site-root` Secret

From the software prerequisites: `site-issuer` is a CA issuer backed by `site-root`, which `selfsigned-bootstrap` signs. Keycloak, Vault KV and DNS are separate parts of the system.

</details>

**3. A client reports `unable to get local issuer certificate` against a server whose certificate is valid and unexpired. What's the most likely cause?**

A. The client doesn't trust the root (or lacks the intermediate) that signed the server cert
B. The server's private key is too short
C. The server's clock is wrong
D. The certificate has too many SANs

<details>
<summary>Answer</summary>

**A.** The client doesn't trust the root (or lacks the intermediate) that signed the server cert

That error means path building failed: the client couldn't link the cert to anything in its trust store. Clock problems give 'not yet valid' or 'expired' errors, and name problems give hostname-mismatch errors.

</details>

**Sources:** [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md)

<a id="tls-certificates-and-x-509-san"></a>
## 6. TLS certificates and X.509 SAN

*Builds on: PKI and TLS certificates (ch. 19), DNS (authoritative and recursive) (ch. 8)*

### Before you read

- Does a certificate for `*.mysite.example.com` cover `a.b.mysite.example.com`? Does it cover `mysite.example.com`?
- Modern TLS clients check the hostname against which part of a certificate: the Common Name (CN) or the Subject Alternative Names?

<details>
<summary>Answers</summary>

- **Does a certificate for `*.mysite.example.com` cover `a.b.mysite.example.com`? Does it cover `mysite.example.com`?** Neither. A wildcard matches exactly one DNS label in the leftmost position, so it covers `rest-api.mysite.example.com` but not names with two extra labels, and not the bare apex.
- **Modern TLS clients check the hostname against which part of a certificate: the Common Name (CN) or the Subject Alternative Names?** The SANs. Browsers and most modern libraries ignore the CN for hostname checks, so a cert with the right CN but no matching SAN fails. (A few libraries still fall back to the CN, but only when the cert has no DNS SANs at all.)

</details>

### Explanation

Once a client has verified the chain (previous lesson), it still has to answer: *is this certificate for the host I meant to reach?* Otherwise any valid certificate from the same CA would do. That's **hostname verification**.

The answer lives in the **Subject Alternative Name (SAN)** extension, a list of entries such as `DNS:rest-api.mysite.example.com`, `DNS:nico-api.nico-system.svc.cluster.local` or `IP:10.0.0.5`. The client compares the name it dialled with each entry. The subject CN is legacy. Browsers, Go's `crypto/tls` (1.15 and later) and rustls ignore it completely. Some other stacks, such as gRPC's C core used by the Python, C++ and Ruby clients, still fall back to the CN when a cert has no DNS SANs at all. Don't rely on that: always put every name in the SANs.

**Wildcard rules** (RFC 6125, as browsers and OpenSSL apply them):
- `*` may appear only as the whole leftmost label: `*.mysite.example.com`.
- It matches **exactly one label**: `nico.mysite.example.com` matches, `a.b.mysite.example.com` doesn't.
- It doesn't match the apex: `mysite.example.com` needs its own SAN entry.
- IP addresses must match an `IP:` entry. A `DNS:` entry holding an IP string doesn't count.

**DNS ties in here** (chapter 8): the client uses the *name* for verification and DNS only to find the address. If you connect by IP, or through a name not in the SANs, verification fails even though the packets reach the right box. `curl --resolve host:port:ip` lets you test a name before DNS exists. `openssl s_client -servername host` sets **SNI**, the hostname the client announces during the handshake so the server can pick the right certificate. SNI only *selects* a certificate. It doesn't verify one: `s_client` checks the hostname only when you also pass `-verify_hostname host`.

**NICo examples:**
- Service certs carry cluster-internal SANs (the docs give `nico-api.<namespace>.svc.cluster.local`-style names and `nico-api.nico`) plus optional external FQDNs. Your ClusterIssuers must be able to issue both.
- For the NICo REST ingress, `certificate.dnsNames` accepts a wildcard covering one label, as X.509 SAN matching does. `ingress.tls[].hosts` must name each host **exactly**, because ingress controllers like Contour key their HTTPS virtual host by that literal string. A wildcard there leaves the route with no HTTPS virtual host.
- The docs' check, `openssl s_client -connect rest-api.mysite.example.com:443 -servername rest-api.mysite.example.com -CAfile nico-rest-ca.crt`, should print `Verify return code: 0 (ok)`. That proves Envoy serves a certificate whose chain leads to the CA in `nico-rest-ca.crt`. It doesn't check the SAN. Clients such as `curl --cacert nico-rest-ca.crt` do check the SAN.

**Analogy.** A parcel addressed to a named list of flats. `*.mysite` is like 'any flat on floor 3': it covers 3A and 3B but not the floor-3 storage cupboard on a mezzanine (a two-level name), and not the building's front office (the apex). Where it breaks down: a postman might deliver to a close-enough address, but hostname verification is exact string and label matching with no fuzziness.

### Worked example: Test which hostnames a wildcard certificate covers

**Step 1: Create a cert with a wildcard and an explicit SAN.**

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout wild.key -out wild.crt -days 7 \
  -subj "/CN=rest-api.mysite.example.com" \
  -addext "subjectAltName=DNS:*.mysite.example.com,DNS:rest-api.mysite.example.com"
```

**Step 2: Read the SAN list.**

On OpenSSL 3.x:
```bash
openssl x509 -in wild.crt -noout -ext subjectAltName
```
The `-ext` option doesn't exist in OpenSSL 1.1.1. There, use:
```bash
openssl x509 -in wild.crt -noout -text | grep -A1 'Subject Alternative Name'
```
Either way the output shows `DNS:*.mysite.example.com, DNS:rest-api.mysite.example.com`.

**Step 3: Check candidate hostnames.**

```bash
for h in rest-api.mysite.example.com nico.mysite.example.com mysite.example.com a.b.mysite.example.com; do
  openssl x509 -in wild.crt -noout -checkhost "$h"
done
```
The first two print `does match certificate`. The apex and the two-label name print `does NOT match certificate`.

**Step 4: Apply the rule to NICo's REST ingress.**

If this cert were stored as a TLS Secret in `nico-rest`, your values would list the **concrete** host:
```yaml
    tls:
      - secretName: mysite-wildcard-tls
        hosts:
          - rest-api.mysite.example.com
```
The cert's SAN may be a wildcard. The `hosts` entry must not be one.

**Step 5: Verify a live endpoint: chain first, then name.**

With a real deployment, the docs' command checks the **chain only**:
```bash
openssl s_client -connect rest-api.mysite.example.com:443 \
  -servername rest-api.mysite.example.com -CAfile nico-rest-ca.crt </dev/null | grep 'Verify return code'
```
`-servername` sets SNI, which tells Envoy which certificate to serve. `Verify return code: 0 (ok)` means that certificate chains to the CA in `nico-rest-ca.crt`. It would still say `0 (ok)` if the SAN were wrong. To check the SAN as well, add `-verify_hostname`:
```bash
openssl s_client -connect rest-api.mysite.example.com:443 \
  -servername rest-api.mysite.example.com -CAfile nico-rest-ca.crt \
  -verify_hostname rest-api.mysite.example.com </dev/null | grep 'Verify return code'
```
A SAN mismatch now shows `Verify return code: 62 (hostname mismatch)`. `curl --cacert nico-rest-ca.crt https://rest-api.mysite.example.com/` does both checks by default.

### Your turn: finish it

Fill in the two SAN entries so the certificate covers `lab.example.com` itself and every single-label host under it (`pxe.lab.example.com`, `dns.lab.example.com`, …).

```text
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout lab.key -out lab.crt -days 7 -subj "/CN=lab.example.com" \
  -addext "subjectAltName=DNS:___,DNS:___"
```

<details>
<summary>Answer</summary>

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout lab.key -out lab.crt -days 7 -subj "/CN=lab.example.com" \
  -addext "subjectAltName=DNS:lab.example.com,DNS:*.lab.example.com"

The wildcard doesn't cover the apex, so the apex needs its own entry. Check with `openssl x509 -in lab.crt -noout -checkhost lab.example.com` and `-checkhost pxe.lab.example.com`.

</details>

### Your turn: on your own

You have a site-wide wildcard Secret `mysite-wildcard-tls` with SAN `DNS:*.mysite.example.com`, and you want NICo REST served at both `rest-api.mysite.example.com` and `rest.api.mysite.example.com` through an existing nginx ingress controller. (a) Which of the two hostnames will pass TLS hostname verification? (b) What exactly goes in `ingress.tls[].hosts`? (c) Name one other requirement from the docs about where the Secret must live.

<details>
<summary>Hint 1</summary>

Count the labels to the left of `mysite.example.com` in each name.

</details>

<details>
<summary>Hint 2</summary>

`ingress.tls[].hosts` is keyed by literal string. The chart rejects any `ingress.hosts` entry it doesn't name exactly.

</details>

<details>
<summary>Hint 3</summary>

`spec.tls[].secretName` resolves in the Ingress's own namespace.

</details>

<details>
<summary>Answer</summary>

(a) Only `rest-api.mysite.example.com`. `rest.api.mysite.example.com` has two labels where the wildcard allows one, so it needs its own SAN or a different certificate. (b) Each concrete host, exactly as in `ingress.hosts`: `- rest-api.mysite.example.com` (and `- rest.api.mysite.example.com` too, if you keep it and get a certificate that covers it). Never `*.mysite.example.com`. (c) The Secret must be in the `nico-rest` namespace, because that's where the Ingress resolves `secretName`, so copy or mirror the wildcard Secret there. Also add `nginx.ingress.kubernetes.io/force-ssl-redirect: "true"` (a quoted string), since the default redirect annotation targets Contour.

</details>

### Explain it

In your own words: Chain verification and hostname verification are separate checks. Explain what attack becomes possible if a client does the first but skips the second.

### Check

**1. A certificate's only SAN is `DNS:*.mysite.example.com`. Which hostname does it cover?**

A. `nico.mysite.example.com`
B. `a.b.mysite.example.com`
C. `mysite.example.com`
D. All three

<details>
<summary>Answer</summary>

**A.** `nico.mysite.example.com`

A wildcard matches exactly one leftmost label. It doesn't reach two levels down, and the apex has no label for `*` to match.

</details>

**2. A cert has CN `nico-api.nico` but no SAN entries. A gRPC client written in Go (`crypto/tls`, Go 1.15 or later) dials `nico-api.nico`. What happens?**

A. Verification succeeds because the CN matches
B. Hostname verification fails, because Go's TLS stack matches only against SANs and ignores the CN
C. The client falls back to IP matching
D. It succeeds only over HTTP/2

<details>
<summary>Answer</summary>

**B.** Hostname verification fails, because Go's TLS stack matches only against SANs and ignores the CN

Since 1.15, Go ignores the CN for hostname checks, and rustls never used it. The CN 'fallback' is real but stack-specific: gRPC's C core (the Python, C++ and Ruby clients) still accepts a CN match when the cert has no DNS SANs. So the same cert can pass in one client and fail in another, which is why every name belongs in the SANs. There's no IP fallback, and the HTTP version is irrelevant.

</details>

**3. In the NICo REST chart, where is a wildcard allowed?**

A. In `certificate.dnsNames`, but not in `ingress.tls[].hosts`
B. In `ingress.tls[].hosts`, but not in `certificate.dnsNames`
C. In both
D. In neither

<details>
<summary>Answer</summary>

**A.** In `certificate.dnsNames`, but not in `ingress.tls[].hosts`

`certificate.dnsNames` become SANs, where one-label wildcards are valid. `ingress.tls[].hosts` must name hosts exactly, because controllers such as Contour key the HTTPS virtual host by the literal string.

</details>

**Sources:** [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md)

<a id="mtls-grpc"></a>
## 7. mTLS / gRPC

*Builds on: TLS certificates and X.509 SAN (ch. 19), Protocol Buffers (ch. 1)*

### Before you read

- In ordinary HTTPS, the server proves its identity with a certificate. How does the server know who the client is?
- gRPC sends messages defined in `.proto` files. Which encoding from chapter 1 does it use on the wire, and over which HTTP version?

<details>
<summary>Answers</summary>

- **In ordinary HTTPS, the server proves its identity with a certificate. How does the server know who the client is?** At the TLS level it doesn't. The client is anonymous unless it sends a password or token. Mutual TLS adds a client certificate, so the client's identity is proven during the handshake as well.
- **gRPC sends messages defined in `.proto` files. Which encoding from chapter 1 does it use on the wire, and over which HTTP version?** Protocol Buffers (binary), over HTTP/2.

</details>

### Explanation

**gRPC** is a remote procedure call framework. You define services and messages in a `.proto` file (chapter 1). Code generators produce typed client and server stubs, and calls travel as binary Protocol Buffers over **HTTP/2**, which carries many concurrent calls on one connection. gRPC supports unary calls and streaming, and returns its own status codes (`OK`, `UNAVAILABLE`, `UNAUTHENTICATED`, `PERMISSION_DENIED`, …). In production it almost always runs over TLS.

In normal TLS only the server authenticates. In **mutual TLS (mTLS)**:
1. The server presents its certificate chain, and the client verifies the chain and the hostname (SAN).
2. The server sends a *CertificateRequest*.
3. The client presents its own certificate and signs the handshake with its private key, proving it holds the key.
4. The server verifies the client's chain against **its** trust bundle. It can then authorise based on the identity in the client cert (a SAN, or a SPIFFE URI, covered in chapter 21).

If any check fails, the handshake aborts before a single RPC is sent. Typical errors are `unknown ca`, `certificate required` and `bad certificate`. Client certs need the `clientAuth` extended key usage, and server certs need `serverAuth`.

**Why NICo does this:** NICo is 'zero-trust'. Being on the right network proves nothing. *All NICo control-plane services communicate over mTLS/gRPC*. The API Service (NICo Core) is the hub. DHCP, PXE, Hardware Health, SSH Console, DNS, Scout on hosts, the DPU Agent and `nico-admin-cli` all connect to it over mTLS/gRPC. Concrete cases from the docs:
- **RMS:** NICo Core calls `rms-api-server` (namespace `rack-manager`) on gRPC port `8801` with mutual TLS. RMS's certificate comes from the **same cert-manager issuer** that signs NICo's, so both directions verify without extra configuration. NICo needs no dedicated RMS client cert, because the RMS client library finds NICo's own SPIFFE certificate mount and presents it.
- **Site agent:** the health check looks for the Certificate `core-grpc-client-site-agent-certs` in `nico-rest`. That's the client certificate the site agent uses to call Core over gRPC.
- **Switches:** the switch state machine installs NVOS mTLS certificates (`ConfigureCertificate`) during bring-up.

**Analogy.** A secure building where the guard checks your badge, and you check the guard's badge before handing over anything sensitive. Both badges come from the same company. Where it breaks down: a person could flash someone else's badge, but in mTLS presenting the certificate isn't enough. You must sign the handshake with the matching private key, so a copied certificate alone is useless.

### Worked example: Run an mTLS server and connect with and without a client cert

**Step 1: Issue a server cert and a client cert from one CA.**

Reuse `ca.crt`/`ca.key` from the PKI lesson (or recreate them):
```bash
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout server.key -out server.csr -subj "/CN=localhost"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 7 \
  -extfile <(printf "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth")
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout client.key -out client.csr -subj "/CN=site-agent"
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt -days 7 \
  -extfile <(printf "extendedKeyUsage=clientAuth")
```

**Step 2: Start a server that requires client certs.**

In terminal 1 (in the same directory):
```bash
openssl s_server -accept 9443 -cert server.crt -key server.key -CAfile ca.crt -Verify 1 -www
```
`-Verify 1` (capital V) makes a client certificate mandatory, and `-CAfile` is the bundle used to check it.

**Step 3: Connect without a client cert.**

In terminal 2 (also in that directory):
```bash
curl --cacert ca.crt https://localhost:9443/
```
This fails with a TLS alert such as `certificate required` or `handshake failure`. The server cert verified fine, but the server refused an anonymous client.

**Step 4: Connect with the client cert.**

```bash
curl --cacert ca.crt --cert client.crt --key client.key https://localhost:9443/
```
You get s_server's status page. Terminal 1 logs the client's subject `CN=site-agent`. Both sides are now authenticated.

**Step 5: Connect with a cert from a different CA.**

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout rogue.key -out rogue.crt -days 1 -subj "/CN=site-agent" -addext "extendedKeyUsage=clientAuth"
curl --cacert ca.crt --cert rogue.crt --key rogue.key https://localhost:9443/
```
This fails (the server reports an unknown CA or verify error). Same name, wrong issuer. This is why NICo and RMS take their certs from the same issuer.

### Your turn: finish it

Complete the curl command so it performs mTLS against the server from the worked example.

```text
curl --cacert ca.crt ___ client.crt ___ client.key https://localhost:9443/
```

<details>
<summary>Answer</summary>

curl --cacert ca.crt --cert client.crt --key client.key https://localhost:9443/

`--cacert` is the trust bundle used to verify the *server*. `--cert` and `--key` are the *client's* own identity. Mixing these up (e.g. passing ca.crt to --cert) is a common mistake.

</details>

### Your turn: on your own

A site's RMS chart was customised so that `rms-api-server` gets its certificate from a separate, newly created CA issuer instead of the issuer that signs nico-api's certificate. NICo Core's calls to RMS on port 8801 now fail during the TLS handshake. Explain which verification fails (and on which side), and give two ways to fix it that are consistent with the RMS architecture page.

<details>
<summary>Hint 1</summary>

In mTLS both sides verify. What does nico-api trust, and what does RMS trust?

</details>

<details>
<summary>Hint 2</summary>

nico-api checks RMS's server cert against roots it trusts, and RMS checks nico-api's SPIFFE client cert against the roots it trusts. With two unrelated CAs, neither chain reaches a root the other side trusts.

</details>

<details>
<summary>Hint 3</summary>

The docs say the shared issuer is what makes it work without extra configuration, and that explicit certificate paths are an override.

</details>

<details>
<summary>Answer</summary>

Both directions break. nico-api can't build a chain from RMS's server cert to a root it trusts (the new CA isn't in its bundle), and RMS can't verify the SPIFFE client cert nico-api presents (signed by the original issuer). The handshake aborts with an unknown-CA style error before any RPC is sent. Fix 1 (preferred): issue RMS's certificate from the same cert-manager issuer that signs NICo's certificate, as the reference install does (`vault-nico-issuer`, or `site-issuer` with `--skip-vault`). Fix 2: use the documented override and supply explicit certificate paths so each side has material that the other side's trust bundle accepts. Simply skipping verification would defeat the purpose of mTLS.

</details>

### Explain it

In your own words: Why does NICo authenticate every service-to-service call with certificates instead of trusting anything that arrives from inside the cluster network?

### Check

**1. In mutual TLS, who presents a certificate?**

A. Only the server
B. Only the client
C. Both client and server, each verified by the other
D. Neither: keys are pre-shared

<details>
<summary>Answer</summary>

**C.** Both client and server, each verified by the other

Server-only is ordinary TLS. mTLS adds a client certificate and a proof-of-possession signature. Pre-shared keys are a different TLS mode, not mTLS.

</details>

**2. Why does NICo Core need no dedicated RMS client certificate?**

A. RMS doesn't use TLS
B. The RMS client library presents NICo's own SPIFFE certificate, and RMS's cert comes from the same issuer, so both directions verify
C. RMS authenticates NICo with HTTP basic auth
D. nico-api disables verification for RMS

<details>
<summary>Answer</summary>

**B.** The RMS client library presents NICo's own SPIFFE certificate, and RMS's cert comes from the same issuer, so both directions verify

The RMS page lists NICo Core to RMS as gRPC on 8801 with mutual TLS. Basic auth is what RMS uses *towards* BMCs. Nothing disables verification.

</details>

**3. How does gRPC encode and transport messages?**

A. JSON over HTTP/1.1
B. Protocol Buffers over HTTP/2
C. XML over SOAP
D. TOML over raw TCP

<details>
<summary>Answer</summary>

**B.** Protocol Buffers over HTTP/2

gRPC's default wire format is binary Protobuf, multiplexed over HTTP/2. JSON over HTTP/1.1 describes REST APIs such as NICo REST.

</details>

**Sources:** [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [architecture/backends/rms.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/backends/rms.md), [architecture/state_machines/switch.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/state_machines/switch.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md)

<a id="cert-manager"></a>
## 8. cert-manager

*Builds on: Kubernetes Custom Resource (CR/CRD) (ch. 14), mTLS / gRPC (ch. 19)*

### Before you read

- NICo has dozens of services, each with a certificate that expires. What goes wrong if renewal depends on a human running openssl?
- In Kubernetes, how might you ask for a certificate 'the Kubernetes way'?

<details>
<summary>Answers</summary>

- **NICo has dozens of services, each with a certificate that expires. What goes wrong if renewal depends on a human running openssl?** Someone eventually forgets. A certificate expires, mTLS handshakes start failing, and services can't talk to each other: an outage caused by a calendar. Automation renews certificates before they expire.
- **In Kubernetes, how might you ask for a certificate 'the Kubernetes way'?** Declare a custom resource describing the cert you want (names, issuer, Secret name). A controller notices it, gets the certificate signed, and keeps the result in a Secret, renewing it as needed.

</details>

### Explanation

**cert-manager** is a Kubernetes controller (chapter 14 covered CRDs) that turns certificate management into declared resources:

- **Issuer** (namespaced) and **ClusterIssuer** (cluster-wide) describe *how* to sign. Types include `selfSigned`, `ca` (sign with a CA key stored in a Secret), `vault` (Vault PKI) and ACME.
- **Certificate** describes *what* you want: `dnsNames` and other SANs, `duration`, `renewBefore`, `usages`, `isCA`, `issuerRef`, and the `secretName` to write to.
- **CertificateRequest** is a one-off signing request the controller creates from a Certificate. It contains a CSR, and the private key stays in the cluster.
- The result is a Kubernetes **Secret** of type `kubernetes.io/tls` with `tls.crt`, `tls.key` and usually `ca.crt`.

The controller keeps reconciling. When a cert nears expiry (at `renewBefore`, or by default two-thirds of the way through its lifetime), it issues a new one and updates the Secret. Pods that mount the Secret see the new files, but the application must reload them, because cert-manager doesn't restart workloads.

**approver-policy** adds a gate: CertificateRequests must be *approved* by policy (rules about which namespaces may use which issuers and SANs) before an issuer signs them. Without it, any namespace that can create a Certificate could ask a powerful ClusterIssuer for any name.

**In NICo:**
- Validated: cert-manager v1.11.1 with approver-policy v0.6.3. `setup.sh` deploys cert-manager v1.17.1 in phase 2, together with the site CA bootstrap.
- Required ClusterIssuers: `site-issuer` (CA, backed by the `site-root` Secret) and `vault-nico-issuer` (Vault PKI). The reference install also creates `selfsigned-bootstrap`, which signs `site-root`.
- cert-manager issues and rotates the certificates NICo services use for mTLS/gRPC, for example `core-grpc-client-site-agent-certs` in `nico-rest`. RMS's server certificate comes from the same issuer as NICo's.
- If you bring your own cert-manager, your issuers must handle cluster-internal service SANs and external FQDNs, and your approver flows must allow Certificates in NICo namespaces.
- The REST ingress chart can create a Certificate issued by `nico-rest-ca-issuer`.

Health checks: `kubectl get clusterissuer` and `kubectl get certificate -A` should show `READY True`.

**Analogy.** A standing order with a print shop for staff ID badges. You file a form once (the Certificate) saying who needs a badge and which print shop to use (the issuer), and the shop reprints each badge before it expires and drops it in the person's pigeonhole (the Secret). Where it breaks down: a person notices a new badge in their pigeonhole, but an application may keep using the old certificate in memory until it reloads or restarts.

### Worked example: Recreate NICo's issuer chain shape in a kind cluster

**Step 1: Create a cluster and install cert-manager.**

```bash
kind create cluster --name pki-lab
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.17.1/cert-manager.yaml
kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=180s
```

**Step 2: Bootstrap a root CA and a CA ClusterIssuer.**

This has the same shape as NICo's selfsigned-bootstrap → site-root → site-issuer, with lab names. Save as `issuers.yaml`:
```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: lab-selfsigned
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: lab-root
  namespace: cert-manager
spec:
  isCA: true
  commonName: lab-root
  secretName: lab-root
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: lab-selfsigned
    kind: ClusterIssuer
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: lab-issuer
spec:
  ca:
    secretName: lab-root
```
Apply with `kubectl apply -f issuers.yaml`. A ClusterIssuer of type `ca` reads its Secret from the `cert-manager` namespace by default, which is why `lab-root` lives there.

**Step 3: Request a service certificate.**

Save as `leaf.yaml` and apply it:
```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: demo-grpc
  namespace: default
spec:
  secretName: demo-grpc-tls
  duration: 24h
  renewBefore: 8h
  dnsNames:
    - demo.default.svc.cluster.local
    - demo.default
  usages:
    - server auth
    - client auth
  issuerRef:
    name: lab-issuer
    kind: ClusterIssuer
```

**Step 4: Check status and the issued Secret.**

```bash
kubectl get clusterissuer
kubectl get certificate -A
kubectl get secret demo-grpc-tls -o jsonpath='{.data.tls\.crt}' | base64 -d \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
```
`-ext` needs OpenSSL 3.x. On 1.1.1, replace the last line's options with `openssl x509 -noout -text | grep -A1 'Subject Alternative Name'`. You should see both ClusterIssuers and both Certificates `READY True`, the issuer `CN=lab-root`, and your two SANs.

**Step 5: Verify against the CA bundle.**

```bash
kubectl get secret demo-grpc-tls -o jsonpath='{.data.ca\.crt}' | base64 -d > lab-ca.crt
kubectl get secret demo-grpc-tls -o jsonpath='{.data.tls\.crt}' | base64 -d > demo.crt
openssl verify -CAfile lab-ca.crt demo.crt
```
The `ca.crt` key is the same bundle you'd export for NICo REST clients (`--cacert nico-rest-ca.crt`).

### Your turn: finish it

You want a server certificate for a lab Service named `rms-api-server` in namespace `rack-manager` (run `kubectl create namespace rack-manager` first), signed by `lab-issuer` from the worked example. Fill in the blanks.

```text
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: rms-server
  namespace: rack-manager
spec:
  secretName: rms-server-tls
  dnsNames:
    - ___
  issuerRef:
    name: ___
    kind: ClusterIssuer
```

<details>
<summary>Answer</summary>

apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: rms-server
  namespace: rack-manager
spec:
  secretName: rms-server-tls
  dnsNames:
    - rms-api-server.rack-manager.svc.cluster.local
  issuerRef:
    name: lab-issuer
    kind: ClusterIssuer

The SAN is the Service's cluster DNS name, so in-cluster clients dialling it pass hostname verification. Using the same issuer as your other services means mTLS peers already trust it, the same idea as RMS sharing NICo's issuer.

</details>

### Your turn: on your own

Watch cert-manager rotate a certificate. Create a Certificate `demo-short` in `default` (issuer `lab-issuer`, SAN `short.default`) that cert-manager will renew within about five minutes, then show evidence that it renewed and that the Secret's certificate changed.

<details>
<summary>Hint 1</summary>

cert-manager requires `duration` of at least 1h, and `renewBefore` must be shorter than `duration`.

</details>

<details>
<summary>Hint 2</summary>

`duration: 1h` with `renewBefore: 55m` renews about 5 minutes after issue.

</details>

<details>
<summary>Hint 3</summary>

Compare `.status.revision` and `.status.notBefore` before and after, or the serial from `openssl x509 -noout -serial` on `tls.crt`.

</details>

<details>
<summary>Answer</summary>

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: demo-short
  namespace: default
spec:
  secretName: demo-short-tls
  duration: 1h
  renewBefore: 55m
  dnsNames:
    - short.default
  issuerRef:
    name: lab-issuer
    kind: ClusterIssuer
```
Apply it, then run:
```bash
kubectl get certificate demo-short -o jsonpath='{.status.revision}  {.status.notBefore}  {.status.renewalTime}{"\n"}'
kubectl get secret demo-short-tls -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -serial
```
After `renewalTime` passes (about 5 minutes), run both again: `revision` goes from 1 to 2, and `notBefore` and the serial change. `kubectl get certificaterequest` shows a second request. A workload mounting this Secret must reload the files to start using the new cert.

</details>

### Explain it

In your own words: Explain the division of labour between a Certificate, an Issuer and the resulting Secret, and why approver-policy matters when a powerful ClusterIssuer like `site-issuer` is available to many namespaces.

### Check

**1. Which resource do you create to ask cert-manager for a certificate for your service?**

A. A Certificate
B. A ClusterIssuer
C. A Secret of type kubernetes.io/tls
D. A CertificateSigningRequest in kube-system

<details>
<summary>Answer</summary>

**A.** A Certificate

The Certificate declares what you want. Issuers say how to sign, and the Secret is the *output*. Writing a TLS Secret yourself bypasses cert-manager, and cert-manager creates its CertificateRequests for you.

</details>

**2. What's the difference between an Issuer and a ClusterIssuer?**

A. An Issuer serves Certificates in its own namespace, and a ClusterIssuer serves the whole cluster
B. A ClusterIssuer is always backed by Vault
C. An Issuer can only self-sign
D. There is no difference

<details>
<summary>Answer</summary>

**A.** An Issuer serves Certificates in its own namespace, and a ClusterIssuer serves the whole cluster

Scope is the only difference. Both support the same issuer types (selfSigned, ca, vault, ACME). NICo uses ClusterIssuers (`site-issuer`, `vault-nico-issuer`) because many namespaces need certificates from the same PKI.

</details>

**3. cert-manager renewed a certificate and updated its Secret, but clients still see the old certificate. What's the likely reason?**

A. The application hasn't reloaded the new files
B. cert-manager only renews on Mondays
C. The Secret update failed silently
D. The CA was revoked

<details>
<summary>Answer</summary>

**A.** The application hasn't reloaded the new files

cert-manager updates the Secret and mounted files refresh, but a process that read the cert at startup keeps serving the old one until it reloads or restarts. A failed Secret update would show up in the Certificate's status.

</details>

**Sources:** [getting-started/prerequisites/software.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/prerequisites/software.md), [getting-started/quick-start.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/getting-started/quick-start.md), [overview/what-is-nico.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/overview/what-is-nico.md), [architecture/backends/rms.md](https://github.com/dsx-ai-factory/infra-controller/blob/38a79e71dff48df7480134da2363acddd5ec117f/docs/architecture/backends/rms.md)

<a id="build-task"></a>
## Build task: A zero-trust API on your laptop: mTLS plus Keycloak JWTs

**Goal:** Build a small HTTPS API that only answers a caller who presents both a client certificate signed by your private CA and a valid Keycloak-issued JWT obtained with the client credentials flow. Then prove that each missing or wrong piece is rejected.

**Why it matters for NICo:** This is NICo's security model in miniature. Control-plane services prove their identity to each other with certificates from a shared CA (mTLS), and callers of NICo REST prove theirs with bearer JWTs whose `iss` must match exactly. When a real NICo connection fails, you'll recognise the symptoms: an unknown CA, a hostname missing from the SANs, a missing client cert, or a localhost-issued token.

**You need:**

- Linux or macOS with bash or zsh (the commands work in both)
- OpenSSL 1.1.1 or 3.x (`openssl version`; on macOS `brew install openssl@3` and put it first on PATH)
- Python 3.9+ with `venv`
- Docker or Podman (substitute `podman` for `docker` throughout)
- curl and jq
- About 1 GB of free RAM for the Keycloak container
- Two terminal windows: terminal A for the client commands, terminal B for the server

Try each step yourself first. The details are there when you need them.

<details>
<summary>Step 1: Build the PKI</summary>

In terminal A:
```bash
mkdir zt-lab && cd zt-lab
openssl req -x509 -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout ca.key -out ca.crt -days 30 -subj "/CN=ZT Lab Root" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"

openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout server.key -out server.csr -subj "/CN=api.lab.internal"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 7 \
  -extfile <(printf "subjectAltName=DNS:api.lab.internal,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth")

openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout client.key -out client.csr -subj "/CN=site-agent"
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt -days 7 \
  -extfile <(printf "extendedKeyUsage=clientAuth")

openssl verify -CAfile ca.crt server.crt client.crt
openssl x509 -in server.crt -noout -checkhost api.lab.internal
```
Both certs should print `OK`, and the hostname should match.

</details>

<details>
<summary>Step 2: Run Keycloak and register a machine client with a high-entropy secret</summary>

Still in terminal A, inside `zt-lab`:
```bash
docker run -d --name kc -p 8080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:26.0 start-dev
until curl -sf http://localhost:8080/realms/master >/dev/null; do sleep 3; done

CLIENT_SECRET=$(openssl rand -hex 32)   # 256 bits; hex avoids form-encoding issues with + and /
echo "$CLIENT_SECRET" > client_secret.txt

# A shell function passes arguments correctly in both bash and zsh
kcadm() { docker exec kc /opt/keycloak/bin/kcadm.sh "$@"; }
kcadm config credentials --server http://localhost:8080 --realm master --user admin --password admin
kcadm create realms -s realm=lab -s enabled=true
kcadm create clients -r lab -s clientId=lab-svc -s secret="$CLIENT_SECRET" \
  -s serviceAccountsEnabled=true -s publicClient=false -s standardFlowEnabled=false
```
Each `create` prints a `Created new ...` line. The admin/admin password is only for this throwaway lab.

</details>

<details>
<summary>Step 3: Get a token with the client credentials flow and inspect it</summary>

In terminal A:
```bash
TOKEN=$(curl -s -X POST http://localhost:8080/realms/lab/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=lab-svc -d client_secret="$(cat client_secret.txt)" \
  | jq -r .access_token)
python3 -c 'import sys,json,base64; p=sys.argv[1].split(".")[1]; c=json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4))); print(c["iss"], c.get("azp"), c["exp"])' "$TOKEN"
```
Expect `http://localhost:8080/realms/lab lab-svc <timestamp>`. Tokens expire after about 5 minutes, so rerun this command when needed. `$TOKEN` exists only in terminal A, so run all later curl commands there.

</details>

<details>
<summary>Step 4: Write the mTLS + JWT server</summary>

In terminal A, inside `zt-lab`, create the virtual environment:
```bash
python3 -m venv .venv && .venv/bin/pip install "pyjwt[crypto]"
```
Save as `server.py` in `zt-lab`:
```python
import json, ssl
from http.server import HTTPServer, BaseHTTPRequestHandler
import jwt

ISSUER = "http://localhost:8080/realms/lab"
jwks = jwt.PyJWKClient(ISSUER + "/protocol/openid-connect/certs")

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        peer = self.connection.getpeercert()
        cn = dict(x[0] for x in peer["subject"])["commonName"]
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return self.reply(401, {"error": "missing bearer token", "client_cert_cn": cn})
        token = auth[len("Bearer "):]
        try:
            key = jwks.get_signing_key_from_jwt(token)
            claims = jwt.decode(token, key.key, algorithms=["RS256"], issuer=ISSUER,
                                options={"verify_aud": False})
        except jwt.PyJWTError as e:
            return self.reply(401, {"error": str(e), "client_cert_cn": cn})
        self.reply(200, {"client_cert_cn": cn, "token_iss": claims["iss"], "token_azp": claims.get("azp")})

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("server.crt", "server.key")
ctx.load_verify_locations("ca.crt")
ctx.verify_mode = ssl.CERT_REQUIRED
srv = HTTPServer(("127.0.0.1", 8443), Handler)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
print("listening on https://127.0.0.1:8443")
srv.serve_forever()
```
Now open terminal B. It starts in your home directory with no virtual environment, so change into the lab and run the server with the venv's own Python:
```bash
cd zt-lab            # use the full path if you created zt-lab somewhere else
.venv/bin/python server.py
```
(Equivalently: `. .venv/bin/activate` then `python3 server.py`.) Leave it running and switch back to terminal A. Audience checking is off because Keycloak's default client-credentials tokens don't carry a custom `aud`. Instead the response reports `azp`. A production API would require a specific audience, as nico-rest-api's `issuers[].audience` does.

</details>

<details>
<summary>Step 5: Make a fully authenticated call</summary>

In terminal A (where `$TOKEN` is set):
```bash
curl -s --resolve api.lab.internal:8443:127.0.0.1 --cacert ca.crt \
  --cert client.crt --key client.key \
  -H "Authorization: Bearer $TOKEN" https://api.lab.internal:8443/whoami | jq .
```
`--resolve` stands in for a DNS record. curl checks both the chain and the name `api.lab.internal` against the SAN.

</details>

<details>
<summary>Step 6: Prove each control rejects bad input</summary>

In terminal A, run each and note the failure:
```bash
# 1. No client cert: TLS handshake fails
curl -s --resolve api.lab.internal:8443:127.0.0.1 --cacert ca.crt https://api.lab.internal:8443/ ; echo "exit=$?"
# 2. Name not in SANs: hostname verification fails
curl -s --resolve wrong.lab.internal:8443:127.0.0.1 --cacert ca.crt --cert client.crt --key client.key https://wrong.lab.internal:8443/ ; echo "exit=$?"
# 3. Token issued via a different hostname: iss mismatch -> 401
BADTOKEN=$(curl -s -X POST http://127.0.0.1:8080/realms/lab/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=lab-svc -d client_secret="$(cat client_secret.txt)" | jq -r .access_token)
curl -s --resolve api.lab.internal:8443:127.0.0.1 --cacert ca.crt --cert client.crt --key client.key \
  -H "Authorization: Bearer $BADTOKEN" https://api.lab.internal:8443/ ; echo
```
Case 3 is the NICo port-forward trap: same Keycloak, valid signature, but `iss` says `127.0.0.1` instead of `localhost`.

</details>

**Check it works:** In terminal A, with a fresh token, `curl -s --resolve api.lab.internal:8443:127.0.0.1 --cacert ca.crt --cert client.crt --key client.key -H "Authorization: Bearer $TOKEN" https://api.lab.internal:8443/whoami` returns `{"client_cert_cn": "site-agent", "token_iss": "http://localhost:8080/realms/lab", "token_azp": "lab-svc"}`. The three negative tests fail as described: (1) curl exits non-zero with a TLS alert, (2) curl exits non-zero with a certificate name mismatch, (3) the server returns HTTP 401 with an `Invalid issuer` error.

<details>
<summary>If you get stuck</summary>

- `unable to get local issuer certificate` or `unknown ca`: you passed the wrong file to `--cacert`, or regenerated `ca.crt` without re-signing the leaf certs. Rerun the whole PKI step.
- `ModuleNotFoundError: No module named 'jwt'` when starting the server: you ran the system `python3` instead of the venv's. In terminal B, `cd zt-lab` and use `.venv/bin/python server.py`.
- `FileNotFoundError` for `server.crt`: terminal B isn't in `zt-lab`. The server loads its certs from the current directory.
- `kcadm: command not found` or `zsh: command not found: docker exec ...`: define the `kcadm` function in the same terminal before using it. Don't store the command in a plain variable, because zsh doesn't split it into words.
- `Signature has expired` from the server: Keycloak tokens live about 5 minutes. Fetch a new `$TOKEN` in terminal A.
- `-addext` or `<(...)` errors: use OpenSSL 1.1.1+ (not old LibreSSL) and run in bash or zsh, which support process substitution. In plain `sh`, write the extension text to a file and pass `-extfile ext.cnf`.
- Keycloak not ready: the `until curl` loop can take 30–90 s on first start. If `kcadm config credentials` fails, wait and retry. `docker logs kc 2>&1 | tail` shows startup progress.
- `Address already in use` on 8080 or 8443: stop the other process or change the ports in both the commands and `server.py`.
- For rejected TLS handshakes (tests 1 and 2), the server usually prints nothing, or at most an SSL error, and keeps running. The handshake fails while the connection is being accepted, so the client never reaches `do_GET`. The evidence is on the curl side.

</details>

**Stretch goal:** Replace the openssl PKI with cert-manager. In a `kind` cluster, create a self-signed ClusterIssuer, a CA Certificate and a CA ClusterIssuer (as in the cert-manager lesson), and issue `server` and `client` Certificates with the right SANs and `usages` (`server auth` / `client auth`). Export `tls.crt`, `tls.key` and `ca.crt` from the Secrets, point `server.py` and curl at them, and confirm the same verify command passes. Then give the server cert `duration: 1h` and `renewBefore: 55m`, wait for renewal, and observe that the running Python server keeps serving the old certificate until you restart it.

## Review notes

The draft was rewritten twice using review issues; the notes below are from the last review.

This chapter was written with 5 finding(s) from testing earlier versions (`topics/<topic>/feedback.yaml`).

Automated review: **major-issues**. Issues to fix before relying on this chapter:

- **major** (Token delegation (RFC 8693 token exchange)): The worked example says, as a fact about NICo, that the workload's NICo-signed JWT 'is the subject_token' and that 'NICo sends the call through the egress proxy'. The independent-problem answer repeats this ('NICo's outbound token calls (which carry subject tokens)'). The docs pages only say that per-org settings include token delegation, that `token_endpoint_http_proxy` is an egress proxy 'for token delegation (RFC 8693)', and that `token_endpoint_domain_allowlist` restricts delegation `token_endpoint` hosts. They never say which token NICo sends as `subject_token`, or which component makes the exchange request. *Fix:* Hedge these statements. For example: 'In a typical RFC 8693 delegation the NICo-issued JWT would be the subject token; see the Day 1 machine identity guide for exactly what NICo sends.' Also say that the docs describe only the proxy and allowlist guard rails. Or cite the Day 1 page if it confirms these details.
- **minor** (mTLS / gRPC): The lesson says `core-grpc-client-site-agent-certs` is 'the client certificate the site agent uses to call Core over gRPC'. The docs only list this Certificate in the overall health check. Its role is a guess from its name. *Fix:* Rephrase to something like 'the health check confirms the Certificate `core-grpc-client-site-agent-certs` in `nico-rest`. As its name suggests, it is the site agent's gRPC client certificate for Core.' Or cite a source that states its role.

---

[← 18-cryptography.md](18-cryptography.md) · [20-credentials-secrets-security-identity.md →](20-credentials-secrets-security-identity.md)
